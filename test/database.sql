-- Run through database.sh: assertions apply equally to fresh and upgraded installs.
\set ON_ERROR_STOP on
begin;
grant usage on schema public to anon, authenticated, service_role;
grant all on all tables in schema public to service_role;
grant select on all tables in schema public to anon, authenticated;
set local role service_role;

do $$
declare
  plan uuid := '08000000-0000-4000-8000-000000000001';
  task uuid := '08000000-0000-4000-8000-000000000011';
  old_plan jsonb;
  event_row jsonb;
  next_plan jsonb;
  exported jsonb;
  before_plans int;
  before_reviews int;
  field text;
  row_count bigint;
begin
  assert (select count(*)=5 from tasks where plan_id='06000000-0000-4000-8000-000000000001'), 'Seed replay keeps five tasks';
  assert (select count(*)=3 from execution_logs l join tasks t on t.id=l.task_id where t.plan_id='06000000-0000-4000-8000-000000000001' and l.kind='work' and l.actual_minutes>0), 'Three nonzero demonstration work logs';
  assert exists(select 1 from tasks where plan_id='06000000-0000-4000-8000-000000000001' and status='progress' and due_date<current_date), 'Demonstration overdue task';
  assert exists(select 1 from execution_logs where blocker<>''), 'Demonstration blocker';

  insert into plans(id,title,start_date,end_date,priority,estimated_minutes,description)
  values(plan,'Initial',current_date,current_date+7,'high',60,'Original');
  select to_jsonb(p) into old_plan from plans p where id=plan;
  update plans set title='Revision one' where id=plan;
  assert (select count(*)=1 from plan_versions where plan_id=plan), 'One revision';
  assert (select v.snapshot=old_plan from plan_versions v where plan_id=plan), 'Exact previous row snapshot';
  update plans set title='Revision two' where id=plan;
  update plans set title=title where id=plan;
  assert (select count(*)=2 from plan_versions where plan_id=plan), 'No-op update adds no history';
  begin
    update plans set estimated_minutes=-1 where id=plan;
    raise exception 'Expected negative estimate rejection';
  exception when check_violation then null; end;
  assert (select count(*)=2 from plan_versions where plan_id=plan), 'Rejected update rolls back history';
  begin
    update plans set title='Rolled back revision' where id=plan;
    raise exception 'Deliberate rollback' using errcode='23514';
  exception when check_violation then null; end;
  assert (select title='Revision two' from plans where id=plan), 'Rolled-back title restored';
  assert (select count(*)=2 from plan_versions where plan_id=plan), 'Rolled-back update adds no history';

  insert into tasks(id,plan_id,title) values(task,plan,'Progress');
  update tasks set status='done' where id=task;
  select to_jsonb(l) into event_row from execution_logs l where task_id=task and kind='completion';
  assert event_row is not null, 'Completion exists';
  assert event_row->>'started_at'=event_row->>'ended_at'
    and (event_row->>'actual_minutes')::int=0 and event_row->>'blocker'='', 'Zero-duration completion';
  update tasks set status='done' where id=task;
  update tasks set status='progress' where id=task;
  update tasks set status='done' where id=task;
  assert (select count(*)=1 from execution_logs where task_id=task and kind='completion'), 'Repeated completion is idempotent across reopening';
  assert (select to_jsonb(l)=event_row from execution_logs l where task_id=task and kind='completion'), 'Original event retained';
  insert into execution_logs(task_id,started_at,ended_at,actual_minutes)
  values(task,now()-interval '10 minutes',now(),10);
  assert (select count(*)=1 from execution_logs where task_id=task and kind='work'), 'Ordinary logs default to work';
  begin
    insert into execution_logs(task_id,kind,started_at,ended_at,actual_minutes,blocker)
    values(task,'completion',now(),now(),0,'');
    raise exception 'Expected duplicate completion rejection';
  exception when unique_violation then null; end;
  insert into tasks(plan_id,title,status,priority,estimated_minutes) values(plan,'Nullable',null,null,null);
  update tasks set status='done' where plan_id=plan and status is null;
  insert into tasks(plan_id,title,status) values(plan,'Created done','done');
  assert (select count(*)=3 from execution_logs l join tasks t on t.id=l.task_id where t.plan_id=plan and l.kind='completion'), 'Insert done and null-to-done both record completion';

  begin update tasks set status='invalid' where id=task; raise exception 'Expected invalid status'; exception when check_violation then null; end;
  begin update tasks set priority='urgent' where id=task; raise exception 'Expected invalid task priority'; exception when check_violation then null; end;
  begin update tasks set estimated_minutes=-1 where id=task; raise exception 'Expected invalid task minutes'; exception when check_violation then null; end;
  begin update plans set priority='urgent' where id=plan; raise exception 'Expected invalid plan priority'; exception when check_violation then null; end;
  begin update plans set end_date=start_date-1 where id=plan; raise exception 'Expected reversed dates'; exception when check_violation then null; end;
  begin insert into execution_logs(task_id,actual_minutes) values(task,-1); raise exception 'Expected negative actual minutes'; exception when check_violation then null; end;
  begin insert into execution_logs(task_id,started_at,ended_at) values(task,now(),now()-interval '1 minute'); raise exception 'Expected reversed times'; exception when check_violation then null; end;
  begin insert into execution_logs(task_id,kind) values(task,'other'); raise exception 'Expected invalid kind'; exception when check_violation then null; end;
  begin insert into execution_logs(kind) values('completion'); raise exception 'Expected invalid completion shape'; exception when check_violation then null; end;

  select count(*) into before_plans from plans;
  select count(*) into before_reviews from reviews;
  next_plan := create_next_plan(plan,'Break tasks into smaller steps');
  assert (next_plan->>'id')::uuid <> plan and next_plan->>'description'='Break tasks into smaller steps', 'Carryforward description and identity';
  assert next_plan->>'title'='Revision two' and next_plan->>'estimated_minutes'='60', 'Carryforward source fields';
  assert (select count(*)=before_plans+1 from plans), 'One new plan';
  assert (select count(*)=before_reviews+1 from reviews), 'One new review';
  assert exists(select 1 from reviews where plan_id=plan and improvement='Break tasks into smaller steps'), 'Review source and improvement';
  begin
    perform create_next_plan('ffffffff-ffff-4fff-8fff-ffffffffffff','Missing');
    raise exception 'Expected missing source rejection';
  exception when no_data_found then null; end;
  assert (select count(*)=before_reviews+1 from reviews), 'Missing source creates no review';

  exported := export_data();
  assert exported->>'version'='1' and exported->>'exported_at' is not null, 'Export metadata';
  foreach field in array array['plans','plan_versions','tasks','execution_logs','reviews'] loop
    execute format('select count(*) from public.%I',field) into row_count;
    assert jsonb_typeof(exported->field)='array'
      and jsonb_array_length(exported->field)=row_count, 'Complete export array ' || field;
  end loop;
