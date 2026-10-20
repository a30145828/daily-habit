// 任務區域：清單與月曆、搜尋篩選排序、任務項目與編輯對話框（含重複任務）。

import {
  addMonthsToMonthKey,
  formatDateLabel,
  formatMonth,
  isValidDateKey,
  monthGrid,
  monthKeyOf,
  monthRange,
  weekdayLabel,
} from '../dates.js';
import { createId } from '../ids.js';
import {
  FREQ_LABELS,
  MONTH_END_LABELS,
  createSeries,
  describeRule,
  endSeriesFrom,
  materialize,
  splitSeries,
  validateRule,
} from '../recurrence.js';
import {
  PRIORITY_LABELS,
  SORTS,
  SORT_LABELS,
  VIEWS as TASK_VIEWS,
  VIEW_LABELS,
  allTags,
  calendarTasks,
  createTask,
  deleteTask,
  dueStatus,
  setTaskArchived,
  setTaskDone,
  taskView,
  toggleSubtask,
  updateTask,
  upsertTask,
  validateTaskInput,
  viewCounts,
} from '../tasks.js';
import {
  app,
  button,
  checkDateChange,
  chooseAction,
  commit,
  confirmAction,
  emptyState,
  h,
  inputField,
  openFormDialog,
  radioField,
  readWeekdays,
  render,
  replaceChildren,
  selectField,
  textareaField,
  viewHead,
  weekdayField,
} from './core.js';

const state = () =>
  (app.ui.tasks ??= {
    view: 'today',
    query: '',
    tag: '',
    priority: '',
    sort: 'due',
    mode: 'list',
    month: monthKeyOf(app.todayKey),
    selectedDate: app.todayKey,
  });

/** 從其他區域（例如今日頁）切換到任務區域的指定視圖。 */
export function showTaskView(view) {
  state().view = view;
  state().mode = 'list';
}

// ---------- 任務項目 ----------

function seriesOf(task) {
  return task.seriesId ? app.data.series.find((s) => s.id === task.seriesId) ?? null : null;
}

export function renderTaskItem(task, { context = 'list' } = {}) {
  const status = dueStatus(task, app.todayKey);
  const checkId = `task-done-${context}-${task.id}`;
  const metaId = `task-meta-${context}-${task.id}`;
  const series = seriesOf(task);

  const badges = [h('span', { class: `badge badge--${task.priority}` }, `優先：${PRIORITY_LABELS[task.priority]}`)];
  if (task.done) {
    badges.push(h('span', { class: 'badge badge--done' }, '✓ 已完成'));
    if (task.dueDate) badges.push(h('span', { class: 'badge' }, `截止 ${formatDateLabel(task.dueDate)}`));
  } else if (status === 'overdue') {
    badges.push(h('span', { class: 'badge badge--overdue' }, `⚠ 已逾期・截止 ${formatDateLabel(task.dueDate)}`));
  } else if (status === 'today') {
    badges.push(h('span', { class: 'badge badge--today' }, '今天到期'));
  } else if (status === 'upcoming') {
    badges.push(h('span', { class: 'badge' }, `截止 ${formatDateLabel(task.dueDate)}`));
  } else {
    badges.push(h('span', { class: 'badge badge--muted' }, '無截止日期'));
  }
  if (series) badges.push(h('span', { class: 'badge badge--repeat' }, `🔁 ${describeRule(series.rule)}`));
  if (task.archived) badges.push(h('span', { class: 'badge badge--muted' }, '已封存'));
  for (const tag of task.tags) badges.push(h('span', { class: 'badge badge--tag' }, `#${tag}`));
  const subDone = task.subtasks.filter((s) => s.done).length;
  if (task.subtasks.length) badges.push(h('span', { class: 'badge' }, `子任務 ${subDone}/${task.subtasks.length}`));

  const actions = [
    button('編輯', () => editTask(task), {
      variant: 'ghost',
      size: 'small',
      focusKey: `task-edit-${context}-${task.id}`,
      label: `編輯「${task.title}」`,
    }),
  ];
  if (series && !task.done && task.virtual && status === 'overdue') {
    actions.push(
      button('略過', () => skipOccurrence(task), {
        variant: 'ghost',
        size: 'small',
        focusKey: `task-skip-${context}-${task.id}`,
        label: `略過「${task.title}」這一次`,
      }),
    );
  }
  if (!series && !task.virtual) {
    actions.push(
      button(task.archived ? '取消封存' : '封存', () => archiveTask(task, !task.archived), {
        variant: 'ghost',
        size: 'small',
        focusKey: `task-archive-${context}-${task.id}`,
        label: `${task.archived ? '取消封存' : '封存'}「${task.title}」`,
      }),
    );
  }
  actions.push(
    button('刪除', () => deleteTaskFlow(task), {
      variant: 'ghost-danger',
      size: 'small',
      focusKey: `task-delete-${context}-${task.id}`,
      label: `刪除「${task.title}」`,
    }),
  );

  return h(
    'li',
    { class: `todo${task.done ? ' is-done' : ''}` },
    h(
      'label',
      { class: 'todo-check' },
      h('input', {
        type: 'checkbox',
        id: checkId,
        checked: task.done,
        disabled: task.archived || null,
        'aria-describedby': metaId,
        dataset: { focusKey: `task-done-${context}-${task.id}` },
        onChange: (event) => toggleTaskDone(task, event.target.checked),
      }),
    ),
    h(
      'div',
      { class: 'todo-main' },
      h('label', { for: checkId, class: 'todo-title' }, task.title),
      h('p', { class: 'todo-meta', id: metaId }, badges),
      task.missedCount > 1 ? h('p', { class: 'small muted' }, `（這個重複任務在這之前還有 ${task.missedCount - 1} 次未完成，已不再列出）`) : null,
      task.note ? h('p', { class: 'todo-note' }, task.note) : null,
      task.subtasks.length
        ? h(
            'ul',
            { class: 'subtask-list', 'aria-label': `「${task.title}」的子任務` },
            task.subtasks.map((sub) =>
              h(
                'li',
                {},
                h(
                  'label',
                  { class: 'checkbox-label' },
                  h('input', {
                    type: 'checkbox',
                    checked: sub.done,
                    disabled: task.archived || null,
                    dataset: { focusKey: `sub-${context}-${task.id}-${sub.id}` },
                    onChange: () => toggleSubtaskFlow(task, sub.id),
                  }),
                  h('span', { class: sub.done ? 'is-struck' : '' }, sub.title),
                ),
              ),
            ),
          )
        : null,
    ),
    h('div', { class: 'todo-actions' }, actions),
  );
}

