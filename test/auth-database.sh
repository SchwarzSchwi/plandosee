#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
PG_BINDIR="${PG_BINDIR:-$(pg_config --bindir)}"
scratch="$(mktemp -d /tmp/plandosee-auth.XXXXXX)"
cleanup() {
  "$PG_BINDIR/pg_ctl" -D "$scratch/data" stop -m immediate > /dev/null 2>&1 || true
  rm -rf "$scratch"
}
trap cleanup EXIT
mkdir "$scratch/socket"
"$PG_BINDIR/initdb" -D "$scratch/data" -A trust --no-locale > "$scratch/init.log"
"$PG_BINDIR/pg_ctl" -D "$scratch/data" -l "$scratch/server.log" \
  -o "-k $scratch/socket -c listen_addresses=''" start > /dev/null
export PGHOST="$scratch/socket" PGPORT=5432 PGUSER="$(id -un)" PGDATABASE=postgres
psql() { "$PG_BINDIR/psql" -X -q -v ON_ERROR_STOP=1 "$@"; }
psql <<'SQL'
create role anon;
create role authenticated;
create role service_role bypassrls;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;
$$;
grant usage on schema public,auth to anon,authenticated,service_role;
SQL
psql -f supabase/schema.sql
psql <<'SQL'
insert into plans(id,title) values ('70000000-0000-4000-8000-000000000001','Private legacy');
insert into tasks(plan_id,title,status) values ('70000000-0000-4000-8000-000000000001','Private legacy done','done');
SQL
psql -f supabase/migrations/002_t07_security.sql
if [ -f supabase/migrations/003_t07_observations.sql ]; then
  psql -f supabase/migrations/003_t07_observations.sql
fi
psql -f test/auth-database.sql
if [ -f supabase/migrations/003_t07_observations.sql ]; then
  # Historical records below are explicit administrator-only synthetic fixtures,
  # not runtime date overrides. The rule change and day three use real RPCs.
  psql <<'SQL'
insert into studies(id,owner_id,initial_rule,created_date,created_at)
values ('30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',
  'synthetic baseline',(clock_timestamp() at time zone 'Asia/Seoul')::date-2,clock_timestamp()-interval '2 days');
alter table observations disable trigger observations_assign;
insert into observations(id,owner_id,study_id,day_number,observed_date,actual_minutes) values
 ('40000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001',1,(clock_timestamp() at time zone 'Asia/Seoul')::date-2,10),
 ('40000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001',2,(clock_timestamp() at time zone 'Asia/Seoul')::date-1,20);
alter table observations enable trigger observations_assign;
set role service_role;
select observation_request(repeat('a',64),'rule-change',
 '{"study_id":"30000000-0000-4000-8000-000000000001","day1_id":"40000000-0000-4000-8000-000000000001","day2_id":"40000000-0000-4000-8000-000000000002","rule":"synthetic changed rule","reason":"test circular cascade"}');
select observation_request(repeat('a',64),'observe',
 '{"study_id":"30000000-0000-4000-8000-000000000001","actual_minutes":30}');
reset role;
SQL
fi

# Reset locks/expected password hashes and create two independently revocable sessions.
psql <<'SQL'
set role service_role;
select auth_issue_session('10000000-0000-4000-8000-000000000001',
  'scrypt$32768$8$3$'||repeat('0',32)||'$'||repeat('1',128),repeat('e',64));
SQL

# A request that obtained the account lock before logout finishes first; logout
# waits, then revokes ALL sessions. A later request must be denied.
psql > "$scratch/request.log" <<'SQL' &
begin;
set local role service_role;
select authorized_request(repeat('e',64),'update','plans','20000000-0000-4000-8000-000000000001','{"title":"serialized"}');
select pg_sleep(0.6);
commit;
SQL
first=$!
for i in $(seq 1 200); do
  locked="$(psql -Atc "select exists(select 1 from pg_stat_activity where pid<>pg_backend_pid() and wait_event='PgSleep' and query like 'select pg_sleep%')")"
  if [ "$locked" = t ]; then break; fi
  sleep 0.01
done
test "$locked" = t
psql > "$scratch/logout.log" <<'SQL' &
set role service_role;
select authorized_request(repeat('e',64),'logout');
SQL
second=$!
wait "$first"
wait "$second"
psql <<'SQL'
do $$ begin
  assert not exists(select 1 from auth_sessions where user_id='10000000-0000-4000-8000-000000000001'), 'Logout revokes every session after concurrent request';
  begin
    perform authorized_request(repeat('e',64),'read','plans');
    raise exception 'Expected revoked rejection';
  exception when invalid_authorization_specification then null; end;
end $$;
select auth_issue_session('10000000-0000-4000-8000-000000000001',
  'scrypt$32768$8$3$'||repeat('0',32)||'$'||repeat('1',128),repeat('f',64));
SQL

# A login that verified the old hash before password replacement must wait on
# the same account lock and then fail its expected-hash compare, not issue.
psql > "$scratch/password.log" <<'SQL' &
begin;
set local role service_role;
select authorized_request(repeat('f',64),'password',null,null,'{}',
  'scrypt$32768$8$3$'||repeat('0',32)||'$'||repeat('1',128),
  'scrypt$32768$8$3$'||repeat('0',32)||'$'||repeat('2',128));