end $$;

reset role;
create function pg_temp.reject_new_plan() returns trigger language plpgsql
as $$ begin raise exception 'Injected plan failure' using errcode='23514'; end $$;
create trigger reject_test_plan before insert on plans for each row
when (new.description='Injected failure') execute function pg_temp.reject_new_plan();
do $$ declare n bigint; begin
  select count(*) into n from reviews;
  begin
    perform create_next_plan('06000000-0000-4000-8000-000000000001','Injected failure');
    raise exception 'Expected injected failure';
  exception when check_violation then null; end;
  assert (select count(*)=n from reviews), 'Failed next-plan insert rolls back preceding review';
end $$;

do $$ begin
  assert (select count(*)=5 from pg_class where relnamespace='public'::regnamespace and relname in ('plans','plan_versions','tasks','execution_logs','reviews') and relrowsecurity), 'All tables use RLS';
  assert not exists(select 1 from pg_proc where pronamespace='public'::regnamespace and proname in ('export_data','create_next_plan','snapshot_plan_before_update','record_task_completion') and prosecdef), 'Functions are security invoker';
  assert not has_function_privilege('anon','public.export_data()','EXECUTE'), 'Anon export denied';
  assert not has_function_privilege('authenticated','public.export_data()','EXECUTE'), 'Authenticated export denied';
  assert not has_function_privilege('anon','public.create_next_plan(uuid,text)','EXECUTE'), 'Anon carryforward denied';
  assert not has_function_privilege('authenticated','public.create_next_plan(uuid,text)','EXECUTE'), 'Authenticated carryforward denied';
  assert has_function_privilege('service_role','public.export_data()','EXECUTE'), 'Service export permitted';
  assert has_function_privilege('service_role','public.create_next_plan(uuid,text)','EXECUTE'), 'Service carryforward permitted';
end $$;
set local role anon;
do $$ begin
  assert (select count(*)=0 from plans), 'Anon cannot read plans';
  assert (select count(*)=0 from tasks), 'Anon cannot read tasks';
  begin perform export_data(); raise exception 'Expected export denied'; exception when insufficient_privilege then null; end;
end $$;
reset role;
truncate plans, plan_versions, tasks, execution_logs, reviews;
do $$ declare payload jsonb; field text; begin
  payload := export_data();
  foreach field in array array['plans','plan_versions','tasks','execution_logs','reviews'] loop
    assert payload->field='[]'::jsonb, 'Empty export array ' || field;
  end loop;
end $$;
rollback;
