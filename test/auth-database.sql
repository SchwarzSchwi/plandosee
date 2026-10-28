\set ON_ERROR_STOP on
create function public.test_reject(statement text, expected text) returns void
language plpgsql as $$
begin
  begin
    execute statement;
  exception when others then
    if sqlstate = expected then return; end if;
    raise;
  end;
  raise exception 'Expected rejection %: %',expected,statement;
end;
$$;
set role service_role;
insert into auth_accounts(id,email,password_hash) values
 ('10000000-0000-4000-8000-000000000001','a@example.com','scrypt$32768$8$3$'||repeat('0',32)||'$'||repeat('1',128)),
 ('10000000-0000-4000-8000-000000000002','b@example.com','scrypt$32768$8$3$'||repeat('0',32)||'$'||repeat('1',128));
select auth_signup('a@example.com','scrypt$32768$8$3$'||repeat('0',32)||'$'||repeat('3',128));
select test_reject($q$select auth_signup(' A@example.com ','scrypt$32768$8$3$'||repeat('0',32)||'$'||repeat('1',128))$q$,'23514');
select auth_issue_session('10000000-0000-4000-8000-000000000001',
 'scrypt$32768$8$3$'||repeat('0',32)||'$'||repeat('1',128),repeat('a',64));
select auth_issue_session('10000000-0000-4000-8000-000000000001',
 'scrypt$32768$8$3$'||repeat('0',32)||'$'||repeat('1',128),repeat('b',64));
select auth_issue_session('10000000-0000-4000-8000-000000000002',
 'scrypt$32768$8$3$'||repeat('0',32)||'$'||repeat('1',128),repeat('c',64));
insert into auth_sessions(token_hash,user_id,expires_at) values
 (repeat('d',64),'10000000-0000-4000-8000-000000000001',now()-interval '1 second');
insert into plans(id,title,owner_id) values
 ('20000000-0000-4000-8000-000000000001','A plan','10000000-0000-4000-8000-000000000001'),
 ('20000000-0000-4000-8000-000000000002','B plan','10000000-0000-4000-8000-000000000002');

