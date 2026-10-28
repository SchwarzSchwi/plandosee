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

export function createHandler(getDatabase) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const { table, id, action } = req.query || {};
    try {
      const db = getDatabase();
      if (!db) return res.status(503).json({ error: '서버 DB 환경 변수가 필요합니다' });
      if (req.method === 'GET') {
        if (action === 'export') {
          const { data, error } = await db.rpc('export_data');
          if (error) throw error;
          return res.json(data);
        }
        if (!names.includes(table)) return res.status(400).json({ error: '잘못된 테이블입니다' });
        const rows = [];
        for (let offset = 0; ; offset += 1000) {
          const { data, error } = await db.from(table).select('*').order('created_at').order('id').range(offset, offset + 999);
          if (error) throw error;
          rows.push(...data);
          if (data.length < 1000) return res.json(rows);
        }
      }
      if (req.method === 'POST' && action === 'carry-forward') {
        const body = parseBody(req.body);
        const payload = validatePayload('reviews', body, true);
        const { data, error } = await db.rpc('create_next_plan', {
          p_plan_id: payload.plan_id, p_improvement: payload.improvement,
        });
        if (error) throw error;
        return res.json(data);
      }
      if (!fields[table] || !['POST', 'PATCH', 'DELETE'].includes(req.method)
        || (['reviews', 'execution_logs'].includes(table) && req.method !== 'POST')) {
        return res.status(405).json({ error: '허용되지 않은 작업입니다' });
      }
      if (req.method !== 'POST' && !validId(id)) return res.status(400).json({ error: '잘못된 ID입니다' });
      if (req.method === 'DELETE') {
        if (table !== 'tasks') return res.status(405).json({ error: '할 일만 삭제할 수 있습니다' });
        const { data, error } = await db.from(table).update({ deleted_at: new Date().toISOString() })
          .eq('id', id).is('deleted_at', null).select();
        if (error) throw error;
        return res.json({ ok: true, changed: data.length });
      }
      const payload = validatePayload(table, parseBody(req.body), req.method === 'POST');
      let query = req.method === 'POST' ? db.from(table).insert(payload) : db.from(table).update(payload).eq('id', id);
      if (table === 'tasks' && req.method === 'PATCH') query = query.is('deleted_at', null);
      const { data, error } = await query.select().single();
      if (error) throw error;
      return res.json(data);
    } catch (error) {
      console.error('[database-operation-failed]', {
        method: req.method,
        table: names.includes(table) ? table : undefined,
        action: ['export', 'carry-forward'].includes(action) ? action : undefined,
        code: typeof error?.code === 'string' ? error.code : 'UNKNOWN',
      });
      if (error instanceof SyntaxError || error instanceof InputError) {
        return res.status(400).json({ error: error instanceof SyntaxError ? '잘못된 JSON입니다' : error.message });
      }
      const status = ['23503', '23514', '23502', '22P02', '22007', '22008', 'PGRST116'].includes(error.code) ? 400 : 500;
      return res.status(status).json({ error: status === 400 ? '저장할 값이나 대상 기록을 확인하세요' : 'DB 작업에 실패했습니다' });
    }
  };
}

function parseBody(body) {
  if (JSON.stringify(body ?? {}).length > 12000) throw new InputError('입력이 너무 큽니다');
  return typeof body === 'string' ? JSON.parse(body) : body;
}
