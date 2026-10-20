// 畫面與操作。資料邏輯都在其他模組，這裡只負責「讀取狀態 → 畫出畫面 → 處理按鈕」。

import { BACKUP_MAX_BYTES, backupFileName, createBackup, validateBackupText } from './backup.js';
import {
  formatDateLabel,
  formatLongDate,
  msUntilNextMidnight,
  toDateKey,
  weekdayLabel,
} from './dates.js';
import { downloadText, h, replaceChildren } from './dom.js';
import {
  DAY_STATUS_LABELS,
  activeHabits,
  archivedHabits,
  createHabit,
  currentStreak,
  isCheckedIn,
  recentHistory,
  renameHabit,
  setCheckin,
  setHabitArchived,
  validateHabitName,
} from './habits.js';
import { buildSampleData } from './sample.js';
import { CURRENT_VERSION, countData, emptyData } from './schema.js';
import { habitCompletion, todaySummary, todoCounts } from './stats.js';
import {
  STORAGE_KEY,
  getBrowserStorage,
  loadData,
  preserveCorruptData,
  saveData,
} from './storage.js';
import {
  FILTERS,
  FILTER_LABELS,
  PRIORITY_LABELS,
  createTodo,
  deleteTodo,
  dueStatus,
  dueTodayTodos,
  filterTodos,
  overdueTodos,
  setTodoDone,
  sortTodos,
  updateTodo,
  validateTodoInput,
} from './todos.js';

const VIEWS = ['today', 'todos', 'habits', 'settings'];
const META_KEY = 'daily-habit:meta';
const DAY_MARKS = { done: '✓', missed: '✕', pending: '○', 'not-started': '–', archived: '‖' };

const app = {
  storage: null,
  mode: 'normal', // normal：正常；memory：無法儲存，只存在記憶體；recovery：資料損壞，等待使用者處理
  data: emptyData(),
  todayKey: toDateKey(),
  view: 'today',
  todoFilter: 'all',
  notices: [],
  corrupt: null, // { raw, errors }
  importPreview: null, // { fileName, result, exportFirst }
  editingTodoId: null,
  editingHabitId: null,
  habitDraft: '',
  habitError: '',
  dialogReturnKey: null,
  pendingFocusKey: null,
  midnightTimer: null,
};

const $ = (id) => document.getElementById(id);

// ---------- 啟動 ----------

function init() {
  if (typeof HTMLDialogElement !== 'function') {
    addNotice('你的瀏覽器版本較舊，部分對話框可能無法使用，建議更新瀏覽器。', 'error');
  }

  app.storage = getBrowserStorage();
  const result = loadData(app.storage);
  if (result.status === 'unavailable') {
    app.mode = 'memory';
    addNotice(
      '瀏覽器目前不允許儲存資料（可能是隱私設定或無痕模式）。你仍可以使用，但關閉頁面後資料會消失，請記得用「匯出備份」保存。',
      'warning',
      false,
    );
  } else if (result.status === 'corrupt') {
    app.mode = 'recovery';
    app.corrupt = { raw: result.raw, errors: result.errors };
  } else {
    app.data = result.data;
    for (const warning of result.warnings ?? []) addNotice(warning, 'info');
    if (result.migratedFrom && result.migratedFrom !== CURRENT_VERSION) {
      addNotice(`已將資料從版本 ${result.migratedFrom} 升級為版本 ${CURRENT_VERSION}，原本的資料也已另存一份。`, 'info');
    }
  }

  setupDialogs();
  setupDateWatch();
  window.addEventListener('hashchange', () => setView(viewFromHash(), true));
  window.addEventListener('storage', handleStorageEvent);

  app.view = viewFromHash();
  $('boot-message').remove();
  render();
}

function viewFromHash() {
  const view = location.hash.replace('#', '');
  return VIEWS.includes(view) ? view : 'today';
}

function setView(view, moveFocus) {
  app.view = view;
  render();
  if (moveFocus) {
    window.scrollTo(0, 0);
    if (!focusPending()) focusHeading();
  }
}

// ---------- 儲存 ----------

/** 嘗試儲存新資料；成功才更新畫面。失敗時保留原資料並顯示原因。 */
function commit(nextData, message) {
  if (app.mode === 'recovery') return false;
  if (app.mode === 'normal') {
    const result = saveData(app.storage, nextData);
    if (!result.ok) {
      addNotice(result.message, 'error');
      render();
      return false;
    }
  }
  app.data = nextData;
  render();
  if (message) showToast(message);
  return true;
}

function handleStorageEvent(event) {
  if (app.mode === 'memory' || (event.key !== STORAGE_KEY && event.key !== null)) return;
  const result = loadData(app.storage);
  if (result.status === 'corrupt') {
    app.mode = 'recovery';
    app.corrupt = { raw: result.raw, errors: result.errors };
  } else {
    app.mode = 'normal';
    app.corrupt = null;
    app.data = result.data;
    showToast('已同步其他分頁的變更。');
  }
  render();
}

function readMeta() {
  try {
    const meta = JSON.parse(app.storage?.getItem(META_KEY) ?? '{}');
    return meta && typeof meta === 'object' ? meta : {};
  } catch {
    return {};
  }
}

function writeMeta(meta) {
  try {
    app.storage?.setItem(META_KEY, JSON.stringify({ ...readMeta(), ...meta }));
  } catch {
    // 只是提示用的資訊，寫不進去不影響主要資料。
  }
}

// ---------- 日期更新 ----------

function setupDateWatch() {
  scheduleMidnight();
  setInterval(checkDateChange, 60 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      checkDateChange();
      scheduleMidnight();
    }
  });
  window.addEventListener('focus', checkDateChange);
}

