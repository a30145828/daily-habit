// 每週回顧：任務完成數、習慣完成率與手動回顧筆記。
//
// 計算方式：
// - 期間：weekStart（週一或週日）起 7 天；本週只計算到今天。
// - 任務完成數：完成時間（completedAt，時間戳）換算成「裝置當地日期」後落在期間內的已完成任務
//   （含重複任務的單次項目；不含已略過的）。
// - 習慣完成率：所有習慣（含已封存）在期間內「排定日」的打卡數 ÷ 排定日數；
//   建立前、非排定日、封存期間、未來與今天尚未打卡不計入（與習慣頁相同規則）。

import { addDays, compareDateKeys, startOfWeek, toDateKey } from './dates.js';
import { compactDate } from './ids.js';
import { completionStats } from './habits.js';

export function reviewId(weekStart) {
  return `rv_${compactDate(weekStart)}`;
}

/** 時間戳 → 裝置當地日期鍵。 */
export function localDateOf(timestamp) {
  return toDateKey(new Date(timestamp));
}

export function weekPeriod(dateKey, weekStartDay = 1) {
  const start = startOfWeek(dateKey, weekStartDay);
  return { start, end: addDays(start, 6) };
}

export function weekReview(data, weekStart, todayKey) {
  const end = addDays(weekStart, 6);
  const countedEnd = compareDateKeys(end, todayKey) > 0 ? todayKey : end;
  const completed = data.tasks.filter((task) => {
    if (!task.done || !task.completedAt || task.skipped) return false;
    const date = localDateOf(task.completedAt);
    return date >= weekStart && date <= end;
  });
  const habits = data.habits
    .filter((habit) => compareDateKeys(habit.createdDate, end) <= 0)
    .map((habit) => ({ habit, ...completionStats(habit, data.checkins, weekStart, end, todayKey) }))
    .filter((item) => item.scheduled > 0 || item.extra > 0);
  const done = habits.reduce((sum, item) => sum + item.done, 0);
  const scheduled = habits.reduce((sum, item) => sum + item.scheduled, 0);
  const note = data.reviews.find((r) => r.id === reviewId(weekStart));
  return {
    start: weekStart,
    end,
    countedEnd,
    isCurrent: weekStart <= todayKey && todayKey <= end,
    isFuture: compareDateKeys(weekStart, todayKey) > 0,
    tasksCompleted: completed.length,
    completedTasks: completed,
    habits,
    habitDone: done,
    habitScheduled: scheduled,
    habitRate: scheduled ? done / scheduled : null,
    note: note?.note ?? '',
  };
}

/** 新增或更新某週的回顧筆記；內容清空時刪除該筆。 */
export function saveReviewNote(reviews, weekStart, note, now = new Date()) {
  const id = reviewId(weekStart);
  const text = String(note ?? '').trim();
  const existing = reviews.find((r) => r.id === id);
  if (!text) return reviews.filter((r) => r.id !== id);
  const timestamp = now.toISOString();
  if (existing) return reviews.map((r) => (r.id === id ? { ...r, note: text, updatedAt: timestamp } : r));
  return [...reviews, { id, weekStart, note: text, createdAt: timestamp, updatedAt: timestamp }];
}