do $$
declare result jsonb; task uuid; n int; old_hash text; payload jsonb;
begin
  assert (select count(*)=2 from auth_accounts), 'Duplicate signup generic no-op';
  assert (select password_hash like '%'||repeat('1',128) from auth_accounts where email='a@example.com'), 'Duplicate cannot replace hash';
  assert (select expires_at between now()+interval '7 hours 59 minutes' and now()+interval '8 hours 1 minute' from auth_sessions where token_hash=repeat('a',64)), 'Eight hour lifetime';
  result := authorized_request(repeat('a',64),'session');
  assert result=jsonb_build_object('id','10000000-0000-4000-8000-000000000001','email','a@example.com'), 'No auth rows in session response';
  perform test_reject($q$select authorized_request(repeat('d',64),'read','plans')$q$,'28000');
  perform test_reject($q$select authorized_request(repeat('0',64),'read','plans')$q$,'28000');
  result := authorized_request(repeat('a',64),'read','plans');
  assert jsonb_array_length(result)=1 and result->0->>'title'='A plan', 'Owner list excludes B and legacy';
  result := authorized_request(repeat('a',64),'read','plans','20000000-0000-4000-8000-000000000001');
  assert result->>'title'='A plan', 'GET id selects exact row';
  perform test_reject($q$select authorized_request(repeat('a',64),'read','plans','20000000-0000-4000-8000-000000000002')$q$,'P0002');
  perform test_reject($q$select authorized_request(repeat('a',64),'read','plans','70000000-0000-4000-8000-000000000001')$q$,'P0002');
  perform test_reject($q$select authorized_request(repeat('a',64),'update','plans','20000000-0000-4000-8000-000000000002','{"title":"stolen"}')$q$,'P0002');
  perform test_reject($q$select authorized_request(repeat('a',64),'create','tasks',null,'{"title":"foreign","plan_id":"20000000-0000-4000-8000-000000000002"}')$q$,'P0002');
  perform test_reject($q$select authorized_request(repeat('a',64),'create','plans',null,'{"title":"bad","owner_id":"10000000-0000-4000-8000-000000000002"}')$q$,'22023');
  perform test_reject($q$select authorized_request(repeat('a',64),'create','plans',null,'{"title":"bad","user_id":"10000000-0000-4000-8000-000000000002"}')$q$,'22023');
  perform test_reject($q$select authorized_request(repeat('a',64),'create','plans',null,'{"title":"bad","created_at":"2000-01-01"}')$q$,'22023');
  perform test_reject($q$select authorized_request(repeat('a',64),'read','auth_accounts')$q$,'22023');
  perform test_reject($q$select authorized_request(repeat('a',64),'read','plans;drop table auth_accounts')$q$,'22023');
  perform test_reject($q$insert into tasks(plan_id,title,owner_id) values('20000000-0000-4000-8000-000000000002','bad','10000000-0000-4000-8000-000000000001')$q$,'23503');
  perform test_reject($q$insert into tasks(plan_id,title) values('20000000-0000-4000-8000-000000000001','null owner child')$q$,'23503');
  perform test_reject($q$insert into tasks(plan_id,title,owner_id) values('70000000-0000-4000-8000-000000000001','owned legacy child','10000000-0000-4000-8000-000000000001')$q$,'23503');
  perform test_reject($q$insert into tasks(title,owner_id) values('missing parent','10000000-0000-4000-8000-000000000001')$q$,'23514');
  result := authorized_request(repeat('a',64),'create','tasks',null,
    '{"title":"A task","plan_id":"20000000-0000-4000-8000-000000000001","status":"done"}');
  task := (result->>'id')::uuid;
  assert result->>'owner_id'='10000000-0000-4000-8000-000000000001', 'Server assigned owner';
  perform authorized_request(repeat('a',64),'update','tasks',task,'{"status":"done"}');
  perform authorized_request(repeat('a',64),'update','tasks',task,'{"status":"progress"}');
  perform authorized_request(repeat('a',64),'update','tasks',task,'{"status":"done"}');
  assert (select count(*)=1 from execution_logs where task_id=task and kind='completion'), 'Unique completion maintained';
  assert (select owner_id='10000000-0000-4000-8000-000000000001' from execution_logs where task_id=task), 'Trigger propagates owner';
  perform test_reject(format($q$select authorized_request(repeat('c',64),'delete','tasks',%L)$q$,task),'P0002');
  perform test_reject(format($q$select authorized_request(repeat('c',64),'create','execution_logs',null,'{"task_id":"%s","started_at":"2026-01-01T00:00:00Z","ended_at":"2026-01-01T00:10:00Z","actual_minutes":10}')$q$,task),'P0002');
  perform authorized_request(repeat('a',64),'update','plans','20000000-0000-4000-8000-000000000001','{"title":"A edited"}');
  assert exists(select 1 from plan_versions where owner_id='10000000-0000-4000-8000-000000000001' and snapshot->>'title'='A plan'), 'Atomic owned snapshot';
  select count(*) into n from plan_versions;
  perform test_reject($q$select authorized_request(repeat('a',64),'update','plans','20000000-0000-4000-8000-000000000001','{"estimated_minutes":-1}')$q$,'23514');
  assert (select count(*)=n from plan_versions), 'Rejected edit rolls back snapshot';
  result := authorized_request(repeat('a',64),'carry-forward',null,null,
    '{"plan_id":"20000000-0000-4000-8000-000000000001","improvement":"smaller tasks"}');
  assert result->>'owner_id'='10000000-0000-4000-8000-000000000001' and result->>'description'='smaller tasks', 'Owned carry-forward';
  assert exists(select 1 from reviews where owner_id='10000000-0000-4000-8000-000000000001'), 'Review owner';
  select count(*) into n from reviews;
  perform test_reject($q$select authorized_request(repeat('a',64),'carry-forward',null,null,'{"plan_id":"20000000-0000-4000-8000-000000000002","improvement":"foreign"}')$q$,'P0002');
  assert (select count(*)=n from reviews), 'Foreign carry-forward leaves no review';
  result := authorized_request(repeat('a',64),'export');
  assert jsonb_array_length(result->'plans')=2, 'Export owned plans only';
  assert jsonb_array_length(result->'plan_versions')=1, 'Export owned history only';
  assert jsonb_array_length(result->'tasks')=1, 'Export excludes legacy';
  assert result::text not like '%password_hash%' and result::text not like '%token_hash%', 'Export never auth data';
  perform authorized_request(repeat('a',64),'delete','tasks',task);
  perform test_reject(format($q$select authorized_request(repeat('a',64),'read','tasks',%L)$q$,task),'P0002');
  perform test_reject(format($q$select authorized_request(repeat('a',64),'delete','tasks',%L)$q$,task),'P0002');
  perform test_reject(format($q$select authorized_request(repeat('a',64),'update','tasks',%L,'{"status":"done"}')$q$,task),'P0002');
  select password_hash into old_hash from auth_accounts where id='10000000-0000-4000-8000-000000000001';
  perform test_reject($q$select authorized_request(repeat('a',64),'password',null,null,'{}','wrong','bad')$q$,'28000');
  perform test_reject(format($q$select authorized_request(repeat('a',64),'password',null,null,'{}',%L,'bad')$q$,old_hash),'23514');
  assert exists(select 1 from auth_sessions where token_hash=repeat('a',64)), 'Failed password replacement cannot revoke';
  assert (select password_hash=old_hash from auth_accounts where id='10000000-0000-4000-8000-000000000001'), 'Failed replacement preserves hash';
