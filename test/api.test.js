import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler, validatePayload } from '../server/handler.js';

const id = '11111111-1111-4111-8111-111111111111';
async function call(db, req) {
  const response = {
    statusCode: 200, headers: {},
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await createHandler(() => db)({ query: {}, ...req }, response);
  return response;
}

test('C04–C07, C14–C17: reject invalid dates, fields, states and units', () => {
  for (const payload of [
    { title: '' }, { title: 'x', estimated_minutes: -1 }, { title: 'x', estimated_minutes: '10' },
    { title: 'x', estimated_minutes: 1.5 }, { title: 'x', priority: 'urgent' },
    { title: 'x', start_date: '2026-02-30' },
    { title: 'x', start_date: '2026-10-27', end_date: '2026-10-26' },
    { title: 'x', snapshot: {} },
  ]) assert.throws(() => validatePayload('plans', payload, true));
  assert.throws(() => validatePayload('tasks', { title: 'x', plan_id: id, tags: '<script>' }, true));
  assert.throws(() => validatePayload('tasks', { status: 'toggle' }, false));
  assert.deepEqual(validatePayload('tasks', { status: 'done' }, false), { status: 'done' });
});

test('C23–C27: derive actual minutes without accepting or modifying plan values', () => {
  const payload = {
    task_id: id, started_at: '2026-10-27T09:00:00+09:00',
    ended_at: '2026-10-27T09:12:30+09:00', blocker: '<script>alert(1)</script>',
  };
  const result = validatePayload('execution_logs', payload, true);
  assert.equal(result.actual_minutes, 13);
  assert.equal(result.blocker, payload.blocker);
  assert.equal(payload.actual_minutes, undefined);
  assert.throws(() => validatePayload('execution_logs', { ...payload, estimated_minutes: 100 }, true));
  assert.throws(() => validatePayload('execution_logs', { ...payload, actual_minutes: 100 }, true));
  assert.throws(() => validatePayload('execution_logs', { ...payload, ended_at: '2026-10-27T08:00:00+09:00' }, true));
  assert.throws(() => validatePayload('execution_logs', { ...payload, started_at: '2026-10-27T09:00' }, true));
});

test('C21: repeated status requests write explicit desired state, not read-then-toggle or log inserts', async () => {
  const writes = [];
  const db = { from(table) {
    assert.equal(table, 'tasks');
    return {
      update(payload) {
        writes.push(payload);
        return {
          eq(key, value) {
            assert.equal(key, 'id'); assert.equal(value, id);
            return { is(key, value) {
              assert.equal(key, 'deleted_at'); assert.equal(value, null);
              return { select: () => ({ single: async () => ({ data: { id, ...payload } }) }) };
            } };
          },
        };
      },
    };
  } };
  const requests = await Promise.all([1, 2].map(() => call(db, {
    method: 'PATCH', query: { table: 'tasks', id }, body: { status: 'done' },
  })));
  assert.deepEqual(writes, [{ status: 'done' }, { status: 'done' }]);
  assert.ok(requests.every(response => response.statusCode === 200));
});

test('C08: plan updates rely on transactional DB snapshots, not a separate history insert', async () => {
  let updates = 0;
  const db = { from(table) {
    assert.equal(table, 'plans');
    return { update: () => { updates++; return { eq: () => ({ select: () => ({
      single: async () => ({ data: { id, title: 'new' } }),
    }) }) }; } };
  } };
  assert.equal((await call(db, { method: 'PATCH', query: { table: 'plans', id }, body: { title: 'new' } })).statusCode, 200);
  assert.equal(updates, 1);
});

test('C33, C36: use atomic carry-forward and consistent all-entity export RPCs', async () => {
  const calls = [];
  const db = { rpc: async (name, args) => { calls.push([name, args]); return { data: { version: 1 } }; } };
  const exported = await call(db, { method: 'GET', query: { action: 'export' } });
  assert.equal(exported.body.version, 1);
  assert.equal(exported.headers['Cache-Control'], 'no-store');
  await call(db, { method: 'POST', query: { action: 'carry-forward' }, body: { plan_id: id, improvement: '작게 나누기' } });
  assert.deepEqual(calls, [
    ['export_data', undefined], ['create_next_plan', { p_plan_id: id, p_improvement: '작게 나누기' }],
  ]);
});

test('C58: configuration and database errors do not expose credentials', async () => {
  assert.equal((await call(null, { method: 'GET' })).statusCode, 503);
  const response = await call({ rpc: async () => ({ error: { code: 'XX000', message: 'sensitive internal details' } }) },
    { method: 'GET', query: { action: 'export' } });
  assert.equal(response.statusCode, 500);
  assert.ok(!JSON.stringify(response.body).includes('sensitive'));
  const unexpected = await call({ rpc: async () => { throw Error('sensitive network details'); } },
    { method: 'GET', query: { action: 'export' } });
  assert.equal(unexpected.statusCode, 500);
  assert.ok(!JSON.stringify(unexpected.body).includes('sensitive'));
});

test('reject malformed JSON, unknown routes, oversized input and history writes', async () => {
  const db = {};
  assert.equal((await call(db, { method: 'POST', query: { table: 'plans' }, body: '{' })).statusCode, 400);
  assert.equal((await call(db, { method: 'POST', query: { table: 'plans' }, body: { title: 'a'.repeat(13000) } })).statusCode, 400);
  assert.equal((await call(db, { method: 'GET', query: { table: 'secret' } })).statusCode, 400);
  assert.equal((await call(db, { method: 'POST', query: { table: 'plan_versions' }, body: {} })).statusCode, 405);
});
