// 習慣與打卡。
// - 排程：每天，或每週指定星期。排程有歷史（schedules：[{ from, days }]），
//   修改排程只影響「今天起」，過去的完成率與連續天數不會被改寫。
// - 打卡：{ id: c_<習慣id>_<YYYYMMDD>, habitId, date, createdAt }，同一習慣同一天只有一筆。
// - 可以補登過去的日期，不能為未來打卡，也不能早於習慣建立日。
// - 非排定日、建立之前、封存期間都不算漏打卡。

import { addDays, compareDateKeys, dayOfWeek, eachDay, lastNDays, monthGrid, monthKeyOf, monthRange } from './dates.js';
import { createId } from './ids.js';
import { checkinId } from './schema.js';

export const HABIT_NAME_MAX_LENGTH = 100;
export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

export const DAY_STATUS_LABELS = {
  done: '已完成',
  extra: '已完成（非排定日）',
  missed: '未完成',
  pending: '今天尚未打卡',
  rest: '非排定日',
  'not-started': '尚未建立',
  archived: '封存中',
  future: '未來',
};

export const DAY_MARKS = { done: '✓', extra: '✓', missed: '✕', pending: '○', rest: '·', 'not-started': '–', archived: '‖', future: '' };

/** 檢查習慣名稱。回傳 { ok: true, value } 或 { ok: false, error }。 */
export function validateHabitName(name) {
  const value = String(name ?? '').trim();
  if (!value) return { ok: false, error: '請輸入習慣名稱。' };
  if (value.length > HABIT_NAME_MAX_LENGTH) return { ok: false, error: `名稱最多 ${HABIT_NAME_MAX_LENGTH} 個字。` };
  return { ok: true, value };
}

/** 檢查排程星期。回傳 { ok: true, value: 排序後的星期 } 或 { ok: false, error }。 */
export function validateScheduleDays(days) {
  const value = [...new Set(days ?? [])].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort();
  if (value.length === 0) return { ok: false, error: '至少要選一天。' };
  return { ok: true, value };
}

/** 排程說明：每天、每週一、三、五。 */
export function describeDays(days) {
  if (days.length === 7) return '每天';
  const names = ['日', '一', '二', '三', '四', '五', '六'];
  const order = [1, 2, 3, 4, 5, 6, 0];
  return `每週${order.filter((d) => days.includes(d)).map((d) => names[d]).join('、')}`;
}