end;
$$;
do $$
declare study_a uuid; study_b uuid; result jsonb;
begin
  if to_regclass('public.studies') is not null then
    result := observation_request(repeat('a',64),'create-study','{"initial_rule":"ten minutes daily"}');
    study_a := (result->>'id')::uuid;
    result := observation_request(repeat('c',64),'create-study','{"initial_rule":"another private study"}');
    study_b := (result->>'id')::uuid;
    perform test_reject(format($q$select observation_request(repeat('a',64),'observe','{"study_id":"%s","actual_minutes":10}')$q$,study_b),'P0002');
    perform test_reject(format($q$select observation_request(repeat('a',64),'observe','{"study_id":"%s","actual_minutes":10,"observed_date":"2020-01-01"}')$q$,study_a),'22023');
    perform test_reject(format($q$select observation_request(repeat('a',64),'observe','{"study_id":"%s","actual_minutes":10,"owner_id":"10000000-0000-4000-8000-000000000002"}')$q$,study_a),'22023');
    result := observation_request(repeat('a',64),'observe',jsonb_build_object('study_id',study_a,'actual_minutes',10));
    assert result->>'day_number'='1' and result->>'observed_date'=((clock_timestamp() at time zone 'Asia/Seoul')::date)::text, 'Observation time assigned by database';
    perform test_reject(format($q$select observation_request(repeat('a',64),'observe','{"study_id":"%s","actual_minutes":10}')$q$,study_a),'23505');
    result := observation_request(repeat('a',64),'study');
    assert jsonb_array_length(result->'studies')=1 and jsonb_array_length(result->'observations')=1, 'Observation read is owner scoped';
    result := authorized_request(repeat('a',64),'export');
    assert jsonb_array_length(result->'studies')=1 and jsonb_array_length(result->'observations')=1, 'Atomic export includes only owned observation data';
    assert result->'rule_changes'='[]'::jsonb, 'Export includes rule change collection';
  end if;
end;
$$;
reset role;

-- Direct REST/database roles cannot access service-only accounts or RPCs.
set role anon;
select test_reject('select * from auth_accounts','42501');
select test_reject('select * from auth_sessions','42501');
select test_reject('select * from plans','42501');
select test_reject($q$select authorized_request(repeat('a',64),'session')$q$,'42501');
select test_reject($q$select auth_signup('x@example.com','bad')$q$,'42501');
reset role;
-- Even an accidental table SELECT grant is still fenced by RLS; NULL legacy
-- rows are invisible with no subject and with a real owner's subject.
grant select on plans,auth_accounts,auth_sessions to anon,authenticated;
set role anon;
do $$ begin
  assert (select count(*)=0 from plans), 'Anon RLS';
  assert (select count(*)=0 from auth_accounts), 'No account RLS policy';
  assert (select count(*)=0 from auth_sessions), 'No session RLS policy';
end $$;
reset role;
set role authenticated;
set request.jwt.claim.sub='10000000-0000-4000-8000-000000000002';
do $$ begin
  assert (select count(*)=1 from plans), 'Authenticated owner RLS';
  assert (select count(*)=0 from auth_accounts), 'Auth rows service only despite subject';
end $$;
reset role;
revoke select on plans,auth_accounts,auth_sessions from anon,authenticated;
reset request.jwt.claim.sub;
