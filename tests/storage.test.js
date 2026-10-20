process.env.TZ = 'Asia/Taipei';

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHabit } from '../js/habits.js';
import { CURRENT_VERSION } from '../js/schema.js';
import { STORAGE_KEY, loadData, preserveCorruptData, saveData, serializeData } from '../js/storage.js';

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
  assert.deepEqual(result.data, { todos: [], habits: [], checkins: [] });
});

test('無法使用 localStorage 時回傳 unavailable', () => {
  assert.equal(loadData(null).status, 'unavailable');
});

test('儲存後重新讀取，資料保留且含版本欄位', () => {
  const storage = new MemoryStorage();
  const data = { todos: [], habits: [createHabit('喝水', now)], checkins: [] };
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
  const raw = JSON.stringify({ version: 1, todos: [{ id: 'x' }], habits: [], checkins: [] });
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
  saveData(storage, { todos: [], habits: [], checkins: [] }, now);
  const before = storage.getItem(STORAGE_KEY);
  storage.failWrites = true;
  const result = saveData(storage, { todos: [], habits: [createHabit('x', now)], checkins: [] }, now);
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
  const parsed = JSON.parse(serializeData({ todos: [], habits: [], checkins: [], extra: 1 }, now));
  assert.deepEqual(Object.keys(parsed).sort(), ['checkins', 'habits', 'savedAt', 'todos', 'version']);
});
