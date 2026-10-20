// 重複任務。
// 重複任務以「規則（series）」儲存；每一次（occurrence）在需要時才計算，不預先產生大量資料。
// 某一次被完成、略過或個別修改時，才存成一筆實體任務（task），
// 其 id 固定為 o_<規則id>_<YYYYMMDD>，因此不同裝置對同一次的操作不會產生兩筆。
//
// 規則：
// - daily：每天。
// - weekly：每週指定星期（weekdays：0 = 日 … 6 = 六）。
// - monthly：每月 monthDay 日；該月沒有這一天時（例如 2 月 30 日），
//   monthEnd = 'last' 改在該月最後一天，monthEnd = 'skip' 該月跳過。
// - startDate 起、endDate（含）止；endDate 為 null 代表沒有結束日。

import {
  addDays,
  addMonthsToMonthKey,
  compareDateKeys,
  dayOfWeek,
  monthDayIn,
  monthKeyOf,
  isValidDateKey,
} from './dates.js';
import { compactDate, createId } from './ids.js';
import { REPEAT_FREQS } from './schema.js';

export const FREQ_LABELS = { daily: '每天', weekly: '每週', monthly: '每月' };
export const MONTH_END_LABELS = { last: '改在該月最後一天', skip: '該月跳過' };

/** 往回找逾期項目的最大天數。 */
const LOOKBACK_DAYS = 366;

export function occurrenceId(seriesId, date) {
  return `o_${seriesId}_${compactDate(date)}`;
}

/** 規則的文字說明，例如「每週一、三」「每月 31 日（沒有該日時改在月底）」。 */
export function describeRule(rule) {
  const names = ['日', '一', '二', '三', '四', '五', '六'];
  if (rule.freq === 'daily') return '每天';
  if (rule.freq === 'weekly') return `每週${rule.weekdays.map((d) => names[d]).join('、')}`;
  const suffix = rule.monthDay > 28 ? `（沒有該日的月份${rule.monthEnd === 'skip' ? '跳過' : '改在月底'}）` : '';
  return `每月 ${rule.monthDay} 日${suffix}`;
}

/** 驗證重複規則輸入。回傳 { ok, value } 或 { ok: false, error }。 */
export function validateRule(input) {
  if (!REPEAT_FREQS.includes(input.freq)) return { ok: false, error: '請選擇重複方式。' };
  if (input.freq === 'weekly') {
    const days = [...new Set(input.weekdays ?? [])].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort();
    if (days.length === 0) return { ok: false, error: '每週重複至少要選一天。' };
    return { ok: true, value: { freq: 'weekly', weekdays: days, monthDay: null, monthEnd: 'last' } };
  }
  if (input.freq === 'monthly') {
    const day = Number(input.monthDay);
    if (!Number.isInteger(day) || day < 1 || day > 31) return { ok: false, error: '每月日期需為 1～31。' };
    const monthEnd = input.monthEnd === 'skip' ? 'skip' : 'last';
    return { ok: true, value: { freq: 'monthly', weekdays: [], monthDay: day, monthEnd } };
  }
  return { ok: true, value: { freq: 'daily', weekdays: [], monthDay: null, monthEnd: 'last' } };
}

/** 某日期是否為規則的排定日（不考慮起訖日）。 */
export function matchesRule(rule, date) {
  if (rule.freq === 'daily') return true;
  if (rule.freq === 'weekly') return rule.weekdays.includes(dayOfWeek(date));
  return monthDayIn(monthKeyOf(date), rule.monthDay, rule.monthEnd) === date;
}

/** 規則在 [from, to]（含）之間的所有日期。 */
export function occurrencesBetween(series, from, to) {
  const start = compareDateKeys(from, series.startDate) < 0 ? series.startDate : from;
  const end = series.endDate && compareDateKeys(series.endDate, to) < 0 ? series.endDate : to;
  if (compareDateKeys(start, end) > 0) return [];
  const dates = [];
  if (series.rule.freq === 'monthly') {
    for (let month = monthKeyOf(start); month <= monthKeyOf(end); month = addMonthsToMonthKey(month, 1)) {
      const date = monthDayIn(month, series.rule.monthDay, series.rule.monthEnd);
      if (date && date >= start && date <= end) dates.push(date);
    }
    return dates;
  }
  for (let date = start; date <= end; date = addDays(date, 1)) {
    if (matchesRule(series.rule, date)) dates.push(date);
  }
  return dates;
}

/** 下一次（含 from 當天）的日期；沒有時回傳 null。 */
export function nextOccurrence(series, from, maxDays = 800) {
  const list = occurrencesBetween(series, from, addDays(from, maxDays));
  return list[0] ?? null;
}

/** 由規則產生某一次的任務內容（尚未儲存的「虛擬」任務）。 */
export function virtualOccurrence(series, date) {
  return {
    id: occurrenceId(series.id, date),
    title: series.title,
    note: series.note,
    dueDate: date,
    priority: series.priority,
    tags: series.tags.slice(),
    subtasks: series.subtasks.map((s) => ({ id: s.id, title: s.title, done: false })),
    done: false,
    completedAt: null,
    archived: false,
    archivedAt: null,
    seriesId: series.id,
    occurrenceDate: date,
    skipped: false,
    createdAt: series.createdAt,
    updatedAt: series.updatedAt,
    virtual: true,
  };
}

/** 把虛擬任務轉成要儲存的實體任務。 */
export function materialize(occurrence, changes = {}, now = new Date()) {
  const { virtual, ...task } = occurrence;
  return { ...task, ...changes, createdAt: now.toISOString(), updatedAt: now.toISOString() };
}

function materializedFor(tasks, seriesId) {
  return tasks.filter((task) => task.seriesId === seriesId && task.occurrenceDate);
}

