-- SYNTHETIC DEMONSTRATION ONLY: these examples are not the user's actual activity.
begin;

insert into public.plans
  (id, title, start_date, end_date, priority, success_criteria, estimated_minutes, description)
values (
  '06000000-0000-4000-8000-000000000001',
  '[Synthetic demo] Practice a weekly planning cycle',
  current_date - 7, current_date + 7, 'medium',
  'Review the five fictional tasks and record a useful improvement.',
  180, 'Synthetic demonstration data, not a record of the user''s real work.'
)
on conflict do nothing;

insert into public.tasks
  (id, plan_id, title, description, due_date, priority, tags, estimated_minutes, status)
values
  ('06000000-0000-4000-8000-000000000011', '06000000-0000-4000-8000-000000000001',
   '[Demo] Draft the checklist', 'Fictional completed task.', current_date - 3,
   'high', array['demo', 'planning'], 30, 'done'),
  ('06000000-0000-4000-8000-000000000012', '06000000-0000-4000-8000-000000000001',
   '[Demo] Review the outline', 'Fictional overdue task.', current_date - 2,
   'high', array['demo', 'review'], 45, 'progress'),
  ('06000000-0000-4000-8000-000000000013', '06000000-0000-4000-8000-000000000001',
   '[Demo] Collect sample feedback', 'Fictional task blocked on sample feedback.',
   current_date + 1, 'medium', array['demo', 'blocked'], 30, 'progress'),
  ('06000000-0000-4000-8000-000000000014', '06000000-0000-4000-8000-000000000001',
   '[Demo] Prepare the next draft', 'Fictional upcoming task.', current_date + 3,
   'medium', array['demo'], 60, 'progress'),
  ('06000000-0000-4000-8000-000000000015', '06000000-0000-4000-8000-000000000001',
   '[Demo] Reflect on the practice week', 'Fictional review task.', current_date + 7,
   'low', array['demo', 'review'], 15, 'progress')
on conflict do nothing;

insert into public.execution_logs
  (id, task_id, kind, started_at, ended_at, actual_minutes, blocker)
values
  ('06000000-0000-4000-8000-000000000021', '06000000-0000-4000-8000-000000000011',
   'work', current_date - interval '3 days' + interval '9 hours',
   current_date - interval '3 days' + interval '9 hours 25 minutes', 25, ''),
  ('06000000-0000-4000-8000-000000000022', '06000000-0000-4000-8000-000000000012',
   'work', current_date - interval '2 days' + interval '10 hours',
   current_date - interval '2 days' + interval '10 hours 20 minutes', 20, ''),
  ('06000000-0000-4000-8000-000000000023', '06000000-0000-4000-8000-000000000013',
   'work', current_date - interval '1 day' + interval '14 hours',
   current_date - interval '1 day' + interval '14 hours 15 minutes', 15,
   'Synthetic blocker: waiting for fictional sample feedback.')
on conflict do nothing;

commit;
