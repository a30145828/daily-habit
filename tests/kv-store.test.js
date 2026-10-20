process.env.TZ = 'Asia/Taipei';

import test from 'node:test';
import assert from 'node:assert/strict';
import { BACKEND_FLAG_KEY, createKvStore, hashString, isAppKey, isDataKey, planMigration } from '../js/kv-store.js';
import { LEGACY_COPY_PREFIX, STORAGE_KEY, accountDataKey, loadData, measureStorage, saveData, storageKind } from '../js/storage.js';
import { createTask } from '../js/tasks.js';

const now = new Date('2026-10-20T02:00:00Z');

/** 模擬 IndexedDB：記錄每次寫入，可以設定讓寫入失敗。 */
function fakeBackend() {
  const saved = new Map();
  const writes = [];
  const backend = {
    saved,
    writes,
    fail: null,
    async write(changes) {
      writes.push(new Map(changes));
      if (backend.fail) throw backend.fail;
      for (const [key, value] of changes) {
        if (value === null) saved.delete(key);
        else saved.set(key, value);
      }
    },
  };
  return backend;
}

function legacyStorage(entries = {}) {
  const map = new Map(Object.entries(entries));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

const dataWith = (title, savedAt) => JSON.stringify({ version: 2, savedAt, tasks: [{ title }] });

// ---------- 同步介面 ----------

test('與 localStorage 相同的讀寫介面，寫入在背景保存', async () => {
  const backend = fakeBackend();
  const store = createKvStore({ entries: new Map([['a', '1']]), backend });
  assert.equal(store.getItem('a'), '1');
  assert.equal(store.getItem('missing'), null);
  store.setItem('b', 2);
  assert.equal(store.getItem('b'), '2', '寫入後立即可讀（內容轉成字串）');
  assert.equal(store.length, 2);
  assert.deepEqual([store.key(0), store.key(1), store.key(2)], ['a', 'b', null]);
  store.removeItem('a');
  assert.equal(store.getItem('a'), null);
  await store.flush();
  assert.deepEqual([...backend.saved], [['b', '2']]);
});

test('同一時間的多次寫入合併成一次', async () => {
  const backend = fakeBackend();
  const store = createKvStore({ backend });
  store.setItem('k', 'x');
  store.setItem('k', 'y');
  store.setItem('j', 'z');
  await store.flush();
  assert.equal(backend.writes.length, 1);
  assert.deepEqual([...backend.writes[0]], [['k', 'y'], ['j', 'z']]);
});

test('現有的 loadData／saveData 可以直接使用', async () => {
  const backend = fakeBackend();
  const store = createKvStore({ backend });
  const data = loadData(store, now).data;
  data.tasks.push(createTask({ title: '新任務', priority: 'medium' }, now));
  assert.equal(saveData(store, data, now).ok, true);
  assert.equal(loadData(store, now).data.tasks[0].title, '新任務');
  await store.flush();
  assert.equal(JSON.parse(backend.saved.get(STORAGE_KEY)).tasks[0].title, '新任務');
});

test('寫入失敗時還原成上次成功保存的內容並通知', async () => {
  const backend = fakeBackend();
  const errors = [];
  const store = createKvStore({ entries: new Map([['k', 'old']]), backend, onError: (keys, error) => errors.push([keys, error.name]) });
  store.setItem('k', 'new');
  store.setItem('added', 'x');
  const quota = new Error('full');
  quota.name = 'QuotaExceededError';
  backend.fail = quota;
  await store.flush();
  assert.equal(store.getItem('k'), 'old');
  assert.equal(store.getItem('added'), null);
  assert.deepEqual(errors, [[['k', 'added'], 'QuotaExceededError']]);

  backend.fail = null;
  store.setItem('k', 'later');
  await store.flush();
  assert.equal(store.getItem('k'), 'later');
  assert.equal(backend.saved.get('k'), 'later');
});

test('寫入失敗時，之後已再次修改的鍵不會被還原', async () => {
  const backend = fakeBackend();
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let calls = 0;
  backend.write = async () => {
    calls += 1;
    if (calls === 1) {
      await gate;
      throw new Error('broken');
    }
  };
  const store = createKvStore({ entries: new Map([['k', 'v0']]), backend });
  store.setItem('k', 'v1');
  await Promise.resolve();
  store.setItem('k', 'v2'); // 第一次寫入還沒完成時又修改
  release();
  await store.flush();
  assert.equal(store.getItem('k'), 'v2');
});

test('backend 直接丟出錯誤也會還原', async () => {
  const store = createKvStore({
    entries: new Map([['k', 'old']]),
    backend: {
      write() {
        throw new Error('sync throw');
      },
    },
  });
  store.setItem('k', 'new');
  await store.flush();
  assert.equal(store.getItem('k'), 'old');
});

test('寫入成功後通知（給其他分頁）', async () => {
  const saved = [];
  const store = createKvStore({ backend: fakeBackend(), onSaved: (keys) => saved.push(keys) });
  store.setItem('a', '1');
  await store.flush();
  assert.deepEqual(saved, [['a']]);
});

test('其他分頁的變更：更新記憶體；自己還沒寫完的鍵以自己為準', async () => {
  const store = createKvStore({ entries: new Map([['a', '1']]), backend: fakeBackend() });
  assert.equal(store.applyExternal('a', '2'), true);
  assert.equal(store.getItem('a'), '2');
  assert.equal(store.applyExternal('a', '2'), false, '內容相同時不算改變');
  assert.equal(store.applyExternal('a', null), true);
  assert.equal(store.getItem('a'), null);
  store.setItem('b', 'mine');
  assert.equal(store.applyExternal('b', 'theirs'), false);
  assert.equal(store.getItem('b'), 'mine');
});

test('刪除時一併刪除舊儲存區的那一份（例如登出時的帳號快取）', async () => {
  const legacy = legacyStorage({ 'daily-habit:u:1:data': 'x', [STORAGE_KEY]: 'local' });
  const store = createKvStore({ entries: new Map([['daily-habit:u:1:data', 'x']]), backend: fakeBackend(), legacy });
  store.removeItem('daily-habit:u:1:data');
  assert.equal(legacy.map.has('daily-habit:u:1:data'), false);
  assert.equal(legacy.map.get(STORAGE_KEY), 'local', '其他資料不受影響');
  store.setItem(STORAGE_KEY, 'changed');
  assert.equal(legacy.map.get(STORAGE_KEY), 'local', '寫入不會改動舊的儲存區');
});

test('用量計算可以用在新的儲存區', () => {
  const store = createKvStore({ entries: new Map([[STORAGE_KEY, 'abc']]), backend: fakeBackend() });
  assert.equal(measureStorage(store, STORAGE_KEY).kinds.current, STORAGE_KEY.length + 3);
});

// ---------- 搬移 ----------

test('只搬移本工具的資料', () => {
  assert.equal(isAppKey(STORAGE_KEY), true);
  assert.equal(isAppKey('daily-habit:before-v1'), true);
  assert.equal(isAppKey('daily-habit:test'), false);
  assert.equal(isAppKey(BACKEND_FLAG_KEY), false);
  assert.equal(isAppKey('other-site'), false);
  assert.equal(isDataKey(STORAGE_KEY), true);
  assert.equal(isDataKey(accountDataKey('u1')), true);
  assert.equal(isDataKey('daily-habit:u:u1:sync'), false);
  assert.notEqual(hashString('abc'), hashString('abd'));
  assert.equal(hashString('abc'), hashString('abc'));
});

test('第一次搬移：複製所有資料，原本的內容不動', () => {
  const legacy = new Map([
    [STORAGE_KEY, dataWith('本機', '2026-10-19T00:00:00Z')],
    ['daily-habit:before-v1', '舊版原始資料'],
    ['daily-habit:corrupt-x', '損壞'],
    ['daily-habit:session', '{"access_token":"t"}'],
  ]);
  const plan = planMigration(legacy, new Map(), null, now);
  assert.deepEqual([...plan.puts], [...legacy]);
  assert.equal(plan.dirty, true);
  assert.deepEqual(plan.preserved, []);
  assert.equal(plan.marker.migratedAt, now.toISOString());
  assert.deepEqual(Object.keys(plan.marker.hashes).sort(), [...legacy.keys()].sort());
});

test('沒有舊資料時也記錄已搬移', () => {
  const plan = planMigration(new Map(), new Map(), null, now);
  assert.equal(plan.puts.size, 0);
  assert.equal(plan.dirty, true);
  const again = planMigration(new Map(), new Map(), plan.marker, now);
  assert.equal(again.dirty, false);
});

test('搬移後沒有變化：不寫入', () => {
  const legacy = new Map([[STORAGE_KEY, dataWith('a', '2026-10-19T00:00:00Z')]]);
  const first = planMigration(legacy, new Map(), null, now);
  const stored = new Map([[STORAGE_KEY, dataWith('新的', '2026-10-20T00:00:00Z')]]);
  const plan = planMigration(legacy, stored, first.marker, now);
  assert.equal(plan.puts.size, 0);
  assert.equal(plan.dirty, false);
});

test('搬移後只有舊版網頁修改了資料：採用舊版網頁的修改', () => {
  const original = dataWith('a', '2026-10-19T00:00:00Z');
  const first = planMigration(new Map([[STORAGE_KEY, original]]), new Map(), null, now);
  const edited = dataWith('舊版網頁新增', '2026-10-20T01:00:00Z');
  const plan = planMigration(new Map([[STORAGE_KEY, edited]]), new Map([[STORAGE_KEY, original]]), first.marker, now);
  assert.equal(plan.puts.get(STORAGE_KEY), edited);
  assert.deepEqual(plan.preserved, []);
  // 下次啟動不再重複處理
  const next = planMigration(new Map([[STORAGE_KEY, edited]]), new Map([[STORAGE_KEY, edited]]), plan.marker, now);
  assert.equal(next.dirty, false);
});

test('兩邊都被修改：採用較新的版本，另一份另存', () => {
  const original = dataWith('a', '2026-10-19T00:00:00Z');
  const first = planMigration(new Map([[STORAGE_KEY, original]]), new Map(), null, now);
  const fromOldPage = dataWith('舊版網頁', '2026-10-20T01:00:00Z');
  const fromNewPage = dataWith('新版網頁', '2026-10-20T00:30:00Z');

  const plan = planMigration(new Map([[STORAGE_KEY, fromOldPage]]), new Map([[STORAGE_KEY, fromNewPage]]), first.marker, now);
  assert.equal(plan.puts.get(STORAGE_KEY), fromOldPage, '舊版網頁的比較新');
  assert.equal(plan.preserved.length, 1);
  assert.ok(plan.preserved[0].startsWith(LEGACY_COPY_PREFIX) && plan.preserved[0].endsWith(`:${STORAGE_KEY}`));
  assert.equal(plan.puts.get(plan.preserved[0]), fromNewPage);
  assert.equal(storageKind(plan.preserved[0], STORAGE_KEY), 'preserved');

  const newer = dataWith('新版網頁更新', '2026-10-20T02:00:00Z');
  const plan2 = planMigration(new Map([[STORAGE_KEY, fromOldPage]]), new Map([[STORAGE_KEY, newer]]), first.marker, now);
  assert.equal(plan2.puts.has(STORAGE_KEY), false, '新儲存區的比較新，保持不變');
  assert.equal(plan2.puts.get(plan2.preserved[0]), fromOldPage);
});

test('兩邊都被修改的設定類資料：以新儲存區為準', () => {
  const first = planMigration(new Map([['daily-habit:session', 'a']]), new Map(), null, now);
  const plan = planMigration(new Map([['daily-habit:session', 'old-page']]), new Map([['daily-habit:session', 'new-page']]), first.marker, now);
  assert.equal(plan.puts.size, 0);
  assert.equal(plan.dirty, true, '記錄新的指紋，下次不再處理');
});

test('舊版網頁新增的鍵會搬過來', () => {
  const first = planMigration(new Map(), new Map(), null, now);
  const key = accountDataKey('u9');
  const plan = planMigration(new Map([[key, 'x']]), new Map(), first.marker, now);
  assert.equal(plan.puts.get(key), 'x');
});
