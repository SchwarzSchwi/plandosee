import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createHandler, validatePayload } from '../server/handler.js';
import {
  hashPassword, verifyPassword, newSession, tokenHash, readSession,
  sessionCookie, validPassword, normalizeEmail,
} from '../server/auth.js';

const id = '11111111-1111-4111-8111-111111111111';
const session = newSession();
const env = { APP_ORIGIN: 'https://planner.example', NODE_ENV: 'production' };
const password = randomBytes(24).toString('base64url');
const wrongPassword = randomBytes(24).toString('base64url');
const replacementPassword = randomBytes(24).toString('base64url');
async function call(db, req, options = env) {
  const response = {
    statusCode: 200, headers: {},
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await createHandler(() => db, options)({
    query: {}, ...req,
    headers: { origin: env.APP_ORIGIN, cookie: `pds_session=${session.token}`, ...req.headers },
  }, response);
  return response;
}
const rpcDatabase = fn => ({ rpc: async (name, args) => {
  assert.equal(name, 'authorized_request');
  assert.equal(args.p_token_hash, session.hash);
  return fn(args);
} });

test('T06 validation: dates, fields, states, units and immutable input', () => {
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
  const payload = {
    task_id: id, started_at: '2026-10-27T09:00:00+09:00',
    ended_at: '2026-10-27T09:12:30+09:00', blocker: '<script>alert(1)</script>',
  };
  assert.equal(validatePayload('execution_logs', payload, true).actual_minutes, 13);
  assert.equal(payload.actual_minutes, undefined);
  for (const extra of [{ estimated_minutes: 100 }, { actual_minutes: 100 },
    { ended_at: '2026-10-27T08:00:00+09:00' }, { started_at: '2026-10-27T09:00' }]) {
    assert.throws(() => validatePayload('execution_logs', { ...payload, ...extra }, true));
  }
});

test('platform scrypt uses random salts and constant-time verification; credentials and tokens are bounded', async () => {
  const a = await hashPassword(password);
  const b = await hashPassword(password);
  assert.match(a, /^scrypt\$32768\$8\$3\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
  assert.ok(a !== b);
  assert.equal(await verifyPassword(password, a), true);
  assert.equal(await verifyPassword(wrongPassword, a), false);
  assert.equal(await verifyPassword(password, null), false);
  assert.equal(await verifyPassword(password, 'malformed'), false);
  const boundaryPassword = randomBytes(100).toString('base64url');
  assert.equal(validPassword(boundaryPassword.slice(0, 12)), true);
  assert.equal(validPassword(boundaryPassword.slice(0, 128)), true);
  for (const value of ['', boundaryPassword.slice(0, 11), boundaryPassword.slice(0, 129), null, 123]) assert.equal(validPassword(value), false);
  assert.equal(normalizeEmail(' USER@Example.Com '), 'user@example.com');
  for (const value of ['x', 'a @b.com', 'a@b', null]) assert.equal(normalizeEmail(value), null);
  assert.notEqual(newSession().token, session.token);
  assert.equal(session.hash, tokenHash(session.token));
  assert.equal(session.hash.length, 64);
});

test('opaque cookie is HttpOnly, SameSite Strict, eight hours and production Secure', () => {
  const cookie = sessionCookie(session.token, true, Date.UTC(2026, 0, 1));
  assert.match(cookie, /HttpOnly; SameSite=Strict; Max-Age=28800; Expires=Thu, 01 Jan 2026 08:00:00 GMT; Secure$/);
  assert.ok(!sessionCookie(session.token, false).includes('Secure'));
  assert.match(sessionCookie(null, true), /Max-Age=0; Expires=Thu, 01 Jan 1970/);
  assert.equal(readSession({ headers: { cookie: `other=1; pds_session=${session.token}` } }), session.hash);
  for (const cookie of ['pds_session=forged', `pds_session=${session.token}; pds_session=${session.token}`]) {
    assert.equal(readSession({ headers: { cookie } }), null);
  }
});

test('all unauthenticated CRUD/export/carry-forward fail without touching DB', async () => {
  for (const request of [
    { method: 'GET', query: { table: 'plans' } },
    { method: 'GET', query: { action: 'export' } },
    { method: 'PATCH', query: { table: 'tasks', id }, body: { status: 'done' } },
    { method: 'POST', query: { action: 'carry-forward' }, body: { plan_id: id, improvement: 'x' } },
  ]) {
    const response = await call({}, { ...request, headers: { cookie: '' } });
    assert.equal(response.statusCode, 401);
  }
  assert.deepEqual((await call({}, { method: 'GET', query: { action: 'session' }, headers: { cookie: '' } })).body,
    { authenticated: false });
  const expired = rpcDatabase(() => ({ error: { code: '28000' } }));
  assert.deepEqual((await call(expired, { method: 'GET', query: { action: 'session' } })).body,
    { authenticated: false });
});

test('CSRF exact configured origin on every mutation, fail closed even in production', async () => {
  for (const action of ['signup', 'login', 'logout', 'password', 'delete-account', 'carry-forward']) {
    for (const origin of [undefined, 'null', 'https://evil.example', 'https://planner.example.evil',
      'https://planner.example/']) {
      assert.equal((await call({}, { method: 'POST', query: { action }, headers: { origin } })).statusCode, 403);
    }
  }
  assert.equal((await call({}, { method: 'PATCH' }, { NODE_ENV: 'production' })).statusCode, 403);
  assert.equal((await call({}, { method: 'POST' }, { ...env, APP_ORIGIN: 'http://localhost:3000' })).statusCode, 403);
  const local = { APP_ORIGIN: 'http://localhost:3000', NODE_ENV: 'development' };
  assert.equal((await call({}, { method: 'POST', headers: { origin: local.APP_ORIGIN, cookie: '' } }, local)).statusCode, 401);
});

test('signup normalization, duplicate response and service-only salted hash', async () => {
  const calls = [];
  const db = { rpc: async (name, args) => { calls.push([name, args]); return { data: null }; } };
  const req = { method: 'POST', query: { action: 'signup' }, body: { email: ' USER@Example.Com ', password } };
  const first = await call(db, req);
  const second = await call(db, req);
  assert.deepEqual(first.body, second.body);
  assert.equal(first.statusCode, 200);
  assert.equal(first.headers['Set-Cookie'], undefined);
  assert.equal(calls[0][0], 'auth_signup');
  assert.equal(calls[0][1].p_email, 'user@example.com');
  assert.ok(!JSON.stringify(calls).includes(password));
  assert.ok(calls[0][1].p_password_hash !== calls[1][1].p_password_hash);
});

test('login unknown/wrong account uniform, valid issues only SHA256 token and expected hash', async () => {
  const hash = await hashPassword(password);
  const makeDb = account => ({
    from(table) {
      assert.equal(table, 'auth_accounts');
      return { select(columns) {
        assert.equal(columns, 'id,email,password_hash');
        return { eq(key, value) {
          assert.equal(key, 'email'); assert.equal(value, 'user@example.com');
          return { maybeSingle: async () => ({ data: account }) };
        } };
      } };
    },
    rpc: async (name, args) => {
      assert.equal(name, 'auth_issue_session');
      assert.equal(args.p_user_id, id);
      assert.equal(args.p_expected_hash, hash);
      assert.match(args.p_token_hash, /^[0-9a-f]{64}$/);
      return { data: null };
    },
  });
  const request = { method: 'POST', query: { action: 'login' }, body: { email: 'USER@example.com', password: wrongPassword } };
  const unknown = await call(makeDb(null), request);
  const wrong = await call(makeDb({ id, email: 'user@example.com', password_hash: hash }), request);
  assert.equal(unknown.statusCode, 401);
  assert.deepEqual(unknown.body, wrong.body);
  const loggedIn = await call(makeDb({ id, email: 'user@example.com', password_hash: hash }),
    { ...request, body: { ...request.body, password } });
  assert.deepEqual(loggedIn.body, { authenticated: true, user: { id, email: 'user@example.com' } });
  assert.match(loggedIn.headers['Set-Cookie'], /pds_session=[A-Za-z0-9_-]{43};/);
  assert.ok(!JSON.stringify(loggedIn.body).includes('hash'));
});

test('authenticated session exposes only public user; logout revokes via transaction and clears cookie', async () => {
  const operations = [];
  const db = rpcDatabase(args => { operations.push(args.p_operation); return {
    data: args.p_operation === 'session' ? { id, email: 'user@example.com' } : { ok: true },
  }; });
  assert.deepEqual((await call(db, { method: 'GET', query: { action: 'session' } })).body,
    { authenticated: true, user: { id, email: 'user@example.com' } });
  const response = await call(db, { method: 'POST', query: { action: 'logout' }, body: {} });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers['Set-Cookie'], /Max-Age=0/);
  assert.deepEqual(operations, ['session', 'logout']);
});

test('password and deletion verify current password, then recheck expected hash atomically', async () => {
  const oldHash = await hashPassword(password);
  for (const action of ['password', 'delete-account']) {
    const calls = [];
    const db = rpcDatabase(args => {
      calls.push(args);
      return { data: args.p_operation === 'credentials' ? { password_hash: oldHash } : { ok: true } };
    });
    const body = action === 'password'
      ? { current_password: password, new_password: replacementPassword } : { current_password: password };
    const response = await call(db, { method: 'POST', query: { action }, body });
    assert.equal(response.statusCode, 200);
    assert.equal(calls[1].p_operation, action);
    assert.equal(calls[1].p_expected_hash, oldHash);
    if (action === 'password') assert.equal(await verifyPassword(replacementPassword, calls[1].p_new_hash), true);
    assert.match(response.headers['Set-Cookie'], /Max-Age=0/);
    calls.length = 0;
    assert.equal((await call(db, { method: 'POST', query: { action },
      body: { ...body, current_password: wrongPassword } })).statusCode, 401);
    assert.equal(calls.length, 1);
    const alternate = action === 'password'
      ? { current_password: password, password: replacementPassword } : { password };
    assert.equal((await call(db, { method: 'POST', query: { action }, body: alternate })).statusCode, 400);
    assert.equal((await call(db, { method: 'POST', query: { action },
      body: { ...body, password } })).statusCode, 400);
  }
});

test('T06 CRUD, snapshot, id GET, export and carry-forward use one authorized RPC, never table writes', async () => {
  const calls = [];
  const db = rpcDatabase(args => { calls.push(args); return { data: { id, version: 1 } }; });
  const requests = [
    { method: 'GET', query: { table: 'plans', id, user_id: 'ignored' } },
    { method: 'PATCH', query: { table: 'plans', id }, body: { title: 'new' } },
    ...[1, 2].map(() => ({ method: 'PATCH', query: { table: 'tasks', id }, body: { status: 'done' } })),
    { method: 'DELETE', query: { table: 'tasks', id } },
    { method: 'GET', query: { action: 'export' } },
    { method: 'POST', query: { action: 'carry-forward' }, body: { plan_id: id, improvement: '작게 나누기' } },
  ];
  for (const req of requests) assert.equal((await call(db, req)).statusCode, 200);
  assert.deepEqual(calls.map(c => c.p_operation), ['read', 'update', 'update', 'update', 'delete', 'export', 'carry-forward']);
  assert.equal(calls[0].p_id, id);
  assert.deepEqual(calls[2].p_payload, { status: 'done' });
  assert.deepEqual(calls[2], calls[3]);
});

test('unknown/foreign rows are 404; expired session 401; no raw database or network error logging', async () => {
  for (const [code, status] of [['P0002', 404], ['28000', 401], ['23503', 400], ['XX000', 500]]) {
    const response = await call(rpcDatabase(() => ({ error: { code, message: 'sensitive internal details' } })),
      { method: 'GET', query: { table: 'plans', id } });
    assert.equal(response.statusCode, status);
    assert.ok(!JSON.stringify(response.body).includes('sensitive'));
  }
  const original = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args);
  try {
    assert.equal((await call(rpcDatabase(() => { throw Error('sensitive network details'); }),
      { method: 'GET', query: { action: 'export' } })).statusCode, 500);
    assert.deepEqual(logs, []);
  } finally { console.error = original; }
  assert.equal((await call(null, { method: 'GET' })).statusCode, 503);
});