select pg_sleep(0.6);
commit;
SQL
first=$!
for i in $(seq 1 200); do
  locked="$(psql -Atc "select exists(select 1 from pg_stat_activity where pid<>pg_backend_pid() and wait_event='PgSleep' and query like 'select pg_sleep%')")"
  if [ "$locked" = t ]; then break; fi
  sleep 0.01
done
test "$locked" = t
psql > "$scratch/stale-login.log" <<'SQL' &
set role service_role;
do $$ begin
  begin
    perform auth_issue_session('10000000-0000-4000-8000-000000000001',
      'scrypt$32768$8$3$'||repeat('0',32)||'$'||repeat('1',128),repeat('9',64));
    raise exception 'Expected stale login rejection';
  exception when invalid_authorization_specification then null; end;
end $$;
SQL
second=$!
wait "$first"
wait "$second"
psql <<'SQL'
do $$ begin
  assert not exists(select 1 from auth_sessions where user_id='10000000-0000-4000-8000-000000000001'), 'Password replacement revokes all; stale concurrent login cannot issue';
  assert (select password_hash like '%'||repeat('2',128) from auth_accounts where id='10000000-0000-4000-8000-000000000001'), 'Password changed atomically';
end $$;
select auth_issue_session('10000000-0000-4000-8000-000000000001',
  'scrypt$32768$8$3$'||repeat('0',32)||'$'||repeat('2',128),repeat('8',64));
select authorized_request(repeat('8',64),'delete-account',null,null,'{}',
  'scrypt$32768$8$3$'||repeat('0',32)||'$'||repeat('2',128));
do $$ declare t text; n bigint; begin
  assert not exists(select 1 from auth_accounts where id='10000000-0000-4000-8000-000000000001');
  foreach t in array array['plans','tasks','plan_versions','reviews','execution_logs'] loop
    execute format('select count(*) from %I where owner_id=$1',t) into n using '10000000-0000-4000-8000-000000000001'::uuid;
    assert n=0, 'Account deletion cascades every entity';
  end loop;
  foreach t in array array['studies','observations','rule_changes'] loop
    if to_regclass('public.'||t) is not null then
      execute format('select count(*) from %I where owner_id=$1',t) into n using '10000000-0000-4000-8000-000000000001'::uuid;
      assert n=0, 'Account deletion cascades observation data too';
    end if;
  end loop;
  assert exists(select 1 from plans where owner_id is null), 'Private legacy is not deleted with unrelated account';
  assert exists(select 1 from plans where owner_id='10000000-0000-4000-8000-000000000002'), 'Other owner retained';
end $$;
SQL
# Invalid legacy topology aborts before any ownership update.
psql <<'SQL'
insert into tasks(id,title) values ('70000000-0000-4000-8000-000000000099','Orphan fixture');
SQL
if sed 's/00000000-0000-0000-0000-000000000000/10000000-0000-4000-8000-000000000002/' supabase/transfer.sql | psql > "$scratch/transfer-orphan.log" 2>&1; then
  echo 'Expected legacy orphan transfer rejection'; exit 1
fi
psql <<'SQL'
do $$ begin
  assert (select owner_id is null from plans where id='70000000-0000-4000-8000-000000000001'), 'Rejected transfer changes nothing';
end $$;
delete from tasks where id='70000000-0000-4000-8000-000000000099';
-- Simulate an administrator-created pre-existing violation. Normal service
-- writes cannot insert this row because migration 002's trigger rejects it.
alter table tasks disable trigger tasks_parent_owner;
insert into tasks(id,plan_id,title) values ('70000000-0000-4000-8000-000000000098','20000000-0000-4000-8000-000000000002','Invalid ownership fixture');
alter table tasks enable trigger tasks_parent_owner;
SQL
if sed 's/00000000-0000-0000-0000-000000000000/10000000-0000-4000-8000-000000000002/' supabase/transfer.sql | psql > "$scratch/transfer-owner.log" 2>&1; then
  echo 'Expected cross-owner transfer rejection'; exit 1
fi
psql <<'SQL'
do $$ begin
  assert (select owner_id is null from plans where id='70000000-0000-4000-8000-000000000001'), 'Cross-owner failure rolls back';
end $$;
delete from tasks where id='70000000-0000-4000-8000-000000000098';
SQL
# The administrator must opt in explicitly; replace only the documented
# placeholder in the script stream, leaving the checked-in script fail closed.
sed 's/00000000-0000-0000-0000-000000000000/10000000-0000-4000-8000-000000000002/' supabase/transfer.sql | psql
psql <<'SQL'
do $$ begin
  assert (select owner_id='10000000-0000-4000-8000-000000000002' from plans where id='70000000-0000-4000-8000-000000000001'), 'Explicit administrator transfer adopts legacy';
  assert not exists(select 1 from tasks where plan_id='70000000-0000-4000-8000-000000000001' and owner_id is null), 'Transfer includes children';
  assert not exists(select 1 from execution_logs l join tasks t on t.id=l.task_id where t.plan_id='70000000-0000-4000-8000-000000000001' and l.owner_id is null), 'Transfer includes generated completion logs';
end $$;
SQL
echo 'T07 PostgreSQL regressions passed: RLS, ownership, NULL legacy, snapshots, completion, export, carry-forward, cascades and real logout/password/login concurrency.'
