import {
  allowedOrigin, hashPassword, newSession, normalizeEmail, readSession,
  sessionCookie, validPassword, verifyPassword,
} from './auth.js';

const names = ['plans', 'plan_versions', 'tasks', 'execution_logs', 'reviews'];
const fields = {
  plans: ['title', 'start_date', 'end_date', 'priority', 'success_criteria', 'estimated_minutes', 'description'],
  tasks: ['plan_id', 'title', 'description', 'due_date', 'priority', 'tags', 'estimated_minutes', 'status'],
  execution_logs: ['task_id', 'started_at', 'ended_at', 'blocker'],
  reviews: ['plan_id', 'improvement'],
};
class InputError extends Error {}
const validId = value => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const validDate = value => value === null || (typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString().slice(0, 10) === value);
const validTime = value => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(value)
  && validDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value));

export function validatePayload(table, body, creating) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new InputError('잘못된 입력입니다');
  if (Object.keys(body).some(key => !fields[table].includes(key))) throw new InputError('허용되지 않은 필드입니다');
  const payload = { ...body };
  for (const [key, value] of Object.entries(payload)) {
    if (['plan_id', 'task_id'].includes(key)) {
      if (!validId(value)) throw new InputError('잘못된 ID입니다');
    } else if (['start_date', 'end_date', 'due_date'].includes(key)) {
      if (!validDate(value)) throw new InputError('잘못된 날짜입니다');
    } else if (key === 'estimated_minutes') {
      if (!Number.isInteger(value) || value < 0 || value > 2147483647) throw new InputError('시간은 0 이상의 정수(분)여야 합니다');
    } else if (key === 'priority') {
      if (!['low', 'medium', 'high'].includes(value)) throw new InputError('잘못된 우선순위입니다');
    } else if (key === 'status') {
      if (!['progress', 'done'].includes(value)) throw new InputError('잘못된 상태입니다');
    } else if (key === 'tags') {
      if (!Array.isArray(value) || value.length > 50
        || value.some(tag => typeof tag !== 'string' || tag.length > 100)) throw new InputError('잘못된 태그입니다');
    } else if (typeof value !== 'string' || value.length > 4000) {
      throw new InputError('문자열은 4000자 이하여야 합니다');
    }
  }
  const required = table === 'plans' ? ['title'] : table === 'tasks' ? ['title', 'plan_id']
    : table === 'reviews' ? ['plan_id', 'improvement'] : ['task_id', 'started_at', 'ended_at'];
  if (creating && required.some(key => !payload[key])) throw new InputError('필수 항목을 입력하세요');
  if ('title' in payload && !payload.title.trim()) throw new InputError('제목을 입력하세요');
  if ('improvement' in payload && !payload.improvement.trim()) throw new InputError('고칠 점을 입력하세요');
  if (payload.start_date && payload.end_date && payload.end_date < payload.start_date) throw new InputError('기간을 확인하세요');
  if (table === 'execution_logs') {
    if (!validTime(payload.started_at) || !validTime(payload.ended_at)
      || Date.parse(payload.ended_at) < Date.parse(payload.started_at)) throw new InputError('실행 시각을 확인하세요');
    payload.actual_minutes = Math.round((Date.parse(payload.ended_at) - Date.parse(payload.started_at)) / 60000);
    if (payload.actual_minutes > 2147483647) throw new InputError('실행 시간이 너무 큽니다');
  }
  return payload;
}

