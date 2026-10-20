// 習慣區域：新增、排程、打卡與補登、最近七天、月份紀錄、完成率與連續天數、封存。

import { addDays, addMonthsToMonthKey, formatDateLabel, formatMonth, monthKeyOf, weekdayLabel } from '../dates.js';
import {
  ALL_DAYS,
  DAY_MARKS,
  DAY_STATUS_LABELS,
  activeHabits,
  archivedHabits,
  canCheckin,
  completionStats,
  createHabit,
  currentSchedule,
  currentStreak,
  describeDays,
  isCheckedIn,
  isScheduledOn,
  longestStreak,
  monthCompletion,
  monthHistory,
  recentHistory,
  renameHabit,
  setCheckin,
  setHabitArchived,
  setHabitSchedule,
  validateHabitName,
  validateScheduleDays,
} from '../habits.js';
import {
  app,
  addNotice,
  button,
  checkDateChange,
  commit,
  emptyState,
  h,
  inputField,
  openFormDialog,
  radioField,
  readWeekdays,
  replaceChildren,
  section,
  viewHead,
  weekdayField,
} from './core.js';

/** 防止連點兩下時「剛打卡就被取消」。 */
export const CHECKIN_REPEAT_GUARD_MS = 400;
const lastCheckinTap = new Map();

function pct(rate) {
  return rate === null ? '—' : `${Math.round(rate * 100)}%`;
}

/**
 * 切換某習慣某天的打卡。date 省略時為今天。
 * 今天的打卡會先確認日期（手機休眠後計時器可能還沒更新），已換日時只更新畫面。
 */
export function toggleHabitCheckin(habit, date = null, { guard = true } = {}) {
  if (date === null) {
    if (checkDateChange()) return false;
    date = app.todayKey;
  }
  const key = `${habit.id}|${date}`;
  const now = Date.now();
  if (guard && now - (lastCheckinTap.get(key) ?? -Infinity) < CHECKIN_REPEAT_GUARD_MS) return false;
  lastCheckinTap.set(key, now);
  const allowed = canCheckin(habit, date, app.todayKey);
  if (!allowed.ok) {
    addNotice(allowed.error, 'warning', { key: 'checkin' });
    return false;
  }
  const done = isCheckedIn(app.data.checkins, habit.id, date);
  const checkins = setCheckin(app.data.checkins, habit.id, date, !done);
  const when = date === app.todayKey ? '今天' : formatDateLabel(date);
  return commit({ ...app.data, checkins }, done ? `已取消「${habit.name}」${when}的打卡。` : `「${habit.name}」${when}已打卡！`);
}