function scheduleMidnight() {
  clearTimeout(app.midnightTimer);
  app.midnightTimer = setTimeout(() => {
    checkDateChange();
    scheduleMidnight();
  }, msUntilNextMidnight() + 500);
}

function checkDateChange() {
  const key = toDateKey();
  if (key === app.todayKey) return;
  app.todayKey = key;
  render();
  showToast('已進入新的一天，今日資料已更新。');
}

// ---------- 訊息 ----------

let noticeCounter = 0;

function addNotice(text, type = 'error', dismissible = true) {
  noticeCounter += 1;
  app.notices.push({ id: noticeCounter, text, type, dismissible });
  renderNotices();
}

function renderNotices() {
  const labels = { error: '錯誤', warning: '注意', info: '提示' };
  replaceChildren(
    $('notices'),
    app.notices.map((notice) =>
      h(
        'div',
        { class: `notice notice--${notice.type}`, role: notice.type === 'info' ? 'status' : 'alert' },
        h('p', {}, h('strong', {}, `${labels[notice.type]}：`), notice.text),
        notice.dismissible
          ? h(
              'button',
              {
                type: 'button',
                class: 'btn btn--small btn--ghost',
                onClick: () => {
                  app.notices = app.notices.filter((n) => n.id !== notice.id);
                  renderNotices();
                  focusHeading();
                },
              },
              '關閉訊息',
            )
          : null,
      ),
    ),
  );
}

let toastTimer = null;

function showToast(message) {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove('is-visible');
    toast.textContent = '';
  }, 3500);
}

// ---------- 焦點管理（鍵盤操作時，重新繪製後焦點不會跑掉） ----------

function focusHeading() {
  const heading = document.querySelector('.view:not([hidden]) h2');
  heading?.focus({ preventScroll: true });
}

function focusByKey(key) {
  if (!key) return false;
  const target = [...document.querySelectorAll(`[data-focus-key="${CSS.escape(key)}"]`)].find(
    (element) => !element.closest('[hidden]'),
  );
  if (!target) return false;
  target.focus({ preventScroll: true });
  return true;
}

function focusPending() {
  const key = app.pendingFocusKey;
  app.pendingFocusKey = null;
  return focusByKey(key);
}

// ---------- 繪製 ----------

