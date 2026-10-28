-- SYNTHETIC timing fixtures only. No simulated date is user activity.
-- Every fixture and trigger change is isolated in this rolled-back transaction.
\set ON_ERROR_STOP on
begin;
do $$
declare uid uuid; other_uid uuid; plan uuid; task uuid; source jsonb;
  study uuid; first_day uuid; second_day uuid; changed uuid;
  today date := (clock_timestamp() at time zone 'Asia/Seoul')::date;
begin
  select id into uid from auth_accounts order by created_at limit 1;
  assert uid is not null, 'Real HTTP signup account exists';
  assert not has_table_privilege('anon','auth_accounts','select'), 'Anon cannot read hashes';
  assert not has_table_privilege('authenticated','auth_sessions','select'), 'Browser cannot read sessions';
  assert not has_function_privilege('anon','authorized_request(text,text,text,uuid,jsonb,text,text)','execute'),
    'Anon cannot invoke authorization RPC';
  select id into other_uid from auth_accounts where id<>uid limit 1;
  insert into plans(owner_id,title,estimated_minutes)
    values(uid,'Synthetic invariant plan',30) returning id,to_jsonb(plans.*) into plan,source;
  begin
    insert into tasks(owner_id,plan_id,title) values(other_uid,plan,'Synthetic mixed owner');
    raise exception 'Expected database mixed owner rejection';
  exception when foreign_key_violation then null; end;
  begin
    insert into tasks(plan_id,title) values(plan,'Synthetic null owner');
    raise exception 'Expected database null owner mismatch rejection';
  exception when foreign_key_violation then null; end;
  insert into tasks(owner_id,plan_id,title,status)
    values(uid,plan,'Synthetic invariant task','done') returning id into task;
  update tasks set status='progress' where id=task;
  update tasks set status='done' where id=task;
  assert (select count(*)=1 from execution_logs where task_id=task and kind='completion'),
    'T06 repeated completion stays unique';
  update plans set title='Synthetic revision' where id=plan;
  assert (select snapshot=source from plan_versions where plan_id=plan), 'T06 exact old snapshot';
  begin
    update plans set estimated_minutes=-1 where id=plan;
    raise exception 'Expected negative estimate rejection';
  exception when check_violation then null; end;
  assert (select count(*)=1 from plan_versions where plan_id=plan), 'T06 rejected update leaves no history';
  begin
    insert into execution_logs(owner_id,task_id,actual_minutes) values(uid,task,-1);
    raise exception 'Expected negative work minutes rejection';
  exception when check_violation then null; end;
  insert into studies(owner_id,initial_rule,created_date)
    values(uid,'Synthetic initial rule',today-4) returning id into study;
  begin
    insert into rule_changes(owner_id,study_id,day1_id,day2_id,rule,reason)
      values(uid,study,gen_random_uuid(),gen_random_uuid(),'Synthetic changed rule','Synthetic reason');
    raise exception 'Expected premature rule rejection';
  exception when invalid_parameter_value then null; end;
  insert into observations(owner_id,study_id,actual_minutes)
    values(uid,study,15) returning id into first_day;
  begin
    insert into observations(owner_id,study_id,actual_minutes) values(uid,study,16);
    raise exception 'Expected same actual date rejection';
  exception when unique_violation then null; end;
  -- Move already validated synthetic rows backward, not the database clock.
  alter table observations disable trigger observations_immutable;
  update observations set observed_date=today-2,created_at=clock_timestamp()-interval '2 days'
    where id=first_day;
  alter table observations enable trigger observations_immutable;
  insert into observations(owner_id,study_id,actual_minutes)
    values(uid,study,20) returning id into second_day;
  alter table observations disable trigger observations_immutable;
  update observations set observed_date=today-1,created_at=clock_timestamp()-interval '1 day'
    where id=second_day;
  alter table observations enable trigger observations_immutable;
  begin
    insert into observations(owner_id,study_id,actual_minutes) values(uid,study,25);
    raise exception 'Expected day three without rule rejection';
  exception when invalid_parameter_value then null; end;
  begin
    insert into rule_changes(owner_id,study_id,day1_id,day2_id,rule,reason)
      values(uid,study,first_day,second_day,'Synthetic initial rule','Synthetic reason');
    raise exception 'Expected unchanged rule rejection';
  exception when invalid_parameter_value then null; end;
  insert into rule_changes(owner_id,study_id,day1_id,day2_id,rule,reason)
    values(uid,study,first_day,second_day,'Synthetic changed rule','Synthetic reason')
    returning id into changed;
  insert into observations(owner_id,study_id,actual_minutes) values(uid,study,25);
  assert (select count(*)=3 from observations where study_id=study), 'Day three persisted';
  assert (select rule_change_id=changed from observations where study_id=study and day_number=3),
    'Day three references exact rule change';
  assert (select created_at <= (select created_at from observations where study_id=study and day_number=3)
    from rule_changes where id=changed), 'Rule precedes day three';
  assert (select bool_and(rule_change_id is null) from observations where study_id=study and day_number<=2),
    'Baseline days do not reference changed rule';
  begin
    update observations set actual_minutes=999 where id=first_day;
    raise exception 'Expected immutable evidence rejection';
  exception when invalid_parameter_value then null; end;
end $$;
rollback;
