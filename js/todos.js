// 待辦事項的建立、驗證、篩選與排序。所有函式都不修改傳入的資料，而是回傳新資料。

import { compareDateKeys, isValidDateKey } from './dates.js';
import { createId } from './ids.js';

export const PRIORITIES = ['high', 'medium', 'low'];
export const PRIORITY_LABELS = { high: '高', medium: '中', low: '低' };
export const FILTERS = ['all', 'open', 'done'];
export const FILTER_LABELS = { all: '全部', open: '未完成', done: '已完成' };

export const TITLE_MAX_LENGTH = 200;
export const NOTE_MAX_LENGTH = 2000;

const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };

/**
 * 檢查使用者在表單輸入的待辦內容。
 * 回傳 { ok: true, value } 或 { ok: false, errors: { 欄位: 訊息 } }。
 */
export function validateTodoInput(input) {
  const errors = {};
  const title = String(input.title ?? '').trim();
  const note = String(input.note ?? '').trim();
  const dueDate = input.dueDate ? String(input.dueDate) : null;
  const priority = input.priority ?? 'medium';

  if (!title) errors.title = '請輸入待辦名稱。';
  else if (title.length > TITLE_MAX_LENGTH) errors.title = `名稱最多 ${TITLE_MAX_LENGTH} 個字。`;
  if (note.length > NOTE_MAX_LENGTH) errors.note = `備註最多 ${NOTE_MAX_LENGTH} 個字。`;
  if (dueDate !== null && !isValidDateKey(dueDate)) errors.dueDate = '截止日期格式不正確。';
  if (!PRIORITIES.includes(priority)) errors.priority = '請選擇優先程度。';

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { title, note, dueDate, priority } };
}

/** 建立新的待辦。input 需先通過 validateTodoInput。 */
export function createTodo(input, now = new Date()) {
  const timestamp = now.toISOString();
  return {
    id: createId('t'),
    title: input.title,
    note: input.note,
    dueDate: input.dueDate,
    priority: input.priority,
    done: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: null,
  };
}

/** 修改待辦內容（名稱、備註、截止日期、優先程度）。 */
export function updateTodo(todos, id, input, now = new Date()) {
  return todos.map((todo) =>
    todo.id === id
      ? {
          ...todo,
          title: input.title,
          note: input.note,
          dueDate: input.dueDate,
          priority: input.priority,
          updatedAt: now.toISOString(),
        }
      : todo,
  );
}

/** 標記完成或取消完成。 */
export function setTodoDone(todos, id, done, now = new Date()) {
  const timestamp = now.toISOString();
  return todos.map((todo) =>
    todo.id === id
      ? { ...todo, done, completedAt: done ? timestamp : null, updatedAt: timestamp }
      : todo,
  );
}

export function deleteTodo(todos, id) {
  return todos.filter((todo) => todo.id !== id);
}

/** 依篩選條件（all / open / done）回傳待辦。 */
export function filterTodos(todos, filter) {
  if (filter === 'open') return todos.filter((todo) => !todo.done);
  if (filter === 'done') return todos.filter((todo) => todo.done);
  return todos.slice();
}

/** 今天到期且未完成的待辦。 */
export function dueTodayTodos(todos, todayKey) {
  return sortTodos(todos.filter((todo) => !todo.done && todo.dueDate === todayKey));
}

/** 已逾期（截止日早於今天）且未完成的待辦。 */
export function overdueTodos(todos, todayKey) {
  return sortTodos(
    todos.filter((todo) => !todo.done && todo.dueDate && compareDateKeys(todo.dueDate, todayKey) < 0),
  );
}

/** 待辦相對於今天的狀態：'overdue'、'today'、'upcoming' 或 'none'（無截止日）。 */
export function dueStatus(todo, todayKey) {
  if (!todo.dueDate) return 'none';
  const diff = compareDateKeys(todo.dueDate, todayKey);
  if (diff < 0) return 'overdue';
  if (diff === 0) return 'today';
  return 'upcoming';
}

/**
 * 排序：未完成在前；未完成依截止日（無截止日排最後）、優先程度、建立時間；
 * 已完成依完成時間新到舊。
 */
export function sortTodos(todos) {
  return todos.slice().sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    if (a.done) return String(b.completedAt ?? '').localeCompare(String(a.completedAt ?? ''));
    if (a.dueDate !== b.dueDate) {
      if (!a.dueDate) return 1;
      if (!b.dueDate) return -1;
      return compareDateKeys(a.dueDate, b.dueDate);
    }
    if (a.priority !== b.priority) return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    return a.createdAt.localeCompare(b.createdAt);
  });
}