function render() {
  const active = document.activeElement;
  const activeInDialog = Boolean(active?.closest?.('dialog'));
  const activeKey = active?.dataset?.focusKey;

  $('today-label').textContent = `今天是 ${formatLongDate(app.todayKey)}`;
  renderNotices();

  const recovery = app.mode === 'recovery';
  $('tabs').hidden = recovery;
  $('view-recovery').hidden = !recovery;
  for (const view of VIEWS) {
    const panel = $(`view-${view}`);
    panel.hidden = recovery || view !== app.view;
    // 只保留目前區域的內容，避免隱藏區域留下過時的元素。
    if (panel.hidden) panel.textContent = '';
  }
  if (!recovery) $('view-recovery').textContent = '';

  if (recovery) {
    renderRecovery();
  } else {
    for (const link of document.querySelectorAll('.tab')) {
      if (link.dataset.view === app.view) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    const renderers = { today: renderToday, todos: renderTodos, habits: renderHabits, settings: renderSettings };
    renderers[app.view]();
  }

  if (focusPending()) return;
  if (!activeInDialog && active && active !== document.body && !active.isConnected) {
    if (!focusByKey(activeKey)) focusHeading();
  }
}

function heading(view, text) {
  return h('h2', { id: `heading-${view}`, class: 'view-title', tabindex: '-1' }, text);
}

function emptyState(title, text, ...actions) {
  return h(
    'div',
    { class: 'empty-state' },
    h('p', { class: 'empty-title' }, title),
    text ? h('p', {}, text) : null,
    actions.length ? h('div', { class: 'button-row' }, actions) : null,
  );
}

function button(text, onClick, { variant = 'secondary', size = '', focusKey, label, type = 'button' } = {}) {
  return h(
    'button',
    {
      type,
      class: `btn btn--${variant}${size ? ` btn--${size}` : ''}`,
      onClick,
      'aria-label': label,
      dataset: focusKey ? { focusKey } : undefined,
    },
    text,
  );
}

// ----- 今日 -----

function renderToday() {
  const { todos, habits } = app.data;
  const panel = $('view-today');

  if (todos.length === 0 && habits.length === 0) {
    replaceChildren(
      panel,
      heading('today', '今日'),
      h(
        'div',
        { class: 'card welcome' },
        h('h3', {}, '歡迎使用！'),
        h('p', {}, '這裡會列出今天到期與已逾期的待辦，以及今天要完成的習慣。先新增第一筆資料吧。'),
        h(
          'div',
          { class: 'button-row' },
          button('新增第一筆待辦', () => openTodoDialog(null, app.todayKey), { variant: 'primary', focusKey: 'welcome-todo' }),
          button('新增第一個習慣', goAddHabit, { variant: 'primary', focusKey: 'welcome-habit' }),
        ),
        h('p', { class: 'muted' }, '想先看看效果？可以載入範例資料，之後隨時能刪除或封存。'),
        button('載入範例資料', loadSampleData, { focusKey: 'welcome-sample' }),
        h('p', { class: 'muted small' }, '資料只會存在這個瀏覽器，不會跨裝置同步。請定期到「設定與備份」匯出備份。'),
      ),
    );
    return;
  }

  const summary = todaySummary(app.data, app.todayKey);
  const overdue = overdueTodos(todos, app.todayKey);
  const dueToday = dueTodayTodos(todos, app.todayKey);
  const active = activeHabits(habits);

  replaceChildren(
    panel,
    heading('today', '今日'),
    h(
      'ul',
      { class: 'summary', 'aria-label': '今日摘要' },
      summaryItem('已逾期', `${summary.overdue} 筆`, summary.overdue > 0 ? 'alert' : ''),
      summaryItem('今天到期', `${summary.dueToday} 筆`),
      summaryItem('今日習慣', `${summary.habitsDone} / ${summary.habitsTotal}`),
    ),
    h(
      'section',
      { class: 'section', 'aria-labelledby': 'today-overdue' },
      h('h3', { id: 'today-overdue', class: 'section-title' }, `⚠ 已逾期（${overdue.length}）`),
      overdue.length
        ? h('ul', { class: 'todo-list' }, overdue.map(renderTodoItem))
        : h('p', { class: 'muted' }, '沒有逾期的待辦。'),
    ),
    h(
      'section',
      { class: 'section', 'aria-labelledby': 'today-due' },
      h(
        'div',
        { class: 'section-head' },
        h('h3', { id: 'today-due', class: 'section-title' }, `今天到期（${dueToday.length}）`),
        button('＋ 新增今天到期的待辦', () => openTodoDialog(null, app.todayKey), {
          variant: 'primary',
          size: 'small',
          focusKey: 'today-add-todo',
        }),
      ),
      dueToday.length
        ? h('ul', { class: 'todo-list' }, dueToday.map(renderTodoItem))
        : h('p', { class: 'muted' }, '今天沒有到期的待辦。沒有截止日期的待辦請到「所有待辦」查看。'),
    ),
    h(
      'section',
      { class: 'section', 'aria-labelledby': 'today-habits' },
      h('h3', { id: 'today-habits', class: 'section-title' }, `今日習慣（${summary.habitsDone} / ${active.length} 完成）`),
      active.length
        ? h('ul', { class: 'habit-list habit-list--compact' }, active.map((habit) => renderTodayHabit(habit)))
        : h(
            'div',
            {},
            h('p', { class: 'muted' }, '目前沒有進行中的習慣。'),
            button('前往新增習慣', goAddHabit, { focusKey: 'today-go-habit' }),
          ),
    ),
  );
}

function summaryItem(label, value, tone = '') {
  return h(
    'li',
    { class: `summary-item${tone ? ` summary-item--${tone}` : ''}` },
    h('span', { class: 'summary-label' }, label),
    h('span', { class: 'summary-value' }, value),
  );
}

function goAddHabit() {
  app.pendingFocusKey = 'habit-name';
  if (location.hash === '#habits') render();
  else location.hash = '#habits';
}

// ----- 待辦項目 -----

function renderTodoItem(todo) {
  const status = dueStatus(todo, app.todayKey);
  const checkId = `todo-done-${todo.id}`;
  const metaId = `todo-meta-${todo.id}`;

  const badges = [h('span', { class: `badge badge--${todo.priority}` }, `優先：${PRIORITY_LABELS[todo.priority]}`)];
  if (todo.done) {
    badges.push(h('span', { class: 'badge badge--done' }, '✓ 已完成'));
    if (todo.dueDate) badges.push(h('span', { class: 'badge' }, `截止 ${formatDateLabel(todo.dueDate)}`));
  } else if (status === 'overdue') {
    badges.push(h('span', { class: 'badge badge--overdue' }, `⚠ 已逾期・截止 ${formatDateLabel(todo.dueDate)}`));
  } else if (status === 'today') {
    badges.push(h('span', { class: 'badge badge--today' }, '今天到期'));
  } else if (status === 'upcoming') {
    badges.push(h('span', { class: 'badge' }, `截止 ${formatDateLabel(todo.dueDate)}`));
  } else {
    badges.push(h('span', { class: 'badge badge--muted' }, '無截止日期'));
  }

  return h(
    'li',
    { class: `todo${todo.done ? ' is-done' : ''}` },
    h(
      'div',
      { class: 'todo-check' },
      h('input', {
        type: 'checkbox',
        id: checkId,
        checked: todo.done,
        'aria-describedby': metaId,
        dataset: { focusKey: `todo-done-${todo.id}` },
        onChange: (event) => toggleTodo(todo.id, event.target.checked),
      }),
    ),
    h(
      'div',
      { class: 'todo-main' },
      h('label', { for: checkId, class: 'todo-title' }, todo.title),
      h('p', { class: 'todo-meta', id: metaId }, badges),
      todo.note ? h('p', { class: 'todo-note' }, todo.note) : null,
    ),
    h(
      'div',
      { class: 'todo-actions' },
      button('編輯', () => openTodoDialog(todo), {
        variant: 'ghost',
        size: 'small',
        focusKey: `todo-edit-${todo.id}`,
        label: `編輯「${todo.title}」`,
      }),
      button('刪除', () => confirmDeleteTodo(todo), {
        variant: 'ghost-danger',
        size: 'small',
        focusKey: `todo-delete-${todo.id}`,
        label: `刪除「${todo.title}」`,
      }),
    ),
  );
}

function toggleTodo(id, done) {
  commit({ ...app.data, todos: setTodoDone(app.data.todos, id, done) }, done ? '已標記為完成。' : '已取消完成。');
}

async function confirmDeleteTodo(todo) {
  const ok = await confirmAction({
    title: '刪除待辦',
    message: `確定要刪除「${todo.title}」嗎？\n刪除後無法復原。`,
    confirmText: '刪除',
    danger: true,
  });
  if (!ok) return;
  commit({ ...app.data, todos: deleteTodo(app.data.todos, todo.id) }, '已刪除待辦。');
}

// ----- 所有待辦 -----

function renderTodos() {
  const counts = todoCounts(app.data.todos);
  const list = sortTodos(filterTodos(app.data.todos, app.todoFilter));

  let content;
  if (counts.all === 0) {
    content = emptyState(
      '還沒有任何待辦',
      '按「新增待辦」建立第一筆。截止日期可以不填。',
      button('新增待辦', () => openTodoDialog(null), { variant: 'primary', focusKey: 'todos-empty-add' }),
      button('載入範例資料', loadSampleData, { focusKey: 'todos-empty-sample' }),
    );
  } else if (list.length === 0) {
    content = emptyState(app.todoFilter === 'done' ? '還沒有已完成的待辦' : '所有待辦都完成了！', null);
  } else {
    content = h('ul', { class: 'todo-list' }, list.map(renderTodoItem));
  }

  replaceChildren(
    $('view-todos'),
    h(
      'div',
      { class: 'view-head' },
      heading('todos', '所有待辦'),
      button('＋ 新增待辦', () => openTodoDialog(null), { variant: 'primary', focusKey: 'todos-add' }),
    ),
    h(
      'fieldset',
      { class: 'filter' },
      h('legend', { class: 'visually-hidden' }, '篩選待辦'),
      h(
        'div',
        { class: 'segmented' },
        FILTERS.map((filter) =>
          h(
            'label',
            {},
            h('input', {
              type: 'radio',
              name: 'todo-filter',
              value: filter,
              checked: app.todoFilter === filter,
              dataset: { focusKey: `filter-${filter}` },
              onChange: () => {
                app.todoFilter = filter;
                render();
              },
            }),
            h('span', {}, `${FILTER_LABELS[filter]}（${counts[filter]}）`),
          ),
        ),
      ),
    ),
    content,
  );
}

// ----- 待辦表單 -----

function openTodoDialog(todo, defaultDueDate = null) {
  const form = $('todo-form');
  form.reset();
  clearTodoErrors();
  app.editingTodoId = todo ? todo.id : null;
  $('todo-dialog-title').textContent = todo ? '編輯待辦' : '新增待辦';
  $('todo-title').value = todo ? todo.title : '';
  $('todo-note').value = todo ? todo.note : '';
  $('todo-due').value = todo ? (todo.dueDate ?? '') : (defaultDueDate ?? '');
  const priority = todo ? todo.priority : 'medium';
  for (const radio of form.elements.priority) radio.checked = radio.value === priority;
  openDialog($('todo-dialog'));
  $('todo-title').focus();
}

function clearTodoErrors() {
  for (const field of ['title', 'note', 'due']) {
    const input = $(`todo-${field}`);
    input.removeAttribute('aria-invalid');
    const error = $(`todo-${field}-error`);
    error.hidden = true;
    error.textContent = '';
  }
}

function submitTodoForm(event) {
  event.preventDefault();
  clearTodoErrors();
  const form = $('todo-form');
  const input = {
    title: form.elements.title.value,
    note: form.elements.note.value,
    dueDate: form.elements.dueDate.value || null,
    priority: form.elements.priority.value,
  };
  const result = validateTodoInput(input);
  if (!result.ok) {
    const fieldIds = { title: 'title', note: 'note', dueDate: 'due' };
    let first = null;
    for (const [key, message] of Object.entries(result.errors)) {
      const id = fieldIds[key];
      if (!id) continue;
      $(`todo-${id}`).setAttribute('aria-invalid', 'true');
      const error = $(`todo-${id}-error`);
      error.textContent = message;
      error.hidden = false;
      first ??= $(`todo-${id}`);
    }
    first?.focus();
    return;
  }

  const editing = app.editingTodoId;
  const todos = editing
    ? updateTodo(app.data.todos, editing, result.value)
    : [...app.data.todos, createTodo(result.value)];
  if (commit({ ...app.data, todos }, editing ? '已儲存變更。' : '已新增待辦。')) {
    $('todo-dialog').close();
  }
}

// ----- 習慣 -----

function renderHabits() {
  const active = activeHabits(app.data.habits);
  const archived = archivedHabits(app.data.habits);
  const errorId = 'habit-name-error';

  const form = h(
    'form',
    { class: 'card add-habit', novalidate: true, onSubmit: submitNewHabit },
    h('label', { for: 'habit-name', class: 'field-label' }, '新增每日習慣'),
    h(
      'div',
      { class: 'inline-field' },
      h('input', {
        id: 'habit-name',
        name: 'name',
        type: 'text',
        maxlength: '100',
        autocomplete: 'off',
        placeholder: '例如：喝水 8 杯',
        value: app.habitDraft,
        'aria-invalid': app.habitError ? 'true' : null,
        'aria-describedby': errorId,
        dataset: { focusKey: 'habit-name' },
        onInput: (event) => {
          app.habitDraft = event.target.value;
        },
      }),
      button('新增', null, { variant: 'primary', type: 'submit', focusKey: 'habit-add' }),
    ),
    h('p', { id: errorId, class: 'field-error', hidden: !app.habitError }, app.habitError),
    h('p', { class: 'muted small' }, '第一版的習慣都是「每天執行」。建立當天之前的日期不會算成漏打卡。'),
  );

  replaceChildren(
    $('view-habits'),
    heading('habits', '習慣'),
    form,
    h(
      'section',
      { class: 'section', 'aria-labelledby': 'habits-active' },
      h('h3', { id: 'habits-active', class: 'section-title' }, `進行中的習慣（${active.length}）`),
      active.length
        ? [weekLegend(), h('ul', { class: 'habit-list' }, active.map(renderHabitCard))]
        : emptyState(
            '還沒有進行中的習慣',
            '在上方輸入名稱即可新增，或先載入範例資料看看。',
            button('載入範例資料', loadSampleData, { focusKey: 'habits-empty-sample' }),
          ),
    ),
    archived.length
      ? h(
          'section',
          { class: 'section', 'aria-labelledby': 'habits-archived' },
          h('h3', { id: 'habits-archived', class: 'section-title' }, `已封存的習慣（${archived.length}）`),
          h('p', { class: 'muted small' }, '封存的習慣保留所有打卡紀錄，但不會列入今日應完成的習慣。'),
          h('ul', { class: 'habit-list' }, archived.map(renderArchivedCard)),
        )
      : null,
  );
}

function submitNewHabit(event) {
  event.preventDefault();
  const result = validateHabitName(app.habitDraft);
  if (!result.ok) {
    app.habitError = result.error;
    app.pendingFocusKey = 'habit-name';
    render();
    return;
  }
  app.habitError = '';
  const habits = [...app.data.habits, createHabit(result.value)];
  app.pendingFocusKey = 'habit-name';
  if (commit({ ...app.data, habits }, `已新增習慣「${result.value}」。`)) {
    app.habitDraft = '';
    app.pendingFocusKey = 'habit-name';
    render();
  }
}

function weekLegend() {
  return h(
    'ul',
    { class: 'legend', 'aria-label': '七天紀錄圖示說明' },
    ['done', 'missed', 'pending', 'not-started', 'archived'].map((status) =>
      h(
        'li',
        {},
        h('span', { class: `day-mark day--${status}`, 'aria-hidden': 'true' }, DAY_MARKS[status]),
        DAY_STATUS_LABELS[status],
      ),
    ),
  );
}

function renderWeek(habit) {
  const history = recentHistory(habit, app.data.checkins, app.todayKey);
  return h(
    'ol',
    { class: 'week', 'aria-label': `「${habit.name}」最近七天紀錄` },
    history.map((day) => {
      const label = `${formatDateLabel(day.date)}：${DAY_STATUS_LABELS[day.status]}`;
      return h(
        'li',
        { class: `day day--${day.status}`, title: label },
        h('span', { class: 'day-weekday', 'aria-hidden': 'true' }, day.date === app.todayKey ? '今' : weekdayLabel(day.date)),
        h('span', { class: 'day-mark', 'aria-hidden': 'true' }, DAY_MARKS[day.status]),
        h('span', { class: 'visually-hidden' }, label),
      );
    }),
  );
}

function checkinButton(habit, prefix) {
  const done = isCheckedIn(app.data.checkins, habit.id, app.todayKey);
  return button(done ? '取消打卡' : '✓ 完成打卡', () => toggleHabitToday(habit), {
    variant: done ? 'secondary' : 'primary',
    focusKey: `${prefix}-check-${habit.id}`,
    label: done ? `取消「${habit.name}」今天的打卡` : `為「${habit.name}」完成今天的打卡`,
  });
}

function todayStatusText(habit) {
  const done = isCheckedIn(app.data.checkins, habit.id, app.todayKey);
  return h('span', { class: `status ${done ? 'status--done' : 'status--pending'}` }, done ? '✓ 今天已打卡' : '○ 今天尚未打卡');
}

function renderTodayHabit(habit) {
  return h(
    'li',
    { class: 'habit habit--compact' },
    h('div', { class: 'habit-info' }, h('p', { class: 'habit-name' }, habit.name), todayStatusText(habit)),
    checkinButton(habit, 'today'),
  );
}

function renderHabitCard(habit) {
  const streak = currentStreak(habit.id, app.data.checkins, app.todayKey);
  const completion = habitCompletion(habit, app.data.checkins, app.todayKey);
  return h(
    'li',
    { class: 'habit card' },
    h(
      'div',
      { class: 'habit-info' },
      h('h4', { class: 'habit-name' }, habit.name),
      h(
        'p',
        { class: 'habit-stats' },
        todayStatusText(habit),
        h('span', {}, `連續 ${streak} 天`),
        h('span', {}, completion.possible ? `近 7 天完成 ${completion.done} / ${completion.possible} 天` : '近 7 天尚無紀錄'),
      ),
    ),
    renderWeek(habit),
    h(
      'div',
      { class: 'habit-actions' },
      checkinButton(habit, 'habits'),
      button('改名', () => openHabitDialog(habit), {
        variant: 'ghost',
        size: 'small',
        focusKey: `habit-rename-${habit.id}`,
        label: `修改「${habit.name}」的名稱`,
      }),
      button('封存', () => archiveHabit(habit, true), {
        variant: 'ghost',
        size: 'small',
        focusKey: `habit-archive-${habit.id}`,
        label: `封存「${habit.name}」`,
      }),
    ),
  );
}

function renderArchivedCard(habit) {
  return h(
    'li',
    { class: 'habit card is-archived' },
    h(
      'div',
      { class: 'habit-info' },
      h('h4', { class: 'habit-name' }, habit.name),
      h('p', { class: 'habit-stats' }, h('span', { class: 'status' }, `‖ 已封存${habit.archivedDate ? `（${formatDateLabel(habit.archivedDate)}）` : ''}`)),
    ),
    renderWeek(habit),
    h(
      'div',
      { class: 'habit-actions' },
      button('還原', () => archiveHabit(habit, false), {
        variant: 'secondary',
        size: 'small',
        focusKey: `habit-restore-${habit.id}`,
        label: `還原「${habit.name}」`,
      }),
      button('改名', () => openHabitDialog(habit), {
        variant: 'ghost',
        size: 'small',
        focusKey: `habit-rename-${habit.id}`,
        label: `修改「${habit.name}」的名稱`,
      }),
    ),
  );
}

function toggleHabitToday(habit) {
  const done = isCheckedIn(app.data.checkins, habit.id, app.todayKey);
  const checkins = setCheckin(app.data.checkins, habit.id, app.todayKey, !done);
  commit({ ...app.data, checkins }, done ? `已取消「${habit.name}」今天的打卡。` : `「${habit.name}」今天已打卡！`);
}

function archiveHabit(habit, archived) {
  // 封存後按鈕會移到別的區塊，焦點改放到對應的按鈕或標題。
  app.pendingFocusKey = archived ? null : `habit-archive-${habit.id}`;
  const habits = setHabitArchived(app.data.habits, habit.id, archived);
  commit(
    { ...app.data, habits },
    archived ? `已封存「${habit.name}」，可在「已封存的習慣」還原。` : `已還原「${habit.name}」。`,
  );
}

function openHabitDialog(habit) {
  app.editingHabitId = habit.id;
  const input = $('habit-name-edit');
  input.value = habit.name;
  input.removeAttribute('aria-invalid');
  $('habit-name-edit-error').hidden = true;
  openDialog($('habit-dialog'));
  input.focus();
  input.select();
}

function submitHabitForm(event) {
  event.preventDefault();
  const input = $('habit-name-edit');
  const result = validateHabitName(input.value);
  if (!result.ok) {
    input.setAttribute('aria-invalid', 'true');
    const error = $('habit-name-edit-error');
    error.textContent = result.error;
    error.hidden = false;
    input.focus();
    return;
  }
  const habits = renameHabit(app.data.habits, app.editingHabitId, result.value);
  if (commit({ ...app.data, habits }, '已修改習慣名稱。')) $('habit-dialog').close();
}

// ----- 設定與備份 -----

function renderSettings() {
  const counts = countData(app.data);
  const meta = readMeta();
  const lastExport = meta.lastExportAt ? formatDateTime(meta.lastExportAt) : null;

  replaceChildren(
    $('view-settings'),
    heading('settings', '設定與備份'),
    h(
      'section',
      { class: 'card notice notice--info', 'aria-labelledby': 'settings-where' },
      h('h3', { id: 'settings-where' }, '你的資料存在哪裡？'),
      h(
        'ul',
        { class: 'bullets' },
        h('li', {}, '所有資料只儲存在「目前這個瀏覽器」中，不會上傳到任何伺服器。'),
        h('li', {}, h('strong', {}, '不會跨裝置或跨瀏覽器同步'), '：手機和電腦上的資料是分開的。'),
        h('li', {}, '清除瀏覽器資料、使用無痕視窗，或更換瀏覽器時，資料可能消失。'),
        h('li', {}, h('strong', {}, '請定期匯出備份'), '（建議每週一次），並把檔案存放在安全的地方。'),
      ),
      h('p', { class: 'small' }, lastExport ? `上次在這個瀏覽器匯出備份：${lastExport}` : '你還沒有在這個瀏覽器匯出過備份。'),
    ),
    h(
      'section',
      { class: 'card', 'aria-labelledby': 'settings-export' },
      h('h3', { id: 'settings-export' }, '匯出備份'),
      h('p', {}, `下載包含全部資料的 JSON 檔：待辦 ${counts.todos} 筆、習慣 ${counts.habits} 個、打卡紀錄 ${counts.checkins} 筆。`),
      button('下載備份檔', exportBackup, { variant: 'primary', focusKey: 'export' }),
    ),
    h(
      'section',
      { class: 'card', 'aria-labelledby': 'settings-import' },
      h('h3', { id: 'settings-import' }, '從備份還原'),
      h('p', {}, '選擇之前匯出的備份檔，系統會先檢查內容。還原會以備份內容「完整取代」目前所有資料。'),
      renderImporter({ allowExportFirst: true }),
    ),
    h(
      'section',
      { class: 'card', 'aria-labelledby': 'settings-sample' },
      h('h3', { id: 'settings-sample' }, '範例資料'),
      h('p', {}, '加入幾筆範例待辦與習慣，名稱前會標示「（範例）」。不會刪除你原有的資料。'),
      button('載入範例資料', loadSampleData, { focusKey: 'settings-sample' }),
    ),
    h(
      'section',
      { class: 'card danger-zone', 'aria-labelledby': 'settings-clear' },
      h('h3', { id: 'settings-clear' }, '清除所有資料'),
      h('p', {}, '刪除這個瀏覽器中的所有待辦、習慣與打卡紀錄。建議先匯出備份。'),
      button('清除所有資料…', clearAllData, { variant: 'danger', focusKey: 'settings-clear' }),
    ),
    h(
      'section',
      { class: 'card', 'aria-labelledby': 'settings-about' },
      h('h3', { id: 'settings-about' }, '技術資訊'),
      h(
        'dl',
        { class: 'details' },
        h('dt', {}, '儲存狀態'),
        h('dd', {}, app.mode === 'memory' ? '⚠ 無法儲存（僅暫存在目前頁面）' : '✓ 已儲存在這個瀏覽器'),
        h('dt', {}, '資料版本'),
        h('dd', {}, String(CURRENT_VERSION)),
        h('dt', {}, '儲存位置'),
        h('dd', {}, h('code', {}, `localStorage「${STORAGE_KEY}」`)),
      ),
    ),
  );
}

function formatDateTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '未知';
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return `${formatLongDate(toDateKey(date))} ${time}`;
}