/**
 * 規則在 [from, to] 之間「尚未存成實體任務」的虛擬任務。
 * 已存成實體任務的（完成、略過、個別修改）由任務清單自行顯示。
 */
export function virtualOccurrencesBetween(series, tasks, from, to) {
  if (series.archived) return [];
  const existing = new Set(materializedFor(tasks, series.id).map((task) => task.occurrenceDate));
  return occurrencesBetween(series, from, to)
    .filter((date) => !existing.has(date))
    .map((date) => virtualOccurrence(series, date));
}

/** 今天起第一個尚未存成實體任務的項目（「全部」視圖用來代表這個重複任務）。 */
export function nextVirtualOccurrence(series, tasks, todayKey, maxDays = 800) {
  if (series.archived) return null;
  const existing = new Set(materializedFor(tasks, series.id).map((task) => task.occurrenceDate));
  const date = occurrencesBetween(series, todayKey, addDays(todayKey, maxDays)).find((d) => !existing.has(d));
  return date ? virtualOccurrence(series, date) : null;
}

/**
 * 逾期的重複任務：只顯示「最近一次已處理（完成或略過）之後、今天之前」最新一次未處理的日期，
 * 避免每天的任務錯過幾天就堆出一長串。回傳 { task, missedCount } 或 null。
 */
export function overdueOccurrence(series, tasks, todayKey) {
  if (series.archived) return null;
  const materialized = materializedFor(tasks, series.id);
  const existing = new Set(materialized.map((task) => task.occurrenceDate));
  const resolved = materialized.filter((task) => task.done || task.skipped).map((task) => task.occurrenceDate).sort();
  const lastResolved = resolved.at(-1);
  let from = addDays(todayKey, -LOOKBACK_DAYS);
  if (lastResolved && compareDateKeys(lastResolved, from) >= 0) from = addDays(lastResolved, 1);
  const pending = occurrencesBetween(series, from, addDays(todayKey, -1)).filter((date) => !existing.has(date));
  if (pending.length === 0) return null;
  return { task: virtualOccurrence(series, pending.at(-1)), missedCount: pending.length };
}

// ---------- 建立與修改 ----------

export function createSeries(input, now = new Date()) {
  const timestamp = now.toISOString();
  return {
    id: createId('s'),
    title: input.title,
    note: input.note,
    priority: input.priority,
    tags: input.tags,
    subtasks: input.subtasks.map((s) => ({ id: s.id, title: s.title })),
    rule: input.rule,
    startDate: input.startDate,
    endDate: null,
    archived: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

/**
 * 「修改這次及未來」：原規則在這次的前一天結束；從這次起改用新規則。
 * 這次之後尚未完成的個別修改會移除（改由新規則產生）；已完成或已略過的保留，並改掛到新規則。
 * 回傳 { series, tasks }（完整的新清單）。
 */
export function splitSeries(allSeries, tasks, seriesId, fromDate, input, now = new Date()) {
  const old = allSeries.find((s) => s.id === seriesId);
  if (!old) throw new Error('找不到重複任務規則。');
  const timestamp = now.toISOString();
  const created = { ...createSeries({ ...input, startDate: fromDate }, now) };
  if (old.endDate && compareDateKeys(old.endDate, fromDate) >= 0) created.endDate = old.endDate;

  let series = allSeries.map((s) => s);
  if (compareDateKeys(fromDate, old.startDate) <= 0) {
    // 從第一次開始改：直接以新規則取代舊規則（舊規則已沒有任何日期）。
    series = series.filter((s) => s.id !== seriesId);
  } else {
    series = series.map((s) => (s.id === seriesId ? { ...s, endDate: addDays(fromDate, -1), updatedAt: timestamp } : s));
  }
  series.push(created);

  const nextTasks = [];
  for (const task of tasks) {
    const isFuture = task.seriesId === seriesId && task.occurrenceDate && compareDateKeys(task.occurrenceDate, fromDate) >= 0;
    if (!isFuture) {
      nextTasks.push(task);
      continue;
    }
    if (!task.done && !task.skipped) continue;
    if (!matchesRule(created.rule, task.occurrenceDate)) {
      nextTasks.push(task); // 新規則已不在這天：保留原紀錄
      continue;
    }
    nextTasks.push({ ...task, id: occurrenceId(created.id, task.occurrenceDate), seriesId: created.id, updatedAt: timestamp });
  }
  return { series, tasks: nextTasks, created };
}

/**
 * 結束規則：「這次及之後」都不再產生。
 * 這次之後尚未完成的個別項目一併移除；已完成的保留為歷史紀錄。
 */
export function endSeriesFrom(allSeries, tasks, seriesId, fromDate, now = new Date()) {
  const timestamp = now.toISOString();
  const old = allSeries.find((s) => s.id === seriesId);
  const series =
    old && compareDateKeys(fromDate, old.startDate) <= 0
      ? allSeries.filter((s) => s.id !== seriesId)
      : allSeries.map((s) => (s.id === seriesId ? { ...s, endDate: addDays(fromDate, -1), updatedAt: timestamp } : s));
  const nextTasks = tasks.filter(
    (task) =>
      !(task.seriesId === seriesId && task.occurrenceDate && compareDateKeys(task.occurrenceDate, fromDate) >= 0 && !task.done),
  );
  return { series, tasks: nextTasks };
}

/** 規則是否已結束（沒有今天或之後的日期）。 */
export function isSeriesFinished(series, todayKey) {
  return Boolean(series.endDate && compareDateKeys(series.endDate, todayKey) < 0) || !nextOccurrence(series, todayKey);
}

export function isValidSeriesStart(date) {
  return isValidDateKey(date);
}
