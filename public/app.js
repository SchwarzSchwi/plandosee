import { queryTodos, summarize } from './model.js';

const root = document.querySelector('#app');
const state = {
  plans: [], tasks: [], execution_logs: [], reviews: [], plan_versions: [],
  tab: 'plans', selected: '', edit: '', search: '', filter: 'all',
};
const pending = new Set();
const priorities = [['low', '낮음'], ['medium', '보통'], ['high', '높음']];

function node(tag, attrs = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith('on')) element.addEventListener(key.slice(2), value);
    else if (key === 'class') element.className = value;
    else element[key] = value;
  }
  for (const child of children.flat(Infinity)) {
    if (child !== null && child !== undefined) element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}
const card = (...children) => node('section', { class: 'card' }, children);
const button = (text, onclick) => node('button', { type: 'button', onclick }, text);
const field = (label, name, type = 'text', value = '') => node('label', {}, label,
  node('input', { name, type, value: value ?? '', min: type === 'number' ? '0' : '',
    required: ['title', 'improvement', 'started_at', 'ended_at'].includes(name) }));
const select = (label, name, options, value, onchange) => {
  const input = node('select', { name, onchange: onchange || (() => {}) },
    options.map(([key, text]) => node('option', { value: key }, text)));
  input.value = value;
  return node('label', {}, label, input);
};
const own = () => queryTodos(state.tasks, { planId: state.selected });

async function request(query, method = 'GET', body) {
  const response = await fetch(`/api?${new URLSearchParams(query)}`, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || '요청에 실패했습니다');
  return data;
}
async function load() {
  const data = await request({ action: 'export' });
  for (const name of ['plans', 'tasks', 'execution_logs', 'reviews', 'plan_versions']) state[name] = data[name];
  if (!state.plans.some(plan => plan.id === state.selected)) state.selected = state.plans[0]?.id || '';
  render();
}
async function run(key, element, operation) {
  if (pending.has(key)) return;
  pending.add(key);
  element.disabled = true;
  try { await operation(); } catch (error) { alert(error.message); }
  finally { pending.delete(key); element.disabled = false; }
}
function form(id, children, save, enabled = true) {
  const submit = node('button', { type: 'submit', class: 'primary', disabled: !enabled }, '저장');
  return node('form', { id, onsubmit: event => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    run(id, submit, () => save(values));
  } }, children, submit);
}
const choose = () => card(select('현재 계획', 'plan', state.plans.map(plan => [plan.id, plan.title]),
  state.selected, event => { state.selected = event.target.value; state.edit = ''; render(); }));
async function save(table, values, id = state.edit) {
  await request({ table, ...(id ? { id } : {}) }, id ? 'PATCH' : 'POST', values);
  state.edit = '';
  await load();
}
function render() {
  root.replaceChildren(...({
    plans: planView, tasks: taskView, logs: logView, review: reviewView,
  }[state.tab])());
}

function planView() {
  const plan = state.plans.find(item => item.id === state.edit);
  return [
    card(node('h2', {}, plan ? '계획 수정' : '새 계획'),
      form('planForm', [
        field('제목', 'title', 'text', plan?.title),
        node('div', { class: 'grid' },
          field('시작일', 'start_date', 'date', plan?.start_date),
          field('종료일', 'end_date', 'date', plan?.end_date),
          select('우선순위', 'priority', priorities, plan?.priority || 'medium'),
          field('예상 시간 (분)', 'estimated_minutes', 'number', plan?.estimated_minutes || 0)),
        field('성공 기준', 'success_criteria', 'text', plan?.success_criteria),
        field('설명 / 이월된 고칠 점', 'description', 'text', plan?.description),
      ], values => save('plans', { ...values, start_date: values.start_date || null,
        end_date: values.end_date || null, estimated_minutes: Number(values.estimated_minutes) }))),
    card(node('h2', {}, '계획 목록'), state.plans.map(item => node('div', { class: 'item' },
      node('strong', {}, item.title), ` · ${item.priority || '보통'}`,
      node('div', { class: 'muted' }, `${item.start_date || ''} ~ ${item.end_date || ''} · ${item.estimated_minutes || 0}분`),
      node('div', {}, item.success_criteria), node('div', {}, item.description),
      button('수정', () => { state.edit = item.id; render(); }),
      button('할 일 보기', () => { state.selected = item.id; state.tab = 'tasks'; state.edit = ''; render(); }),
      node('details', {}, node('summary', {}, '과거 계획'),
        state.plan_versions.filter(version => version.plan_id === item.id).map(version =>
          node('div', { class: 'item' }, version.created_at,
            node('pre', {}, JSON.stringify(version.snapshot, null, 2)))))))),
  ];
}

