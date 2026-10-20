process.env.TZ = 'Asia/Taipei';

import test from 'node:test';
import assert from 'node:assert/strict';
import { backupFileName, createBackup, validateBackupObject, validateBackupText } from '../js/backup.js';
import { createHabit, setCheckin } from '../js/habits.js';
import { buildSampleData } from '../js/sample.js';
import { CURRENT_VERSION, migrateData } from '../js/schema.js';
import { createTodo } from '../js/todos.js';

const now = new Date('2026-10-20T02:00:00Z');
const today = '2026-10-20';

function sampleState() {
  const habit = createHabit('喝水', now);
  return {
    todos: [createTodo({ title: '<img src=x onerror=alert(1)>', note: '', dueDate: today, priority: 'high' }, now)],
    habits: [habit],
    checkins: setCheckin([], habit.id, today, true, now),
  };
}

test('匯出檔名包含台灣當地日期', () => {
  assert.equal(backupFileName(new Date('2026-10-20T16:30:00Z')), 'daily-habit-backup-2026-10-21.json');
});

test('匯出後再匯入，資料完全一致並回報筆數', () => {
  const state = sampleState();
  const text = JSON.stringify(createBackup(state, now));
  const result = validateBackupText(text);
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.deepEqual(result.data, state);
  assert.deepEqual(result.counts, { todos: 1, habits: 1, checkins: 1 });
  assert.equal(result.version, CURRENT_VERSION);
  assert.equal(result.exportedAt, now.toISOString());
});

test('範例資料可通過驗證', () => {
  const result = validateBackupObject(createBackup(buildSampleData(today, now), now));
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.deepEqual(result.counts, { todos: 5, habits: 3, checkins: 12 });
});

test('非 JSON、空檔案、其他程式的檔案都會被拒絕', () => {
  assert.equal(validateBackupText('').ok, false);
  assert.equal(validateBackupText('{not json').ok, false);
  assert.equal(validateBackupText('[]').ok, false);
  assert.match(validateBackupText('{"app":"other","version":1,"data":{}}').errors[0], /不是/);
});

test('缺少版本或版本過新會被拒絕', () => {
  const backup = createBackup(sampleState(), now);
  assert.equal(validateBackupObject({ ...backup, version: undefined }).ok, false);
  const newer = validateBackupObject({ ...backup, version: CURRENT_VERSION + 1 });
  assert.equal(newer.ok, false);
  assert.match(newer.errors[0], /新/);
});

test('缺少欄位會被拒絕', () => {
  const backup = createBackup(sampleState(), now);
  const { checkins, ...rest } = backup.data;
  assert.equal(validateBackupObject({ ...backup, data: rest }).ok, false);
  const todo = { ...backup.data.todos[0] };
  delete todo.title;
  assert.equal(validateBackupObject({ ...backup, data: { ...backup.data, todos: [todo] } }).ok, false);
});

test('錯誤的日期會被拒絕', () => {
  const backup = createBackup(sampleState(), now);
  const badDue = { ...backup.data, todos: [{ ...backup.data.todos[0], dueDate: '2026-02-30' }] };
  assert.match(validateBackupObject({ ...backup, data: badDue }).errors[0], /截止日期/);
  const badCheckin = { ...backup.data, checkins: [{ ...backup.data.checkins[0], date: '2026/10/20' }] };
  assert.equal(validateBackupObject({ ...backup, data: badCheckin }).ok, false);
  const badCreated = { ...backup.data, habits: [{ ...backup.data.habits[0], createdDate: 'today' }] };
  assert.equal(validateBackupObject({ ...backup, data: badCreated }).ok, false);
});

test('識別碼錯誤、重複或對應不到習慣會被拒絕', () => {
  const backup = createBackup(sampleState(), now);
  const t = backup.data.todos[0];
  const dupTodos = { ...backup.data, todos: [t, { ...t }] };
  assert.match(validateBackupObject({ ...backup, data: dupTodos }).errors[0], /重複/);
  const badId = { ...backup.data, todos: [{ ...t, id: 'bad id!' }] };
  assert.equal(validateBackupObject({ ...backup, data: badId }).ok, false);
  const orphan = { ...backup.data, checkins: [{ habitId: 'h_missing', date: today, createdAt: null }] };
  assert.match(validateBackupObject({ ...backup, data: orphan }).errors[0], /找不到/);
});

test('重複打卡會被合併並提出警告，而不是拒絕', () => {
  const backup = createBackup(sampleState(), now);
  const c = backup.data.checkins[0];
  const result = validateBackupObject({ ...backup, data: { ...backup.data, checkins: [c, { ...c }] } });
  assert.equal(result.ok, true);
  assert.equal(result.data.checkins.length, 1);
  assert.equal(result.warnings.length, 1);
});

test('未知的多餘欄位會被忽略，不會寫入資料', () => {
  const backup = createBackup(sampleState(), now);
  const todos = [{ ...backup.data.todos[0], extra: 'x' }];
  const result = validateBackupObject({ ...backup, data: { ...backup.data, todos } });
  assert.equal(result.ok, true);
  assert.equal('extra' in result.data.todos[0], false);
});

test('migrateData 會依序套用版本轉換', () => {
  assert.deepEqual(migrateData({ a: 1 }, CURRENT_VERSION), { a: 1 });
  assert.throws(() => migrateData({}, 0));
});
