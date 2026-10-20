// 任務：建立、修改、篩選、排序與各種視圖。所有函式都不修改傳入的資料，而是回傳新資料。
// 重複任務的規則在 recurrence.js；這裡把一般任務、已存成實體的重複項目與「虛擬」重複項目合併顯示。

import { addDays, compareDateKeys, isValidDateKey, startOfWeek } from './dates.js';
import { createId } from './ids.js';
import { PRIORITIES } from './schema.js';
import { nextVirtualOccurrence, overdueOccurrence, virtualOccurrencesBetween } from './recurrence.js';

export { PRIORITIES };
export const PRIORITY_LABELS = { high: '高', medium: '中', low: '低' };
export const VIEWS = ['today', 'overdue', 'week', 'all', 'done', 'archived'];
export const VIEW_LABELS = { today: '今日', overdue: '逾期', week: '本週', all: '全部', done: '已完成', archived: '已封存' };
export const SORTS = ['due', 'priority', 'created', 'title'];
export const SORT_LABELS = { due: '截止日期', priority: '優先程度', created: '建立時間（新到舊）', title: '名稱' };

export const TITLE_MAX_LENGTH = 200;
export const NOTE_MAX_LENGTH = 2000;
export const MAX_TAGS = 20;
export const MAX_SUBTASKS = 50;

const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };

/** 把「工作, 家裡、重要」這類文字拆成標籤陣列（逗號、頓號或全形逗號分隔）。 */
export function parseTags(text) {
  const tags = [];
  for (const raw of String(text ?? '').split(/[,，、]/)) {
    const tag = raw.trim().replace(/^#/, '');
    if (tag && !tags.includes(tag)) tags.push(tag);
  }
  return tags;
}

/**
 * 檢查表單輸入。subtasks 為 [{ id?, title, done? }]，空白標題會被略過。
 * 回傳 { ok: true, value } 或 { ok: false, errors: { 欄位: 訊息 } }。
 */
export function validateTaskInput(input) {
  const errors = {};
  const title = String(input.title ?? '').trim();
  const note = String(input.note ?? '').trim();
  const dueDate = input.dueDate ? String(input.dueDate) : null;
  const priority = input.priority ?? 'medium';
  const tags = Array.isArray(input.tags) ? parseTags(input.tags.join(',')) : parseTags(input.tags);
  const subtasks = (input.subtasks ?? [])
    .map((s) => ({ id: s.id || createId('st'), title: String(s.title ?? '').trim(), done: Boolean(s.done) }))
    .filter((s) => s.title);

  if (!title) errors.title = '請輸入任務名稱。';
  else if (title.length > TITLE_MAX_LENGTH) errors.title = `名稱最多 ${TITLE_MAX_LENGTH} 個字。`;
  if (note.length > NOTE_MAX_LENGTH) errors.note = `備註最多 ${NOTE_MAX_LENGTH} 個字。`;
  if (dueDate !== null && !isValidDateKey(dueDate)) errors.dueDate = '截止日期格式不正確。';
  if (!PRIORITIES.includes(priority)) errors.priority = '請選擇優先程度。';
  if (tags.length > MAX_TAGS) errors.tags = `標籤最多 ${MAX_TAGS} 個。`;
  else if (tags.some((tag) => tag.length > 30)) errors.tags = '每個標籤最多 30 個字。';
  if (subtasks.length > MAX_SUBTASKS) errors.subtasks = `子任務最多 ${MAX_SUBTASKS} 項。`;
  else if (subtasks.some((s) => s.title.length > 200)) errors.subtasks = '子任務名稱最多 200 個字。';

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { title, note, dueDate, priority, tags, subtasks } };
}