function exportBackup() {
  const filename = backupFileName();
  downloadText(filename, JSON.stringify(createBackup(app.data), null, 2));
  writeMeta({ lastExportAt: new Date().toISOString() });
  if (app.view === 'settings' && app.mode !== 'recovery') render();
  showToast(`已下載備份檔 ${filename}`);
}

/** 匯入區塊（設定頁與資料救援頁共用）。 */
function renderImporter({ allowExportFirst }) {
  const preview = app.importPreview;
  const fileInput = h('input', {
    type: 'file',
    id: 'import-file',
    class: 'file-input',
    accept: '.json,application/json',
    dataset: { focusKey: 'import-file' },
    onChange: (event) => handleImportFile(event.target.files?.[0], allowExportFirst),
  });
  const parts = [
    h('div', { class: 'field' }, h('label', { for: 'import-file', class: 'field-label' }, '選擇備份檔（.json）'), fileInput),
  ];

  if (preview && !preview.result.ok) {
    parts.push(
      h(
        'div',
        { class: 'import-preview notice notice--error' },
        h('h4', { id: 'import-result', tabindex: '-1' }, '✕ 無法使用這個備份檔'),
        h('p', {}, `檔案「${preview.fileName}」沒有通過檢查，`, h('strong', {}, '目前的資料沒有任何變更'), '。'),
        h('ul', { class: 'bullets' }, preview.result.errors.map((error) => h('li', {}, error))),
        button('關閉', cancelImport, { size: 'small', focusKey: 'import-cancel' }),
      ),
    );
  } else if (preview) {
    const { result } = preview;
    const current = countData(app.data);
    parts.push(
      h(
        'div',
        { class: 'import-preview notice notice--info' },
        h('h4', { id: 'import-result', tabindex: '-1' }, '✓ 備份檔檢查通過'),
        h(
          'dl',
          { class: 'details' },
          h('dt', {}, '檔案'),
          h('dd', {}, preview.fileName),
          h('dt', {}, '資料版本'),
          h('dd', {}, String(result.version)),
          h('dt', {}, '匯出時間'),
          h('dd', {}, result.exportedAt ? formatDateTime(result.exportedAt) : '未記錄'),
          h('dt', {}, '內容'),
          h('dd', {}, `待辦 ${result.counts.todos} 筆、習慣 ${result.counts.habits} 個、打卡紀錄 ${result.counts.checkins} 筆`),
        ),
        result.warnings.length ? h('ul', { class: 'bullets' }, result.warnings.map((w) => h('li', {}, w))) : null,
        app.mode === 'recovery'
          ? h('p', {}, '還原後會使用備份內容；無法讀取的原始資料會另外保留在瀏覽器中。')
          : h(
              'p',
              {},
              h('strong', {}, '注意：'),
              `目前的資料（待辦 ${current.todos} 筆、習慣 ${current.habits} 個、打卡紀錄 ${current.checkins} 筆）將被完整取代。`,
            ),
        allowExportFirst && app.mode !== 'recovery'
          ? h(
              'label',
              { class: 'checkbox-label' },
              h('input', {
                type: 'checkbox',
                checked: preview.exportFirst,
                dataset: { focusKey: 'import-export-first' },
                onChange: (event) => {
                  preview.exportFirst = event.target.checked;
                },
              }),
              h('span', {}, '還原前，先下載目前資料的備份（建議）'),
            )
          : null,
        h(
          'div',
          { class: 'button-row' },
          button('以此備份還原…', confirmImport, { variant: 'danger', focusKey: 'import-confirm' }),
          button('取消', cancelImport, { focusKey: 'import-cancel' }),
        ),
      ),
    );
  }
  return h('div', { class: 'importer' }, parts);
}

