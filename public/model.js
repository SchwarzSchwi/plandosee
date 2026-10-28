export function seoulDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const value = type => parts.find(part => part.type === type).value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

export function isOverdue(todo, today = seoulDate()) {
  return todo.status !== 'done' && Boolean(todo.due_date) && todo.due_date < today;
}

export function queryTodos(todos, { planId, search = '', filter = 'all', today = seoulDate() }) {
  const priorities = { high: 0, medium: 1, low: 2 };
  return todos.filter(todo => !todo.deleted_at && todo.plan_id === planId)
    .filter(todo => [todo.title, todo.description, ...(todo.tags || [])]
      .join(' ').toLocaleLowerCase().includes(search.toLocaleLowerCase()))
    .filter(todo => filter === 'all' || (filter === 'overdue'
      ? isOverdue(todo, today) : todo.status === filter))
    .sort((a, b) => (a.due_date || '9999').localeCompare(b.due_date || '9999')
      || (priorities[a.priority] ?? 3) - (priorities[b.priority] ?? 3)
      || a.title.localeCompare(b.title, 'ko') || a.id.localeCompare(b.id));
}

export function summarize(todos, logs, planId, today = seoulDate()) {
  const planned = todos.filter(todo => !todo.deleted_at && todo.plan_id === planId);
  const ids = new Set(planned.map(todo => todo.id));
  const work = logs.filter(log => ids.has(log.task_id) && log.kind !== 'completion');
  const blockedIds = new Set(work.filter(log => log.blocker?.trim()).map(log => log.task_id));
  const expected = planned.reduce((sum, todo) => sum + Number(todo.estimated_minutes || 0), 0);
  const actual = work.reduce((sum, log) => sum + Number(log.actual_minutes || 0), 0);
  return {
    planned, completed: planned.filter(todo => todo.status === 'done'),
    overdue: planned.filter(todo => isOverdue(todo, today)),
    blocked: planned.filter(todo => blockedIds.has(todo.id)),
    work, expected, actual, difference: actual - expected,
  };
}

export const STUDY_QUESTION = '실행 규칙을 바꾼 뒤 하루 실제 실행 시간(분)은 어떻게 달라지는가?';
export const STUDY_METRIC = 'actual_minutes';

export function mondayStart(date = seoulDate()) {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - (day.getUTCDay() + 6) % 7);
  return day.toISOString().slice(0, 10);
}

export function validateObservation(observations, minutes, today, createdDate, changed = false) {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) throw Error('0~1440 사이 정수(분)를 입력하세요.');
  if (today < createdDate) throw Error('연구 생성일 이전에는 관찰할 수 없습니다.');
  if (observations.length >= 5) throw Error('관찰은 정확히 5일입니다.');
  if (observations.some(item => item.observed_date === today)) throw Error('오늘 관찰은 이미 기록했습니다.');
  if (observations.some(item => item.observed_date > today)) throw Error('미래 날짜의 관찰은 허용하지 않습니다.');
  if (observations.length >= 2 && !changed) throw Error('3일차 전 실행 규칙 변경을 기록하세요.');
}

export function observationSummary(observations) {
  const ordered = [...observations].sort((a, b) => a.observed_date.localeCompare(b.observed_date));
  const unique = new Set(ordered.map(item => item.observed_date));
  const valid = unique.size === ordered.length && ordered.length <= 5 && ordered.every(item =>
    Number.isInteger(item.actual_minutes) && item.actual_minutes >= 0 && item.actual_minutes <= 1440);
  if (!valid) throw Error('관찰 날짜 또는 분 값이 올바르지 않습니다.');
  const group = items => ({
    count: items.length,
    sum: items.length ? items.reduce((sum, item) => sum + item.actual_minutes, 0) : null,
    average: items.length ? Number((items.reduce((sum, item) => sum + item.actual_minutes, 0) / items.length).toFixed(2)) : null,
  });
  return {
    complete: ordered.length === 5, remaining: 5 - ordered.length,
    total: group(ordered), before: group(ordered.slice(0, 2)), after: group(ordered.slice(2)),
  };
}
