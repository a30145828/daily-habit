// 習慣與打卡。第一版只支援「每天執行」的習慣。
// 打卡資料格式：{ habitId, date: 'YYYY-MM-DD', createdAt }，同一習慣同一天只會有一筆。

import { addDays, compareDateKeys, lastNDays, toDateKey } from './dates.js';
import { createId } from './ids.js';

export const HABIT_NAME_MAX_LENGTH = 100;

export const DAY_STATUS_LABELS = {
  done: '已完成',
  missed: '未完成',
  pending: '今天尚未打卡',
  'not-started': '尚未建立',
  archived: '已封存',
};

/** 檢查習慣名稱。回傳 { ok: true, value } 或 { ok: false, error }。 */
export function validateHabitName(name) {
  const value = String(name ?? '').trim();
  if (!value) return { ok: false, error: '請輸入習慣名稱。' };
  if (value.length > HABIT_NAME_MAX_LENGTH) {
    return { ok: false, error: `名稱最多 ${HABIT_NAME_MAX_LENGTH} 個字。` };
  }
  return { ok: true, value };
}

/** 建立新習慣。createdDate 為建立當天的當地日期，之前的日期不算漏打卡。 */
export function createHabit(name, now = new Date()) {
  const timestamp = now.toISOString();
  return {
    id: createId('h'),
    name,
    createdDate: toDateKey(now),
    archived: false,
    archivedDate: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function renameHabit(habits, id, name, now = new Date()) {
  return habits.map((habit) =>
    habit.id === id ? { ...habit, name, updatedAt: now.toISOString() } : habit,
  );
}

/** 封存（archived = true）或還原（archived = false）。打卡紀錄不會被刪除。 */
export function setHabitArchived(habits, id, archived, now = new Date()) {
  return habits.map((habit) =>
    habit.id === id
      ? {
          ...habit,
          archived,
          archivedDate: archived ? toDateKey(now) : null,
          updatedAt: now.toISOString(),
        }
      : habit,
  );
}

/** 未封存的習慣（今日應完成的習慣），依建立時間排序。 */
export function activeHabits(habits) {
  return habits.filter((habit) => !habit.archived).sort(byCreatedAt);
}

export function archivedHabits(habits) {
  return habits.filter((habit) => habit.archived).sort(byCreatedAt);
}

function byCreatedAt(a, b) {
  return a.createdAt.localeCompare(b.createdAt);
}

function checkinKey(habitId, date) {
  return `${habitId}|${date}`;
}

export function isCheckedIn(checkins, habitId, date) {
  return checkins.some((checkin) => checkin.habitId === habitId && checkin.date === date);
}

/**
 * 設定某習慣某天是否打卡。重複打卡不會產生第二筆；取消時會移除該天所有紀錄。
 */
export function setCheckin(checkins, habitId, date, checked, now = new Date()) {
  const others = checkins.filter((c) => !(c.habitId === habitId && c.date === date));
  if (!checked) return others;
  return [...others, { habitId, date, createdAt: now.toISOString() }];
}

/** 切換打卡狀態。 */
export function toggleCheckin(checkins, habitId, date, now = new Date()) {
  return setCheckin(checkins, habitId, date, !isCheckedIn(checkins, habitId, date), now);
}

/** 移除重複的打卡（同一習慣同一天只保留第一筆）。回傳 { checkins, removed }。 */
export function dedupeCheckins(checkins) {
  const seen = new Set();
  const result = [];
  for (const checkin of checkins) {
    const key = checkinKey(checkin.habitId, checkin.date);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(checkin);
  }
  return { checkins: result, removed: checkins.length - result.length };
}

/** 刪除習慣時一併移除其打卡（目前介面只提供封存，保留給未來使用）。 */
export function removeCheckinsForHabit(checkins, habitId) {
  return checkins.filter((checkin) => checkin.habitId !== habitId);
}

/**
 * 某習慣在某一天的狀態：
 * done（已打卡）、pending（今天還沒打卡）、missed（漏打卡）、
 * not-started（習慣建立之前）、archived（封存之後）。
 */
export function dayStatus(habit, checkedDates, date, todayKey) {
  if (checkedDates.has(date)) return 'done';
  if (compareDateKeys(date, habit.createdDate) < 0) return 'not-started';
  if (habit.archived && habit.archivedDate && compareDateKeys(date, habit.archivedDate) > 0) {
    return 'archived';
  }
  if (date === todayKey) return 'pending';
  if (compareDateKeys(date, todayKey) > 0) return 'not-started';
  return 'missed';
}

function checkedDatesFor(checkins, habitId) {
  return new Set(checkins.filter((c) => c.habitId === habitId).map((c) => c.date));
}

/** 最近 days 天（含今天）的打卡紀錄：[{ date, status }]，由舊到新。 */
export function recentHistory(habit, checkins, todayKey, days = 7) {
  const checked = checkedDatesFor(checkins, habit.id);
  return lastNDays(todayKey, days).map((date) => ({
    date,
    status: dayStatus(habit, checked, date, todayKey),
  }));
}

/**
 * 目前連續打卡天數。今天已打卡就從今天往回算；今天還沒打卡則從昨天往回算，
 * 這樣白天還沒打卡時不會把連續紀錄顯示成 0。
 */
export function currentStreak(habitId, checkins, todayKey) {
  const checked = checkedDatesFor(checkins, habitId);
  let date = checked.has(todayKey) ? todayKey : addDays(todayKey, -1);
  let streak = 0;
  while (checked.has(date)) {
    streak += 1;
    date = addDays(date, -1);
  }
  return streak;
}