test('reject owner injection, malformed JSON, unknown routes, oversized input and history writes', async () => {
  for (const key of ['owner_id', 'user_id']) {
    assert.equal((await call({}, { method: 'POST', query: { table: 'plans' }, body: { title: 'x', [key]: id } })).statusCode, 400);
    assert.equal((await call({}, { method: 'DELETE', query: { table: 'tasks', id }, body: { [key]: id } })).statusCode, 400);
    assert.equal((await call({}, { method: 'POST', query: { action: 'signup' }, body: { email: 'x@y.com', password, [key]: id } })).statusCode, 400);
  }
  for (const body of ['{', { title: 'a'.repeat(13000) }]) {
    assert.equal((await call({}, { method: 'POST', query: { table: 'plans' }, body })).statusCode, 400);
  }
  assert.equal((await call({}, { method: 'GET', query: { table: 'secret' } })).statusCode, 400);
  assert.equal((await call({}, { method: 'GET', query: { table: 'plans', id: 'bad' } })).statusCode, 400);
  assert.equal((await call({}, { method: 'POST', query: { table: 'plan_versions' }, body: {} })).statusCode, 405);
});

test('observations use one transactional session-verified RPC and reject date/owner/derived field injection', async () => {
  const calls = [];
  const db = { rpc: async (name, args) => { calls.push([name, args]); return { data: { ok: true } }; } };
  for (const [action, body] of [
    ['study', undefined], ['create-study', { initial_rule: 'work for ten minutes' }],
    ['observe', { study_id: id, actual_minutes: 0 }],
    ['rule-change', { study_id: id, day1_id: id, day2_id: id, rule: 'work for five minutes', reason: 'smaller' }],
  ]) {
    assert.equal((await call(db, { method: action === 'study' ? 'GET' : 'POST', query: { action }, body })).statusCode, 200);
  }
  assert.ok(calls.every(([name, args]) => name === 'observation_request' && args.p_token_hash === session.hash));
  assert.deepEqual(calls.map(([, args]) => args.p_operation), ['study', 'create-study', 'observe', 'rule-change']);
  const before = calls.length;
  for (const extra of [{ observed_date: '2026-01-01' }, { day_number: 1 }, { rule_change_id: id },
    { owner_id: id }, { user_id: id }, { actual_minutes: -1 }, { actual_minutes: 1441 },
    { actual_minutes: 1.5 }, { actual_minutes: '10' }, { study_id: 'bad' }]) {
    assert.equal((await call(db, { method: 'POST', query: { action: 'observe' },
      body: { study_id: id, actual_minutes: 10, ...extra } })).statusCode, 400);
  }
  assert.equal((await call(db, { method: 'POST', query: { action: 'create-study' }, body: { initial_rule: ' ' } })).statusCode, 400);
  assert.equal((await call(db, { method: 'POST', query: { action: 'study' }, body: {} })).statusCode, 405);
  assert.equal(calls.length, before);
});
