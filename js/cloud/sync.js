// 雲端同步的資料處理（不碰畫面與網路，方便測試）。
//
// 同步狀態 meta：
//   cursor     已下載到的雲端序號
//   revs       { "集合/id": 雲端版本 }：本機目前內容所根據的雲端版本
//   pending    { "集合/id": true }：本機有尚未上傳的變更（新增、修改或刪除）
//   conflicts  { "集合/id": { collection, id, server, detectedAt } }：雲端與本機都改過，等使用者選擇
//
// 規則：
// - 本機每次儲存，比對前後資料，把變更的紀錄加入 pending。
// - 上傳時附上「看到的版本」（base_rev）；雲端版本不同就回報衝突，不會無聲覆蓋任何一邊。
// - 下載到的紀錄若本機沒有未上傳的變更，直接套用；若有，標記為衝突。
// - 刪除會以「已刪除」標記同步，舊資料不會重新出現。
// - 獎勵帳本（ledger）不可修改：衝突時一律採用雲端版本，再由遊戲化規則重新結算差額。

import { COLLECTIONS, DEFAULT_SETTINGS, validateRecord } from '../schema.js';

export const PUSH_BATCH = 200;

export function emptyMeta() {
  return { cursor: 0, revs: {}, pending: {}, conflicts: {}, lastSyncAt: null, localImportDone: false };
}

export function keyOf(collection, id) {
  return `${collection}/${id}`;
}

export function splitKey(key) {
  const index = key.indexOf('/');
  return { collection: key.slice(0, index), id: key.slice(index + 1) };
}

/** 鍵順序無關的 JSON（比較內容用；雲端 jsonb 不保留鍵的順序）。 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
    .join(',')}}`;
}

export function sameRecord(a, b) {
  if (!a || !b) return a === b || (!a && !b);
  return stableStringify(a) === stableStringify(b);
}

/** 取得某集合的紀錄（settings 為單筆）。 */
export function getRecord(data, collection, id) {
  if (collection === 'settings') return id === 'settings' ? data.settings : null;
  return data[collection]?.find((item) => item.id === id) ?? null;
}

/** 寫入（record 為 null 時刪除）某筆紀錄，回傳新的 data。 */
export function putRecord(data, collection, id, record) {
  if (collection === 'settings') return { ...data, settings: record ?? { ...DEFAULT_SETTINGS } };
  const list = data[collection] ?? [];
  const others = list.filter((item) => item.id !== id);
  if (!record) return others.length === list.length ? data : { ...data, [collection]: others };
  const index = list.findIndex((item) => item.id === id);
  if (index === -1) return { ...data, [collection]: [...list, record] };
  const next = list.slice();
  next[index] = record;
  return { ...data, [collection]: next };
}

/** 比對兩份資料，回傳有變化的紀錄鍵。未變更的紀錄通常是同一個物件，比對很快。 */
export function diffKeys(prev, next) {
  const keys = [];
  for (const collection of COLLECTIONS) {
    if (collection === 'settings') {
      if (prev.settings !== next.settings && !sameRecord(prev.settings, next.settings)) keys.push(keyOf('settings', 'settings'));
      continue;
    }
    const before = new Map((prev[collection] ?? []).map((item) => [item.id, item]));
    const after = new Map((next[collection] ?? []).map((item) => [item.id, item]));
    for (const [id, item] of after) {
      const old = before.get(id);
      if (old !== item && !sameRecord(old, item)) keys.push(keyOf(collection, id));
    }
    for (const id of before.keys()) if (!after.has(id)) keys.push(keyOf(collection, id));
  }
  return keys;
}

export function markPending(meta, keys) {
  if (!keys.length) return meta;
  const pending = { ...meta.pending };
  for (const key of keys) pending[key] = true;
  return { ...meta, pending };
}

export function pendingCount(meta) {
  return Object.keys(meta.pending).filter((key) => !meta.conflicts[key]).length;
}

export function conflictCount(meta) {
  return Object.keys(meta.conflicts).length;
}

/** 組出要上傳的變更（略過衝突中的紀錄）。 */
export function buildChanges(meta, data, limit = PUSH_BATCH) {
  const changes = [];
  for (const key of Object.keys(meta.pending)) {
    if (meta.conflicts[key]) continue;
    const { collection, id } = splitKey(key);
    const record = getRecord(data, collection, id);
    changes.push({
      collection,
      id,
      base_rev: meta.revs[key] ?? null,
      deleted: !record,
      data: record ?? null,
    });
    if (changes.length >= limit) break;
  }
  return changes;
}

/**
 * 套用上傳結果。sent 為送出的變更（與 results 同順序）。
 * 回傳 { meta, data, rejected: [{ change, result }], invalid: [{ change, result }], conflicts: 新增的衝突數 }
 */