export function renderTaskList(tasks, context) {
  return h('ul', { class: 'todo-list' }, tasks.map((task) => renderTaskItem(task, { context })));
}

// ---------- 任務操作 ----------

function saveTask(task, message) {
  return commit({ ...app.data, tasks: upsertTask(app.data.tasks, task) }, message);
}

export function toggleTaskDone(task, done) {
  const message = done ? `已完成「${task.title}」。` : `已取消完成「${task.title}」。`;
  if (task.virtual) {
    const now = new Date();
    return saveTask(materialize(task, { done, completedAt: done ? now.toISOString() : null }, now), message);
  }
  return commit({ ...app.data, tasks: setTaskDone(app.data.tasks, task.id, done) }, message);
}

function toggleSubtaskFlow(task, subtaskId) {
  if (task.virtual) {
    const subtasks = task.subtasks.map((s) => (s.id === subtaskId ? { ...s, done: !s.done } : s));
    return saveTask(materialize(task, { subtasks }), null);
  }
  return commit({ ...app.data, tasks: toggleSubtask(app.data.tasks, task.id, subtaskId) });
}

function skipOccurrence(task) {
  saveTask(materialize(task, { skipped: true }), `已略過「${task.title}」${formatDateLabel(task.occurrenceDate)} 這一次。`);
}

function archiveTask(task, archived) {
  commit(
    { ...app.data, tasks: setTaskArchived(app.data.tasks, task.id, archived) },
    archived ? `已封存「${task.title}」，可在「已封存」視圖找回。` : `已取消封存「${task.title}」。`,
  );
}