export function weekRow(habit) {
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

export function weekLegend() {
  return h(
    'ul',
    { class: 'legend', 'aria-label': '紀錄圖示說明' },
    ['done', 'missed', 'pending', 'rest', 'not-started', 'archived'].map((status) =>
      h('li', {}, h('span', { class: `day-mark day--${status}`, 'aria-hidden': 'true' }, DAY_MARKS[status]), DAY_STATUS_LABELS[status]),
    ),
  );
}

export function todayStatus(habit) {
  const done = isCheckedIn(app.data.checkins, habit.id, app.todayKey);
  if (done) return h('span', { class: 'status status--done' }, '✓ 今天已打卡');
  if (!isScheduledOn(habit, app.todayKey)) return h('span', { class: 'status status--rest' }, '· 今天非排定日');
  return h('span', { class: 'status status--pending' }, '○ 今天尚未打卡');
}

export function checkinButton(habit, prefix) {
  const done = isCheckedIn(app.data.checkins, habit.id, app.todayKey);
  const scheduled = isScheduledOn(habit, app.todayKey);
  const text = done ? '取消打卡' : scheduled ? '✓ 完成打卡' : '仍要打卡';
  return button(text, () => toggleHabitCheckin(habit), {
    variant: done || !scheduled ? 'secondary' : 'primary',
    focusKey: `${prefix}-check-${habit.id}`,
    label: done ? `取消「${habit.name}」今天的打卡` : `為「${habit.name}」完成今天的打卡`,
  });
}

// ---------- 表單 ----------

function scheduleFields(days) {
  const type = days.length === 7 ? 'daily' : 'weekly';
  const weekly = h('div', { class: 'repeat-detail', hidden: type !== 'weekly' }, weekdayField({ id: 'habit-days', legend: '每週的哪幾天', value: type === 'weekly' ? days : [] }));
  return h(
    'div',
    {},
    radioField({
      id: 'habit-schedule',
      legend: '執行頻率',
      value: type,
      options: [
        { value: 'daily', label: '每天' },
        { value: 'weekly', label: '每週指定星期' },
      ],
      onChange: (event) => {
        weekly.hidden = event.target.value !== 'weekly';
      },
    }),
    weekly,
  );
}

function readSchedule(form) {
  const type = form.querySelector('input[name="habit-schedule"]:checked')?.value;
  if (type !== 'weekly') return { ok: true, value: ALL_DAYS.slice() };
  return validateScheduleDays(readWeekdays(form, 'habit-days'));
}

export function openNewHabitDialog() {
  openFormDialog({
    title: '新增習慣',
    body: () =>
      h(
        'div',
        {},
        inputField({ id: 'habit-name', label: '習慣名稱', required: true, attrs: { maxlength: '100', placeholder: '例如：喝水 8 杯' } }),
        scheduleFields(ALL_DAYS),
        h('p', { class: 'small muted' }, '建立當天之前的日期、非排定日，都不會算成漏打卡。'),
      ),
    onSubmit: (form) => {
      const name = validateHabitName(form.elements['habit-name'].value);
      const days = readSchedule(form);
      const errors = {};
      if (!name.ok) errors['habit-name'] = name.error;
      if (!days.ok) errors['habit-days'] = days.error;
      if (Object.keys(errors).length) return errors;
      checkDateChange();
      const habit = createHabit(name.value, days.value, app.todayKey);
      return commit({ ...app.data, habits: [...app.data.habits, habit] }, `已新增習慣「${name.value}」（${describeDays(days.value)}）。`);
    },
  });
}

function openEditHabitDialog(habit) {
  openFormDialog({
    title: '編輯習慣',
    body: () =>
      h(
        'div',
        {},
        inputField({ id: 'habit-name', label: '習慣名稱', required: true, value: habit.name, attrs: { maxlength: '100' } }),
        scheduleFields(currentSchedule(habit)),
        h('p', { class: 'notice notice--info small' }, '修改執行頻率只從今天起生效，過去的完成率與連續天數依當時的排程計算，不會被改寫。'),
      ),
    onSubmit: (form) => {
      const name = validateHabitName(form.elements['habit-name'].value);
      const days = readSchedule(form);
      const errors = {};
      if (!name.ok) errors['habit-name'] = name.error;
      if (!days.ok) errors['habit-days'] = days.error;
      if (Object.keys(errors).length) return errors;
      let habits = renameHabit(app.data.habits, habit.id, name.value);
      const changed = days.value.join() !== currentSchedule(habit).join();
      if (changed) habits = setHabitSchedule(habits, habit.id, days.value, app.todayKey);
      return commit({ ...app.data, habits }, changed ? '已更新習慣，新的頻率從今天起生效。' : '已更新習慣。');
    },
  });
}

/** 月份紀錄與補登：點日期即可打卡或取消。 */
export function openMonthDialog(habitId) {
  let month = monthKeyOf(app.todayKey);
  let container;
  const draw = () => {
    const habit = app.data.habits.find((x) => x.id === habitId);
    if (!habit) return;
    const days = monthHistory(habit, app.data.checkins, month, app.todayKey, app.data.settings.weekStart);
    const stats = monthCompletion(habit, app.data.checkins, month, app.todayKey);
    replaceChildren(
      container,
      h(
        'div',
        { class: 'calendar-nav' },
        button('‹ 上個月', () => ((month = addMonthsToMonthKey(month, -1)), draw()), { size: 'small', label: '上個月', focusKey: 'hm-prev' }),
        h('h3', { class: 'calendar-title', 'aria-live': 'polite' }, formatMonth(month)),
        button('下個月 ›', () => ((month = addMonthsToMonthKey(month, 1)), draw()), {
          size: 'small',
          label: '下個月',
          focusKey: 'hm-next',
          disabled: month >= monthKeyOf(app.todayKey),
        }),
      ),
      h(
        'p',
        { class: 'small' },
        `本月完成率：${pct(stats.rate)}（排定日完成 ${stats.done} / ${stats.scheduled} 天${stats.extra ? `，另有 ${stats.extra} 天非排定日完成` : ''}）`,
      ),
      h(
        'div',
        { class: 'calendar-grid', role: 'group', 'aria-label': `${habit.name} ${formatMonth(month)}紀錄` },
        days.slice(0, 7).map((d) => h('span', { class: 'calendar-weekday', 'aria-hidden': 'true' }, weekdayLabel(d.date))),
        days.map((day) => {
          const allowed = canCheckin(habit, day.date, app.todayKey).ok;
          const checked = day.status === 'done' || day.status === 'extra';
          return h(
            'button',
            {
              type: 'button',
              class: `calendar-day day--${day.status}${day.inMonth ? '' : ' is-outside'}${day.date === app.todayKey ? ' is-today' : ''}`,
              'aria-pressed': String(checked),
              'aria-label': `${formatDateLabel(day.date)}：${DAY_STATUS_LABELS[day.status]}${allowed ? (checked ? '，按下取消打卡' : '，按下補登打卡') : ''}`,
              disabled: !allowed || null,
              dataset: { focusKey: `hm-day-${day.date}` },
              onClick: () => {
                toggleHabitCheckin(habit, day.date, { guard: true });
                draw();
                container.querySelector(`[data-focus-key="hm-day-${day.date}"]`)?.focus();
              },
            },
            h('span', { class: 'calendar-date', 'aria-hidden': 'true' }, String(Number(day.date.slice(8)))),
            h('span', { class: 'day-mark', 'aria-hidden': 'true' }, DAY_MARKS[day.status]),
          );
        }),
      ),
      weekLegend(),
      h('p', { class: 'small muted' }, '未來的日期、習慣建立之前與封存期間不能打卡。補登與今天打卡使用相同規則：同一天只會有一筆紀錄。'),
    );
  };
  openFormDialog({
    title: '月份紀錄與補登',
    wide: true,
    submitText: null,
    body: () => {
      container = h('div', { class: 'habit-month' });
      return container;
    },
    onSubmit: () => true,
  });
  draw();
  container.querySelector('[data-focus-key="hm-prev"]')?.focus();
}

// ---------- 卡片 ----------

function statsLine(habit) {
  const recent = completionStats(habit, app.data.checkins, addDays(app.todayKey, -29), app.todayKey, app.todayKey);
  return h(
    'p',
    { class: 'habit-stats' },
    todayStatus(habit),
    h('span', {}, `連續 ${currentStreak(habit, app.data.checkins, app.todayKey)} 天`),
    h('span', {}, `最長 ${longestStreak(habit, app.data.checkins, app.todayKey)} 天`),
    h('span', {}, recent.scheduled ? `近 30 天 ${pct(recent.rate)}（${recent.done}/${recent.scheduled}）` : '近 30 天尚無紀錄'),
  );
}

function renderHabitCard(habit) {
  return h(
    'li',
    { class: 'habit card' },
    h(
      'div',
      { class: 'habit-info' },
      h('h4', { class: 'habit-name' }, habit.name),
      h('p', { class: 'small muted habit-schedule' }, describeDays(currentSchedule(habit))),
      statsLine(habit),
    ),
    weekRow(habit),
    h(
      'div',
      { class: 'habit-actions' },
      checkinButton(habit, 'habits'),
      button('月份紀錄與補登', () => openMonthDialog(habit.id), { size: 'small', focusKey: `habit-month-${habit.id}`, label: `「${habit.name}」的月份紀錄與補登` }),
      button('編輯', () => openEditHabitDialog(habit), { variant: 'ghost', size: 'small', focusKey: `habit-edit-${habit.id}`, label: `編輯「${habit.name}」` }),
      button('封存', () => archiveHabit(habit, true), { variant: 'ghost', size: 'small', focusKey: `habit-archive-${habit.id}`, label: `封存「${habit.name}」` }),
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
      h('p', { class: 'habit-stats' }, h('span', { class: 'status' }, `‖ 已封存${habit.archivedDate ? `（${formatDateLabel(habit.archivedDate)}）` : ''}`), h('span', {}, `最長連續 ${longestStreak(habit, app.data.checkins, app.todayKey)} 天`)),
    ),
    weekRow(habit),
    h(
      'div',
      { class: 'habit-actions' },
      button('還原', () => archiveHabit(habit, false), { size: 'small', focusKey: `habit-restore-${habit.id}`, label: `還原「${habit.name}」` }),
      button('月份紀錄', () => openMonthDialog(habit.id), { variant: 'ghost', size: 'small', focusKey: `habit-month-${habit.id}`, label: `「${habit.name}」的月份紀錄` }),
    ),
  );
}

function archiveHabit(habit, archived) {
  app.pendingFocusKey = archived ? null : `habit-archive-${habit.id}`;
  const habits = setHabitArchived(app.data.habits, habit.id, archived, app.todayKey);
  commit({ ...app.data, habits }, archived ? `已封存「${habit.name}」，紀錄都會保留，可在「已封存的習慣」還原。` : `已還原「${habit.name}」。`);
}

export function renderHabits(panel) {
  const active = activeHabits(app.data.habits);
  const archived = archivedHabits(app.data.habits);
  replaceChildren(
    panel,
    viewHead('habits', '習慣', button('＋ 新增習慣', openNewHabitDialog, { variant: 'primary', focusKey: 'habits-add' })),
    section(
      'habits-active',
      `進行中的習慣（${active.length}）`,
      active.length
        ? [weekLegend(), h('ul', { class: 'habit-list' }, active.map(renderHabitCard))]
        : emptyState('還沒有進行中的習慣', '按「新增習慣」建立，可以設定每天或每週指定星期。', button('新增習慣', openNewHabitDialog, { variant: 'primary', focusKey: 'habits-empty-add' })),
    ),
    archived.length
      ? section(
          'habits-archived',
          `已封存的習慣（${archived.length}）`,
          h('p', { class: 'muted small' }, '封存的習慣保留所有打卡紀錄，但不會列入今日應完成的習慣；封存期間不算漏打卡。'),
          h('ul', { class: 'habit-list' }, archived.map(renderArchivedCard)),
        )
      : null,
    h(
      'details',
      { class: 'method' },
      h('summary', {}, '完成率與連續天數怎麼計算？'),
      h(
        'ul',
        { class: 'bullets small' },
        h('li', {}, '完成率 = 期間內「排定日」已打卡天數 ÷ 排定日數。'),
        h('li', {}, '不計入：習慣建立之前、非排定日、封存期間、未來日期，以及今天還沒打卡（今天尚未結束）。'),
        h('li', {}, '非排定日打卡會顯示為完成，但不影響完成率。'),
        h('li', {}, '連續天數只計排定日；非排定日與封存期間不會中斷連續。'),
        h('li', {}, '修改執行頻率只從今天起生效，過去依當時的排程計算。'),
      ),
    ),
  );
}