export function applyPushResults(meta, data, sent, results, now = new Date()) {
  let nextData = data;
  const revs = { ...meta.revs };
  const pending = { ...meta.pending };
  const conflicts = { ...meta.conflicts };
  const rejected = [];
  const invalid = [];
  let newConflicts = 0;

  sent.forEach((change, index) => {
    const result = results[index] ?? {};
    const key = keyOf(change.collection, change.id);
    const current = getRecord(nextData, change.collection, change.id);
    if (result.status === 'applied') {
      if (result.rev === null || result.rev === undefined) delete revs[key];
      else revs[key] = result.rev;
      // 上傳期間本機又改過：保留 pending，下次再上傳
      const unchanged = change.deleted ? !current : sameRecord(current, change.data);
      if (unchanged) delete pending[key];
    } else if (result.status === 'conflict') {
      const server = result.server ?? {};
      if (change.collection === 'ledger') {
        // 帳本不可修改：採用雲端版本
        nextData = putRecord(nextData, change.collection, change.id, server.deleted ? null : server.data);
        revs[key] = server.rev;
        delete pending[key];
      } else {
        conflicts[key] = { collection: change.collection, id: change.id, server, detectedAt: now.toISOString() };
        newConflicts += 1;
      }
    } else if (result.status === 'rejected') {
      // 目前只有「兌換時雲端金幣不足」：取消本機的兌換紀錄
      nextData = putRecord(nextData, change.collection, change.id, null);
      delete pending[key];
      rejected.push({ change, result });
    } else {
      delete pending[key];
      invalid.push({ change, result });
    }
  });

  return { meta: { ...meta, revs, pending, conflicts }, data: nextData, rejected, invalid, conflicts: newConflicts };
}

/**
 * 套用下載的紀錄。rows：[{ collection, id, data, deleted, rev, seq }]
 * 回傳 { meta, data, applied, conflicts, invalid }
 */
export function applyPullRows(meta, data, rows, now = new Date()) {
  let nextData = data;
  const revs = { ...meta.revs };
  const pending = { ...meta.pending };
  const conflicts = { ...meta.conflicts };
  let cursor = meta.cursor;
  let applied = 0;
  let newConflicts = 0;
  let invalid = 0;

  for (const row of rows) {
    cursor = Math.max(cursor, Number(row.seq) || 0);
    if (!COLLECTIONS.includes(row.collection)) {
      invalid += 1;
      continue;
    }
    const key = keyOf(row.collection, row.id);
    if ((revs[key] ?? 0) >= row.rev && !conflicts[key]) continue; // 已經是這個版本
    const local = getRecord(nextData, row.collection, row.id);

    let incoming = null;
    if (!row.deleted) {
      const result = validateRecord(row.collection, row.data);
      if (!result.ok) {
        invalid += 1;
        continue;
      }
      incoming = result.value;
    }

    if (pending[key]) {
      const same = row.deleted ? !local : sameRecord(local, incoming);
      if (same) {
        revs[key] = row.rev;
        delete pending[key];
        delete conflicts[key];
      } else if (row.collection === 'ledger') {
        nextData = putRecord(nextData, row.collection, row.id, incoming);
        revs[key] = row.rev;
        delete pending[key];
      } else {
        conflicts[key] = { collection: row.collection, id: row.id, server: { data: row.data, deleted: row.deleted, rev: row.rev, seq: row.seq }, detectedAt: now.toISOString() };
        newConflicts += 1;
      }
      continue;
    }

    nextData = putRecord(nextData, row.collection, row.id, incoming);
    revs[key] = row.rev;
    applied += 1;
  }

  return { meta: { ...meta, revs, pending, conflicts, cursor }, data: nextData, applied, conflicts: newConflicts, invalid };
}

/**
 * 處理衝突：choice = 'local'（保留這台裝置的版本，覆蓋雲端）或 'server'（改用雲端版本）。
 */
export function resolveConflict(meta, data, key, choice) {
  const conflict = meta.conflicts[key];
  if (!conflict) return { meta, data };
  const revs = { ...meta.revs };
  const pending = { ...meta.pending };
  const conflicts = { ...meta.conflicts };
  delete conflicts[key];
  let nextData = data;
  if (choice === 'local') {
    revs[key] = conflict.server.rev;
    pending[key] = true;
  } else {
    let incoming = null;
    if (!conflict.server.deleted) {
      const result = validateRecord(conflict.collection, conflict.server.data);
      incoming = result.ok ? result.value : null;
    }
    nextData = putRecord(nextData, conflict.collection, conflict.id, incoming);
    revs[key] = conflict.server.rev;
    delete pending[key];
  }
  return { meta: { ...meta, revs, pending, conflicts }, data: nextData };
}

/** 衝突的簡短說明（顯示用）。 */
export function describeRecord(collection, record) {
  if (!record) return '（已刪除）';
  return record.title ?? record.name ?? record.note ?? record.label ?? record.id;
}

// ---------- 本機資料匯入帳號 ----------

/**
 * 規劃把本機（未登入）資料匯入帳號：只加入帳號中「沒有相同 id」的紀錄；
 * 相同 id 的保留帳號版本（例如預設分類），因此重複執行不會產生重複資料。設定不匯入。
 * 回傳 { additions: { 集合: 紀錄[] }, addCount, skipCount }
 */
export function planLocalImport(accountData, localData) {
  const additions = {};
  let addCount = 0;
  let skipCount = 0;
  for (const collection of COLLECTIONS) {
    if (collection === 'settings') continue;
    const existing = new Set((accountData[collection] ?? []).map((item) => item.id));
    const add = (localData[collection] ?? []).filter((item) => !existing.has(item.id));
    skipCount += (localData[collection] ?? []).length - add.length;
    if (add.length) additions[collection] = add;
    addCount += add.length;
  }
  return { additions, addCount, skipCount };
}

export function applyLocalImport(accountData, plan) {
  const data = { ...accountData };
  for (const [collection, list] of Object.entries(plan.additions)) data[collection] = [...data[collection], ...list];
  return data;
}
