#!/usr/bin/env bash
# Real isolated PostgreSQL + Node HTTP integration; no package dependencies.
set -euo pipefail
cd "$(dirname "$0")/.."
PG_BINDIR="${PG_BINDIR:-$(pg_config --bindir)}"
scratch="$(mktemp -d /tmp/plandosee-t07.XXXXXX)"
mkdir "$scratch/socket"
cleanup() {
  "$PG_BINDIR/pg_ctl" -D "$scratch/data" stop -m immediate >/dev/null 2>&1 || true
  rm -rf "$scratch"
}
trap cleanup EXIT
"$PG_BINDIR/initdb" -D "$scratch/data" -A trust --no-locale >"$scratch/init.log"
"$PG_BINDIR/pg_ctl" -D "$scratch/data" -l "$scratch/server.log" \
  -o "-k $scratch/socket -c listen_addresses=''" start >/dev/null
export PGHOST="$scratch/socket" PGPORT=5432 PGUSER="$(id -un)" PGDATABASE=t07_integration
export T07_PG=1 T07_PSQL="$PG_BINDIR/psql" T07_PG_LOG="$scratch/server.log"
psql() { "$PG_BINDIR/psql" -X -q -v ON_ERROR_STOP=1 "$@"; }
psql -d postgres <<'SQL' >"$scratch/setup.log" 2>&1
create role anon;
create role authenticated;
create role service_role bypassrls;
create database t07_integration;
SQL
psql <<'SQL' >>"$scratch/setup.log" 2>&1
create schema auth;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
$$;
grant usage on schema public, auth to service_role, authenticated, anon;
SQL
psql -f supabase/schema.sql -f supabase/seed.sql -f supabase/seed.sql >>"$scratch/setup.log" 2>&1
psql <<'SQL' >>"$scratch/setup.log" 2>&1
update plans set description='Synthetic pre-security revision'
  where id='06000000-0000-4000-8000-000000000001';
insert into reviews(plan_id,improvement)
  values('06000000-0000-4000-8000-000000000001','Synthetic pre-security review');
SQL
psql -f supabase/migrations/002_t07_security.sql \
  -f supabase/migrations/003_t07_observations.sql >>"$scratch/setup.log" 2>&1
node --test test/t07-integration.test.js
psql -f test/t07-integration.sql >>"$scratch/setup.log" 2>&1 || {
  echo 'T07 PostgreSQL invariant assertion failed (SQL details withheld).'
  exit 1
}
echo 'T07 PostgreSQL: legacy transfer, T06 invariants, privilege denial, synthetic timing rollback PASS.'