export function createHandler(getDatabase, env = process.env) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const { table, id, action } = req.query || {};
    try {
      if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(req.method)) {
        return res.status(405).json({ error: '허용되지 않은 작업입니다' });
      }
      if (req.method !== 'GET' && !allowedOrigin(req, env)) {
        return res.status(403).json({ error: '요청 출처를 확인하세요' });
      }
      const db = getDatabase();
      if (!db) return res.status(503).json({ error: '서버 DB 환경 변수가 필요합니다' });
      const sessionHash = readSession(req);
      const rpc = async (operation, args = {}) => {
        const { data, error } = await db.rpc('authorized_request', {
          p_token_hash: sessionHash, p_operation: operation, ...args,
        });
        if (error) throw error;
        return data;
      };
      if (action === 'session' && req.method === 'GET') {
        if (!sessionHash) return res.json({ authenticated: false });
        try {
          const user = await rpc('session');
          return res.json({ authenticated: true, user: { id: user.id, email: user.email } });
        } catch (error) {
          if (error?.code !== '28000') throw error;
          res.setHeader('Set-Cookie', sessionCookie(null, env.NODE_ENV === 'production'));
          return res.json({ authenticated: false });
        }
      }
      if (['signup', 'login'].includes(action) && req.method === 'POST') {
        const body = parseBody(req.body);
        exactFields(body, ['email', 'password']);
        const email = normalizeEmail(body.email);
        if (!email || !validPassword(body.password)) {
          throw new InputError('이메일과 12~128자 비밀번호를 입력하세요');
        }
        if (action === 'signup') {
          const passwordHash = await hashPassword(body.password);
          const { error } = await db.rpc('auth_signup', { p_email: email, p_password_hash: passwordHash });
          if (error) throw error;
          return res.json({ ok: true, message: '가입 요청을 처리했습니다. 로그인해 주세요.' });
        }
        const { data: account, error } = await db.from('auth_accounts')
          .select('id,email,password_hash').eq('email', email).maybeSingle();
        if (error) throw error;
        if (!await verifyPassword(body.password, account?.password_hash)) {
          return res.status(401).json({ error: '이메일 또는 비밀번호를 확인하세요' });
        }
        const session = newSession();
        const issued = await db.rpc('auth_issue_session', {
          p_user_id: account.id, p_expected_hash: account.password_hash, p_token_hash: session.hash,
        });
        if (issued.error?.code === '28000') {
          return res.status(401).json({ error: '이메일 또는 비밀번호를 확인하세요' });
        }
        if (issued.error) throw issued.error;
        res.setHeader('Set-Cookie', sessionCookie(session.token, env.NODE_ENV === 'production'));
        return res.json({ authenticated: true, user: { id: account.id, email: account.email } });
      }
      if (!sessionHash) return res.status(401).json({ error: '로그인이 필요합니다' });
      if (['logout', 'password', 'delete-account'].includes(action) && req.method === 'POST') {
        const body = parseBody(req.body) ?? {};
        exactFields(body, action === 'logout' ? [] : action === 'password'
          ? ['current_password', 'new_password'] : ['current_password']);
        const args = {};
        if (action !== 'logout') {
          if (!validPassword(body.current_password)
            || (action === 'password' && !validPassword(body.new_password))) {
            throw new InputError('비밀번호는 12~128자여야 합니다');
          }
          const account = await rpc('credentials');
          if (!await verifyPassword(body.current_password, account.password_hash)) {
            return res.status(401).json({ error: '현재 비밀번호를 확인하세요' });
          }
          args.p_expected_hash = account.password_hash;
          if (action === 'password') args.p_new_hash = await hashPassword(body.new_password);
        }
        await rpc(action, args);
        res.setHeader('Set-Cookie', sessionCookie(null, env.NODE_ENV === 'production'));
        return res.json({ ok: true });
      }
      if (['study', 'create-study', 'observe', 'rule-change'].includes(action)) {
        if (req.method !== (action === 'study' ? 'GET' : 'POST')) {
          return res.status(405).json({ error: '허용되지 않은 작업입니다' });
        }
        const payload = action === 'study' ? {} : parseBody(req.body);
        exactFields(payload, {
          study: [], 'create-study': ['initial_rule'], observe: ['study_id', 'actual_minutes'],
          'rule-change': ['study_id', 'day1_id', 'day2_id', 'rule', 'reason'],
        }[action]);
        if (action !== 'study') {
          for (const key of action === 'create-study' ? ['initial_rule']
            : action === 'rule-change' ? ['rule', 'reason'] : []) {
            if (typeof payload[key] !== 'string' || !payload[key].trim() || payload[key].length > 4000) {
              throw new InputError('규칙과 이유는 1~4000자여야 합니다');
            }
          }
          for (const key of action === 'rule-change' ? ['study_id', 'day1_id', 'day2_id']
            : action === 'observe' ? ['study_id'] : []) {
            if (!validId(payload[key])) throw new InputError('잘못된 ID입니다');
          }
          if (action === 'observe' && (!Number.isInteger(payload.actual_minutes)
            || payload.actual_minutes < 0 || payload.actual_minutes > 1440)) {
            throw new InputError('실제 시간은 0~1440 사이 정수(분)여야 합니다');
          }
        }
        const { data, error } = await db.rpc('observation_request', {
          p_token_hash: sessionHash, p_operation: action, p_payload: payload,
        });
        if (error) throw error;
        return res.json(data);
      }
      if (req.method === 'GET') {
        if (action === 'export') {
          return res.json(await rpc('export'));
        }
        if (action) return res.status(405).json({ error: '허용되지 않은 작업입니다' });
        if (!names.includes(table)) return res.status(400).json({ error: '잘못된 테이블입니다' });
        if (id !== undefined && !validId(id)) throw new InputError('잘못된 ID입니다');
        return res.json(await rpc('read', { p_table: table, p_id: id ?? null }));
      }
      if (req.method === 'POST' && action === 'carry-forward') {
        const body = parseBody(req.body);
        const payload = validatePayload('reviews', body, true);
        return res.json(await rpc('carry-forward', { p_payload: payload }));
      }
      if (action) return res.status(405).json({ error: '허용되지 않은 작업입니다' });
      if (!fields[table] || !['POST', 'PATCH', 'DELETE'].includes(req.method)
        || (['reviews', 'execution_logs'].includes(table) && req.method !== 'POST')) {
        return res.status(405).json({ error: '허용되지 않은 작업입니다' });
      }
      if (req.method !== 'POST' && !validId(id)) return res.status(400).json({ error: '잘못된 ID입니다' });
      if (req.method === 'DELETE') {
        if (table !== 'tasks') return res.status(405).json({ error: '할 일만 삭제할 수 있습니다' });
        exactFields(parseBody(req.body) ?? {}, []);
        return res.json(await rpc('delete', { p_table: table, p_id: id }));
      }
      const payload = validatePayload(table, parseBody(req.body), req.method === 'POST');
      return res.json(await rpc(req.method === 'POST' ? 'create' : 'update', {
        p_table: table, p_id: req.method === 'POST' ? null : id, p_payload: payload,
      }));
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof InputError) {
        return res.status(400).json({ error: error instanceof SyntaxError ? '잘못된 JSON입니다' : error.message });
      }
      const status = error?.code === '28000' ? 401 : error?.code === 'P0002' ? 404
        : ['23503', '23514', '23502', '22P02', '22007', '22008', '22023', '23505'].includes(error?.code) ? 400 : 500;
      return res.status(status).json({ error: status === 401 ? '로그인이 필요합니다'
        : status === 404 ? '기록을 찾을 수 없습니다'
          : status === 400 ? '저장할 값이나 대상 기록을 확인하세요' : 'DB 작업에 실패했습니다' });
    }
  };
}

function parseBody(body) {
  if (JSON.stringify(body ?? {}).length > 12000) throw new InputError('입력이 너무 큽니다');
  return typeof body === 'string' ? JSON.parse(body) : body;
}

function exactFields(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some(key => !allowed.includes(key))) throw new InputError('허용되지 않은 입력입니다');
}
