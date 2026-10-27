#!/usr/bin/env bash
# Standalone: bash test/database.sh. Requires PostgreSQL server tools, no repository dependencies.
set -euo pipefail
cd "$(dirname "$0")/.."
PG_BINDIR="${PG_BINDIR:-$(pg_config --bindir)}"
scratch="$(mktemp -d /tmp/plandosee-db.XXXXXX)"
mkdir -p "$scratch/socket"
cleanup() {
  "$PG_BINDIR/pg_ctl" -D "$scratch/data" stop -m immediate > /dev/null 2>&1 || true
  rm -rf "$scratch"
}
trap cleanup EXIT
"$PG_BINDIR/initdb" -D "$scratch/data" -A trust --no-locale > "$scratch/init.log"
"$PG_BINDIR/pg_ctl" -D "$scratch/data" -l "$scratch/server.log" \
  -o "-k $scratch/socket -c listen_addresses=''" start > /dev/null
export PGHOST="$scratch/socket" PGPORT=5432 PGUSER="$(id -un)"
psql() { "$PG_BINDIR/psql" -X -q -v ON_ERROR_STOP=1 "$@"; }
psql -d postgres -c 'create role anon; create role authenticated; create role service_role bypassrls;'
psql -d postgres -c 'create database t06_fresh;'
psql -d postgres -c 'create database t06_migrated;'
psql -d t06_fresh -f supabase/schema.sql
psql -d t06_migrated <<'SQL'
create table plans(id uuid primary key default gen_random_uuid(),title text not null,start_date date,end_date date,priority text,success_criteria text,estimated_minutes int default 0,description text,created_at timestamptz default now());
create table plan_versions(id uuid primary key default gen_random_uuid(),plan_id uuid references plans(id),snapshot jsonb not null,created_at timestamptz default now());
create table tasks(id uuid primary key default gen_random_uuid(),plan_id uuid references plans(id),title text not null,description text,due_date date,priority text,tags text[],estimated_minutes int default 0,status text default 'progress',deleted_at timestamptz,created_at timestamptz default now());
create table execution_logs(id uuid primary key default gen_random_uuid(),task_id uuid references tasks(id),started_at timestamptz,ended_at timestamptz,actual_minutes int,blocker text,created_at timestamptz default now());
create table reviews(id uuid primary key default gen_random_uuid(),plan_id uuid references plans(id),improvement text,created_at timestamptz default now());
insert into plans(id,title,priority,estimated_minutes) values('07000000-0000-4000-8000-000000000001','Legacy nullable',null,null);
insert into tasks(id,plan_id,title,status,priority,estimated_minutes) values
('07000000-0000-4000-8000-000000000011','07000000-0000-4000-8000-000000000001','Legacy done','done',null,null),
('07000000-0000-4000-8000-000000000012','07000000-0000-4000-8000-000000000001','Legacy nullable',null,null,null);
insert into execution_logs(task_id,actual_minutes) values('07000000-0000-4000-8000-000000000011',null);
SQL
psql -d t06_migrated -f supabase/migrations/001_t06.sql
psql -d t06_migrated <<'SQL'
do $$ begin
  assert (select count(*)=1 from execution_logs where task_id='07000000-0000-4000-8000-000000000011' and kind='completion'), 'Legacy completion backfill';
  assert (select count(*)=1 from execution_logs where task_id='07000000-0000-4000-8000-000000000011' and kind='work' and actual_minutes is null), 'Legacy work retained';
  assert (select status is null from tasks where id='07000000-0000-4000-8000-000000000012'), 'Legacy null status retained';
end $$;
SQL
for db in t06_fresh t06_migrated; do
  psql -d "$db" -f supabase/seed.sql -f supabase/seed.sql -f test/database.sql
  "$PG_BINDIR/pg_dump" -d "$db" --schema-only --no-owner --no-privileges |
    sed '/^\\restrict /d;/^\\unrestrict /d' > "$scratch/$db.sql"
done
diff -u "$scratch/t06_fresh.sql" "$scratch/t06_migrated.sql"

