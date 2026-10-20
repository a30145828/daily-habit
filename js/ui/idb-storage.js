// 開啟大容量儲存（IndexedDB），把 localStorage 的資料搬過去（原本的內容保留不動）。
// 無法使用時退回 localStorage（約 5 MB），網站照常運作。
// 其他分頁的變更透過 BroadcastChannel 通知，並轉成與 localStorage 相同的 storage 事件。

import { BACKEND_FLAG_KEY, createKvStore, isAppKey, planMigration } from '../kv-store.js';
import { getBrowserStorage } from '../storage.js';

const DB_NAME = 'daily-habit';
const DB_VERSION = 1;
const KV = 'kv';
const META = 'meta';
const MIGRATION_KEY = 'migration';
const CHANNEL = 'daily-habit-storage';

function done(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openDb(timeoutMs) {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      reject(new Error('開啟逾時'));
    }, timeoutMs);
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(KV)) db.createObjectStore(KV);
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
    };
    request.onsuccess = () => {
      clearTimeout(timer);
      const db = request.result;
      if (timedOut) db.close();
      else resolve(db);
    };
    request.onerror = () => {
      clearTimeout(timer);
      reject(request.error);
    };
  });
}

async function readAll(db) {
  const tx = db.transaction([KV, META], 'readonly');
  const kv = tx.objectStore(KV);
  const [keys, values, marker] = await Promise.all([done(kv.getAllKeys()), done(kv.getAll()), done(tx.objectStore(META).get(MIGRATION_KEY))]);
  return { entries: new Map(keys.map((key, i) => [key, values[i]])), marker: marker ?? null };
}

function writeAll(db, changes, marker = null) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([KV, META], 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('寫入中止'));
    try {
      const kv = tx.objectStore(KV);
      for (const [key, value] of changes) {
        if (value === null) kv.delete(key);
        else kv.put(value, key);
      }
      if (marker) tx.objectStore(META).put(marker, MIGRATION_KEY);
    } catch (error) {
      try {
        tx.abort();
      } catch {
        // 已中止
      }
      reject(error);
    }
  });
}

/** localStorage 中本工具的資料（無法使用時為空）。 */
function readLegacy() {
  const entries = new Map();
  let storage = null;
  try {
    storage = globalThis.localStorage ?? null;
    for (let i = 0; i < (storage?.length ?? 0); i += 1) {
      const key = storage.key(i);
      if (isAppKey(key)) entries.set(key, storage.getItem(key));
    }
  } catch {
    storage = null;
  }
  return { storage, entries };
}

function readFlag(storage) {
  try {
    return storage?.getItem(BACKEND_FLAG_KEY) === 'indexeddb';
  } catch {
    return false;
  }
}

function writeFlag(storage) {
  try {
    if (storage && storage.getItem(BACKEND_FLAG_KEY) !== 'indexeddb') storage.setItem(BACKEND_FLAG_KEY, 'indexeddb');
  } catch {
    // 無法記錄時略過
  }
}

function fallback(notices) {
  const storage = getBrowserStorage();
  globalThis.dailyHabitStorage = { backend: storage ? 'localstorage' : null, flush: async () => {} };
  return { storage, backend: storage ? 'localstorage' : null, notices };
}

/**
 * 開啟網站要使用的儲存區。回傳 { storage, backend: 'indexeddb'|'localstorage'|null, notices: [{ text, type }] }。
 * handlers.onError(keys, error)：背景寫入失敗（變更已還原）。
 * handlers.onExternalChange(key, oldValue, newValue)：其他分頁修改了資料。
 */
export async function openAppStorage({ onError = () => {}, onExternalChange = () => {} } = {}) {
  const legacy = readLegacy();
  const usedBefore = readFlag(legacy.storage);
  if (typeof indexedDB === 'undefined' || !indexedDB) return fallback([]);

  let db;
  let snapshot;
  try {
    // 曾經使用過大容量儲存時多等一會兒，避免因一時開啟太慢就改用舊的資料
    db = await openDb(usedBefore ? 10000 : 4000);
    snapshot = await readAll(db);
  } catch {
    db?.close();
    return fallback(
      usedBefore
        ? [{ text: '暫時無法開啟大容量儲存區，目前改用舊的儲存區，顯示的內容可能不是最新的。請重新整理頁面；如果一直發生，請先匯出備份。', type: 'error' }]
        : [],
    );
  }

  const notices = [];
  const plan = planMigration(legacy.entries, snapshot.entries, snapshot.marker);
  if (plan.dirty) {
    try {
      await writeAll(db, plan.puts, plan.marker);
    } catch {
      db.close();
      return fallback([]);
    }
  }
  for (const [key, value] of plan.puts) snapshot.entries.set(key, value);
  writeFlag(legacy.storage);
  if (!snapshot.marker && legacy.entries.size) {
    notices.push({ text: '資料已搬到容量較大的儲存區。原本的資料仍原封不動保留在舊的儲存區。', type: 'info' });
  }
  if (plan.preserved.length) {
    notices.push({
      text: '偵測到舊版網頁在資料搬移後又修改了資料：已採用較新的版本，另一份已另存在這台裝置（不會刪除）。',
      type: 'warning',
    });
  }

  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL) : null;
  db.onversionchange = () => db.close();

  async function write(changes) {
    try {
      await writeAll(db, changes);
    } catch (error) {
      if (error?.name !== 'InvalidStateError') throw error;
      // 連線被瀏覽器關閉：重新開啟後再試一次
      db = await openDb(4000);
      db.onversionchange = () => db.close();
      await writeAll(db, changes);
    }
  }

  const storage = createKvStore({
    entries: snapshot.entries,
    backend: { write },
    legacy: legacy.storage,
    onSaved: (keys) => channel?.postMessage({ keys }),
    onError,
  });

  if (channel) {
    channel.onmessage = async (event) => {
      for (const key of event.data?.keys ?? []) {
        let value;
        try {
          value = (await done(db.transaction(KV, 'readonly').objectStore(KV).get(key))) ?? null;
        } catch {
          continue;
        }
        const oldValue = storage.getItem(key);
        if (storage.applyExternal(key, value)) onExternalChange(key, oldValue, value);
      }
    };
  }

  globalThis.dailyHabitStorage = { backend: 'indexeddb', flush: () => storage.flush() };
  return { storage, backend: 'indexeddb', notices };
}
