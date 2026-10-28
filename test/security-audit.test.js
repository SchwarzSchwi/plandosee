import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {containsSecret} from '../scripts/security-audit.js';

test('secret audit detects runtime-generated private credentials without printing them', () => {
  assert.equal(containsSecret('sb_' + 'secret_' + randomBytes(24).toString('hex')), true);
  assert.equal(containsSecret(['password', '=', JSON.stringify(randomBytes(24).toString('hex'))].join(' ')), true);
  const header = Buffer.from(JSON.stringify({alg: 'HS256'})).toString('base64url');
  const payload = Buffer.from(JSON.stringify({role: 'service_role'})).toString('base64url');
  assert.equal(containsSecret([header, payload, randomBytes(32).toString('base64url')].join('.')), true);
  assert.equal(containsSecret('SUPABASE_SECRET_KEY=replace-with-server-only-key'), false);
  assert.equal(containsSecret('Cookie: [REDACTED]'), false);
});