async function handleImportFile(file, allowExportFirst) {
  if (!file) return;
  let result;
  if (file.size > BACKUP_MAX_BYTES) {
    result = { ok: false, errors: ['檔案太大，不像是本工具的備份檔。'], warnings: [] };
  } else {
    try {
      result = validateBackupText(await file.text());
    } catch {
      result = { ok: false, errors: ['無法讀取這個檔案。'], warnings: [] };
    }
  }
  const hasData = countData(app.data).todos + countData(app.data).habits > 0;
  app.importPreview = { fileName: file.name, result, exportFirst: allowExportFirst && hasData };
  render();
  $('import-result')?.focus();
}

function cancelImport() {
  app.importPreview = null;
  app.pendingFocusKey = 'import-file';
  render();
}

async function confirmImport() {
  const preview = app.importPreview;
  if (!preview?.result.ok) return;
  const { counts } = preview.result;
  const ok = await confirmAction({
    title: '以備份完整取代目前資料？',
    message:
      app.mode === 'recovery'
        ? `將以備份內容（待辦 ${counts.todos} 筆、習慣 ${counts.habits} 個、打卡紀錄 ${counts.checkins} 筆）開始使用。`
        : `目前所有的待辦、習慣與打卡紀錄都會被刪除，改為備份檔中的內容（待辦 ${counts.todos} 筆、習慣 ${counts.habits} 個、打卡紀錄 ${counts.checkins} 筆）。\n此動作無法復原。`,
    confirmText: '確定還原',
    danger: true,
  });
  if (!ok) return;

  if (app.mode === 'recovery') {
    if (leaveRecovery(preview.result.data)) {
      app.importPreview = null;
      render();
      showToast('已從備份還原資料。');
    }
    return;
  }
  if (preview.exportFirst) exportBackup();
  app.importPreview = null;
  if (!commit(preview.result.data, '已從備份還原資料。')) {
    app.importPreview = preview;
    render();
  }
}

