import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes, createHash, scryptSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createHandler } from '../server/handler.js';

// This adapter speaks to actual PostgreSQL as the production service role. It
// implements only Supabase's transport surface, never authorization or storage.
const literal = value => value === null ? 'null'
  : `'${String(typeof value === 'object' ? JSON.stringify(value) : value).replaceAll("'", "''")}'`;
function sql(statement, service = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.T07_PSQL || 'psql',
      ['-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose'],
      { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { errors += chunk; });
    child.on('error', () => reject(new Error('PostgreSQL transport failed')));
    child.on('close', code => {
      if (code) reject(Object.assign(new Error('PostgreSQL rejected operation'),
        { code: errors.match(/ERROR:\s+([A-Z0-9]{5}):/)?.[1] || 'XX000' }));
      else resolve(output.trim());
    });
    child.stdin.end(`${service ? 'set role service_role;\n' : ''}${statement}\n`);
  });
}
async function result(statement) {
  try {
    const value = await sql(statement, true);
    return { data: value ? JSON.parse(value) : null, error: null };
  } catch (error) {
    return { data: null, error: { code: error.code } };
  }
}
const database = {
  rpc(name, args) {
    assert.ok(['auth_signup', 'auth_issue_session', 'authorized_request', 'observation_request'].includes(name));
    const parameters = Object.entries(args).map(([key, value]) => {
      assert.match(key, /^p_[a-z_]+$/);
      return `${key} => ${literal(value)}`;
    }).join(',');
    return result(`select public.${name}(${parameters});`);
  },
  from(table) {
    assert.equal(table, 'auth_accounts');
    return { select(columns) {
      assert.equal(columns, 'id,email,password_hash');
      return { eq(key, value) {
        assert.equal(key, 'email');
        return { maybeSingle: () => result(
          `select row_to_json(a) from (select id,email,password_hash from public.auth_accounts where email=${literal(value)}) a;`) };
      } };
    } };
  },
};

