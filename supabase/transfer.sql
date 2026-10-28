-- ADMINISTRATOR ONLY. Run in the Supabase SQL editor after migration 002.
-- This does not auto-adopt legacy rows on signup. Replace the explicit UUID
-- below with an EXISTING auth_accounts.id, review the affected legacy rows,
-- then execute the entire transaction. Never expose this script as an API.
begin;
set constraints all deferred;
do $$
declare target uuid := '00000000-0000-0000-0000-000000000000';
  t text; total_count bigint; legacy_count bigint; owned_count bigint;
  before_counts jsonb := '{}'::jsonb; after_counts jsonb := '{}'::jsonb;
begin
  if not exists (select 1 from public.auth_accounts where id=target) then
    raise exception 'Set target to an existing account UUID before transferring';
  end if;
  perform 1 from public.auth_accounts where id=target for update;
  lock table public.plans,public.tasks,public.plan_versions,public.reviews,public.execution_logs
    in share row exclusive mode;
  if exists (
    select 1 from public.tasks c left join public.plans p on p.id=c.plan_id
      where p.id is null or c.owner_id is distinct from p.owner_id
    union all
    select 1 from public.plan_versions c left join public.plans p on p.id=c.plan_id
      where p.id is null or c.owner_id is distinct from p.owner_id
    union all
    select 1 from public.reviews c left join public.plans p on p.id=c.plan_id
      where p.id is null or c.owner_id is distinct from p.owner_id
    union all
    select 1 from public.execution_logs c left join public.tasks p on p.id=c.task_id
      where p.id is null or c.owner_id is distinct from p.owner_id
  ) then
    raise exception 'Transfer aborted: repair orphan or cross-owner parent links first';
  end if;
  foreach t in array array['plans','tasks','plan_versions','reviews','execution_logs'] loop
    execute format('select count(*),count(*) filter(where owner_id is null),count(*) filter(where owner_id=$1) from public.%I',t)
      into total_count,legacy_count,owned_count using target;
    before_counts := before_counts || jsonb_build_object(t,jsonb_build_object(
      'total',total_count,'legacy',legacy_count,'target_owned',owned_count));
  end loop;
  update public.plans set owner_id=target where owner_id is null;
  update public.tasks t set owner_id=target from public.plans p
    where t.owner_id is null and t.plan_id=p.id and p.owner_id=target;
  update public.plan_versions v set owner_id=target from public.plans p
    where v.owner_id is null and v.plan_id=p.id and p.owner_id=target;
  update public.reviews r set owner_id=target from public.plans p
    where r.owner_id is null and r.plan_id=p.id and p.owner_id=target;
  update public.execution_logs l set owner_id=target from public.tasks t
    where l.owner_id is null and l.task_id=t.id and t.owner_id=target;
  foreach t in array array['plans','tasks','plan_versions','reviews','execution_logs'] loop
    execute format('select count(*),count(*) filter(where owner_id is null),count(*) filter(where owner_id=$1) from public.%I',t)
      into total_count,legacy_count,owned_count using target;
    after_counts := after_counts || jsonb_build_object(t,jsonb_build_object(
      'total',total_count,'legacy',legacy_count,'target_owned',owned_count));
    if total_count <> (before_counts->t->>'total')::bigint or legacy_count <> 0
      or owned_count <> (before_counts->t->>'target_owned')::bigint + (before_counts->t->>'legacy')::bigint then
      raise exception 'Transfer aborted: row count mismatch in %',t;
    end if;
  end loop;
  if exists (
    select 1 from public.tasks c join public.plans p on p.id=c.plan_id where c.owner_id is distinct from p.owner_id
    union all
    select 1 from public.plan_versions c join public.plans p on p.id=c.plan_id where c.owner_id is distinct from p.owner_id
    union all
    select 1 from public.reviews c join public.plans p on p.id=c.plan_id where c.owner_id is distinct from p.owner_id
    union all
    select 1 from public.execution_logs c join public.tasks p on p.id=c.task_id where c.owner_id is distinct from p.owner_id
  ) then raise exception 'Transfer aborted: parent ownership mismatch'; end if;
  raise notice 'Transfer counts: %',jsonb_build_object('before',before_counts,'after',after_counts);
end;
$$;
commit;
