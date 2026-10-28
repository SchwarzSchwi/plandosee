import {execFileSync} from 'node:child_process';
import {existsSync, lstatSync, readFileSync, readdirSync} from 'node:fs';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', args, {cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});

export function containsSecret(text) {
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) return true;
  if (/\b(?:sb_secret_|gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}\b/.test(text)) return true;
  if (/\b(?:password|wrongPassword|newPassword)\s*[:=]\s*(?:"[^"\r\n]{12,128}"|'[^'\r\n]{12,128}')/.test(text)) return true;
  for (const match of text.matchAll(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g)) {
    try {
      const payload = JSON.parse(Buffer.from(match[0].split('.')[1], 'base64url'));
      if (['service_role', 'authenticated'].includes(payload.role)) return true;
    } catch { /* Non-JWT text is not evidence of a credential. */ }
  }
  return /(?:SUPABASE_(?:SECRET_KEY|SERVICE_ROLE_KEY)|password_hash|session_token)\s*[:=]\s*["'][A-Za-z0-9+/_.=-]{32,}["']/i.test(text);
}

function scan() {
  let checked = 0;
  let findings = 0;
  const inspect = (label, buffer) => {
    checked++;
    if (containsSecret(buffer.toString('utf8'))) {
      findings++;
      console.error(`의심 값 발견: ${label} (값은 출력하지 않음)`);
    }
  };
  const files = git('ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter(Boolean);
  for (const file of files) {
    const path = join(root, file);
    if (existsSync(path) && lstatSync(path).isFile()) inspect(`작업 파일 ${file}`, readFileSync(path));
  }
  // Inspect each reachable historical blob once, never print its contents.
  const objects = git('rev-list', '--objects', '--all').trim().split('\n').filter(Boolean);
  for (const object of objects) {
    const [oid, ...path] = object.split(' ');
    if (git('cat-file', '-t', oid).trim() === 'blob') {
      inspect(`Git 객체의 파일 ${path.join(' ') || '(이름 없음)'}`, git('cat-file', 'blob', oid));
    }
  }
  const walk = path => {
    if (!existsSync(path) || lstatSync(path).isSymbolicLink()) return;
    if (lstatSync(path).isDirectory()) {
      for (const name of readdirSync(path)) walk(join(path, name));
    } else if (lstatSync(path).isFile()) inspect(`산출물 ${relative(root, path)}`, readFileSync(path));
  };
  for (const folder of ['public', '.vercel/output', 'dist']) walk(join(root, folder));
  console.log(JSON.stringify({
    checked, findings,
    shallow: git('rev-parse', '--is-shallow-repository').trim() === 'true',
    scope: '현재 checkout·로컬에서 도달 가능한 전체 Git 객체·존재하는 정적 산출물',
    limitation: '패턴 검사일 뿐 무유출 증명 아님. 원격 배포·삭제된 원격 ref·런타임 로그·개인 기록 내용은 별도 관리자 감사 필요',
  }));
  if (findings) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) scan();
