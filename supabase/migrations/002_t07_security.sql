-- Apply after the T06 schema (schema.sql, or the original schema + 001_t06.sql).
begin;

create table public.auth_accounts (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  password_hash text not null,
  created_at timestamptz not null default now(),
  constraint auth_accounts_email_normalized check (
    email = lower(btrim(email)) and length(email) <= 254
    and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  ),
  constraint auth_accounts_hash_valid check (
    password_hash ~ '^scrypt\$32768\$8\$3\$[0-9a-f]{32}\$[0-9a-f]{128}$'
  )
);
create table public.auth_sessions (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid not null references public.auth_accounts(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index auth_sessions_user on public.auth_sessions(user_id);
create index auth_sessions_expiry on public.auth_sessions(expires_at);
alter table public.auth_accounts enable row level security;
alter table public.auth_sessions enable row level security;
revoke all on public.auth_accounts, public.auth_sessions from public, anon, authenticated;
grant select, insert, update, delete on public.auth_accounts, public.auth_sessions to service_role;

-- NULL is deliberately NOT adopted. Only transfer.sql, run by an administrator,
-- can explicitly assign legacy records to an account.
do $$
declare t text;
begin
  foreach t in array array['plans','plan_versions','tasks','execution_logs','reviews'] loop
    execute format('alter table public.%I add column owner_id uuid references public.auth_accounts(id) on delete cascade', t);
    execute format('alter table public.%I add constraint %I unique (id, owner_id)', t, t || '_id_owner_unique');
    execute format('create index %I on public.%I(owner_id)', t || '_owner_idx', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
    execute format('create policy owner_only on public.%I for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid())', t);
  end loop;
end;
$$;

alter table public.tasks drop constraint tasks_plan_id_fkey;
alter table public.plan_versions drop constraint plan_versions_plan_id_fkey;
alter table public.reviews drop constraint reviews_plan_id_fkey;
alter table public.execution_logs drop constraint execution_logs_task_id_fkey;
alter table public.tasks
  add constraint tasks_plan_id_fkey foreign key (plan_id) references public.plans(id) on delete cascade,
  add constraint tasks_plan_owner_fkey foreign key (plan_id,owner_id) references public.plans(id,owner_id) on delete cascade deferrable,
  add constraint tasks_owned_parent_required check (owner_id is null or plan_id is not null);
alter table public.plan_versions
  add constraint plan_versions_plan_id_fkey foreign key (plan_id) references public.plans(id) on delete cascade,
  add constraint plan_versions_plan_owner_fkey foreign key (plan_id,owner_id) references public.plans(id,owner_id) on delete cascade deferrable,
  add constraint plan_versions_owned_parent_required check (owner_id is null or plan_id is not null);
alter table public.reviews
  add constraint reviews_plan_id_fkey foreign key (plan_id) references public.plans(id) on delete cascade,
  add constraint reviews_plan_owner_fkey foreign key (plan_id,owner_id) references public.plans(id,owner_id) on delete cascade deferrable,
  add constraint reviews_owned_parent_required check (owner_id is null or plan_id is not null);
alter table public.execution_logs
  add constraint execution_logs_task_id_fkey foreign key (task_id) references public.tasks(id) on delete cascade,
  add constraint execution_logs_task_owner_fkey foreign key (task_id,owner_id) references public.tasks(id,owner_id) on delete cascade deferrable,
  add constraint execution_logs_owned_parent_required check (owner_id is null or task_id is not null);

-- Composite foreign keys alone skip NULLs. This also protects legacy NULL owners.
create function public.check_parent_owner()
returns trigger language plpgsql security invoker
set search_path = pg_catalog, public
as $$
declare parent_owner uuid; parent_id uuid; parent_found boolean;
begin
  parent_id := (to_jsonb(new)->>tg_argv[1])::uuid;
  if parent_id is null then return new; end if;
  execute format('select owner_id,true from public.%I where id = $1', tg_argv[0])
    into parent_owner,parent_found using parent_id;
  if parent_found is not true or parent_owner is distinct from new.owner_id then
    raise exception 'Parent ownership mismatch' using errcode = '23503';
  end if;
  return new;
end;
$$;
create constraint trigger tasks_parent_owner after insert or update on public.tasks
  deferrable initially immediate for each row execute function public.check_parent_owner('plans','plan_id');
create constraint trigger versions_parent_owner after insert or update on public.plan_versions
  deferrable initially immediate for each row execute function public.check_parent_owner('plans','plan_id');
create constraint trigger reviews_parent_owner after insert or update on public.reviews
  deferrable initially immediate for each row execute function public.check_parent_owner('plans','plan_id');
create constraint trigger logs_parent_owner after insert or update on public.execution_logs
  deferrable initially immediate for each row execute function public.check_parent_owner('tasks','task_id');

create function public.check_children_owner()
returns trigger language plpgsql security invoker
set search_path = pg_catalog, public
as $$
begin
  if tg_table_name = 'plans' then
    if exists (select 1 from public.tasks where plan_id=new.id and owner_id is distinct from new.owner_id)
      or exists (select 1 from public.plan_versions where plan_id=new.id and owner_id is distinct from new.owner_id)
      or exists (select 1 from public.reviews where plan_id=new.id and owner_id is distinct from new.owner_id) then
      raise exception 'Child ownership mismatch' using errcode = '23503';
    end if;
  elsif exists (select 1 from public.execution_logs where task_id=new.id and owner_id is distinct from new.owner_id) then
    raise exception 'Child ownership mismatch' using errcode = '23503';
  end if;
  return new;
end;
$$;
create constraint trigger plans_children_owner after update of owner_id on public.plans
  deferrable initially immediate for each row execute function public.check_children_owner();
create constraint trigger tasks_children_owner after update of owner_id on public.tasks
  deferrable initially immediate for each row execute function public.check_children_owner();

create or replace function public.snapshot_plan_before_update()
returns trigger language plpgsql security invoker
set search_path = pg_catalog, public
as $$
begin
  if (to_jsonb(new) - 'owner_id') is distinct from (to_jsonb(old) - 'owner_id') then
    insert into public.plan_versions(plan_id, snapshot, owner_id)
    values (old.id, to_jsonb(old), old.owner_id);
  end if;
  return new;
end;
$$;
create or replace function public.record_task_completion()
returns trigger language plpgsql security invoker
set search_path = pg_catalog, public
as $$
begin
  if new.status = 'done' then
    if tg_op = 'INSERT' or old.status is distinct from 'done' then
      insert into public.execution_logs
        (task_id, kind, started_at, ended_at, actual_minutes, blocker, owner_id)
      values (new.id, 'completion', now(), now(), 0, '', new.owner_id)
      on conflict (task_id) where kind = 'completion' do nothing;
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.create_next_plan(p_plan_id uuid, p_improvement text)
returns jsonb language plpgsql security invoker
set search_path = pg_catalog, public
as $$
declare source_plan public.plans%rowtype; next_plan public.plans%rowtype;
  uid uuid := nullif(current_setting('app.user_id', true),'')::uuid;
begin
  select * into source_plan from public.plans where id = p_plan_id and owner_id = uid for update;
  if not found then raise exception 'Not found' using errcode = 'P0002'; end if;
  if p_improvement is null or length(btrim(p_improvement)) = 0 or length(p_improvement) > 4000 then
    raise exception 'Invalid improvement' using errcode = '22023';
  end if;
  insert into public.reviews(plan_id, improvement, owner_id) values (p_plan_id, p_improvement, uid);
  insert into public.plans
    (title,start_date,end_date,priority,success_criteria,estimated_minutes,description,owner_id)
  values (source_plan.title,source_plan.start_date,source_plan.end_date,source_plan.priority,
    source_plan.success_criteria,source_plan.estimated_minutes,p_improvement,uid)
  returning * into next_plan;
  return to_jsonb(next_plan);
end;
$$;

create or replace function public.export_data()
returns jsonb language sql stable security invoker
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'version', 1, 'exported_at', now(),
    'plans', coalesce((select jsonb_agg(p order by p.created_at,p.id) from public.plans p
      where p.owner_id = nullif(current_setting('app.user_id',true),'')::uuid), '[]'::jsonb),
    'plan_versions', coalesce((select jsonb_agg(p order by p.created_at,p.id) from public.plan_versions p
      where p.owner_id = nullif(current_setting('app.user_id',true),'')::uuid), '[]'::jsonb),
    'tasks', coalesce((select jsonb_agg(p order by p.created_at,p.id) from public.tasks p
      where p.owner_id = nullif(current_setting('app.user_id',true),'')::uuid), '[]'::jsonb),
    'execution_logs', coalesce((select jsonb_agg(p order by p.created_at,p.id) from public.execution_logs p
      where p.owner_id = nullif(current_setting('app.user_id',true),'')::uuid), '[]'::jsonb),
    'reviews', coalesce((select jsonb_agg(p order by p.created_at,p.id) from public.reviews p
      where p.owner_id = nullif(current_setting('app.user_id',true),'')::uuid), '[]'::jsonb)
  );
$$;

create function public.auth_signup(p_email text,p_password_hash text)
returns void language sql security invoker
set search_path = pg_catalog, public
as $$
  insert into public.auth_accounts(email,password_hash) values (p_email,p_password_hash)
  on conflict (email) do nothing;
$$;

-- Password verification happens with Node's platform scrypt. Locking + hash
-- comparison prevents a login checked before a password reset from issuing later.
create function public.auth_issue_session(p_user_id uuid,p_expected_hash text,p_token_hash text)
returns void language plpgsql security invoker
set search_path = pg_catalog, public
as $$
declare account public.auth_accounts%rowtype;
begin
  select * into account from public.auth_accounts where id = p_user_id for update;
  if not found or account.password_hash is distinct from p_expected_hash then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  delete from public.auth_sessions where user_id = account.id and expires_at <= clock_timestamp();
  insert into public.auth_sessions(token_hash,user_id,expires_at)
    values (p_token_hash,account.id,clock_timestamp() + interval '8 hours');
end;
$$;

-- All application requests, including reads, are a single transaction. The
-- account lock serializes them with login, logout, reset and deletion even
-- though the service-role connection itself bypasses RLS.
create function public.authorized_request(
  p_token_hash text,p_operation text,p_table text default null,p_id uuid default null,
  p_payload jsonb default '{}'::jsonb,p_expected_hash text default null,p_new_hash text default null
)
returns jsonb language plpgsql security invoker
set search_path = pg_catalog, public
as $$
declare uid uuid; account public.auth_accounts%rowtype; result jsonb;
  allowed text[]; columns_sql text; values_sql text; assignments_sql text;
begin
  select user_id into uid from public.auth_sessions where token_hash = p_token_hash;
  if uid is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  select * into account from public.auth_accounts where id = uid for update;
  if not found or not exists (select 1 from public.auth_sessions
    where token_hash = p_token_hash and user_id = uid and expires_at > clock_timestamp()) then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  perform set_config('app.user_id',uid::text,true);
  perform set_config('request.jwt.claim.sub',uid::text,true);
  if p_operation = 'session' then return jsonb_build_object('id',uid,'email',account.email); end if;
  if p_operation = 'credentials' then return jsonb_build_object('password_hash',account.password_hash); end if;
  if p_operation in ('logout','password','delete-account') then
    if p_operation <> 'logout' and account.password_hash is distinct from p_expected_hash then
      raise exception 'Authentication required' using errcode = '28000';
    end if;
    if p_operation = 'password' then
      if p_new_hash is null then raise exception 'Invalid hash' using errcode = '22023'; end if;
      update public.auth_accounts set password_hash = p_new_hash where id = uid;
    end if;
    delete from public.auth_sessions where user_id = uid;
    if p_operation = 'delete-account' then delete from public.auth_accounts where id = uid; end if;
    return '{"ok":true}'::jsonb;
  end if;
  if p_operation = 'export' then return public.export_data(); end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' or p_payload ?| array['owner_id','user_id'] then
    raise exception 'Invalid payload' using errcode = '22023';
  end if;
  if p_operation = 'carry-forward' then
    if exists (select 1 from jsonb_object_keys(p_payload) k where k not in ('plan_id','improvement')) then
      raise exception 'Invalid payload' using errcode = '22023';
    end if;
    return public.create_next_plan((p_payload->>'plan_id')::uuid,p_payload->>'improvement');
  end if;
  if p_table is null or p_table not in ('plans','plan_versions','tasks','execution_logs','reviews') then
    raise exception 'Invalid table' using errcode = '22023';
  end if;
  if p_operation = 'read' then
    if p_id is not null then
      execute format('select to_jsonb(t) from public.%I t where owner_id=$1 and id=$2 %s',
        p_table,case when p_table='tasks' then 'and t.deleted_at is null' else '' end)
        into result using uid,p_id;
      if result is null then raise exception 'Not found' using errcode = 'P0002'; end if;
      return result;
    end if;
    execute format('select coalesce(jsonb_agg(t order by t.created_at,t.id),''[]''::jsonb) from public.%I t where owner_id=$1',p_table)
      into result using uid;
    return result;
  end if;
  if p_table = 'plan_versions' or (p_table in ('reviews','execution_logs') and p_operation <> 'create') then
    raise exception 'Invalid operation' using errcode = '22023';
  end if;
  if p_operation = 'delete' and p_table = 'tasks' then
    update public.tasks set deleted_at=clock_timestamp()
      where id=p_id and owner_id=uid and deleted_at is null returning to_jsonb(tasks.*) into result;
    if result is null then raise exception 'Not found' using errcode = 'P0002'; end if;
    return '{"ok":true,"changed":1}'::jsonb;
  end if;
  if p_operation not in ('create','update') then raise exception 'Invalid operation' using errcode = '22023'; end if;
  allowed := case p_table
    when 'plans' then array['title','start_date','end_date','priority','success_criteria','estimated_minutes','description']
    when 'tasks' then array['plan_id','title','description','due_date','priority','tags','estimated_minutes','status']
    when 'execution_logs' then array['task_id','started_at','ended_at','actual_minutes','blocker']
    when 'reviews' then array['plan_id','improvement'] end;
  if p_payload = '{}'::jsonb or exists (
    select 1 from jsonb_object_keys(p_payload) k where not (k = any(allowed))
  ) then raise exception 'Invalid payload' using errcode = '22023'; end if;
  -- Return 404 for foreign parents as well as unknown ones, before FK evaluation.
  if p_payload ? 'plan_id' then
    if not exists (select 1 from public.plans where id=(p_payload->>'plan_id')::uuid and owner_id=uid) then
      raise exception 'Not found' using errcode = 'P0002';
    end if;
  end if;
  if p_payload ? 'task_id' then
    if not exists (select 1 from public.tasks where id=(p_payload->>'task_id')::uuid and owner_id=uid and deleted_at is null) then
      raise exception 'Not found' using errcode = 'P0002';
    end if;
  end if;
  if p_operation = 'create' then
    p_payload := p_payload || jsonb_build_object('owner_id',uid);
    select string_agg(format('%I',k),','), string_agg(format('r.%I',k),',')
      into columns_sql,values_sql from jsonb_object_keys(p_payload) k;
    execute format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I,$1) r returning to_jsonb(%I.*)',
      p_table,columns_sql,values_sql,p_table,p_table) into result using p_payload;
  else
    select string_agg(format('%1$I=r.%1$I',k),',') into assignments_sql from jsonb_object_keys(p_payload) k;
    execute format('update public.%I t set %s from jsonb_populate_record(null::public.%I,$1) r where t.id=$2 and t.owner_id=$3 %s returning to_jsonb(t.*)',
      p_table,assignments_sql,p_table,case when p_table='tasks' then 'and t.deleted_at is null' else '' end)
      into result using p_payload,p_id,uid;
    if result is null then raise exception 'Not found' using errcode = 'P0002'; end if;
  end if;
  return result;
end;
$$;

revoke all on function public.check_parent_owner() from public,anon,authenticated;
revoke all on function public.check_children_owner() from public,anon,authenticated;
revoke all on function public.auth_signup(text,text) from public,anon,authenticated;
revoke all on function public.auth_issue_session(uuid,text,text) from public,anon,authenticated;
revoke all on function public.authorized_request(text,text,text,uuid,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.check_parent_owner() to service_role;
grant execute on function public.check_children_owner() to service_role;
grant execute on function public.auth_signup(text,text) to service_role;
grant execute on function public.auth_issue_session(uuid,text,text) to service_role;
grant execute on function public.authorized_request(text,text,text,uuid,jsonb,text,text) to service_role;
commit;