async function loadSampleData() {
  const { todos, habits, checkins } = app.data;
  if (todos.length + habits.length > 0) {
    const ok = await confirmAction({
      title: '加入範例資料？',
      message: '範例資料會「加入」到目前的資料中，不會刪除你原有的內容。\n範例項目名稱前會標示「（範例）」，之後可以自行刪除或封存。',
      confirmText: '加入範例',
    });
    if (!ok) return;
  }
  const sample = buildSampleData(app.todayKey);
  commit(
    {
      todos: [...todos, ...sample.todos],
      habits: [...habits, ...sample.habits],
      checkins: [...checkins, ...sample.checkins],
    },
    '已載入範例資料。',
  );
}

async function clearAllData() {
  const ok = await confirmAction({
    title: '清除所有資料？',
    message: '這個瀏覽器中所有的待辦、習慣與打卡紀錄都會被刪除，無法復原。\n如果還沒備份，請先按「取消」，再到「匯出備份」下載備份檔。',
    confirmText: '全部清除',
    danger: true,
  });
  if (!ok) return;
  commit(emptyData(), '已清除所有資料。');
}

// ----- 資料救援（儲存的資料無法讀取時） -----

function renderRecovery() {
  const { raw, errors } = app.corrupt;
  replaceChildren(
    $('view-recovery'),
    h('h2', { id: 'heading-recovery', class: 'view-title', tabindex: '-1' }, '無法讀取已儲存的資料'),
    h(
      'div',
      { class: 'notice notice--error' },
      h(
        'p',
        {},
        '這個瀏覽器裡有本工具的資料，但內容無法正確讀取（可能已損壞，或是由較新版本的網頁建立）。',
        h('strong', {}, '為了保護你的資料，程式沒有修改或刪除它。'),
      ),
      h(
        'details',
        {},
        h('summary', {}, '查看錯誤細節'),
        h('ul', { class: 'bullets' }, errors.map((error) => h('li', {}, error))),
      ),
    ),
    h(
      'section',
      { class: 'card', 'aria-labelledby': 'recovery-1' },
      h('h3', { id: 'recovery-1' }, '1. 先下載原始資料'),
      h('p', {}, '把目前無法讀取的內容存成檔案，之後可以請人協助修復。'),
      button('下載原始資料', () => downloadText(`daily-habit-raw-${app.todayKey}.txt`, raw, 'text/plain'), {
        variant: 'primary',
        focusKey: 'recovery-download',
      }),
    ),
    h(
      'section',
      { class: 'card', 'aria-labelledby': 'recovery-2' },
      h('h3', { id: 'recovery-2' }, '2. 重新整理'),
      h('p', {}, '如果你剛在其他分頁或較新版本的網頁使用過，重新整理可能就能解決。'),
      button('重新整理頁面', () => location.reload(), { focusKey: 'recovery-reload' }),
    ),
    h(
      'section',
      { class: 'card', 'aria-labelledby': 'recovery-3' },
      h('h3', { id: 'recovery-3' }, '3. 從備份還原'),
      renderImporter({ allowExportFirst: false }),
    ),
    h(
      'section',
      { class: 'card danger-zone', 'aria-labelledby': 'recovery-4' },
      h('h3', { id: 'recovery-4' }, '4. 改用空白資料重新開始'),
      h('p', {}, '無法讀取的原始內容會另外保留在瀏覽器中（不會被刪除），然後以空白資料開始使用。'),
      button('改用空白資料開始…', startFresh, { variant: 'danger', focusKey: 'recovery-fresh' }),
    ),
  );
}

