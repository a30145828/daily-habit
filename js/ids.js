// 產生與檢查識別碼。
// 識別碼也是雲端同步的主鍵，只允許英數字、底線與連字號，長度 1～100。

const ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

/** 產生新的隨機識別碼。prefix 例如 't'（任務）、'h'（習慣）。 */
export function createId(prefix) {
  let random;
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    random = globalThis.crypto.randomUUID().replace(/-/g, '');
  } else {
    random = Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  }
  return `${prefix}_${random}`.slice(0, 100);
}

/** 由日期鍵產生識別碼片段：2026-10-20 → 20261020。 */
export function compactDate(dateKey) {
  return dateKey.replace(/-/g, '');
}

export function isValidId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}
