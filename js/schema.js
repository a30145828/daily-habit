// 資料格式定義、驗證與版本遷移。
// localStorage 與備份檔共用這裡的驗證規則。
//
// 目前資料格式（版本 1）：
// {
//   todos:    [{ id, title, note, dueDate, priority, done, createdAt, updatedAt, completedAt }],
//   habits:   [{ id, name, createdDate, archived, archivedDate, createdAt, updatedAt }],
//   checkins: [{ habitId, date, createdAt }]
// }
//
// 修改資料格式時：
// 1. 把 CURRENT_VERSION 加 1。
// 2. 在 MIGRATIONS 加入「舊版本 -> 新版本」的轉換函式，不可刪除舊的轉換。
// 3. 更新 validateData 與測試，確認舊版資料與舊版備份都能轉換後通過驗證。

import { isValidDateKey, isValidTimestamp } from './dates.js';
import { HABIT_NAME_MAX_LENGTH, dedupeCheckins } from './habits.js';
import { isValidId } from './ids.js';
import { NOTE_MAX_LENGTH, PRIORITIES, TITLE_MAX_LENGTH } from './todos.js';

export const CURRENT_VERSION = 1;

/**
 * 版本遷移表：key 為舊版本號，函式把該版本資料轉成下一版本。
 * 例：2: (data) => ({ ...data, todos: data.todos.map((t) => ({ ...t, tags: [] })) })
 */
export const MIGRATIONS = {};

const MAX_ERRORS = 20;

export function emptyData() {
  return { todos: [], habits: [], checkins: [] };
}