/** 建立一般（不重複）任務。input 需先通過 validateTaskInput。 */
export function createTask(input, now = new Date()) {
  const timestamp = now.toISOString();
  return {
    id: createId('t'),
    title: input.title,
    note: input.note,
    dueDate: input.dueDate,
    priority: input.priority,
    tags: input.tags,
    subtasks: input.subtasks,
    done: false,
    completedAt: null,
    archived: false,
    archivedAt: null,
    seriesId: null,
    occurrenceDate: null,
    skipped: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function mapTask(tasks, id, change) {
  return tasks.map((task) => (task.id === id ? change(task) : task));
}

/** 修改任務內容（名稱、備註、截止日、優先程度、標籤、子任務）。 */
export function updateTask(tasks, id, input, now = new Date()) {
  return mapTask(tasks, id, (task) => ({
    ...task,
    title: input.title,
    note: input.note,
    dueDate: input.dueDate,
    priority: input.priority,
    tags: input.tags,
    subtasks: input.subtasks,
    updatedAt: now.toISOString(),
  }));
}

/** 標記完成或取消完成。 */
export function setTaskDone(tasks, id, done, now = new Date()) {
  const timestamp = now.toISOString();
  return mapTask(tasks, id, (task) => ({ ...task, done, completedAt: done ? timestamp : null, updatedAt: timestamp }));
}

/** 封存或取消封存。封存的任務不出現在一般視圖，但保留完成紀錄。 */
export function setTaskArchived(tasks, id, archived, now = new Date()) {
  const timestamp = now.toISOString();
  return mapTask(tasks, id, (task) => ({ ...task, archived, archivedAt: archived ? timestamp : null, updatedAt: timestamp }));
}

export function toggleSubtask(tasks, taskId, subtaskId, now = new Date()) {
  return mapTask(tasks, taskId, (task) => ({
    ...task,
    subtasks: task.subtasks.map((s) => (s.id === subtaskId ? { ...s, done: !s.done } : s)),
    updatedAt: now.toISOString(),
  }));
}

export function deleteTask(tasks, id) {
  return tasks.filter((task) => task.id !== id);
}

/** 寫入（新增或取代）一筆任務，用於把虛擬重複項目存成實體。 */
export function upsertTask(tasks, task) {
  return tasks.some((t) => t.id === task.id) ? tasks.map((t) => (t.id === task.id ? task : t)) : [...tasks, task];
}

/** 任務相對於今天的狀態：'overdue'、'today'、'upcoming' 或 'none'（無截止日）。 */
export function dueStatus(task, todayKey) {
  if (!task.dueDate) return 'none';
  const diff = compareDateKeys(task.dueDate, todayKey);
  if (diff < 0) return 'overdue';
  if (diff === 0) return 'today';
  return 'upcoming';
}

// ---------- 搜尋、篩選、排序 ----------

/** 文字搜尋：名稱、備註、標籤、子任務（不分大小寫）。 */
export function matchesQuery(task, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return true;
  const haystack = [task.title, task.note, ...task.tags, ...task.subtasks.map((s) => s.title)].join('\n').toLowerCase();
  return q.split(/\s+/).every((word) => haystack.includes(word));
}

/** 套用搜尋、標籤與優先程度篩選。filters：{ query, tag, priority } */
export function applyFilters(tasks, filters = {}) {
  return tasks.filter(
    (task) =>
      matchesQuery(task, filters.query) &&
      (!filters.tag || task.tags.includes(filters.tag)) &&
      (!filters.priority || task.priority === filters.priority),
  );
}

/** 依排序方式排序（未完成在前）。 */
export function sortTasks(tasks, sort = 'due') {
  return tasks.slice().sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    if (a.done && sort === 'due') return String(b.completedAt ?? '').localeCompare(String(a.completedAt ?? ''));
    if (sort === 'priority' && a.priority !== b.priority) return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    if (sort === 'created') return String(b.createdAt).localeCompare(String(a.createdAt));
    if (sort === 'title') return a.title.localeCompare(b.title, 'zh-Hant');
    if (a.dueDate !== b.dueDate) {
      if (!a.dueDate) return 1;
      if (!b.dueDate) return -1;
      return compareDateKeys(a.dueDate, b.dueDate);
    }
    if (a.priority !== b.priority) return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    return String(a.createdAt).localeCompare(String(b.createdAt));
  });
}

/** 所有出現過的標籤（依名稱排序）。 */
export function allTags(data) {
  const tags = new Set();
  for (const task of data.tasks) task.tags.forEach((tag) => tags.add(tag));
  for (const series of data.series) series.tags.forEach((tag) => tags.add(tag));
  return [...tags].sort((a, b) => a.localeCompare(b, 'zh-Hant'));
}

// ---------- 視圖 ----------

/** 一般顯示的實體任務（未封存、未略過）。 */
function visibleTasks(tasks) {
  return tasks.filter((task) => !task.archived && !task.skipped);
}