export PGDATABASE=t06_fresh
psql <<'SQL'
insert into plans(id,title) values('09000000-0000-4000-8000-000000000001','original');
insert into tasks(id,plan_id,title) values('09000000-0000-4000-8000-000000000011','09000000-0000-4000-8000-000000000001','original');
SQL
# C21: separate backend transactions contend for the same plan.
psql > "$scratch/first.log" <<'SQL' &
begin;
update plans set title='first' where id='09000000-0000-4000-8000-000000000001';
select pg_sleep(0.5);
commit;
SQL
first=$!
# Wait for the first backend's uncommitted update, rather than assuming process startup order.
for i in $(seq 1 200); do
  locked="$(psql -Atc "select exists(select 1 from pg_locks where relation='public.plans'::regclass and mode='RowExclusiveLock' and granted)")"
  if [ "$locked" = t ]; then break; fi
  sleep 0.01
done
test "$locked" = t
psql > "$scratch/second.log" <<'SQL' &
begin;
update plans set title='second' where id='09000000-0000-4000-8000-000000000001';
commit;
SQL
second=$!
wait "$first"
wait "$second"
# C22: independently contend on the task row, not on the preceding plan lock.
psql > "$scratch/completion-first.log" <<'SQL' &
begin;
update tasks set status='done' where id='09000000-0000-4000-8000-000000000011';
select pg_sleep(0.5);
commit;
SQL
first=$!
for i in $(seq 1 200); do
  locked="$(psql -Atc "select exists(select 1 from pg_locks where relation='public.tasks'::regclass and mode='RowExclusiveLock' and granted)")"
  if [ "$locked" = t ]; then break; fi
  sleep 0.01
done
test "$locked" = t
psql > "$scratch/completion-second.log" <<'SQL' &
begin;
update tasks set status='done' where id='09000000-0000-4000-8000-000000000011';
commit;
SQL
second=$!
wait "$first"
wait "$second"
psql <<'SQL'
do $$ begin
  assert (select count(*)=1 from execution_logs where task_id='09000000-0000-4000-8000-000000000011' and kind='completion'), 'C22 concurrent done creates one event';
  assert (select count(*)=2 from plan_versions where plan_id='09000000-0000-4000-8000-000000000001'), 'C21 both concurrent revisions captured';
  assert exists(select 1 from plan_versions where plan_id='09000000-0000-4000-8000-000000000001' and snapshot->>'title'='original'), 'C21 original state captured';
  assert exists(select 1 from plan_versions where plan_id='09000000-0000-4000-8000-000000000001' and snapshot->>'title'='first'), 'C21 second writer captures committed first revision';
end $$;
update plans set title='consistent-0' where id='09000000-0000-4000-8000-000000000001';
update tasks set title='consistent-0' where id='09000000-0000-4000-8000-000000000011';
SQL
(
  for i in $(seq 1 60); do
    printf "begin; update plans set title='consistent-%s' where id='09000000-0000-4000-8000-000000000001'; select pg_sleep(0.002); update tasks set title='consistent-%s' where id='09000000-0000-4000-8000-000000000011'; commit;\n" "$i" "$i"
  done
) | psql > "$scratch/export-writer.log" &
writer=$!
psql <<'SQL'
do $$ declare payload jsonb; plan_title text; task_title text; begin
  for i in 1..100 loop
    payload := export_data();
    select e->>'title' into plan_title from jsonb_array_elements(payload->'plans') e where e->>'id'='09000000-0000-4000-8000-000000000001';
    select e->>'title' into task_title from jsonb_array_elements(payload->'tasks') e where e->>'id'='09000000-0000-4000-8000-000000000011';
    assert plan_title=task_title, 'Export has one consistent multi-table snapshot';
    perform pg_sleep(0.003);
  end loop;
end $$;
SQL
wait "$writer"
echo 'PostgreSQL regressions passed: fresh, migration, seed replay, atomicity, permissions, C21/C22 concurrency and consistent export.'