/** 把 fromVersion 版本的資料逐版轉換成目前版本。 */
export function migrateData(data, fromVersion) {
  if (!Number.isInteger(fromVersion) || fromVersion < 1) {
    throw new Error(`資料版本「${fromVersion}」無法辨識。`);
  }
  if (fromVersion > CURRENT_VERSION) {
    throw new Error(`資料版本 ${fromVersion} 比目前程式支援的版本 ${CURRENT_VERSION} 新，請更新網頁後再試。`);
  }
  let result = data;
  for (let version = fromVersion; version < CURRENT_VERSION; version += 1) {
    const migrate = MIGRATIONS[version];
    if (!migrate) throw new Error(`缺少版本 ${version} 的轉換方式。`);
    result = migrate(result);
  }
  return result;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 驗證並整理資料（只保留已知欄位）。
 * 回傳 { ok, errors: string[], warnings: string[], data }，ok 為 false 時 data 為 null。
 */
export function validateData(input) {
  const errors = [];
  const warnings = [];
  const addError = (message) => {
    if (errors.length < MAX_ERRORS) errors.push(message);
  };

  if (!isPlainObject(input)) {
    return { ok: false, errors: ['資料內容不是正確的格式。'], warnings, data: null };
  }
  for (const field of ['todos', 'habits', 'checkins']) {
    if (!Array.isArray(input[field])) addError(`缺少「${field}」清單。`);
  }
  if (errors.length > 0) return { ok: false, errors, warnings, data: null };

  const todos = [];
  const todoIds = new Set();
  input.todos.forEach((todo, index) => {
    const where = `待辦第 ${index + 1} 筆`;
    if (!isPlainObject(todo)) {
      addError(`${where}：格式不正確。`);
      return;
    }
    const before = errors.length;
    if (!isValidId(todo.id)) addError(`${where}：識別碼不正確。`);
    else if (todoIds.has(todo.id)) addError(`${where}：識別碼「${todo.id}」重複。`);
    if (typeof todo.title !== 'string' || !todo.title.trim()) addError(`${where}：名稱不可空白。`);
    else if (todo.title.length > TITLE_MAX_LENGTH) addError(`${where}：名稱過長。`);
    const note = todo.note ?? '';
    if (typeof note !== 'string' || note.length > NOTE_MAX_LENGTH) addError(`${where}：備註不正確。`);
    const dueDate = todo.dueDate ?? null;
    if (dueDate !== null && !isValidDateKey(dueDate)) addError(`${where}：截止日期「${dueDate}」不正確。`);
    if (!PRIORITIES.includes(todo.priority)) addError(`${where}：優先程度不正確。`);
    if (typeof todo.done !== 'boolean') addError(`${where}：完成狀態不正確。`);
    if (!isValidTimestamp(todo.createdAt)) addError(`${where}：建立時間不正確。`);
    if (!isValidTimestamp(todo.updatedAt)) addError(`${where}：更新時間不正確。`);
    const completedAt = todo.completedAt ?? null;
    if (completedAt !== null && !isValidTimestamp(completedAt)) addError(`${where}：完成時間不正確。`);
    if (errors.length !== before) return;
    todoIds.add(todo.id);
    todos.push({
      id: todo.id,
      title: todo.title.trim(),
      note,
      dueDate,
      priority: todo.priority,
      done: todo.done,
      createdAt: todo.createdAt,
      updatedAt: todo.updatedAt,
      completedAt: todo.done ? completedAt : null,
    });
  });

  const habits = [];
  const habitIds = new Set();
  input.habits.forEach((habit, index) => {
    const where = `習慣第 ${index + 1} 筆`;
    if (!isPlainObject(habit)) {
      addError(`${where}：格式不正確。`);
      return;
    }
    const before = errors.length;
    if (!isValidId(habit.id)) addError(`${where}：識別碼不正確。`);
    else if (habitIds.has(habit.id)) addError(`${where}：識別碼「${habit.id}」重複。`);
    if (typeof habit.name !== 'string' || !habit.name.trim()) addError(`${where}：名稱不可空白。`);
    else if (habit.name.length > HABIT_NAME_MAX_LENGTH) addError(`${where}：名稱過長。`);
    if (!isValidDateKey(habit.createdDate)) addError(`${where}：建立日期「${habit.createdDate}」不正確。`);
    if (typeof habit.archived !== 'boolean') addError(`${where}：封存狀態不正確。`);
    const archivedDate = habit.archivedDate ?? null;
    if (archivedDate !== null && !isValidDateKey(archivedDate)) addError(`${where}：封存日期不正確。`);
    if (!isValidTimestamp(habit.createdAt)) addError(`${where}：建立時間不正確。`);
    if (!isValidTimestamp(habit.updatedAt)) addError(`${where}：更新時間不正確。`);
    if (errors.length !== before) return;
    habitIds.add(habit.id);
    habits.push({
      id: habit.id,
      name: habit.name.trim(),
      createdDate: habit.createdDate,
      archived: habit.archived,
      archivedDate: habit.archived ? archivedDate : null,
      createdAt: habit.createdAt,
      updatedAt: habit.updatedAt,
    });
  });

  const checkins = [];
  input.checkins.forEach((checkin, index) => {
    const where = `打卡紀錄第 ${index + 1} 筆`;
    if (!isPlainObject(checkin)) {
      addError(`${where}：格式不正確。`);
      return;
    }
    const before = errors.length;
    if (!isValidId(checkin.habitId)) addError(`${where}：習慣識別碼不正確。`);
    else if (!habitIds.has(checkin.habitId)) addError(`${where}：找不到對應的習慣「${checkin.habitId}」。`);
    if (!isValidDateKey(checkin.date)) addError(`${where}：日期「${checkin.date}」不正確。`);
    const createdAt = checkin.createdAt ?? null;
    if (createdAt !== null && !isValidTimestamp(createdAt)) addError(`${where}：建立時間不正確。`);
    if (errors.length !== before) return;
    checkins.push({ habitId: checkin.habitId, date: checkin.date, createdAt });
  });

  if (errors.length > 0) return { ok: false, errors, warnings, data: null };

  const deduped = dedupeCheckins(checkins);
  if (deduped.removed > 0) {
    warnings.push(`有 ${deduped.removed} 筆重複的打卡紀錄（同一習慣同一天），已自動合併為一筆。`);
  }
  return { ok: true, errors, warnings, data: { todos, habits, checkins: deduped.checkins } };
}

/** 各類資料筆數。 */
export function countData(data) {
  return {
    todos: data.todos.length,
    habits: data.habits.length,
    checkins: data.checkins.length,
  };
}