/** 建立新習慣。createdDate 為建立當天的當地日期。 */
export function createHabit(name, days, todayKey, now = new Date()) {
  const timestamp = now.toISOString();
  return {
    id: createId('h'),
    name,
    createdDate: todayKey,
    schedules: [{ from: todayKey, days }],
    archived: false,
    archivedDate: null,
    archivedRanges: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function mapHabit(habits, id, change) {
  return habits.map((habit) => (habit.id === id ? change(habit) : habit));
}

export function renameHabit(habits, id, name, now = new Date()) {
  return mapHabit(habits, id, (habit) => ({ ...habit, name, updatedAt: now.toISOString() }));
}

/** 修改排程：只從今天起生效（今天已有排程變更時直接取代）。 */
export function setHabitSchedule(habits, id, days, todayKey, now = new Date()) {
  return mapHabit(habits, id, (habit) => {
    const kept = habit.schedules.filter((s) => compareDateKeys(s.from, todayKey) < 0);
    const from = compareDateKeys(todayKey, habit.createdDate) < 0 ? habit.createdDate : todayKey;
    return { ...habit, schedules: [...kept, { from, days }], updatedAt: now.toISOString() };
  });
}

/**
 * 封存或還原。封存期間（封存日的隔天起到還原日的前一天）會記錄在 archivedRanges，
 * 這段期間不算漏打卡；打卡紀錄完整保留。
 */
export function setHabitArchived(habits, id, archived, todayKey, now = new Date()) {
  return mapHabit(habits, id, (habit) => {
    if (archived) {
      if (habit.archived) return habit;
      return { ...habit, archived: true, archivedDate: todayKey, updatedAt: now.toISOString() };
    }
    if (!habit.archived) return habit;
    const ranges = habit.archivedRanges.slice();
    const from = addDays(habit.archivedDate ?? todayKey, 1);
    const to = addDays(todayKey, -1);
    if (compareDateKeys(from, to) <= 0) ranges.push({ from, to });
    return { ...habit, archived: false, archivedDate: null, archivedRanges: ranges, updatedAt: now.toISOString() };
  });
}

/** 未封存的習慣，依建立時間排序。 */
export function activeHabits(habits) {
  return habits.filter((habit) => !habit.archived).sort(byCreatedAt);
}

export function archivedHabits(habits) {
  return habits.filter((habit) => habit.archived).sort(byCreatedAt);
}

function byCreatedAt(a, b) {
  return a.createdAt.localeCompare(b.createdAt);
}

/** 某天生效的排程星期；早於第一個排程時回傳 null。 */
export function scheduleOn(habit, date) {
  let days = null;
  for (const schedule of habit.schedules) {
    if (compareDateKeys(schedule.from, date) <= 0) days = schedule.days;
  }
  return days;
}

export function currentSchedule(habit) {
  return habit.schedules.at(-1).days;
}

export function isScheduledOn(habit, date) {
  const days = scheduleOn(habit, date);
  return Boolean(days && days.includes(dayOfWeek(date)));
}

/** 某天是否處於封存狀態。 */
export function isArchivedOn(habit, date) {
  if (habit.archived && habit.archivedDate && compareDateKeys(date, habit.archivedDate) > 0) return true;
  return habit.archivedRanges.some((r) => date >= r.from && date <= r.to);
}

/** 今天需要打卡的習慣（未封存且今天是排定日）。 */
export function habitsDueOn(habits, date) {
  return activeHabits(habits).filter((habit) => isScheduledOn(habit, date));
}

// ---------- 打卡 ----------

export function isCheckedIn(checkins, habitId, date) {
  const id = checkinId(habitId, date);
  return checkins.some((checkin) => checkin.id === id);
}

/** 檢查能否為某天打卡或取消打卡。回傳 { ok: true } 或 { ok: false, error }。 */
export function canCheckin(habit, date, todayKey) {
  if (!habit) return { ok: false, error: '找不到這個習慣。' };
  if (compareDateKeys(date, todayKey) > 0) return { ok: false, error: '不能為未來的日期打卡。' };
  if (compareDateKeys(date, habit.createdDate) < 0) return { ok: false, error: '不能早於習慣建立日。' };
  if (habit.archived) return { ok: false, error: '已封存的習慣不能打卡，請先還原。' };
  if (isArchivedOn(habit, date)) return { ok: false, error: '這一天習慣處於封存狀態。' };
  return { ok: true };
}

/**
 * 設定某習慣某天是否打卡。打卡的 id 固定，重複打卡不會產生第二筆；取消時移除該筆。
 */
export function setCheckin(checkins, habitId, date, checked, now = new Date()) {
  const id = checkinId(habitId, date);
  const others = checkins.filter((c) => c.id !== id);
  if (!checked) return others;
  const existing = checkins.find((c) => c.id === id);
  return [...others, existing ?? { id, habitId, date, createdAt: now.toISOString() }];
}

function checkedDatesFor(checkins, habitId) {
  return new Set(checkins.filter((c) => c.habitId === habitId).map((c) => c.date));
}

/** 某習慣某天的狀態，見 DAY_STATUS_LABELS。 */
export function dayStatus(habit, checkedDates, date, todayKey) {
  if (compareDateKeys(date, todayKey) > 0) return 'future';
  const scheduled = isScheduledOn(habit, date);
  if (checkedDates.has(date)) return scheduled ? 'done' : 'extra';
  if (compareDateKeys(date, habit.createdDate) < 0) return 'not-started';
  if (isArchivedOn(habit, date)) return 'archived';
  if (!scheduled) return 'rest';
  if (date === todayKey) return 'pending';
  return 'missed';
}

/** 最近 days 天（含今天）的紀錄：[{ date, status }]，由舊到新。 */
export function recentHistory(habit, checkins, todayKey, days = 7) {
  const checked = checkedDatesFor(checkins, habit.id);
  return lastNDays(todayKey, days).map((date) => ({ date, status: dayStatus(habit, checked, date, todayKey) }));
}

/** 月曆（6 週 × 7 天）：[{ date, status, inMonth }]。 */
export function monthHistory(habit, checkins, monthKey, todayKey, weekStart = 1) {
  const checked = checkedDatesFor(checkins, habit.id);
  return monthGrid(monthKey, weekStart).map((date) => ({
    date,
    inMonth: monthKeyOf(date) === monthKey,
    status: dayStatus(habit, checked, date, todayKey),
  }));
}

/**
 * 完成率：期間 [from, to] 內「排定日」的完成數 / 排定日數。
 * 不計入：建立之前、封存期間、非排定日、未來，以及「今天還沒打卡」（今天還沒結束）。
 * 非排定日的打卡另計為 extra，不影響完成率。
 */
export function completionStats(habit, checkins, from, to, todayKey) {
  const checked = checkedDatesFor(checkins, habit.id);
  let done = 0;
  let scheduled = 0;
  let extra = 0;
  const end = compareDateKeys(to, todayKey) > 0 ? todayKey : to;
  if (compareDateKeys(from, end) > 0) return { done, scheduled, extra, rate: null };
  for (const date of eachDay(from, end)) {
    const status = dayStatus(habit, checked, date, todayKey);
    if (status === 'done') {
      done += 1;
      scheduled += 1;
    } else if (status === 'missed') scheduled += 1;
    else if (status === 'extra') extra += 1;
  }
  return { done, scheduled, extra, rate: scheduled ? done / scheduled : null };
}

/** 本月完成率。 */
export function monthCompletion(habit, checkins, monthKey, todayKey) {
  const { start, end } = monthRange(monthKey);
  return completionStats(habit, checkins, start, end, todayKey);
}

/**
 * 目前連續達成：從今天往回數連續完成的「排定日」。
 * 今天是排定日但還沒打卡時，從昨天算起（白天還沒打卡不會變 0）。
 * 非排定日與封存期間會跳過，不會中斷連續。
 */
export function currentStreak(habit, checkins, todayKey) {
  const checked = checkedDatesFor(checkins, habit.id);
  let streak = 0;
  for (let date = todayKey; compareDateKeys(date, habit.createdDate) >= 0; date = addDays(date, -1)) {
    const status = dayStatus(habit, checked, date, todayKey);
    if (status === 'done') streak += 1;
    else if (status === 'missed') break;
  }
  return streak;
}

/** 最長連續達成（同樣只計排定日）。 */
export function longestStreak(habit, checkins, todayKey) {
  const checked = checkedDatesFor(checkins, habit.id);
  let best = 0;
  let run = 0;
  if (compareDateKeys(habit.createdDate, todayKey) > 0) return 0;
  for (const date of eachDay(habit.createdDate, todayKey)) {
    const status = dayStatus(habit, checked, date, todayKey);
    if (status === 'done') {
      run += 1;
      best = Math.max(best, run);
    } else if (status === 'missed') run = 0;
  }
  return best;
}

/** 所有習慣中最長的目前連續天數（成就判斷用）。 */
export function bestCurrentStreak(habits, checkins, todayKey) {
  return habits.reduce((best, habit) => Math.max(best, currentStreak(habit, checkins, todayKey)), 0);
}
