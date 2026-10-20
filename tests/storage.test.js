process.env.TZ = 'Asia/Taipei';

import test from 'node:test';
import assert from 'node:assert/strict';
import { ALL_DAYS, createHabit } from '../js/habits.js';
import { CURRENT_VERSION, emptyData } from '../js/schema.js';
import { STORAGE_KEY, accountDataKey, loadData, preserveCorruptData, saveData, serializeData } from '../js/storage.js';

class MemoryStorage {
  constructor(entries = {}) {
    this.map = new Map(Object.entries(entries));
    this.failWrites = false;
  }
  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }
  setItem(key, value) {
    if (this.failWrites) {
      const error = new Error('quota');
      error.name = 'QuotaExceededError';
      throw error;
    }
    this.map.set(key, String(value));
  }
  removeItem(key) {
    this.map.delete(key);
  }
}

const now = new Date('2026-10-20T02:00:00Z');

test('第一次使用回傳 empty', () => {
  const result = loadData(new MemoryStorage());
  assert.equal(result.status, 'empty');
  assert.deepEqual(result.data, emptyData());
});

test('無法使用 localStorage 時回傳 unavailable', () => {
  assert.equal(loadData(null).status, 'unavailable');
});

test('儲存後重新讀取，資料保留且含版本欄位', () => {
  const storage = new MemoryStorage();
  const data = { ...emptyData(), habits: [createHabit('喝水', ALL_DAYS, '2026-10-20', now)] };
  assert.deepEqual(saveData(storage, data, now), { ok: true });
  const stored = JSON.parse(storage.getItem(STORAGE_KEY));
  assert.equal(stored.version, CURRENT_VERSION);
  const loaded = loadData(storage);
  assert.equal(loaded.status, 'ok');
  assert.deepEqual(loaded.data, data);
});

test('損壞的資料回傳 corrupt，且原始內容不被修改', () => {
  const storage = new MemoryStorage({ [STORAGE_KEY]: '{broken' });
  const result = loadData(storage);
  assert.equal(result.status, 'corrupt');
  assert.equal(result.raw, '{broken');
  assert.equal(storage.getItem(STORAGE_KEY), '{broken');
});

test('格式不符的資料也視為 corrupt', () => {
  const raw = JSON.stringify({ version: 2, ...emptyData(), tasks: [{ id: 'x' }] });
  const storage = new MemoryStorage({ [STORAGE_KEY]: raw });
  const result = loadData(storage);
  assert.equal(result.status, 'corrupt');
  assert.ok(result.errors.length > 0);
  assert.equal(storage.getItem(STORAGE_KEY), raw);
});

test('較新版本的資料不會被讀取或覆蓋', () => {
  const raw = JSON.stringify({ version: CURRENT_VERSION + 1, todos: [], habits: [], checkins: [] });
  const storage = new MemoryStorage({ [STORAGE_KEY]: raw });
  assert.equal(loadData(storage).status, 'corrupt');
  assert.equal(storage.getItem(STORAGE_KEY), raw);
});

test('寫入失敗時回傳錯誤訊息，原資料不變', () => {
  const storage = new MemoryStorage();
  saveData(storage, emptyData(), now);
  const before = storage.getItem(STORAGE_KEY);
  storage.failWrites = true;
  const result = saveData(storage, { ...emptyData(), habits: [createHabit('x', ALL_DAYS, '2026-10-20', now)] }, now);
  assert.equal(result.ok, false);
  assert.match(result.message, /空間已滿/);
  assert.equal(storage.getItem(STORAGE_KEY), before);
});

test('損壞資料可另存到獨立的 key', () => {
  const storage = new MemoryStorage({ [STORAGE_KEY]: '{broken' });
  const result = preserveCorruptData(storage, '{broken', now);
  assert.equal(result.ok, true);
  assert.equal(storage.getItem(result.key), '{broken');
});

test('serializeData 只寫入資料欄位', () => {
  const parsed = JSON.parse(serializeData({ ...emptyData(), extra: 1 }, now));
  assert.equal('extra' in parsed, false);
  assert.equal(parsed.version, CURRENT_VERSION);
  assert.ok(Array.isArray(parsed.tasks) && parsed.settings.id === 'settings');
});

test('版本 1 的 localStorage 資料會自動升級，並先另存原始內容', () => {
  const v1 = JSON.stringify({
    version: 1,
    savedAt: '2026-10-19T00:00:00.000Z',
    todos: [{ id: 't_1', title: '舊', note: '', dueDate: null, priority: 'medium', done: false, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', completedAt: null }],
    habits: [],
    checkins: [],
  });
  const storage = new MemoryStorage({ [STORAGE_KEY]: v1 });
  const result = loadData(storage, now);
  assert.equal(result.status, 'ok');
  assert.equal(result.migratedFrom, 1);
  assert.equal(result.data.tasks[0].title, '舊');
  assert.equal(storage.getItem('daily-habit:before-v1'), v1, '原始內容另存');
  assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)).version, CURRENT_VERSION);
  // 再讀一次：已是新版本，不會再升級，也不會覆寫另存的原始內容
  const again = loadData(storage, now);
  assert.equal(again.migratedFrom, CURRENT_VERSION);
  assert.equal(storage.getItem('daily-habit:before-v1'), v1);
});

test('帳號資料與本機資料分開存放', () => {
  const storage = new MemoryStorage();
  const data = { ...emptyData(), habits: [createHabit('帳號A', ALL_DAYS, '2026-10-20', now)] };
  saveData(storage, data, now, accountDataKey('user-a'));
  assert.equal(loadData(storage, now).status, 'empty', '本機資料不受影響');
  assert.equal(loadData(storage, now, accountDataKey('user-a')).data.habits[0].name, '帳號A');
  assert.equal(loadData(storage, now, accountDataKey('user-b')).status, 'empty', '其他帳號看不到');
});