function todoItem(todo) {
  const targetStatus = todo.status === 'done' ? 'progress' : 'done';
  return node('div', { class: 'item' }, node('strong', {}, todo.title),
    ` · ${todo.status === 'done' ? '완료' : '진행 중'}`,
    node('div', {}, todo.description),
    node('div', { class: 'muted' }, `${todo.due_date || '마감일 없음'} · ${todo.priority || '보통'} · ${(todo.tags || []).join(', ')} · ${todo.estimated_minutes || 0}분`),
    button(targetStatus === 'done' ? '완료' : '진행 중으로', event =>
      run(`status:${todo.id}`, event.currentTarget, async () => {
        await request({ table: 'tasks', id: todo.id }, 'PATCH', { status: targetStatus });
        await load();
      })),
    button('수정', () => { state.edit = todo.id; render(); }),
    button('삭제', event => {
      if (confirm('할 일을 삭제할까요?')) run(`delete:${todo.id}`, event.currentTarget, async () => {
        await request({ table: 'tasks', id: todo.id }, 'DELETE');
        await load();
      });
    }));
}
function taskView() {
  const todo = own().find(item => item.id === state.edit);
  const list = node('div', { id: 'todoList' });
  const updateList = () => list.replaceChildren(...queryTodos(state.tasks, {
    planId: state.selected, search: state.search, filter: state.filter,
  }).map(todoItem));
  updateList();
  return [
    choose(),
    card(node('h2', {}, todo ? '할 일 수정' : '할 일 추가'),
      form('taskForm', [
        field('할 일', 'title', 'text', todo?.title), field('내용', 'description', 'text', todo?.description),
        node('div', { class: 'grid' },
          field('마감일', 'due_date', 'date', todo?.due_date),
          select('우선순위', 'priority', priorities, todo?.priority || 'medium'),
          field('태그 (쉼표 구분)', 'tags', 'text', todo?.tags?.join(', ')),
          field('예상 시간 (분)', 'estimated_minutes', 'number', todo?.estimated_minutes || 0)),
      ], values => save('tasks', { ...values, plan_id: state.selected,
        due_date: values.due_date || null, tags: values.tags.split(',').map(tag => tag.trim()).filter(Boolean),
        estimated_minutes: Number(values.estimated_minutes) }), Boolean(state.selected))),
    card(node('h2', {}, '할 일 목록'),
      node('input', { id: 'search', placeholder: '제목·내용·태그 검색', value: state.search,
        oninput: event => { state.search = event.target.value; updateList(); } }),
      select('상태 필터', 'filter', [['all', '전체'], ['progress', '진행 중'], ['done', '완료'], ['overdue', '지연']],
        state.filter, event => { state.filter = event.target.value; updateList(); }),
      node('p', { class: 'muted' }, '정렬 기준: 마감일 오름차순(없으면 마지막) → 우선순위 높음순 → 제목순 → ID순'),
      list),
  ];
}

function logItem(log) {
  return node('div', { class: 'item' },
    state.tasks.find(todo => todo.id === log.task_id)?.title || log.task_id,
    ` · ${log.kind === 'completion' ? '최초 완료 기록' : '실행'} · ${log.actual_minutes || 0}분`,
    node('div', { class: 'muted' }, `${log.started_at} ~ ${log.ended_at}`),
    node('div', {}, '막힘: ', log.blocker));
}
function logView() {
  const todos = own();
  return [
    choose(),
    card(node('h2', {}, '실행 기록'),
      form('logForm', [
        select('할 일', 'task_id', todos.map(todo => [todo.id, todo.title]), todos[0]?.id || ''),
        node('p', { class: 'muted' }, '시작·종료 시각은 서울시간(Asia/Seoul)으로 입력합니다. 실제 시간은 분 단위 반올림입니다.'),
        field('시작 시각 (서울)', 'started_at', 'datetime-local'),
        field('종료 시각 (서울)', 'ended_at', 'datetime-local'), field('막힌 이유', 'blocker'),
      ], values => save('execution_logs', { ...values,
        started_at: new Date(`${values.started_at}+09:00`).toISOString(),
        ended_at: new Date(`${values.ended_at}+09:00`).toISOString() }, ''), todos.length > 0)),
    card(state.execution_logs.filter(log => todos.some(todo => todo.id === log.task_id)).map(logItem)),
  ];
}

function reviewView() {
  const summary = summarize(state.tasks, state.execution_logs, state.selected);
  const detail = node('div', { id: 'detail', class: 'item' }, '집계 숫자를 누르면 근거 기록을 확인합니다.');
  const showTodos = todos => detail.replaceChildren(...(todos.length ? todos.map(todo =>
    node('div', { class: 'item' }, todo.title, ` · 예상 ${todo.estimated_minutes || 0}분`,
      summary.work.filter(log => log.task_id === todo.id).map(logItem))) : ['해당 기록이 없습니다.']));
  const metric = (name, value, onclick) => node('button', { type: 'button', onclick }, name, node('strong', {}, value));
  return [
    choose(),
    card(node('h2', {}, '돌아보기'),
      node('div', { class: 'stats' },
        [['계획 수', summary.planned], ['완료 수', summary.completed],
          ['지연 수', summary.overdue], ['막힘 수', summary.blocked]].map(([label, todos]) =>
          metric(label, todos.length, () => showTodos(todos))),
        metric('예상 시간', `${summary.expected}분`, () => showTodos(summary.planned)),
        metric('실제 시간', `${summary.actual}분`, () =>
          detail.replaceChildren(...(summary.work.length ? summary.work.map(logItem) : ['해당 기록이 없습니다.']))),
        metric('차이 (실제 − 예상)', `${summary.difference}분`, () => showTodos(summary.planned))),
      detail),
    card(node('h2', {}, '다음 계획으로 이어갈 개선점'),
      form('reviewForm', [field('고칠 점 한 건', 'improvement')], async values => {
        const next = await request({ action: 'carry-forward' }, 'POST', { plan_id: state.selected, ...values });
        state.selected = next.id; state.edit = next.id; state.tab = 'plans';
        await load();
      }, Boolean(state.selected)),
      state.reviews.filter(review => review.plan_id === state.selected).map(review =>
        node('div', { class: 'item' }, review.improvement))),
  ];
}

document.querySelectorAll('[data-tab]').forEach(element => element.addEventListener('click', () => {
  state.tab = element.dataset.tab; state.edit = ''; render();
}));
document.querySelector('#export').addEventListener('click', event => run('export', event.currentTarget, async () => {
  const data = await request({ action: 'export' });
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const link = node('a', { href: url, download: 'plandosee-export.json' });
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}));
load().catch(error => { root.textContent = `데이터를 불러올 수 없습니다: ${error.message}`; });
