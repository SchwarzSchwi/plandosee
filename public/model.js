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