/** 離開救援模式：先另存損壞的原始內容，再寫入新資料。 */
function leaveRecovery(data) {
  const preserved = preserveCorruptData(app.storage, app.corrupt.raw);
  if (!preserved.ok) {
    addNotice(preserved.message, 'error');
    return false;
  }
  const saved = saveData(app.storage, data);
  if (!saved.ok) {
    addNotice(saved.message, 'error');
    return false;
  }
  app.mode = 'normal';
  app.corrupt = null;
  app.data = data;
  app.view = 'today';
  if (location.hash !== '#today') history.replaceState(null, '', '#today');
  addNotice(`無法讀取的原始資料已另存在瀏覽器的「${preserved.key}」。`, 'info');
  return true;
}

async function startFresh() {
  const ok = await confirmAction({
    title: '改用空白資料開始？',
    message: '無法讀取的原始內容會另外保留，不會被刪除。建議先按「下載原始資料」存一份檔案。',
    confirmText: '以空白資料開始',
    danger: true,
  });
  if (!ok) return;
  if (leaveRecovery(emptyData())) {
    render();
    focusHeading();
    showToast('已改用空白資料開始。');
  }
}

// ---------- 對話框 ----------

function openDialog(dialog) {
  app.dialogReturnKey = document.activeElement?.dataset?.focusKey ?? null;
  dialog.showModal();
}

