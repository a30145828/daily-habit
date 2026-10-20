// 日期工具：一律以「使用者裝置的當地日期」為準。
// 日期鍵（date key）格式為 YYYY-MM-DD，代表「某一天」，沒有時區；
// 時間戳（timestamp）用 ISO 字串（toISOString），代表「某個瞬間」。兩者不可混用。
// 注意：不要用 date.toISOString().slice(0, 10) 取得日期，
// 那是 UTC 日期，在台灣凌晨 0:00～7:59 會得到前一天。

const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_KEY_PATTERN = /^(\d{4})-(\d{2})$/;
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const DAY_MS = 24 * 60 * 60 * 1000;

export const WEEKDAY_LABELS = WEEKDAYS;

function pad2(n) {
  return String(n).padStart(2, '0');
}

function parts(key) {
  return key.split('-').map(Number);
}

/** 把 Date 轉成當地日期鍵 YYYY-MM-DD。 */
export function toDateKey(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** 由年、月（1～12）、日組成日期鍵（不檢查是否存在）。 */
export function makeDateKey(year, month, day) {
  return `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
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
  return day <= daysInMonth(year, month);
}

/** 某年某月（1～12）有幾天。 */
export function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 把日期鍵轉成當地時間當天中午的 Date（用中午可避開日光節約時間的邊界問題）。 */
export function parseDateKey(key) {
  if (!isValidDateKey(key)) throw new Error(`無效的日期：${key}`);
  const [year, month, day] = parts(key);
  return new Date(year, month - 1, day, 12, 0, 0, 0);
}

/** 日期鍵加減天數（純日曆計算，與時區無關）。 */
export function addDays(key, days) {
  const [year, month, day] = parts(key);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return makeDateKey(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

/** 兩個日期鍵相差幾天（b - a）。 */
export function diffDays(a, b) {
  const [ay, am, ad] = parts(a);
  const [by, bm, bd] = parts(b);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / DAY_MS);
}

/** 比較兩個日期鍵，回傳負數、0 或正數。YYYY-MM-DD 可直接用字串比較。 */
export function compareDateKeys(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** 星期幾：0 = 星期日 … 6 = 星期六。 */
export function dayOfWeek(key) {
  const [year, month, day] = parts(key);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** 回傳以 endKey 結尾、共 count 天的日期鍵陣列（由舊到新）。 */
export function lastNDays(endKey, count) {
  const days = [];
  for (let i = count - 1; i >= 0; i -= 1) days.push(addDays(endKey, -i));
  return days;
}

/** 從 start 到 end（含）的每一天。 */
export function eachDay(start, end) {
  const days = [];
  for (let key = start; key <= end; key = addDays(key, 1)) days.push(key);
  return days;
}

/** 本週第一天（weekStart：1 = 星期一，0 = 星期日）。 */
export function startOfWeek(key, weekStart = 1) {
  const offset = (dayOfWeek(key) - weekStart + 7) % 7;
  return addDays(key, -offset);
}

// ---------- 月份 ----------

/** 日期鍵所屬月份 YYYY-MM。 */
export function monthKeyOf(key) {
  return key.slice(0, 7);
}

export function isValidMonthKey(value) {
  if (typeof value !== 'string') return false;
  const match = MONTH_KEY_PATTERN.exec(value);
  return Boolean(match) && Number(match[2]) >= 1 && Number(match[2]) <= 12 && Number(match[1]) >= 1900;
}

/** 月份的第一天與最後一天。 */
export function monthRange(monthKey) {
  const [year, month] = monthKey.split('-').map(Number);
  return { start: makeDateKey(year, month, 1), end: makeDateKey(year, month, daysInMonth(year, month)) };
}

/** 月份加減。 */
export function addMonthsToMonthKey(monthKey, months) {
  const [year, month] = monthKey.split('-').map(Number);
  const index = year * 12 + (month - 1) + months;
  return `${Math.floor(index / 12)}-${pad2((index % 12) + 1)}`;
}

/**
 * 某月的「第 day 日」。該月沒有這一天時（例如 2 月 30 日）：
 * policy = 'last' 回傳該月最後一天；policy = 'skip' 回傳 null。
 */
export function monthDayIn(monthKey, day, policy = 'last') {
  const [year, month] = monthKey.split('-').map(Number);
  const last = daysInMonth(year, month);
  if (day <= last) return makeDateKey(year, month, day);
  return policy === 'skip' ? null : makeDateKey(year, month, last);
}

/**
 * 日期加上 n 個月，並以 anchorDay 為準（例如每月 31 日：1/31 → 2/28 → 3/31）。
 * 月份沒有 anchorDay 時取該月最後一天。
 */
export function addMonthsClamped(key, months, anchorDay = Number(key.slice(8, 10))) {
  return monthDayIn(addMonthsToMonthKey(monthKeyOf(key), months), anchorDay, 'last');
}

/** 月曆格子：回傳 6 週 × 7 天的日期鍵（weekStart 為每週第一天）。 */
export function monthGrid(monthKey, weekStart = 1) {
  const first = startOfWeek(monthRange(monthKey).start, weekStart);
  return Array.from({ length: 42 }, (_, i) => addDays(first, i));
}

// ---------- 其他 ----------

/** 距離下一個當地午夜還有幾毫秒。 */
export function msUntilNextMidnight(now = new Date()) {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return Math.max(0, next.getTime() - now.getTime());
}

/** 星期幾的中文字（日、一…六）。 */
export function weekdayLabel(key) {
  return WEEKDAYS[dayOfWeek(key)];
}

/** 顯示用：10/20（二） */
export function formatDateLabel(key) {
  const [, month, day] = parts(key);
  return `${month}/${day}（${weekdayLabel(key)}）`;
}

/** 顯示用：2026 年 10 月 20 日 星期二 */
export function formatLongDate(key) {
  const [year, month, day] = parts(key);
  return `${year} 年 ${month} 月 ${day} 日 星期${weekdayLabel(key)}`;
}

/** 顯示用：2026/10/20 */
export function formatShortDate(key) {
  const [year, month, day] = parts(key);
  return `${year}/${month}/${day}`;
}

/** 顯示用：2026 年 10 月 */
export function formatMonth(monthKey) {
  const [year, month] = monthKey.split('-').map(Number);
  return `${year} 年 ${month} 月`;
}

/** 顯示用：時間戳轉為當地「2026/10/20 14:05」。 */
export function formatTimestamp(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '未知';
  return `${formatShortDate(toDateKey(date))} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** 檢查是否為可解析的 ISO 時間字串。 */
export function isValidTimestamp(value) {
  return typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value));
}