test('T07 real PostgreSQL and HTTP integration (run bash test/t07-integration.sh)', {
  skip: process.env.T07_PG !== '1',
}, async t => {
  const secrets = Array.from({ length: 3 }, () => randomBytes(24).toString('base64url'));
  const password = secrets[0], replacement = secrets[1];
  const wrongPassword = secrets[2];
  const suffix = randomBytes(10).toString('hex');
  const emails = [`first-${suffix}@example.test`, `second-${suffix}@example.test`];
  const logs = [];
  let origin;
  const handler = createHandler(() => database, {
    NODE_ENV: 'test', get APP_ORIGIN() { return origin; },
  });
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url, origin);
    req.query = Object.fromEntries(url.searchParams);
    req.body = body || undefined;
    res.status = code => { res.statusCode = code; return res; };
    res.json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
    logs.push(`${req.method} ${url.pathname} ${[...url.searchParams.keys()].join(',')}`);
    await handler(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise(resolve => server.close(resolve)));
  async function request(method, query, cookie, body, extraHeaders = {}) {
    const url = `${origin}/api?${new URLSearchParams(query)}`;
    for (const secret of secrets) assert.ok(!url.includes(secret), 'No secret in request URL');
    const response = await fetch(url, {
      method, headers: { Origin: origin, 'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}), ...extraHeaders },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    for (const secret of secrets) assert.ok(!text.includes(secret), 'No secret in response body');
    assert.ok(!text.includes('password_hash') && !text.includes('token_hash') && !text.includes('scrypt$'),
      'No credential representation in response body');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return { status: response.status, body: JSON.parse(text), cookie: response.headers.get('set-cookie') };
  }
  let protectedSnapshot;
  async function expect(method, query, cookie, body, status, headers) {
    const response = await request(method, query, cookie, body, headers);
    assert.equal(response.status, status, `Expected HTTP ${status} for ${method} ${query.action || query.table}`);
    if (status >= 400 && protectedSnapshot) {
      const current = await request('GET', { action: protectedSnapshot.action }, protectedSnapshot.cookie);
      assert.equal(current.status, 200, 'Victim can still read original content');
      delete current.body.exported_at;
      assert.deepEqual(current.body, protectedSnapshot.body,
        'Each rejected request leaves victim content unchanged');
    }
    return response;
  }
  async function login(index, credential = password) {
    const response = await expect('POST', { action: 'login' }, null,
      { email: emails[index], password: credential }, 200);
    assert.ok(response.cookie?.includes('HttpOnly') && response.cookie.includes('SameSite=Strict'),
      'Session cookie security attributes');
    const cookie = response.cookie.split(';')[0];
    secrets.push(cookie.slice(cookie.indexOf('=') + 1));
    return { cookie, id: response.body.user.id };
  }

  await expect('GET', { action: 'export' }, undefined, undefined, 401);
  console.log('T07 evidence: GET /api?action=export no-cookie=401');
  const duplicate = await Promise.all(Array.from({ length: 4 }, () =>
    expect('POST', { action: 'signup' }, null, { email: emails[0], password }, 200)));
  assert.ok(duplicate.every(value => JSON.stringify(value.body) === JSON.stringify(duplicate[0].body)),
    'Concurrent duplicate signup responses are indistinguishable');
  await expect('POST', { action: 'signup' }, null, { email: emails[1], password }, 200);
  const accounts = JSON.parse(await sql(`select json_agg(a) from
    (select id,email,password_hash from auth_accounts order by email) a;`));
  assert.equal(accounts.length, 2, 'Concurrent signup creates exactly one account per email');
  const hashes = accounts.map(account => account.password_hash);
  assert.ok(hashes.every(hash => /^scrypt\$32768\$8\$3\$[0-9a-f]{32}\$[0-9a-f]{128}$/.test(hash)));
  assert.ok(hashes[0] !== hashes[1] && hashes[0].split('$')[4] !== hashes[1].split('$')[4],
    'Same runtime password has distinct stored salts and hashes');
  for (const hash of hashes) {
    const parts = hash.split('$');
    assert.ok(scryptSync(password, parts[4], 64, {
      N: Number(parts[1]), r: Number(parts[2]), p: Number(parts[3]), maxmem: 64 * 1024 * 1024,
    }).toString('hex') === parts[5],
      'Stored scrypt independently verifies');
  }
  const hashMetadata = hashes[0].split('$').slice(0, 4).join('$');
  assert.ok(hashes.every(hash => hash.length === 178), 'Real stored hash representation length');
  console.log(`T07 evidence: concurrent signup=200/200 accounts=2 hash=${hashMetadata}$[salt REDACTED]$[derived REDACTED] length=178 same-runtime-secret-hashes=DIFFERENT distinct-salts=PASS independent-verification=PASS`);

  const unknownAccount = await expect('POST', { action: 'login' }, undefined,
    { email: `missing-${suffix}@example.test`, password: wrongPassword }, 401);
  const wrongCredential = await expect('POST', { action: 'login' }, undefined,
    { email: emails[0], password: wrongPassword }, 401);
  assert.deepEqual(unknownAccount.body, wrongCredential.body,
    'Missing account and wrong runtime password have exactly equal response bodies');
  console.log('T07 evidence: missing-account/wrong-credential=401/401 exact-response-body-equality=PASS');

  const users = [await login(0), await login(1)];
  const persistedSessions = JSON.parse(await sql(`select json_agg(s) from
    (select token_hash,extract(epoch from (expires_at-created_at)) as lifetime from auth_sessions) s;`));
  assert.equal(persistedSessions.length, 2, 'Both real logins persist sessions');
  for (const user of users) {
    const rawToken = user.cookie.slice(user.cookie.indexOf('=') + 1);
    const hashedToken = createHash('sha256').update(rawToken).digest('hex');
    assert.ok(persistedSessions.some(session => session.token_hash === hashedToken),
      'Only SHA256 representation of actual session persists');
    assert.ok(!JSON.stringify(persistedSessions).includes(rawToken), 'Raw session is not stored');
  }
  assert.ok(persistedSessions.every(session => Math.abs(Number(session.lifetime) - 28800) < 1),
    'Actual stored session expiry is eight hours');
  console.log('T07 evidence: real-login=200 session-storage=SHA256-only expiry-seconds=28800 raw-session=[REDACTED]');
  for (const user of users) {
    user.plan = (await expect('POST', { table: 'plans' }, user.cookie,
      { title: 'Synthetic private plan', estimated_minutes: 30 }, 200)).body;
    user.task = (await expect('POST', { table: 'tasks' }, user.cookie,
      { title: 'Synthetic private task', plan_id: user.plan.id }, 200)).body;
    await expect('PATCH', { table: 'plans', id: user.plan.id }, user.cookie, { title: 'Synthetic revision' }, 200);
    await Promise.all([1, 2].map(() => expect('PATCH', { table: 'tasks', id: user.task.id },
      user.cookie, { status: 'done' }, 200)));
    await expect('POST', { table: 'execution_logs' }, user.cookie, {
      task_id: user.task.id, started_at: '2026-01-01T09:00:00Z',
      ended_at: '2026-01-01T09:12:30Z', blocker: '',
    }, 200);
    await expect('POST', { table: 'reviews' }, user.cookie,
      { plan_id: user.plan.id, improvement: 'Synthetic review' }, 200);
  }
  for (const [actor, victim] of [[users[0], users[1]], [users[1], users[0]]]) {
    const before = (await expect('GET', { action: 'export' }, victim.cookie, undefined, 200)).body;
    protectedSnapshot = { action: 'export', cookie: victim.cookie, body: structuredClone(before) };
    delete protectedSnapshot.body.exported_at;
    for (const table of ['plans', 'tasks', 'plan_versions', 'execution_logs', 'reviews']) {
      const foreign = before[table][0];
      const owned = await expect('GET', { table, id: foreign.id }, victim.cookie, undefined, 200);
      assert.deepEqual(owned.body, foreign, 'Owned entity ID read matches actual stored export row');
      await expect('GET', { table, id: foreign.id }, actor.cookie, undefined, 404);
      const listed = await expect('GET', { table, owner_id: victim.id }, actor.cookie, undefined, 200,
        { 'X-User-Id': victim.id, 'X-Owner-Id': victim.id });
      assert.ok(listed.body.every(row => row.owner_id === actor.id), 'List cannot inject an owner');
    }
    for (const table of ['plans', 'tasks']) {
      await expect('PATCH', { table, id: victim[table === 'plans' ? 'plan' : 'task'].id },
        actor.cookie, { title: 'Foreign overwrite attempt' }, 404);
    }
    await expect('DELETE', { table: 'tasks', id: victim.task.id }, actor.cookie, undefined, 404);
    await expect('POST', { table: 'tasks' }, actor.cookie,
      { title: 'Foreign parent attempt', plan_id: victim.plan.id }, 404);
    await expect('PATCH', { table: 'tasks', id: actor.task.id }, actor.cookie,
      { plan_id: victim.plan.id }, 404);
    await expect('POST', { table: 'execution_logs' }, actor.cookie, {
      task_id: victim.task.id, started_at: '2026-01-01T09:00:00Z', ended_at: '2026-01-01T09:01:00Z',
    }, 404);
    await expect('POST', { table: 'reviews' }, actor.cookie,
      { plan_id: victim.plan.id, improvement: 'Foreign review attempt' }, 404);
    await expect('POST', { action: 'carry-forward' }, actor.cookie,
      { plan_id: victim.plan.id, improvement: 'Foreign carry-forward attempt' }, 404);
    for (const key of ['owner_id', 'user_id']) {
      await expect('POST', { table: 'plans' }, actor.cookie, { title: 'Injected', [key]: victim.id }, 400);
      await expect('PATCH', { table: 'plans', id: actor.plan.id }, actor.cookie,
        { title: 'Injected', [key]: victim.id }, 400);
    }
    const exported = (await expect('GET', { action: 'export', owner_id: victim.id },
      actor.cookie, undefined, 200, { 'X-User-Id': victim.id })).body;
    for (const table of ['plans', 'tasks', 'plan_versions', 'execution_logs', 'reviews']) {
      assert.ok(exported[table].every(row => row.owner_id === actor.id), 'Export remains owner scoped');
    }
    const after = (await expect('GET', { action: 'export' }, victim.cookie, undefined, 200)).body;
    delete before.exported_at; delete after.exported_at;
    assert.deepEqual(after, before, 'All denied requests leave foreign content unchanged');
    protectedSnapshot = undefined;
  }
  console.log('T07 evidence: bidirectional own/foreign entity-id-read=200/404 foreign-update/delete/parent=404 owner-body=400 list/export injection=200 own-rows-only each-rejection-unchanged-content=PASS');

  for (const user of users) {
    user.study = (await expect('POST', { action: 'create-study' }, user.cookie,
      { initial_rule: 'Synthetic HTTP study initial rule' }, 200)).body;
    const observed = (await expect('POST', { action: 'observe' }, user.cookie,
      { study_id: user.study.id, actual_minutes: 15 }, 200)).body;
    const state = (await expect('GET', { action: 'study' }, user.cookie, undefined, 200)).body;
    assert.equal(observed.observed_date, state.today, 'Actual server Seoul date is assigned');
    assert.equal(observed.day_number, 1, 'Server assigns first observation number');
    await expect('POST', { action: 'observe' }, user.cookie,
      { study_id: user.study.id, actual_minutes: 20 }, 400);
    await expect('POST', { action: 'observe' }, user.cookie,
      { study_id: user.study.id, actual_minutes: 20, observed_date: '2020-01-01' }, 400);
    await expect('POST', { action: 'rule-change' }, user.cookie, {
      study_id: user.study.id, day1_id: observed.id, day2_id: observed.id,
      rule: 'Synthetic premature rule change', reason: 'Synthetic reason',
    }, 400);
  }
  for (const [actor, victim] of [[users[0], users[1]], [users[1], users[0]]]) {
    const before = (await expect('GET', { action: 'study' }, victim.cookie, undefined, 200)).body;
    protectedSnapshot = { action: 'study', cookie: victim.cookie, body: structuredClone(before) };
    await expect('POST', { action: 'observe' }, actor.cookie,
      { study_id: victim.study.id, actual_minutes: 999 }, 404);
    await expect('POST', { action: 'rule-change' }, actor.cookie, {
      study_id: victim.study.id, day1_id: before.observations[0].id,
      day2_id: before.observations[0].id, rule: 'Synthetic foreign change', reason: 'Synthetic reason',
    }, 404);
    await expect('POST', { action: 'create-study' }, actor.cookie,
      { initial_rule: 'Synthetic injection attempt', owner_id: victim.id }, 400);
    const ownState = (await expect('GET', { action: 'study', owner_id: victim.id },
      actor.cookie, undefined, 200, { 'X-User-Id': victim.id })).body;
    for (const table of ['studies', 'observations', 'rule_changes']) {
      assert.ok(ownState[table].every(row => row.owner_id === actor.id),
        'Observation state cannot inject owner');
    }
    const exported = (await expect('GET', { action: 'export', owner_id: victim.id },
      actor.cookie, undefined, 200)).body;
    for (const table of ['studies', 'observations', 'rule_changes']) {
      assert.ok(Array.isArray(exported[table]) && exported[table].every(row => row.owner_id === actor.id),
        'Combined export includes only owned observation evidence');
    }
    const after = (await expect('GET', { action: 'study' }, victim.cookie, undefined, 200)).body;
    assert.deepEqual(after, before, 'Foreign observation and rule attempts leave evidence unchanged');
    protectedSnapshot = undefined;
  }
  console.log('T07 evidence: real-auth observation create=200 same-day/client-date/premature-rule=400 foreign-observe/change=404/404 scoped-state=PASS unchanged-evidence=PASS');

  const snapshot = JSON.parse(await sql(`select json_build_object(
    'revisions',(select count(*) from plan_versions where owner_id is not null),
    'completions',(select count(*) from execution_logs where owner_id is not null and kind='completion'),
    'work',(select count(*) from execution_logs where owner_id is not null and kind='work' and actual_minutes=13));`));
  assert.deepEqual(snapshot, { revisions: 2, completions: 2, work: 2 });
  await expect('DELETE', { table: 'tasks', id: users[0].task.id }, users[0].cookie, undefined, 200);
  await expect('GET', { table: 'tasks', id: users[0].task.id }, users[0].cookie, undefined, 404);
  await expect('PATCH', { table: 'tasks', id: users[0].task.id }, users[0].cookie, { title: 'Deleted' }, 404);

  const route = { table: 'plans' };
  const fixedCookie = users[0].cookie;
  const beforeLogout = await expect('GET', route, fixedCookie, undefined, 200);
  await expect('POST', { action: 'logout' }, fixedCookie, {}, 200);
  assert.ok(users[0].cookie === fixedCookie, 'Exact same cookie replayed after logout');
  const afterLogout = await expect('GET', route, fixedCookie, undefined, 401);
  assert.equal(beforeLogout.status, 200); assert.equal(afterLogout.status, 401);
  console.log('T07 evidence: same GET /api?table=plans same-cookie=[REDACTED] logout status=200/401');

  const expired = await login(0);
  const digest = createHash('sha256').update(expired.cookie.split('=')[1]).digest('hex');
  await sql(`update auth_sessions set expires_at=clock_timestamp()-interval '1 second' where token_hash=${literal(digest)};`);
  await expect('GET', route, expired.cookie, undefined, 401);
  const sessions = [await login(0), await login(0)];
  await expect('POST', { action: 'password' }, sessions[0].cookie,
    { current_password: password, new_password: replacement }, 200);
  for (const session of sessions) await expect('GET', route, session.cookie, undefined, 401);
  assert.equal(await sql(`select count(*) from auth_sessions where user_id=${literal(users[0].id)};`), '0');
  await expect('POST', { action: 'login' }, null, { email: emails[0], password }, 401);
  await login(0, replacement);
  console.log('T07 evidence: expired-cookie=401 password-change=200 all-prior-sessions=401 old-credential=401 replacement-login=200');

  const legacy = '06000000-0000-4000-8000-000000000001';
  for (const user of users) await expect('GET', { table: 'plans', id: legacy },
    user.id === users[0].id ? (await login(0, replacement)).cookie : user.cookie, undefined, 404);
  let transfer = await readFile(new URL('../supabase/transfer.sql', import.meta.url), 'utf8');
  transfer = transfer.replace('00000000-0000-0000-0000-000000000000', users[1].id)
    .replace(/commit;\s*$/, () => `do $$ begin
      assert not exists(select 1 from plans where owner_id is null), 'Legacy plans transferred';
      assert not exists(select 1 from tasks where owner_id is null), 'Legacy tasks transferred';
      assert not exists(select 1 from execution_logs where owner_id is null), 'Legacy logs transferred';
      assert not exists(select 1 from plan_versions where owner_id is null), 'Legacy history transferred';
      assert not exists(select 1 from reviews where owner_id is null), 'Legacy reviews transferred';
      assert (select count(*)=1 from plan_versions where plan_id='${legacy}'), 'Legacy history retained';
      assert (select count(*)=1 from reviews where plan_id='${legacy}'), 'Legacy review retained';
      assert (select count(*)=5 from tasks where plan_id='${legacy}'), 'Legacy task content retained';
      assert (select count(*)=1 from execution_logs where kind='completion' and task_id='06000000-0000-4000-8000-000000000011'), 'Legacy completion retained';
    end $$; set constraints all immediate; rollback;`);
  await sql(transfer);
  assert.equal(await sql(`select count(*) from plans where id=${literal(legacy)} and owner_id is null;`), '1');
  console.log('T07 evidence: migrated legacy=404/404 explicit administrator transfer=PASS transaction=ROLLBACK');

  const deleteCookie = users[1].cookie;
  const otherDeleteSession = await login(1);
  await expect('GET', route, deleteCookie, undefined, 200);
  await expect('POST', { action: 'delete-account' }, deleteCookie,
    { current_password: password }, 200);
  assert.ok(users[1].cookie === deleteCookie, 'Exact same cookie replayed after account deletion');
  await expect('GET', route, deleteCookie, undefined, 401);
  await expect('GET', route, otherDeleteSession.cookie, undefined, 401);
  const deleted = literal(users[1].id);
  const remaining = JSON.parse(await sql(`select json_build_object(
    'accounts',(select count(*) from auth_accounts where id=${deleted}),
    'sessions',(select count(*) from auth_sessions where user_id=${deleted}),
    'owned_rows',(
      select sum(n) from (
        select count(*) n from plans where owner_id=${deleted}
        union all select count(*) from plan_versions where owner_id=${deleted}
        union all select count(*) from tasks where owner_id=${deleted}
        union all select count(*) from execution_logs where owner_id=${deleted}
        union all select count(*) from reviews where owner_id=${deleted}
        union all select count(*) from studies where owner_id=${deleted}
        union all select count(*) from observations where owner_id=${deleted}
        union all select count(*) from rule_changes where owner_id=${deleted}
      ) counts));`));
  assert.deepEqual(remaining, { accounts: 0, sessions: 0, owned_rows: 0 },
    'Actual account deletion removes account, every session and all eight owned entity types');
  await expect('POST', { action: 'login' }, undefined,
    { email: emails[1], password }, 401);
  console.log('T07 evidence: delete-account=200 same GET /api?table=plans same-cookie=[REDACTED] status=200/401 other-session=401 SQL accounts/sessions/owned-rows=0/0/0 deleted-account-login=401');

  // Supply an empty second real account for the subsequent rolled-back SQL
  // ownership fixtures, after independently verifying the deleted ID has no rows.
  await expect('POST', { action: 'signup' }, undefined, { email: emails[1], password }, 200);
  assert.equal(await sql(`select count(*) from auth_accounts where email=${literal(emails[1])} and id<>${deleted};`),
    '1', 'A later signup is a new identity, not resurrection of deleted owned data');
  const postgresLog = await readFile(process.env.T07_PG_LOG, 'utf8');
  const evidence = [...logs, postgresLog].join('\n');
  for (const secret of secrets) assert.ok(!evidence.includes(secret), 'Request and PostgreSQL logs contain no passwords or raw sessions');
  console.log('T07 evidence: request-URL/response-body/request-log/PostgreSQL-log plaintext-secret-absence=PASS');
});
