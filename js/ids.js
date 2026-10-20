// 產生與檢查識別碼。

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** 產生新的識別碼。prefix 例如 't'（待辦）、'h'（習慣）。 */
export function createId(prefix) {
  let random;
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    random = globalThis.crypto.randomUUID().replace(/-/g, '');
  } else {
    random = Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  }
  return `${prefix}_${random}`.slice(0, 64);
}

/** 識別碼只允許英數字、底線與連字號，長度 1～64。 */
export function isValidId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}
