import test from 'node:test';
import assert from 'node:assert/strict';
import { queryTodos, seoulDate, summarize } from '../public/model.js';

const todo = (id, values = {}) => ({
  id, plan_id: 'p', title: id, estimated_minutes: 10, status: 'progress', priority: 'medium', ...values,
});

test('C30: Seoul midnight, not browser/UTC date, determines overdue', () => {
  assert.equal(seoulDate(new Date('2026-10-26T14:59:59Z')), '2026-10-26');
  const today = seoulDate(new Date('2026-10-26T15:00:00Z'));
  assert.equal(today, '2026-10-27');
  const result = summarize([
    todo('late', { due_date: '2026-10-26' }),
    todo('today', { due_date: today }),
    todo('done', { due_date: '2026-10-25', status: 'done' }),
    todo('no-date'),
    todo('deleted', { due_date: '2026-10-25', deleted_at: '2026-10-26' }),
  ], [], 'p', today);
  assert.deepEqual(result.overdue.map(item => item.id), ['late']);
  assert.equal(result.completed.length, 1);
  assert.equal(result.planned.length, 4);
});

test('C28–C32: scope, unique blockers, sums, zero defaults, and completion event exclusion', () => {
  const result = summarize([
    todo('a'), todo('b', { estimated_minutes: null, status: 'done' }),
    todo('deleted', { deleted_at: '2026-10-26' }), todo('other', { plan_id: 'other' }),
  ], [
    { task_id: 'a', actual_minutes: 12, blocker: '막힘', kind: 'work' },
    { task_id: 'a', actual_minutes: 3, blocker: '다른 막힘' },
    { task_id: 'b', actual_minutes: null, blocker: '  ' },
    { task_id: 'b', actual_minutes: 0, kind: 'completion' },
    { task_id: 'deleted', actual_minutes: 999, blocker: '삭제' },
    { task_id: 'other', actual_minutes: 999 },
  ], 'p', '2026-10-27');
  assert.equal(result.planned.length, 2);
  assert.equal(result.completed.length, 1);
  assert.equal(result.blocked.length, 1);
  assert.equal(result.expected, 10);
  assert.equal(result.actual, 15);
  assert.equal(result.difference, 5);
  const empty = summarize([], [], 'p');
  assert.equal(empty.expected, 0);
  assert.equal(empty.actual, 0);
  assert.equal(empty.difference, 0);
});

test('C22: applying done twice increases the current completion count only once; reopening decreases it', () => {
  const todos = [todo('existing', { status: 'done' }), todo('target')];
  const before = summarize(todos, [], 'p').completed.length;
  for (let request = 0; request < 2; request++) todos[1].status = 'done';
  const event = { task_id: 'target', kind: 'completion', actual_minutes: 0 };
  assert.equal(summarize(todos, [event], 'p').completed.length, before + 1);
  todos[1].status = 'progress';
  assert.equal(summarize(todos, [event], 'p').completed.length, before);
});

test('C18–C20: search and filters compose with stable documented ordering without mutation', () => {
  const todos = [
    todo('z', { title: 'alpha', tags: ['찾기'], due_date: '2026-10-26', priority: 'low' }),
    todo('a', { title: 'beta', description: '찾기', due_date: '2026-10-26', priority: 'high' }),
    todo('b', { title: '찾기', status: 'done', due_date: '2026-10-25' }),
    todo('c', { title: '찾기' }), todo('d', { title: 'else' }),
  ];
  assert.deepEqual(queryTodos(todos, { planId: 'p', search: '찾기', filter: 'overdue', today: '2026-10-27' })
    .map(item => item.id), ['a', 'z']);
  assert.deepEqual(queryTodos(todos, { planId: 'p', search: '찾기', filter: 'progress' })
    .map(item => item.id), ['a', 'z', 'c']);
  assert.equal(todos[0].id, 'z');
});
