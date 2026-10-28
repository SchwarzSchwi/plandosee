begin;

create table public.studies (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.auth_accounts(id) on delete cascade,
  question text not null default '실행 규칙을 바꾼 뒤 하루 실제 실행 시간(분)은 어떻게 달라지는가?'
    check (question = '실행 규칙을 바꾼 뒤 하루 실제 실행 시간(분)은 어떻게 달라지는가?'),
  metric text not null default 'actual_minutes' check (metric = 'actual_minutes'),
  unit text not null default 'minutes' check (unit = 'minutes'),
  initial_rule text not null check (length(btrim(initial_rule)) between 1 and 4000),
  created_at timestamptz not null default clock_timestamp(),
  created_date date not null default (clock_timestamp() at time zone 'Asia/Seoul')::date,
  unique (id, owner_id)
);

create table public.observations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  study_id uuid not null,
  day_number integer not null check (day_number between 1 and 5),
  observed_date date not null,
  actual_minutes integer not null check (actual_minutes between 0 and 1440),
  rule_change_id uuid,
  created_at timestamptz not null default clock_timestamp(),
  foreign key (study_id, owner_id) references public.studies(id, owner_id) on delete cascade,
  unique (study_id, observed_date),
  unique (study_id, day_number),
  unique (study_id, owner_id, id, day_number),
  check ((day_number <= 2 and rule_change_id is null) or (day_number >= 3 and rule_change_id is not null))
);

create table public.rule_changes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  study_id uuid not null,
  day1_id uuid not null,
  day2_id uuid not null,
  day1_number integer not null default 1 check (day1_number = 1),
  day2_number integer not null default 2 check (day2_number = 2),
  rule text not null check (length(btrim(rule)) between 1 and 4000),
  reason text not null check (length(btrim(reason)) between 1 and 4000),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (study_id, owner_id) references public.studies(id, owner_id) on delete cascade,
  foreign key (study_id, owner_id, day1_id, day1_number)
    references public.observations(study_id, owner_id, id, day_number),
  foreign key (study_id, owner_id, day2_id, day2_number)
    references public.observations(study_id, owner_id, id, day_number),
  unique (study_id),
  unique (study_id, owner_id, id)
);

alter table public.observations add constraint observations_rule_owned
  foreign key (study_id, owner_id, rule_change_id)
  references public.rule_changes(study_id, owner_id, id);

create function public.t07_immutable()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  raise exception 'Study definitions, observations and rule changes are immutable' using errcode = '22023';
end;
$$;

create function public.t07_assign_observation()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
declare
  source public.studies%rowtype;
  observation_count integer;
  last_date date;
  change_id uuid;
begin
  select * into source from public.studies where id = new.study_id and owner_id = new.owner_id for update;
  if not found then raise exception 'Study not found' using errcode = 'P0002'; end if;
  new.created_at := clock_timestamp();
  new.observed_date := (new.created_at at time zone 'Asia/Seoul')::date;
  if new.observed_date < source.created_date then
    raise exception 'Observation predates study' using errcode = '22023';
  end if;
  select count(*), max(observed_date) into observation_count, last_date
    from public.observations where study_id = source.id;
  if observation_count >= 5 then raise exception 'Exactly five observation days allowed' using errcode = '22023'; end if;
  if last_date >= new.observed_date then raise exception 'One observation per actual Seoul date' using errcode = '23505'; end if;
  new.day_number := observation_count + 1;
  select id into change_id from public.rule_changes where study_id = source.id;
  if observation_count >= 2 and change_id is null then
    raise exception 'Record a rule change after day two and before day three' using errcode = '22023';
  end if;
  new.rule_change_id := case when observation_count >= 2 then change_id else null end;
  return new;
end;
$$;

create function public.t07_assign_rule_change()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
declare
  source public.studies%rowtype;
begin
  select * into source from public.studies where id = new.study_id and owner_id = new.owner_id for update;
  if not found then raise exception 'Study not found' using errcode = 'P0002'; end if;
  if (select count(*) from public.observations where study_id = source.id) <> 2 then
    raise exception 'Rule change requires exactly day one and day two' using errcode = '22023';
  end if;
  if new.rule = source.initial_rule then raise exception 'The rule must change' using errcode = '22023'; end if;
  new.created_at := clock_timestamp();
  return new;
end;
$$;

create trigger studies_immutable before update on public.studies for each row execute function public.t07_immutable();
create trigger observations_immutable before update on public.observations for each row execute function public.t07_immutable();
create trigger rule_changes_immutable before update on public.rule_changes for each row execute function public.t07_immutable();
create trigger observations_assign before insert on public.observations for each row execute function public.t07_assign_observation();
create trigger rule_changes_assign before insert on public.rule_changes for each row execute function public.t07_assign_rule_change();

alter table public.studies enable row level security;
alter table public.observations enable row level security;
alter table public.rule_changes enable row level security;
-- Ownership is a database session identity, never an owner supplied by the browser.
create policy studies_owner on public.studies using (owner_id = nullif(current_setting('app.user_id', true), '')::uuid);
create policy observations_owner on public.observations using (owner_id = nullif(current_setting('app.user_id', true), '')::uuid);
create policy rule_changes_owner on public.rule_changes using (owner_id = nullif(current_setting('app.user_id', true), '')::uuid);

