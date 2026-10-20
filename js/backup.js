// 備份檔的產生與驗證。
// 備份檔格式：
// { "app": "daily-habit", "version": 1, "exportedAt": "ISO 時間", "data": { todos, habits, checkins } }

import { toDateKey } from './dates.js';
import { CURRENT_VERSION, countData, migrateData, validateData } from './schema.js';

export const BACKUP_APP_ID = 'daily-habit';
export const BACKUP_MAX_BYTES = 5 * 1024 * 1024;

/** 產生備份物件。 */
export function createBackup(data, now = new Date()) {
  return {
    app: BACKUP_APP_ID,
    version: CURRENT_VERSION,
    exportedAt: now.toISOString(),
    data: {
      todos: data.todos,
      habits: data.habits,
      checkins: data.checkins,
    },
  };
}

/** 備份檔名，包含當地日期，例如 daily-habit-backup-2026-10-20.json。 */
export function backupFileName(now = new Date()) {
  return `daily-habit-backup-${toDateKey(now)}.json`;
}

/**
 * 驗證備份檔文字內容。
 * 回傳 { ok, errors, warnings, version, exportedAt, counts, data }。
 * ok 為 false 時不可用來覆蓋現有資料。
 */
export function validateBackupText(text) {
  const fail = (message) => ({ ok: false, errors: [message], warnings: [], data: null, counts: null });

  if (typeof text !== 'string' || !text.trim()) return fail('檔案是空的。');
  if (text.length > BACKUP_MAX_BYTES) return fail('檔案太大，不像是本工具的備份檔。');

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail('檔案不是有效的 JSON 格式，可能已損壞或不是備份檔。');
  }
  return validateBackupObject(parsed);
}

/** 驗證已解析的備份物件。 */
export function validateBackupObject(parsed) {
  const fail = (message) => ({ ok: false, errors: [message], warnings: [], data: null, counts: null });

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return fail('檔案內容不是本工具的備份格式。');
  }
  if (parsed.app !== BACKUP_APP_ID) return fail('這不是「每日待辦與習慣」的備份檔。');
  if (!Number.isInteger(parsed.version)) return fail('備份檔缺少資料版本。');
  if (parsed.exportedAt !== undefined && Number.isNaN(Date.parse(parsed.exportedAt))) {
    return fail('備份檔的匯出時間不正確。');
  }

  let migrated;
  try {
    migrated = migrateData(parsed.data, parsed.version);
  } catch (error) {
    return fail(error.message);
  }

  const result = validateData(migrated);
  return {
    ok: result.ok,
    errors: result.errors,
    warnings: result.warnings,
    version: parsed.version,
    exportedAt: parsed.exportedAt ?? null,
    counts: result.ok ? countData(result.data) : null,
    data: result.data,
  };
}
