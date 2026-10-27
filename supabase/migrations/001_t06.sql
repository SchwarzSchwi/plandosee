begin;

-- Nullable legacy fields remain nullable; CHECK constraints reject invalid supplied values.
alter table public.plans
  add constraint plans_minutes_nonnegative check (estimated_minutes >= 0),
  add constraint plans_priority_valid check (priority in ('low', 'medium', 'high')),
  add constraint plans_dates_ordered check (end_date >= start_date);
alter table public.tasks
  add constraint tasks_minutes_nonnegative check (estimated_minutes >= 0),
  add constraint tasks_priority_valid check (priority in ('low', 'medium', 'high')),
  add constraint tasks_status_valid check (status in ('progress', 'done'));
alter table public.execution_logs
  add column kind text not null default 'work',
  add constraint execution_logs_minutes_nonnegative check (actual_minutes >= 0),
  add constraint execution_logs_times_ordered check (ended_at >= started_at),
  add constraint execution_logs_kind_valid check (kind in ('work', 'completion')),
  add constraint execution_logs_completion_valid check (
    kind <> 'completion' or (
      task_id is not null and started_at is not null and ended_at is not null
      and started_at = ended_at and actual_minutes is not null
      and actual_minutes = 0 and blocker is not null and blocker = ''
    )
  );

create unique index execution_logs_one_completion_per_task
  on public.execution_logs(task_id) where kind = 'completion';

alter table public.plans enable row level security;
alter table public.plan_versions enable row level security;
alter table public.tasks enable row level security;
alter table public.execution_logs enable row level security;
alter table public.reviews enable row level security;

create function public.snapshot_plan_before_update()
returns trigger
language plpgsql security invoker
set search_path = pg_catalog, public
as $$
begin
  if new is distinct from old then
    insert into public.plan_versions(plan_id, snapshot)
    values (old.id, to_jsonb(old));
  end if;
  return new;
end;
$$;

create trigger plans_snapshot_before_update
before update on public.plans
for each row execute function public.snapshot_plan_before_update();

create function public.record_task_completion()
returns trigger
language plpgsql security invoker
set search_path = pg_catalog, public
as $$
begin
  if new.status = 'done' then
    if tg_op = 'INSERT' or old.status is distinct from 'done' then
      insert into public.execution_logs
        (task_id, kind, started_at, ended_at, actual_minutes, blocker)
      values (new.id, 'completion', now(), now(), 0, '')
      on conflict (task_id) where kind = 'completion' do nothing;
    end if;
  end if;
  return new;
end;
$$;

create trigger tasks_record_completion
after insert or update of status on public.tasks
for each row execute function public.record_task_completion();

-- Existing completed tasks also get an event without reclassifying ordinary work logs.
insert into public.execution_logs
  (task_id, kind, started_at, ended_at, actual_minutes, blocker)
select id, 'completion', now(), now(), 0, '' from public.tasks where status = 'done'
on conflict (task_id) where kind = 'completion' do nothing;

create function public.create_next_plan(p_plan_id uuid, p_improvement text)
returns jsonb
language plpgsql security invoker
set search_path = pg_catalog, public
as $$
declare
  source_plan public.plans%rowtype;
  next_plan public.plans%rowtype;
begin
  select * into source_plan from public.plans where id = p_plan_id for update;
  if not found then
    raise exception 'Plan not found' using errcode = 'P0002';
  end if;

  insert into public.reviews(plan_id, improvement)
  values (p_plan_id, p_improvement);

  insert into public.plans
    (title, start_date, end_date, priority, success_criteria, estimated_minutes, description)
  values
    (source_plan.title, source_plan.start_date, source_plan.end_date,
     source_plan.priority, source_plan.success_criteria, source_plan.estimated_minutes,
     p_improvement)
  returning * into next_plan;

  return to_jsonb(next_plan);
end;
$$;

-- One SQL statement and a STABLE function keep every table on the same MVCC snapshot.
create function public.export_data()
returns jsonb
language sql stable security invoker
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'version', 1,
    'exported_at', now(),
    'plans', coalesce((select jsonb_agg(p order by p.created_at, p.id) from public.plans p), '[]'::jsonb),
    'plan_versions', coalesce((select jsonb_agg(v order by v.created_at, v.id) from public.plan_versions v), '[]'::jsonb),
    'tasks', coalesce((select jsonb_agg(t order by t.created_at, t.id) from public.tasks t), '[]'::jsonb),
    'execution_logs', coalesce((select jsonb_agg(l order by l.created_at, l.id) from public.execution_logs l), '[]'::jsonb),
    'reviews', coalesce((select jsonb_agg(r order by r.created_at, r.id) from public.reviews r), '[]'::jsonb)
  );
$$;

revoke all on function public.snapshot_plan_before_update() from public, anon, authenticated;
revoke all on function public.record_task_completion() from public, anon, authenticated;
revoke all on function public.create_next_plan(uuid, text) from public, anon, authenticated;
revoke all on function public.export_data() from public, anon, authenticated;
grant execute on function public.snapshot_plan_before_update() to service_role;
grant execute on function public.record_task_completion() to service_role;
grant execute on function public.create_next_plan(uuid, text) to service_role;
grant execute on function public.export_data() to service_role;

commit;