create function public.observation_request(p_token_hash text, p_operation text, p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  account jsonb;
  owner uuid;
  source public.studies%rowtype;
  result jsonb;
  allowed text[];
begin
  account := public.authorized_request(p_token_hash => p_token_hash, p_operation => 'session');
  owner := (account->>'id')::uuid;
  if owner is null then raise exception 'Session required' using errcode = '28000'; end if;
  perform set_config('app.user_id', owner::text, true);
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'Object required' using errcode = '22023';
  end if;
  allowed := case p_operation
    when 'study' then array[]::text[]
    when 'create-study' then array['initial_rule']
    when 'observe' then array['study_id', 'actual_minutes']
    when 'rule-change' then array['study_id', 'day1_id', 'day2_id', 'rule', 'reason']
    else null end;
  if allowed is null or exists(select 1 from jsonb_object_keys(p_payload) key where not key = any(allowed)) then
    raise exception 'Unsupported action or field' using errcode = '22023';
  end if;
  if p_operation = 'study' then
    select jsonb_build_object(
      'today', (clock_timestamp() at time zone 'Asia/Seoul')::date,
      'studies', coalesce((select jsonb_agg(s order by s.created_at, s.id) from public.studies s where s.owner_id = owner), '[]'::jsonb),
      'observations', coalesce((select jsonb_agg(o order by o.observed_date, o.id) from public.observations o where o.owner_id = owner), '[]'::jsonb),
      'rule_changes', coalesce((select jsonb_agg(r order by r.created_at, r.id) from public.rule_changes r where r.owner_id = owner), '[]'::jsonb)
    ) into result;
    return result;
  elsif p_operation = 'create-study' then
    if jsonb_typeof(p_payload->'initial_rule') is distinct from 'string' then
      raise exception 'Initial rule required' using errcode = '22023';
    end if;
    insert into public.studies(owner_id, initial_rule) values (owner, btrim(p_payload->>'initial_rule'))
      returning to_jsonb(studies.*) into result;
    return result;
  end if;
  select * into source from public.studies
    where id = (p_payload->>'study_id')::uuid and owner_id = owner for update;
  if not found then raise exception 'Study not found' using errcode = 'P0002'; end if;
  if p_operation = 'observe' then
    if jsonb_typeof(p_payload->'actual_minutes') is distinct from 'number'
      or (p_payload->>'actual_minutes')::numeric <> trunc((p_payload->>'actual_minutes')::numeric)
      or (p_payload->>'actual_minutes')::numeric not between 0 and 1440 then
      raise exception 'Minutes must be an integer from 0 to 1440' using errcode = '22023';
    end if;
    insert into public.observations(owner_id, study_id, actual_minutes)
      values (owner, source.id, (p_payload->>'actual_minutes')::numeric::integer)
      returning to_jsonb(observations.*) into result;
  elsif p_operation = 'rule-change' then
    if jsonb_typeof(p_payload->'rule') is distinct from 'string'
      or jsonb_typeof(p_payload->'reason') is distinct from 'string'
      or p_payload->>'day1_id' is null or p_payload->>'day2_id' is null then
      raise exception 'Rule, reason and exact evidence IDs required' using errcode = '22023';
    end if;
    insert into public.rule_changes(owner_id, study_id, day1_id, day2_id, rule, reason)
      values (owner, source.id, (p_payload->>'day1_id')::uuid, (p_payload->>'day2_id')::uuid,
        btrim(p_payload->>'rule'), btrim(p_payload->>'reason'))
      returning to_jsonb(rule_changes.*) into result;
  end if;
  return result;
end;
$$;

revoke all on public.studies, public.observations, public.rule_changes from public, anon, authenticated;
revoke all on function public.t07_immutable(), public.t07_assign_observation(), public.t07_assign_rule_change() from public, anon, authenticated;
revoke all on function public.observation_request(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.observation_request(text, text, jsonb) to service_role;

-- A single stable SQL snapshot includes T06 and T07, without granting table access.
alter function public.export_data() rename to t07_base_export_data;
revoke all on function public.t07_base_export_data() from public, anon, authenticated;
create function public.export_data()
returns jsonb language sql stable security definer
set search_path = pg_catalog, public as $$
  select public.t07_base_export_data() || jsonb_build_object(
    'studies', coalesce((select jsonb_agg(s order by s.created_at, s.id) from public.studies s
      where s.owner_id = nullif(current_setting('app.user_id', true), '')::uuid), '[]'::jsonb),
    'observations', coalesce((select jsonb_agg(o order by o.observed_date, o.id) from public.observations o
      where o.owner_id = nullif(current_setting('app.user_id', true), '')::uuid), '[]'::jsonb),
    'rule_changes', coalesce((select jsonb_agg(r order by r.created_at, r.id) from public.rule_changes r
      where r.owner_id = nullif(current_setting('app.user_id', true), '')::uuid), '[]'::jsonb)
  );
$$;
revoke all on function public.export_data() from public, anon, authenticated;
grant execute on function public.export_data() to service_role;

commit;