async function deleteTaskFlow(task) {
  const series = seriesOf(task);
  if (!series) {
    const ok = await confirmAction({
      title: '刪除任務',
      message: `確定要刪除「${task.title}」嗎？\n刪除後無法復原。若只是暫時不需要，可以改用「封存」。`,
      confirmText: '刪除',
      danger: true,
    });
    if (ok) commit({ ...app.data, tasks: deleteTask(app.data.tasks, task.id) }, '已刪除任務。');
    return;
  }
  const choice = await chooseAction({
    title: '刪除重複任務',
    message: `「${task.title}」是重複任務（${describeRule(series.rule)}）。要刪除哪些項目？\n已完成的過去紀錄都會保留。`,
    choices: [
      { value: 'this', label: `只刪除這次（${formatDateLabel(task.occurrenceDate)}）` },
      { value: 'future', label: '這次及之後的項目', variant: 'danger' },
      { value: 'all', label: '整個重複任務', variant: 'danger' },
    ],
  });
  if (!choice) return;
  if (choice === 'this') {
    const base = task.virtual ? materialize(task) : task;
    saveTask({ ...base, skipped: true, done: false, completedAt: null, updatedAt: new Date().toISOString() }, '已刪除這一次。');
  } else if (choice === 'future') {
    const result = endSeriesFrom(app.data.series, app.data.tasks, series.id, task.occurrenceDate);
    commit({ ...app.data, ...result }, '已刪除這次及之後的項目。');
  } else {
    const result = endSeriesFrom(app.data.series, app.data.tasks, series.id, series.startDate);
    commit({ ...app.data, ...result }, '已刪除整個重複任務（已完成的紀錄保留）。');
  }
}

async function editTask(task) {
  const series = seriesOf(task);
  if (!series) return openTaskDialog({ mode: task.virtual ? 'occurrence' : 'single', task });
  const choice = await chooseAction({
    title: '修改重複任務',
    message: `「${task.title}」是重複任務（${describeRule(series.rule)}）。要修改哪些項目？`,
    choices: [
      { value: 'this', label: `只修改這次（${formatDateLabel(task.occurrenceDate)}）`, variant: 'primary' },
      { value: 'future', label: '這次及未來的項目' },
    ],
  });
  if (choice === 'this') openTaskDialog({ mode: 'occurrence', task });
  else if (choice === 'future') openTaskDialog({ mode: 'series', task, series });
}

// ---------- 任務表單 ----------

function subtaskEditor(subtasks) {
  const list = h('ul', { class: 'subtask-editor' });
  let counter = 0;
  const addRow = (sub = { id: createId('st'), title: '', done: false }) => {
    counter += 1;
    const inputId = `subtask-input-${counter}`;
    const input = h('input', { id: inputId, type: 'text', value: sub.title, maxlength: '200', autocomplete: 'off' });
    const row = h(
      'li',
      { dataset: { id: sub.id, done: String(Boolean(sub.done)) } },
      h('label', { for: inputId, class: 'visually-hidden' }, `子任務 ${counter}`),
      input,
      button(
        '移除',
        () => {
          row.remove();
          addButton.focus();
        },
        { variant: 'ghost-danger', size: 'small', label: `移除子任務 ${counter}` },
      ),
    );
    list.append(row);
    return input;
  };
  const addButton = button('＋ 新增子任務', () => addRow().focus(), { size: 'small' });
  subtasks.forEach((sub) => addRow(sub));
  return h('fieldset', { class: 'field', id: 'task-subtasks' }, h('legend', {}, '子任務 ', h('span', { class: 'optional' }, '（選填）')), list, addButton, h('p', { id: 'task-subtasks-error', class: 'field-error', hidden: true }));
}

function readSubtasks(form) {
  return [...form.querySelectorAll('.subtask-editor li')].map((li) => ({
    id: li.dataset.id,
    title: li.querySelector('input').value,
    done: li.dataset.done === 'true',
  }));
}

function repeatFields(rule, startLabelHint) {
  const freq = rule?.freq ?? 'none';
  const weekly = h('div', { class: 'repeat-detail', hidden: freq !== 'weekly' }, weekdayField({ id: 'task-weekdays', legend: '每週的哪幾天', value: rule?.weekdays ?? [] }));
  const monthly = h(
    'div',
    { class: 'repeat-detail', hidden: freq !== 'monthly' },
    inputField({ id: 'task-monthday', label: '每月幾日', type: 'number', value: rule?.monthDay ?? '', attrs: { min: '1', max: '31', inputmode: 'numeric' } }),
    radioField({
      id: 'task-monthend',
      legend: '該月沒有這一天時（例如 2 月 30 日）',
      value: rule?.monthEnd ?? 'last',
      options: Object.entries(MONTH_END_LABELS).map(([value, label]) => ({ value, label })),
    }),
  );
  const select = selectField({
    id: 'task-repeat',
    label: '重複',
    value: freq,
    hint: startLabelHint,
    options: [{ value: 'none', label: '不重複' }, ...Object.entries(FREQ_LABELS).map(([value, label]) => ({ value, label }))],
    onChange: (event) => {
      weekly.hidden = event.target.value !== 'weekly';
      monthly.hidden = event.target.value !== 'monthly';
    },
  });
  return h('div', { class: 'repeat-fields' }, select, weekly, monthly);
}

