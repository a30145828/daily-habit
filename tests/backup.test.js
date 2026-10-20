process.env.TZ = 'Asia/Taipei';

import test from 'node:test';
import assert from 'node:assert/strict';
import { backupFileName, createBackup, validateBackupObject, validateBackupText } from '../js/backup.js';
import { ALL_DAYS, createHabit, setCheckin } from '../js/habits.js';
import { buildSampleData, mergeSample } from '../js/sample.js';
import { CURRENT_VERSION, checkinId, emptyData, migrateData } from '../js/schema.js';
import { createTask } from '../js/tasks.js';

const now = new Date('2026-10-20T02:00:00Z');
const today = '2026-10-20';

function sampleState() {
  const habit = createHabit('喝水', ALL_DAYS, today, now);
  return {
    ...emptyData(),
    tasks: [createTask({ title: '<img src=x onerror=alert(1)>', note: '', dueDate: today, priority: 'high', tags: ['a'], subtasks: [] }, now)],
    habits: [habit],
    checkins: setCheckin([], habit.id, today, true, now),
  };
}

/** 版本 1（第一版）的備份檔，用來確認舊備份仍可還原。 */
const V1_BACKUP = {
  app: 'daily-habit',
  version: 1,
  exportedAt: '2026-10-19T12:00:00.000Z',
  data: {
    todos: [
      { id: 't_1', title: '舊待辦', note: '備註', dueDate: '2026-10-19', priority: 'high', done: false, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', completedAt: null },
      { id: 't_2', title: '完成的', note: '', dueDate: null, priority: 'low', done: true, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z', completedAt: '2026-10-02T00:00:00.000Z' },
    ],
    habits: [
      { id: 'h_1', name: '舊習慣', createdDate: '2026-10-10', archived: true, archivedDate: '2026-10-15', createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-15T00:00:00.000Z' },
    ],
    checkins: [
      { habitId: 'h_1', date: '2026-10-12', createdAt: null },
      { habitId: 'h_1', date: '2026-10-12', createdAt: null },
      { habitId: 'h_1', date: '2026-10-13', createdAt: '2026-10-13T01:00:00.000Z' },
    ],
  },
};

test('匯出檔名包含台灣當地日期', () => {
  assert.equal(backupFileName(new Date('2026-10-20T16:30:00Z')), 'daily-habit-backup-2026-10-21.json');
});

test('匯出後再匯入，資料完全一致並回報筆數', () => {
  const state = sampleState();
  const result = validateBackupText(JSON.stringify(createBackup(state, now)));
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.deepEqual(result.data, state);
  assert.equal(result.counts.tasks, 1);
  assert.equal(result.counts.habits, 1);
  assert.equal(result.counts.checkins, 1);
  assert.equal(result.version, CURRENT_VERSION);
});

test('版本 1 的舊備份可以還原，並轉換為版本 2', () => {
  const result = validateBackupObject(V1_BACKUP);
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(result.version, 1);
  assert.equal(result.data.tasks.length, 2);
  assert.deepEqual(result.data.tasks[0].tags, []);
  assert.equal(result.data.tasks[1].done, true);
  assert.equal(result.data.habits[0].archived, true);
  assert.deepEqual(result.data.habits[0].schedules, [{ from: '2026-10-10', days: ALL_DAYS }]);
  assert.deepEqual(result.data.checkins.map((c) => c.id), [checkinId('h_1', '2026-10-12'), checkinId('h_1', '2026-10-13')]);
  assert.equal(result.warnings.length, 1, '重複打卡合併的提示');
  assert.ok(result.data.categories.length > 0, '補上預設分類');
  assert.equal(result.data.settings.baseCurrency, 'TWD');
});

test('範例資料可通過驗證', () => {
  const merged = mergeSample(emptyData(), buildSampleData(today, now));
  const result = validateBackupObject(createBackup(merged, now));
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.ok(result.counts.series >= 1 && result.counts.tasks >= 1 && result.counts.checkins >= 1);
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

test('缺少欄位、錯誤日期、錯誤金額會被拒絕', () => {
  const backup = createBackup(sampleState(), now);
  const { checkins, ...rest } = backup.data;
  assert.equal(validateBackupObject({ ...backup, data: rest }).ok, false);
  const badDue = { ...backup.data, tasks: [{ ...backup.data.tasks[0], dueDate: '2026-02-30' }] };
  assert.match(validateBackupObject({ ...backup, data: badDue }).errors[0], /2026-02-30/);
  const badTxn = {
    ...backup.data,
    transactions: [{ id: 'x_1', type: 'expense', date: today, amountMinor: 1.5, currency: 'TWD', createdAt: now.toISOString(), updatedAt: now.toISOString() }],
  };
  assert.match(validateBackupObject({ ...backup, data: badTxn }).errors[0], /金額/);
});

test('識別碼錯誤或重複會被拒絕；打卡 id 必須與習慣、日期一致', () => {
  const backup = createBackup(sampleState(), now);
  const t = backup.data.tasks[0];
  assert.match(validateBackupObject({ ...backup, data: { ...backup.data, tasks: [t, { ...t }] } }).errors[0], /重複/);
  assert.equal(validateBackupObject({ ...backup, data: { ...backup.data, tasks: [{ ...t, id: 'bad id!' }] } }).ok, false);
  const c = backup.data.checkins[0];
  assert.equal(validateBackupObject({ ...backup, data: { ...backup.data, checkins: [{ ...c, id: 'c_other' }] } }).ok, false);
});

test('未知的多餘欄位會被忽略', () => {
  const backup = createBackup(sampleState(), now);
  const tasks = [{ ...backup.data.tasks[0], extra: 'x' }];
  const result = validateBackupObject({ ...backup, data: { ...backup.data, tasks } });
  assert.equal(result.ok, true);
  assert.equal('extra' in result.data.tasks[0], false);
});

test('migrateData 會依序套用版本轉換', () => {
  assert.deepEqual(migrateData({ a: 1 }, CURRENT_VERSION), { a: 1 });
  assert.throws(() => migrateData({}, 0));
  assert.throws(() => migrateData({}, CURRENT_VERSION + 1), /新/);
});

test('重複載入範例資料不會產生重複 id（例如固定 id 的預算）', () => {
  let data = mergeSample(emptyData(), buildSampleData(today, now));
  data = mergeSample(data, buildSampleData(today, now));
  const result = validateBackupObject(createBackup(data, now));
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(data.budgets.length, 1);
});
