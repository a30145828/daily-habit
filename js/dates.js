// 日期工具：一律以「使用者裝置的當地日期」為準。
// 日期鍵格式為 YYYY-MM-DD。
// 注意：不要用 date.toISOString().slice(0, 10) 取得日期，
// 那是 UTC 日期，在台灣凌晨 0:00～7:59 會得到前一天。

const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 把 Date 轉成當地日期鍵 YYYY-MM-DD。 */
export function toDateKey(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** 檢查字串是否為真實存在的日期鍵（例如 2026-02-30 不合法）。 */
export function isValidDateKey(value) {
  if (typeof value !== 'string') return false;
  const match = DATE_KEY_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1900 || year > 9999 || month < 1 || month > 12 || day < 1) return false;
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

/** 把日期鍵轉成當地時間當天中午的 Date（用中午可避開日光節約時間的邊界問題）。 */
export function parseDateKey(key) {
  if (!isValidDateKey(key)) throw new Error(`無效的日期：${key}`);
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year, month - 1, day, 12, 0, 0, 0);
}

/** 日期鍵加減天數。 */
export function addDays(key, days) {
  const date = parseDateKey(key);
  date.setDate(date.getDate() + days);
  return toDateKey(date);
}

/** 比較兩個日期鍵，回傳負數、0 或正數。YYYY-MM-DD 可直接用字串比較。 */
export function compareDateKeys(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** 回傳以 endKey 結尾、共 count 天的日期鍵陣列（由舊到新）。 */
export function lastNDays(endKey, count) {
  const days = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    days.push(addDays(endKey, -i));
  }
  return days;
}

/** 距離下一個當地午夜還有幾毫秒。 */
export function msUntilNextMidnight(now = new Date()) {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return Math.max(0, next.getTime() - now.getTime());
}

/** 星期幾的中文字（日、一…六）。 */
export function weekdayLabel(key) {
  return WEEKDAYS[parseDateKey(key).getDay()];
}

/** 顯示用：10/20（二） */
export function formatDateLabel(key) {
  const date = parseDateKey(key);
  return `${date.getMonth() + 1}/${date.getDate()}（${WEEKDAYS[date.getDay()]}）`;
}

/** 顯示用：2026 年 10 月 20 日 星期二 */
export function formatLongDate(key) {
  const date = parseDateKey(key);
  return `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日 星期${WEEKDAYS[date.getDay()]}`;
}

/** 檢查是否為可解析的 ISO 時間字串。 */
export function isValidTimestamp(value) {
  return typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value));
}