function readRule(form) {
  const freq = form.elements['task-repeat']?.value ?? 'none';
  if (freq === 'none') return { ok: true, value: null };
  return validateRule({
    freq,
    weekdays: readWeekdays(form, 'task-weekdays'),
    monthDay: Number(form.elements['task-monthday'].value),
    monthEnd: form.querySelector('input[name="task-monthend"]:checked')?.value,
  });
}

/**
 * 任務表單。mode：
 * - new：新增（可設定重複）
 * - single：修改一般任務
 * - occurrence：只修改重複任務的這一次（可移動日期）
 * - series：修改這次及未來（修改規則內容）
 */
export function openTaskDialog({ mode = 'new', task = null, series = null, defaultDue = null }) {
  const titles = { new: '新增任務', single: '編輯任務', occurrence: '修改這一次', series: '修改這次及未來的項目' };
  const source = mode === 'series' ? series : task;
  const showRepeat = mode === 'new' || mode === 'series';
  const showDue = mode !== 'series';

  openFormDialog({
    title: titles[mode],
    wide: true,
    body: () =>
      h(
        'div',
        {},
        mode === 'series'
          ? h('p', { class: 'notice notice--info small' }, `從 ${formatDateLabel(task.occurrenceDate)} 起套用新內容；之前的項目與已完成紀錄不受影響。`)
          : null,
        inputField({ id: 'task-title', label: '名稱', required: true, value: source?.title ?? '', attrs: { maxlength: '200' } }),
        textareaField({ id: 'task-note', label: '備註', value: source?.note ?? '' }),
        showDue
          ? inputField({
              id: 'task-due',
              label: mode === 'new' ? '截止日期（重複任務為開始日期）' : '截止日期',
              type: 'date',
              value: task?.dueDate ?? defaultDue ?? '',
            })
          : null,
        radioField({
          id: 'task-priority',
          legend: '優先程度',
          value: source?.priority ?? 'medium',
          options: Object.entries(PRIORITY_LABELS).map(([value, label]) => ({ value, label })),
        }),
        inputField({
          id: 'task-tags',
          label: '標籤',
          value: (source?.tags ?? []).join('、'),
          hint: '多個標籤用逗號或頓號分隔，例如：工作、家裡',
        }),
        subtaskEditor(source?.subtasks ?? []),
        showRepeat ? repeatFields(mode === 'series' ? series.rule : null, mode === 'new' ? '重複任務需要開始日期（沒填時從今天開始）。' : null) : null,
      ),
    onSubmit: (form) => submitTaskForm(form, { mode, task, series }),
  });
}

function submitTaskForm(form, { mode, task, series }) {
  const input = {
    title: form.elements['task-title'].value,
    note: form.elements['task-note'].value,
    dueDate: form.elements['task-due']?.value || null,
    priority: form.querySelector('input[name="task-priority"]:checked')?.value,
    tags: form.elements['task-tags'].value,
    subtasks: readSubtasks(form),
  };
  const result = validateTaskInput(input);
  const errors = {};
  if (!result.ok) {
    const map = { title: 'task-title', note: 'task-note', dueDate: 'task-due', priority: 'task-priority', tags: 'task-tags', subtasks: 'task-subtasks' };
    for (const [key, message] of Object.entries(result.errors)) errors[map[key]] = message;
  }
  const rule = mode === 'new' || mode === 'series' ? readRule(form) : { ok: true, value: null };
  if (!rule.ok) {
    const freq = form.elements['task-repeat'].value;
    errors[freq === 'weekly' ? 'task-weekdays' : 'task-monthday'] = rule.error;
  }
  if (mode === 'series' && !rule.value) errors['task-repeat'] = '修改未來項目時請保留重複設定；若要停止重複，請改用「刪除這次及之後」。';
  if (Object.keys(errors).length) return errors;
  const value = result.value;
  const now = new Date();

  if (mode === 'new') {
    if (rule.value) {
      checkDateChange();
      const startDate = value.dueDate ?? app.todayKey;
      const created = createSeries({ ...value, rule: rule.value, startDate }, now);
      return commit({ ...app.data, series: [...app.data.series, created] }, `已新增重複任務「${value.title}」（${describeRule(rule.value)}）。`);
    }
    return commit({ ...app.data, tasks: [...app.data.tasks, createTask(value, now)] }, '已新增任務。');
  }
  if (mode === 'single') {
    return commit({ ...app.data, tasks: updateTask(app.data.tasks, task.id, value, now) }, '已儲存變更。');
  }
  if (mode === 'occurrence') {
    const base = task.virtual ? materialize(task, {}, now) : task;
    const saved = { ...base, ...value, dueDate: value.dueDate ?? task.occurrenceDate, updatedAt: now.toISOString() };
    return saveTask(saved, '已修改這一次。');
  }
  // series：這次及未來
  const split = splitSeries(app.data.series, app.data.tasks, series.id, task.occurrenceDate, { ...value, rule: rule.value }, now);
  return commit({ ...app.data, series: split.series, tasks: split.tasks }, '已修改這次及未來的項目。');
}

