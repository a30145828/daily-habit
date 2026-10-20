// localStorage 讀寫。原則：
// - 讀不到或資料損壞時，絕不自動覆蓋原本的內容。
// - 寫入失敗時回傳錯誤，讓畫面顯示訊息，並且不套用這次的變更。

import { COLLECTIONS, CURRENT_VERSION, emptyData, migrateData, validateData } from './schema.js';

/** 本機模式（未登入）的資料位置。登入後各帳號另有獨立位置，見 accountDataKey。 */
export const STORAGE_KEY = 'daily-habit:data';
export const CORRUPT_KEY_PREFIX = 'daily-habit:corrupt-';
export const PRE_MIGRATION_KEY_PREFIX = 'daily-habit:before-v';
export const ACCOUNT_KEY_PREFIX = 'daily-habit:u:';

/** 某帳號在這台裝置上的資料快取位置。 */
export function accountDataKey(userId) {
  return `${ACCOUNT_KEY_PREFIX}${userId}:data`;
}

/** 取得可用的 localStorage；無法使用（例如被瀏覽器封鎖）時回傳 null。 */
export function getBrowserStorage() {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return null;
    const testKey = 'daily-habit:test';
    storage.setItem(testKey, '1');
    storage.removeItem(testKey);
    return storage;
  } catch {
    return null;
  }
}

/** 序列化成要存進 localStorage 的文字。 */
export function serializeData(data, now = new Date()) {
  const payload = { version: CURRENT_VERSION, savedAt: now.toISOString() };
  for (const name of COLLECTIONS) payload[name] = data[name];
  return JSON.stringify(payload);
}

/**
 * 讀取資料。回傳：
 * - { status: 'ok', data, warnings, migratedFrom }
 * - { status: 'empty', data }            第一次使用
 * - { status: 'unavailable', data }      瀏覽器不允許使用 localStorage
 * - { status: 'corrupt', raw, errors }   資料無法讀取（原始內容保持不動）
 */
export function loadData(storage, now = new Date(), key = STORAGE_KEY) {
  if (!storage) return { status: 'unavailable', data: emptyData() };

  let raw;
  try {
    raw = storage.getItem(key);
  } catch {
    return { status: 'unavailable', data: emptyData() };
  }
  if (raw === null) return { status: 'empty', data: emptyData() };

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'corrupt', raw, errors: ['儲存的內容不是有效的 JSON。'] };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 'corrupt', raw, errors: ['儲存的內容格式不正確。'] };
  }

  let migrated;
  try {
    const { version, savedAt, ...content } = parsed;
    migrated = migrateData(content, parsed.version);
  } catch (error) {
    return { status: 'corrupt', raw, errors: [error.message] };
  }

  const result = validateData(migrated);
  if (!result.ok) return { status: 'corrupt', raw, errors: result.errors };

  const warnings = [...result.warnings];
  if (parsed.version !== CURRENT_VERSION) {
    // 升級前先把舊版原始資料另存一份，再寫入新版本格式。
    try {
      const backupKey = key === STORAGE_KEY ? `${PRE_MIGRATION_KEY_PREFIX}${parsed.version}` : `${key}:before-v${parsed.version}`;
      if (storage.getItem(backupKey) === null) storage.setItem(backupKey, raw);
      storage.setItem(key, serializeData(result.data, now));
    } catch {
      warnings.push('資料已升級為新版格式，但無法寫回瀏覽器，下次開啟會再升級一次。');
    }
  }
  return { status: 'ok', data: result.data, warnings, migratedFrom: parsed.version };
}

/** 寫入資料。回傳 { ok: true } 或 { ok: false, message }。 */
export function saveData(storage, data, now = new Date(), key = STORAGE_KEY) {
  if (!storage) return { ok: false, message: '瀏覽器不允許儲存資料。' };
  try {
    storage.setItem(key, serializeData(data, now));
    return { ok: true };
  } catch (error) {
    const quota =
      error && (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED' || error.code === 22);
    return {
      ok: false,
      message: quota
        ? '瀏覽器儲存空間已滿，這次變更沒有保存。請先匯出備份並清理瀏覽器資料。'
        : '無法寫入瀏覽器儲存空間，這次變更沒有保存。',
    };
  }
}

/**
 * 把無法讀取的原始內容另存到新的 key，之後才能放心寫入新資料。
 * 回傳 { ok: true, key } 或 { ok: false, message }。
 */
export function preserveCorruptData(storage, raw, now = new Date()) {
  const key = `${CORRUPT_KEY_PREFIX}${now.toISOString().replace(/[:.]/g, '-')}`;
  try {
    storage.setItem(key, raw);
    return { ok: true, key };
  } catch {
    return { ok: false, message: '無法另存損壞的資料（儲存空間可能已滿），請先下載原始內容。' };
  }
}
