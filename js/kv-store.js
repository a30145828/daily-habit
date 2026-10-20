// 大容量儲存（IndexedDB）的共用邏輯，不直接存取瀏覽器 API，以便測試。
// - createKvStore：提供與 localStorage 相同的同步介面（getItem、setItem…），
//   內容放在記憶體，寫入在背景交給 backend 保存；寫入失敗時還原成上次成功保存的內容。
// - planMigration：把 localStorage 的資料搬到新的儲存區。原本的 localStorage 內容一律保留不動；
//   如果搬移後舊版網頁又修改了 localStorage，採用較新的版本，另一份另存（不會刪除）。

import { ACCOUNT_KEY_PREFIX, LEGACY_COPY_PREFIX, STORAGE_KEY } from './storage.js';

/** 只搬移本工具的資料；daily-habit:test 是測試能否寫入用的暫存鍵。 */
export const APP_KEY_PREFIX = 'daily-habit:';
const TEST_KEY = 'daily-habit:test';

/** 記在 localStorage：這台裝置已改用大容量儲存（之後若暫時無法開啟，才知道要提醒使用者）。 */
export const BACKEND_FLAG_KEY = 'daily-habit:storage-backend';

export function isAppKey(key) {
  return typeof key === 'string' && key.startsWith(APP_KEY_PREFIX) && key !== TEST_KEY && key !== BACKEND_FLAG_KEY;
}

/** 字串的簡短指紋（FNV-1a），用來判斷內容是否改變。 */
export function hashString(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${text.length}:${(hash >>> 0).toString(16)}`;
}

/** 資料鍵（本機資料或帳號資料）才有 savedAt，可以比較新舊。 */
export function isDataKey(key) {
  return key === STORAGE_KEY || (key.startsWith(ACCOUNT_KEY_PREFIX) && key.endsWith(':data'));
}

function savedAtOf(raw) {
  try {
    const time = Date.parse(JSON.parse(raw).savedAt);
    return Number.isFinite(time) ? time : -Infinity;
  } catch {
    return -Infinity;
  }
}

/**
 * 決定要寫入新儲存區的內容。
 * legacy：localStorage 中本工具的資料 Map；stored：新儲存區目前的內容 Map；marker：上次搬移的紀錄（第一次為 null）。
 * 回傳 { puts: Map, marker, preserved: [另存的鍵], dirty: 是否需要寫入 }。不會刪除任何內容。
 */
export function planMigration(legacy, stored, marker, now = new Date()) {
  const puts = new Map();
  const preserved = [];
  const hashes = { ...(marker?.hashes ?? {}) };
  let dirty = !marker;
  const copyKey = (key) => `${LEGACY_COPY_PREFIX}${now.toISOString()}-${preserved.length + 1}:${key}`;
  const keep = (key, value) => {
    const name = copyKey(key);
    puts.set(name, value);
    preserved.push(name);
  };

  for (const [key, value] of legacy) {
    if (!isAppKey(key)) continue;
    const hash = hashString(value);
    const current = stored.get(key);
    if (!marker) {
      // 第一次搬移：新儲存區應該是空的；萬一已有不同內容，先另存再採用 localStorage 的內容
      if (current !== undefined && current !== value) keep(key, current);
      if (current !== value) puts.set(key, value);
    } else if (hashes[key] !== hash) {
      // 搬移後 localStorage 又被修改（例如還開著舊版網頁）
      const storedUnchanged = current === undefined || hashString(current) === hashes[key];
      if (storedUnchanged) puts.set(key, value);
      else if (current !== value && isDataKey(key)) {
        if (savedAtOf(value) > savedAtOf(current)) {
          keep(key, current);
          puts.set(key, value);
        } else {
          keep(key, value);
        }
      }
      // 其他設定（登入狀態、同步紀錄等）兩邊都改過時，以新儲存區為準
    }
    if (hashes[key] !== hash) dirty = true;
    hashes[key] = hash;
  }
  return { puts, preserved, dirty: dirty || puts.size > 0, marker: { migratedAt: marker?.migratedAt ?? now.toISOString(), hashes } };
}

/**
 * 建立同步介面的儲存物件。
 * entries：啟動時從新儲存區讀出的內容（Map）。
 * backend.write(changes)：changes 為 Map<key, 字串|null（刪除）>，回傳 Promise。
 * legacy：原本的 localStorage（可為 null）；刪除資料時一併刪除舊的那份（例如登出時的帳號快取）。
 * onSaved(keys)：寫入成功；onError(keys, error)：寫入失敗，記憶體已還原成上次成功保存的內容。
 */
export function createKvStore({ entries = new Map(), backend, legacy = null, onSaved = () => {}, onError = () => {} }) {
  const memory = new Map(entries);
  const durable = new Map(entries);
  let pending = new Map();
  const inFlight = new Map(); // key → 正在寫入的批次數
  let scheduled = false;
  let chain = Promise.resolve();

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      writeBatch();
    });
  }

  function writeBatch() {
    if (!pending.size) return;
    const changes = pending;
    pending = new Map();
    for (const key of changes.keys()) inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
    let request;
    try {
      request = Promise.resolve(backend.write(changes));
    } catch (error) {
      request = Promise.reject(error);
    }
    chain = chain.then(() =>
      request.then(
        () => {
          for (const [key, value] of changes) {
            if (value === null) durable.delete(key);
            else durable.set(key, value);
          }
          settle(changes);
          onSaved([...changes.keys()]);
        },
        (error) => {
          settle(changes);
          // 還原：之後沒有再修改過的鍵，回到上次成功保存的內容
          const reverted = [];
          for (const key of changes.keys()) {
            if (pending.has(key) || inFlight.has(key)) continue;
            if (durable.has(key)) memory.set(key, durable.get(key));
            else memory.delete(key);
            reverted.push(key);
          }
          onError(reverted, error);
        },
      ),
    );
  }

  function settle(changes) {
    for (const key of changes.keys()) {
      const count = inFlight.get(key) - 1;
      if (count > 0) inFlight.set(key, count);
      else inFlight.delete(key);
    }
  }

  return {
    get length() {
      return memory.size;
    },
    key(index) {
      return [...memory.keys()][index] ?? null;
    },
    getItem(key) {
      return memory.has(key) ? memory.get(key) : null;
    },
    setItem(key, value) {
      const text = String(value);
      memory.set(key, text);
      pending.set(key, text);
      schedule();
    },
    removeItem(key) {
      memory.delete(key);
      pending.set(key, null);
      schedule();
      try {
        legacy?.removeItem(key);
      } catch {
        // 舊的儲存區無法使用時略過
      }
    },
    /** 等待目前所有變更寫入完成。 */
    async flush() {
      writeBatch();
      await chain;
    },
    /** 其他分頁修改了這個鍵：更新記憶體。這個分頁自己還沒寫完的鍵不更新（以自己的變更為準）。回傳是否有改變。 */
    applyExternal(key, value) {
      if (pending.has(key) || inFlight.has(key)) return false;
      const old = memory.has(key) ? memory.get(key) : null;
      if (old === value) return false;
      if (value === null) {
        memory.delete(key);
        durable.delete(key);
      } else {
        memory.set(key, value);
        durable.set(key, value);
      }
      return true;
    },
  };
}