// ---------- 任務區域 ----------

function toolbar(results) {
  const s = state();
  const tags = allTags(app.data);
  const rerender = () => renderResults(results);
  return h(
    'div',
    { class: 'toolbar' },
    h(
      'div',
      { class: 'field field--search' },
      h('label', { for: 'task-search' }, '搜尋'),
      h('input', {
        id: 'task-search',
        type: 'search',
        value: s.query,
        placeholder: '名稱、備註、標籤、子任務',
        autocomplete: 'off',
        dataset: { focusKey: 'task-search' },
        onInput: (event) => {
          s.query = event.target.value;
          rerender();
        },
      }),
    ),
    h(
      'div',
      { class: 'toolbar-row' },
      selectField({
        id: 'task-filter-tag',
        label: '標籤',
        required: null,
        value: s.tag,
        options: [{ value: '', label: '全部標籤' }, ...tags.map((tag) => ({ value: tag, label: `#${tag}` }))],
        onChange: (event) => {
          s.tag = event.target.value;
          rerender();
        },
      }),
      selectField({
        id: 'task-filter-priority',
        label: '優先程度',
        required: null,
        value: s.priority,
        options: [{ value: '', label: '全部' }, ...Object.entries(PRIORITY_LABELS).map(([value, label]) => ({ value, label }))],
        onChange: (event) => {
          s.priority = event.target.value;
          rerender();
        },
      }),
      selectField({
        id: 'task-sort',
        label: '排序',
        required: null,
        value: s.sort,
        options: SORTS.map((value) => ({ value, label: SORT_LABELS[value] })),
        onChange: (event) => {
          s.sort = event.target.value;
          rerender();
        },
      }),
    ),
  );
}

function filters() {
  const s = state();
  return { query: s.query, tag: s.tag, priority: s.priority };
}

function renderResults(container) {
  const s = state();
  if (s.mode === 'calendar') return replaceChildren(container, renderCalendar());
  const list = taskView(app.data, s.view, app.todayKey, { filters: filters(), sort: s.sort, weekStart: app.data.settings.weekStart });
  const hasFilter = s.query || s.tag || s.priority;
  const emptyMessages = {
    today: '今天沒有到期的任務。',
    overdue: '沒有逾期的任務。',
    week: '本週接下來沒有到期的任務。',
    all: '還沒有任何任務。',
    done: '還沒有已完成的任務。',
    archived: '沒有封存的任務。',
  };
  replaceChildren(
    container,
    h('p', { class: 'small muted', role: 'status' }, hasFilter ? `符合條件：${list.length} 項` : `共 ${list.length} 項`),
    list.length
      ? renderTaskList(list, 'tasks')
      : emptyState(
          hasFilter ? '沒有符合搜尋或篩選條件的任務' : emptyMessages[s.view],
          s.view === 'all' && !hasFilter ? '按「新增任務」建立第一筆。截止日期可以不填。' : null,
        ),
  );
}

