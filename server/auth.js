import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
export const SESSION_COOKIE = 'pds_session';
export const SESSION_SECONDS = 8 * 60 * 60;
const scryptOptions = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const dummyHash = `scrypt$32768$8$3$${'00'.repeat(16)}$${'00'.repeat(64)}`;

export function validPassword(password) {
  return typeof password === 'string' && password.length >= 12 && password.length <= 128;
}

export function normalizeEmail(email) {
  if (typeof email !== 'string') return null;
  const normalized = email.trim().toLowerCase();
  return normalized.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized : null;
}

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = await derive(password, salt, 64, scryptOptions);
  return `scrypt$32768$8$3$${salt}$${hash.toString('hex')}`;
}

export async function verifyPassword(password, encoded) {
  const valid = typeof encoded === 'string'
    && /^scrypt\$32768\$8\$3\$[0-9a-f]{32}\$[0-9a-f]{128}$/.test(encoded);
  const parts = (valid ? encoded : dummyHash).split('$');
  const hash = await derive(typeof password === 'string' ? password : '', parts[4], 64, scryptOptions);
  return timingSafeEqual(hash, Buffer.from(parts[5], 'hex')) && valid;
}

export function newSession() {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: tokenHash(token) };
}

export function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function readSession(req) {
  const cookie = req.headers?.cookie;
  if (typeof cookie !== 'string') return null;
  const matches = cookie.split(';').map(value => value.trim())
    .filter(value => value.startsWith(`${SESSION_COOKIE}=`));
  if (matches.length !== 1) return null;
  const token = matches[0].slice(SESSION_COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? tokenHash(token) : null;
}

export function sessionCookie(token, production, now = Date.now()) {
  const expires = new Date(token ? now + SESSION_SECONDS * 1000 : 0).toUTCString();
  return `${SESSION_COOKIE}=${token || ''}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${token ? SESSION_SECONDS : 0}; Expires=${expires}${production ? '; Secure' : ''}`;
}

export function allowedOrigin(req, env) {
  const origin = req.headers?.origin;
  if (typeof origin !== 'string' || typeof env.APP_ORIGIN !== 'string') return false;
  try {
    const configured = new URL(env.APP_ORIGIN);
    if (configured.origin !== env.APP_ORIGIN || origin !== configured.origin) return false;
    if (env.NODE_ENV === 'production' && configured.protocol !== 'https:') return false;
    return ['https:', 'http:'].includes(configured.protocol);
  } catch {
    return false;
  }
}
