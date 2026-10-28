import { queryTodos, summarize, STUDY_QUESTION, observationSummary, validateObservation, mondayStart } from './model.js';

const shell = document.querySelector('#shell');
const loginMarkup = shell.innerHTML;
let root;
let verified = false;
let sessionGeneration = 0;
const state = {
  plans: [], tasks: [], execution_logs: [], reviews: [], plan_versions: [],
  studies: [], observations: [], rule_changes: [], today: '', study: '',
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
    required: ['title', 'improvement', 'started_at', 'ended_at', 'initial_rule', 'rule', 'reason', 'password', 'current_password', 'new_password'].includes(name),
    maxLength: type === 'password' ? 128 : 4000,
    autocomplete: type === 'password' ? (name === 'current_password' ? 'current-password' : 'new-password') : '',
  }));
const select = (label, name, options, value, onchange) => {
  const input = node('select', { name, onchange: onchange || (() => {}) },
    options.map(([key, text]) => node('option', { value: key }, text)));
  input.value = value;
  return node('label', {}, label, input);
};
const own = () => queryTodos(state.tasks, { planId: state.selected });

async function request(query, method = 'GET', body) {
  const publicActions = ['session', 'signup', 'login'];
  if (!verified && !publicActions.includes(query.action)) throw Error('먼저 로그인하세요.');
  const generation = sessionGeneration;
  const response = await fetch(`/api?${new URLSearchParams(query)}`, {
    method, credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && verified && generation === sessionGeneration) signedOut('세션이 만료되었습니다. 다시 로그인하세요.');
    throw Error(data.error || '요청에 실패했습니다');
  }
  return data;
}
async function load() {
  const generation = sessionGeneration;
  const [data, studyData] = await Promise.all([request({ action: 'export' }), request({ action: 'study' })]);
  if (!verified || generation !== sessionGeneration) return;
  for (const name of ['plans', 'tasks', 'execution_logs', 'reviews', 'plan_versions']) state[name] = data[name];
  for (const name of ['studies', 'observations', 'rule_changes', 'today']) state[name] = studyData[name];
  if (!state.plans.some(plan => plan.id === state.selected)) state.selected = state.plans[0]?.id || '';
  render();
}
async function run(key, element, operation, onError = error => alert(error.message)) {
  if (pending.has(key)) return;
  pending.add(key);
  element.disabled = true;
  try { await operation(); } catch (error) { onError(error); }
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
  if (!verified) return;
  root.replaceChildren(...({
    plans: planView, tasks: taskView, logs: logView, review: reviewView, study: studyView, account: accountView,
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

async function exportRecords() {
  const generation = sessionGeneration;
  const data = await request({ action: 'export' });
  if (!verified || generation !== sessionGeneration) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const link = node('a', { href: url, download: 'plandosee-export.json' });
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function studyView() {
  const study = state.studies.find(item => item.id === state.study) || state.studies[0];
  const observations = state.observations.filter(item => item.study_id === study?.id)
    .sort((a, b) => a.day_number - b.day_number);
  const change = state.rule_changes.find(item => item.study_id === study?.id);
  const summary = observationSummary(observations);
  const metric = group => group.count
    ? `${group.count}일 · 합계 ${group.sum}분 · 평균 ${group.average.toFixed(2)}분`
    : '미관찰 (0으로 처리하지 않음)';
  return [
    card(node('h2', {}, '실제 5일 관찰'),
      node('p', {}, STUDY_QUESTION),
      node('p', { class: 'muted' }, '고정 지표: 하루 실제 실행 시간 · 분 · 0~1440 정수. 서울 날짜당 한 번, 오늘만 기록합니다. 관찰값과 질문·지표·규칙 이력은 수정할 수 없습니다. 빠진 날은 0이 아니며, 가상 관찰은 만들지 않습니다.'),
      form('studyForm', [field('처음 실행할 규칙', 'initial_rule')], async values => {
        await request({ action: 'create-study' }, 'POST', values); await load();
      })),
    ...(study ? [
      card(select('관찰 연구', 'study', state.studies.map(item => [item.id, `${item.created_at} · ${item.initial_rule}`]),
        study.id, event => { state.study = event.target.value; render(); }),
      node('p', {}, `질문: ${study.question} · 지표: ${study.metric} · 단위: 분`),
      node('p', {}, `처음 규칙: ${study.initial_rule}`),
      node('p', {}, `서울 오늘: ${state.today} · 이번 주 월요일: ${mondayStart(state.today)}`),
      node('h3', {}, summary.complete ? '5일 관찰 완료' : `판단 대기 · 실제 ${observations.length}/5일 (${summary.remaining}일 남음)`),
      node('p', {}, `전체: ${metric(summary.total)}`),
      node('p', {}, `변경 전 (1~2일): ${metric(summary.before)}`),
      node('p', {}, `변경 후 (3~5일): ${metric(summary.after)}`),
      node('p', { class: 'muted' }, '전후 모두 동일한 분 지표입니다. 평균은 소수 둘째 자리 반올림. 5일 전에는 결론을 내리지 않습니다.')),
      card(node('h3', {}, '관찰 기록'),
        node('table', {}, node('thead', {}, node('tr', {}, ['일차', '실제 관찰일 (서울)', '실행 시간 (분)', '기록 시각 (서버)'].map(text => node('th', {}, text)))),
          node('tbody', {}, observations.map(item => node('tr', {},
            node('td', {}, item.day_number), node('td', {}, item.observed_date),
            node('td', {}, item.actual_minutes), node('td', {}, item.created_at))))),
        ...(!summary.complete ? [
          form('observationForm', [
            node('p', {}, '지금 실제 관찰한 오늘의 값만 제출하세요. 날짜·기록 시각은 서버가 정합니다.'),
            node('label', {}, '오늘 실제 실행 시간 (분)', node('input', {
              name: 'actual_minutes', type: 'number', min: 0, max: 1440, step: 1, required: true,
            })),
          ], async values => {
            const minutes = Number(values.actual_minutes);
            validateObservation(observations, minutes, state.today,
              study.created_date, Boolean(change));
            await request({ action: 'observe' }, 'POST', { study_id: study.id, actual_minutes: minutes });
            await load();
          }, !observations.some(item => item.observed_date === state.today) && (observations.length < 2 || Boolean(change))),
        ] : [])),
      card(node('h3', {}, '2일 뒤, 3일 전 규칙 변경'),
        ...(change ? [
          node('p', {}, `변경 규칙: ${change.rule}`), node('p', {}, `이유: ${change.reason}`),
          node('p', {}, `근거 1일차 ID: ${change.day1_id} · 2일차 ID: ${change.day2_id}`),
          node('p', { class: 'muted' }, `서버 기록 시각: ${change.created_at}`),
        ] : [
          node('p', {}, '1일차와 2일차 실제 기록을 근거로 변경합니다. 변경 전에는 3일차를 기록할 수 없습니다.'),
          form('ruleForm', [field('변경할 실행 규칙', 'rule'), field('두 관찰에 근거한 변경 이유', 'reason')],
            async values => {
              await request({ action: 'rule-change' }, 'POST', {
                study_id: study.id, day1_id: observations[0].id, day2_id: observations[1].id, ...values,
              }); await load();
            }, observations.length === 2),
        ])),
    ] : [card(node('p', {}, '연구를 만든 뒤 실제 날짜별 관찰을 시작하세요. 아직 관찰 데이터가 없습니다.'))]),
  ];
}

function accountView() {
  return [
    card(node('h2', {}, '비밀번호 변경'),
      form('passwordForm', [
        field('현재 비밀번호', 'current_password', 'password'), field('새 비밀번호', 'new_password', 'password'),
      ], async values => {
        await request({ action: 'password' }, 'POST', values);
        signedOut('비밀번호를 변경했습니다. 다시 로그인하세요.');
      })),
    card(node('h2', {}, '계정 및 모든 기록 삭제'),
      node('p', {}, '삭제한 계정과 개인 기록은 복구할 수 없습니다. 필요한 경우 먼저 전체 내보내기를 하세요.'),
      form('deleteAccountForm', [field('비밀번호 확인', 'current_password', 'password')], async values => {
        if (!confirm('계정과 모든 개인 기록을 영구 삭제할까요?')) return;
        await request({ action: 'delete-account' }, 'POST', values);
        signedOut('계정과 기록을 삭제했습니다.');
      })),
  ];
}

function signedOut(message = '') {
  verified = false;
  sessionGeneration++;
  for (const key of ['plans', 'tasks', 'execution_logs', 'reviews', 'plan_versions', 'studies', 'observations', 'rule_changes']) state[key] = [];
  state.selected = ''; state.study = ''; state.edit = ''; state.tab = 'plans';
  state.search = ''; state.filter = 'all'; state.today = '';
  shell.innerHTML = loginMarkup;
  root = undefined;
  bindLogin(message);
  document.querySelector('#loginForm [name=email]').focus();
}

function bindLogin(message = '') {
  document.querySelector('#authStatus').textContent = message;
  const login = document.querySelector('#loginForm');
  const authenticate = async (action, element) => {
    if (!login.reportValidity()) return;
    await run('auth', element, async () => {
      await request({ action }, 'POST', Object.fromEntries(new FormData(login)));
      login.reset();
      if (action === 'signup') {
        signedOut('가입 요청을 처리했습니다. 이메일과 12~128자 비밀번호로 로그인하세요.');
        return;
      }
      await verifySession();
    }, error => {
      const status = document.querySelector('#authStatus');
      if (!status) return;
      status.textContent = error.message;
      const password = document.querySelector('#loginForm [name=password]');
      password.value = '';
      password.focus();
    });
  };
  login.addEventListener('submit', event => {
    event.preventDefault(); authenticate('login', login.querySelector('[type=submit]'));
  });
  document.querySelector('#signup').addEventListener('click', event => authenticate('signup', event.currentTarget));
}

async function verifySession() {
  const generation = ++sessionGeneration;
  try {
    const session = await request({ action: 'session' });
    if (generation !== sessionGeneration) return;
    if (!session.authenticated) { signedOut('로그인하거나 회원가입하세요.'); return; }
    verified = true;
    const nav = node('nav', { ariaLabel: '다이어리 메뉴' });
    for (const [tab, title] of [['plans', '계획'], ['tasks', '할 일'], ['logs', '실행 기록'], ['review', '돌아보기'], ['study', '5일 관찰'], ['account', '계정']]) {
      nav.append(button(title, () => { state.tab = tab; state.edit = ''; render(); }));
    }
    nav.append(button('서버 날짜·기록 새로고침', event => run('reload', event.currentTarget, load)),
      button('전체 내보내기', event => run('export', event.currentTarget, exportRecords)),
      button('로그아웃', event => run('logout', event.currentTarget, async () => {
        await request({ action: 'logout' }, 'POST', {}); signedOut('로그아웃했습니다.');
      })));
    root = node('div', { id: 'app', tabIndex: -1 }, '데이터를 불러오는 중…');
    shell.replaceChildren(nav, root);
    await load();
    if (verified && generation === sessionGeneration) root.focus();
  } catch (error) {
    if (generation === sessionGeneration) signedOut(`세션 또는 데이터를 확인할 수 없습니다: ${error.message}`);
  }
}

bindLogin('세션 확인 중…');
verifySession();