function renderCalendar() {
  const s = state();
  const { start, end } = monthRange(s.month);
  const grid = monthGrid(s.month, app.data.settings.weekStart);
  const map = calendarTasks(app.data, grid[0], grid.at(-1), app.todayKey, filters());
  const weekdays = grid.slice(0, 7).map((d) => weekdayLabel(d));
  if (!isValidDateKey(s.selectedDate)) s.selectedDate = app.todayKey;
  const selected = map[s.selectedDate] ?? [];
  const nav = (months) => {
    s.month = addMonthsToMonthKey(s.month, months);
    render();
  };
  return h(
    'div',
    { class: 'calendar' },
    h(
      'div',
      { class: 'calendar-nav' },
      button('‹ 上個月', () => nav(-1), { size: 'small', focusKey: 'cal-prev', label: '上個月' }),
      h('h3', { class: 'calendar-title', 'aria-live': 'polite' }, formatMonth(s.month)),
      button('下個月 ›', () => nav(1), { size: 'small', focusKey: 'cal-next', label: '下個月' }),
    ),
    button(
      '回到本月',
      () => {
        s.month = monthKeyOf(app.todayKey);
        s.selectedDate = app.todayKey;
        render();
      },
      { variant: 'ghost', size: 'small', focusKey: 'cal-today' },
    ),
    h(
      'div',
      { class: 'calendar-grid', role: 'group', 'aria-label': `${formatMonth(s.month)}月曆` },
      weekdays.map((w) => h('span', { class: 'calendar-weekday', 'aria-hidden': 'true' }, w)),
      grid.map((date) => {
        const items = map[date] ?? [];
        const open = items.filter((t) => !t.done).length;
        const inMonth = date >= start && date <= end;
        const label = `${formatDateLabel(date)}${date === app.todayKey ? '（今天）' : ''}，${items.length ? `${items.length} 項任務，${open} 項未完成` : '沒有任務'}`;
        return h(
          'button',
          {
            type: 'button',
            class: `calendar-day${inMonth ? '' : ' is-outside'}${date === app.todayKey ? ' is-today' : ''}`,
            'aria-pressed': String(date === s.selectedDate),
            'aria-label': label,
            dataset: { focusKey: `cal-day-${date}` },
            onClick: () => {
              s.selectedDate = date;
              render();
            },
          },
          h('span', { class: 'calendar-date', 'aria-hidden': 'true' }, String(Number(date.slice(8)))),
          items.length ? h('span', { class: `calendar-count${open ? '' : ' is-done'}`, 'aria-hidden': 'true' }, open ? `${open}` : '✓') : null,
        );
      }),
    ),
    h(
      'section',
      { class: 'section', 'aria-labelledby': 'cal-selected' },
      h(
        'div',
        { class: 'section-head' },
        h('h3', { id: 'cal-selected', class: 'section-title' }, `${formatDateLabel(s.selectedDate)} 的任務（${selected.length}）`),
        button('＋ 在這天新增', () => openTaskDialog({ defaultDue: s.selectedDate }), { variant: 'primary', size: 'small', focusKey: 'cal-add' }),
      ),
      selected.length ? renderTaskList(selected, 'cal') : h('p', { class: 'muted' }, '這天沒有任務。'),
    ),
  );
}

export function renderTasks(panel) {
  const s = state();
  const counts = viewCounts(app.data, app.todayKey, app.data.settings.weekStart);
  const results = h('div', { class: 'task-results' });
  replaceChildren(
    panel,
    viewHead('tasks', '任務', button('＋ 新增任務', () => openTaskDialog({}), { variant: 'primary', focusKey: 'tasks-add' })),
    h(
      'div',
      { class: 'mode-switch', role: 'group', 'aria-label': '顯示方式' },
      button('清單', () => ((s.mode = 'list'), render()), { size: 'small', pressed: s.mode === 'list', focusKey: 'mode-list' }),
      button('月曆', () => ((s.mode = 'calendar'), render()), { size: 'small', pressed: s.mode === 'calendar', focusKey: 'mode-calendar' }),
    ),
    s.mode === 'list'
      ? h(
          'fieldset',
          { class: 'filter' },
          h('legend', { class: 'visually-hidden' }, '任務視圖'),
          h(
            'div',
            { class: 'segmented segmented--scroll' },
            TASK_VIEWS.map((view) =>
              h(
                'label',
                {},
                h('input', {
                  type: 'radio',
                  name: 'task-view',
                  value: view,
                  checked: s.view === view,
                  dataset: { focusKey: `task-view-${view}` },
                  onChange: () => {
                    s.view = view;
                    render();
                  },
                }),
                h('span', {}, `${VIEW_LABELS[view]}（${counts[view]}）`),
              ),
            ),
          ),
        )
      : null,
    h(
      'details',
      {
        class: 'filters',
        open: s.filtersOpen || Boolean(s.query || s.tag || s.priority) || null,
        onToggle: (event) => {
          s.filtersOpen = event.target.open;
        },
      },
      h('summary', { dataset: { focusKey: 'task-filters' } }, '搜尋、篩選與排序'),
      toolbar(results),
    ),
    results,
  );
  renderResults(results);
}