function activeSeries(data) {
  return data.series.filter((series) => !series.archived);
}

/** 今天到期的未完成任務（含今天的重複項目）。 */
export function dueTodayTasks(data, todayKey) {
  const real = visibleTasks(data.tasks).filter((task) => !task.done && task.dueDate === todayKey);
  const virtual = activeSeries(data).flatMap((series) => virtualOccurrencesBetween(series, data.tasks, todayKey, todayKey));
  return [...real, ...virtual];
}

/** 已逾期的未完成任務。重複任務只列出最近一次未處理的項目，並附上錯過次數。 */
export function overdueTasks(data, todayKey) {
  const real = visibleTasks(data.tasks).filter(
    (task) => !task.done && task.dueDate && compareDateKeys(task.dueDate, todayKey) < 0,
  );
  const virtual = activeSeries(data)
    .map((series) => overdueOccurrence(series, data.tasks, todayKey))
    .filter(Boolean)
    .map(({ task, missedCount }) => ({ ...task, missedCount }));
  return [...real, ...virtual];
}

/** 本週（週一至週日）今天起到期的未完成任務，不含已逾期。 */
export function thisWeekTasks(data, todayKey, weekStart = 1) {
  const end = addDays(startOfWeek(todayKey, weekStart), 6);
  const real = visibleTasks(data.tasks).filter(
    (task) => !task.done && task.dueDate && task.dueDate >= todayKey && task.dueDate <= end,
  );
  const virtual = activeSeries(data).flatMap((series) => virtualOccurrencesBetween(series, data.tasks, todayKey, end));
  return [...real, ...virtual];
}

/**
 * 「全部」：所有未封存的實體任務（含已完成），加上每個重複任務的「下一次」項目。
 */
export function allTasks(data, todayKey) {
  const real = visibleTasks(data.tasks);
  const next = activeSeries(data)
    .map((series) => nextVirtualOccurrence(series, data.tasks, todayKey))
    .filter(Boolean);
  return [...real, ...next];
}

export function doneTasks(data) {
  return visibleTasks(data.tasks).filter((task) => task.done);
}

export function archivedTasks(data) {
  return data.tasks.filter((task) => task.archived);
}

/** 取得指定視圖的任務清單（已套用篩選與排序）。 */
export function taskView(data, view, todayKey, { filters = {}, sort = 'due', weekStart = 1 } = {}) {
  const sources = {
    today: () => dueTodayTasks(data, todayKey),
    overdue: () => overdueTasks(data, todayKey),
    week: () => thisWeekTasks(data, todayKey, weekStart),
    all: () => allTasks(data, todayKey),
    done: () => doneTasks(data),
    archived: () => archivedTasks(data),
  };
  const list = (sources[view] ?? sources.all)();
  return sortTasks(applyFilters(list, filters), sort);
}

/** 月曆：回傳 { 日期鍵: 任務[] }。今天以前只顯示實體任務，今天起也顯示重複任務的虛擬項目。 */
export function calendarTasks(data, from, to, todayKey, filters = {}) {
  const map = {};
  const add = (task) => {
    if (!task.dueDate || task.dueDate < from || task.dueDate > to) return;
    (map[task.dueDate] ??= []).push(task);
  };
  applyFilters(visibleTasks(data.tasks), filters).forEach(add);
  const virtualFrom = compareDateKeys(from, todayKey) > 0 ? from : todayKey;
  if (compareDateKeys(virtualFrom, to) <= 0) {
    for (const series of activeSeries(data)) {
      applyFilters(virtualOccurrencesBetween(series, data.tasks, virtualFrom, to), filters).forEach(add);
    }
  }
  for (const key of Object.keys(map)) map[key] = sortTasks(map[key], 'due');
  return map;
}

/** 視圖數量（顯示在分頁上）。 */
export function viewCounts(data, todayKey, weekStart = 1) {
  return {
    today: dueTodayTasks(data, todayKey).length,
    overdue: overdueTasks(data, todayKey).length,
    week: thisWeekTasks(data, todayKey, weekStart).length,
    all: allTasks(data, todayKey).length,
    done: doneTasks(data).length,
    archived: archivedTasks(data).length,
  };
}