function setupDialogs() {
  for (const dialog of document.querySelectorAll('dialog')) {
    dialog.addEventListener('close', () => {
      // 對話框關閉後，把焦點還給開啟它的按鈕（若按鈕已重新繪製，依 data-focus-key 找回）。
      setTimeout(() => {
        const active = document.activeElement;
        if (active && active !== document.body && active.isConnected) return;
        if (!focusByKey(app.dialogReturnKey)) focusHeading();
      }, 0);
    });
    for (const closeButton of dialog.querySelectorAll('[data-close]')) {
      closeButton.addEventListener('click', () => dialog.close());
    }
  }
  $('todo-form').addEventListener('submit', submitTodoForm);
  $('habit-form').addEventListener('submit', submitHabitForm);
  $('todo-due-clear').addEventListener('click', () => {
    $('todo-due').value = '';
    $('todo-due').focus();
  });
}

/** 確認對話框，回傳 Promise<boolean>。 */
function confirmAction({ title, message, confirmText = '確定', danger = false }) {
  const dialog = $('confirm-dialog');
  if (typeof dialog.showModal !== 'function') {
    return Promise.resolve(window.confirm(`${title}\n\n${message}`));
  }
  $('confirm-title').textContent = title;
  $('confirm-message').textContent = message;
  const ok = $('confirm-ok');
  ok.textContent = confirmText;
  ok.className = `btn ${danger ? 'btn--danger' : 'btn--primary'}`;
  dialog.returnValue = '';
  openDialog(dialog);
  $('confirm-cancel').focus();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
  });
}

init();
