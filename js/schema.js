// 資料格式定義、驗證與版本遷移。localStorage、備份檔、雲端同步都共用這裡的規則。
//
// 版本 2 的資料（data）包含以下集合（每筆都有 id、createdAt、updatedAt）：
//   tasks         任務（含重複任務的單次項目）
//   series        重複任務的規則
//   habits        習慣（含排程歷史）
//   checkins      習慣打卡（id 固定為 c_<習慣id>_<YYYYMMDD>，天然防重複）
//   reviews       每週回顧筆記
//   transactions  收入／支出（金額為最小貨幣單位整數）
//   accounts      帳戶
//   categories    收支分類
//   budgets       每月分類預算
//   subscriptions 訂閱
//   rewards       獎勵商店項目
//   ledger        經驗值／金幣帳本（只新增，不修改）
//   settings      設定（單筆，id 固定為 settings）
//
// 修改資料格式時：
// 1. CURRENT_VERSION 加 1。
// 2. 在 MIGRATIONS 加入「舊版本 -> 新版本」的轉換函式，不可刪除舊的轉換。
// 3. 更新 SPECS 與測試，確認舊版資料與舊版備份都能轉換後通過驗證。

import { isValidDateKey, isValidTimestamp } from './dates.js';
import { compactDate, isValidId } from './ids.js';
import { DEFAULT_CURRENCY, MAX_AMOUNT_MINOR, isCurrency } from './money.js';

export const CURRENT_VERSION = 2;

export const PRIORITIES = ['high', 'medium', 'low'];
export const REPEAT_FREQS = ['daily', 'weekly', 'monthly'];
export const MONTH_END_POLICIES = ['last', 'skip'];
export const TXN_TYPES = ['expense', 'income'];
export const ACCOUNT_KINDS = ['cash', 'bank', 'card', 'ewallet', 'other'];
export const CYCLE_UNITS = ['day', 'week', 'month', 'year'];
export const SUB_STATUSES = ['active', 'paused', 'cancelled'];
export const LEDGER_KINDS = ['award', 'revoke', 'achievement', 'redeem', 'refund'];
export const TXN_SOURCES = ['manual', 'csv', 'subscription'];

export const COLLECTIONS = [
  'tasks',
  'series',
  'habits',
  'checkins',
  'reviews',
  'transactions',
  'accounts',
  'categories',
  'budgets',
  'subscriptions',
  'rewards',
  'ledger',
  'settings',
];

export const COLLECTION_LABELS = {
  tasks: '任務',
  series: '重複任務規則',
  habits: '習慣',
  checkins: '打卡紀錄',
  reviews: '回顧筆記',
  transactions: '收支紀錄',
  accounts: '帳戶',
  categories: '分類',
  budgets: '預算',
  subscriptions: '訂閱',
  rewards: '獎勵項目',
  ledger: '獎勵紀錄',
  settings: '設定',
};

/** 預設資料使用固定時間戳，讓不同裝置建立的預設資料完全相同（同步時不會衝突或重複）。 */
export const DEFAULT_TIMESTAMP = '2026-01-01T00:00:00.000Z';

export const DEFAULT_SETTINGS = {
  id: 'settings',
  baseCurrency: DEFAULT_CURRENCY,
  gameEnabled: true,
  weekStart: 1,
  upcomingDays: 30,
  createdAt: DEFAULT_TIMESTAMP,
  updatedAt: DEFAULT_TIMESTAMP,
};

const DEFAULT_CATEGORY_LIST = [
  ['cat_food', '餐飲', 'expense'],
  ['cat_transport', '交通', 'expense'],
  ['cat_shopping', '購物', 'expense'],
  ['cat_housing', '居住', 'expense'],
  ['cat_utilities', '水電通訊', 'expense'],
  ['cat_entertainment', '娛樂', 'expense'],
  ['cat_subscription', '訂閱', 'expense'],
  ['cat_medical', '醫療', 'expense'],
  ['cat_education', '學習', 'expense'],
  ['cat_other_expense', '其他支出', 'expense'],
  ['cat_salary', '薪資', 'income'],
  ['cat_bonus', '獎金', 'income'],
  ['cat_other_income', '其他收入', 'income'],
];

export function defaultCategories() {
  return DEFAULT_CATEGORY_LIST.map(([id, name, type]) => ({
    id,
    name,
    type,
    archived: false,
    createdAt: DEFAULT_TIMESTAMP,
    updatedAt: DEFAULT_TIMESTAMP,
  }));
}

export function defaultAccounts() {
  return [{ id: 'acc_cash', name: '現金', kind: 'cash', archived: false, createdAt: DEFAULT_TIMESTAMP, updatedAt: DEFAULT_TIMESTAMP }];
}

/** 全新的資料（第一次使用）。 */
export function emptyData() {
  return {
    tasks: [],
    series: [],
    habits: [],
    checkins: [],
    reviews: [],
    transactions: [],
    accounts: defaultAccounts(),
    categories: defaultCategories(),
    budgets: [],
    subscriptions: [],
    rewards: [],
    ledger: [],
    settings: { ...DEFAULT_SETTINGS },
  };
}

/** 使用者是否已有自己輸入的資料（預設分類、帳戶與設定不算）。 */
export function hasUserData(data) {
  const defaults = new Set([...DEFAULT_CATEGORY_LIST.map(([id]) => id), 'acc_cash']);
  return COLLECTIONS.some((name) => {
    if (name === 'settings') return false;
    return (data[name] ?? []).some((item) => !(defaults.has(item.id) && item.updatedAt === DEFAULT_TIMESTAMP));
  });
}

export function checkinId(habitId, date) {
  return `c_${habitId}_${compactDate(date)}`;
}

// ---------- 版本遷移 ----------

/** 版本 1 → 2：todos 改名為 tasks 並加上新欄位；習慣加上排程；打卡加上固定 id；新增其他集合。 */
function migrate1to2(data) {
  const v2 = emptyData();
  v2.tasks = (Array.isArray(data?.todos) ? data.todos : []).map((todo) => ({
    ...todo,
    tags: [],
    subtasks: [],
    archived: false,
    archivedAt: null,
    seriesId: null,
    occurrenceDate: null,
    skipped: false,
  }));
  v2.habits = (Array.isArray(data?.habits) ? data.habits : []).map((habit) => ({
    ...habit,
    schedules: [{ from: habit?.createdDate, days: [0, 1, 2, 3, 4, 5, 6] }],
    archivedRanges: [],
  }));
  v2.checkins = (Array.isArray(data?.checkins) ? data.checkins : []).map((checkin) => ({
    id: isValidId(checkin?.habitId) && isValidDateKey(checkin?.date) ? checkinId(checkin.habitId, checkin.date) : checkin?.id,
    habitId: checkin?.habitId,
    date: checkin?.date,
    createdAt: checkin?.createdAt ?? null,
  }));
  return v2;
}

/** 版本遷移表：key 為舊版本號，函式把該版本資料轉成下一版本。 */
export const MIGRATIONS = {
  1: migrate1to2,
};

/** 把 fromVersion 版本的資料逐版轉換成目前版本。 */
export function migrateData(data, fromVersion) {
  if (!Number.isInteger(fromVersion) || fromVersion < 1) {
    throw new Error(`資料版本「${fromVersion}」無法辨識。`);
  }
  if (fromVersion > CURRENT_VERSION) {
    throw new Error(`資料版本 ${fromVersion} 比目前程式支援的版本 ${CURRENT_VERSION} 新，請更新網頁後再試。`);
  }
  let result = data;
  for (let version = fromVersion; version < CURRENT_VERSION; version += 1) {
    const migrate = MIGRATIONS[version];
    if (!migrate) throw new Error(`缺少版本 ${version} 的轉換方式。`);
    result = migrate(result);
  }
  return result;
}

// ---------- 欄位驗證 ----------
// 每個欄位規則為 (value) => { ok: true, value } 或 { ok: false, error }。
// 缺少的選填欄位會補上預設值，讓舊資料與新資料都能讀取。

const okv = (value) => ({ ok: true, value });
const bad = (error) => ({ ok: false, error });

const F = {
  id: (v) => (isValidId(v) ? okv(v) : bad('識別碼不正確')),
  idOrNull: (v) => (v === undefined || v === null ? okv(null) : isValidId(v) ? okv(v) : bad('關聯識別碼不正確')),
  text: (min, max, fallback) => (v) => {
    if ((v === undefined || v === null) && fallback !== undefined) return okv(fallback);
    if (typeof v !== 'string') return bad('應為文字');
    const value = min > 0 ? v.trim() : v;
    if (value.length < min) return bad('不可空白');
    if (value.length > max) return bad(`超過 ${max} 字`);
    return okv(value);
  },
  bool: (fallback) => (v) =>
    v === undefined && fallback !== undefined ? okv(fallback) : typeof v === 'boolean' ? okv(v) : bad('應為是／否'),
  date: (v) => (isValidDateKey(v) ? okv(v) : bad(`日期「${v}」不正確`)),
  dateOrNull: (v) => (v === undefined || v === null || v === '' ? okv(null) : isValidDateKey(v) ? okv(v) : bad(`日期「${v}」不正確`)),
  ts: (v) => (isValidTimestamp(v) ? okv(v) : bad('時間不正確')),
  tsOrNull: (v) => (v === undefined || v === null ? okv(null) : isValidTimestamp(v) ? okv(v) : bad('時間不正確')),
  oneOf: (list, fallback) => (v) =>
    v === undefined && fallback !== undefined ? okv(fallback) : list.includes(v) ? okv(v) : bad(`「${v}」不是有效的選項`),
  int: (min, max, fallback) => (v) => {
    if ((v === undefined || v === null) && fallback !== undefined) return okv(fallback);
    return Number.isInteger(v) && v >= min && v <= max ? okv(v) : bad('數字不正確');
  },
  intOrNull: (min, max) => (v) =>
    v === undefined || v === null ? okv(null) : Number.isInteger(v) && v >= min && v <= max ? okv(v) : bad('數字不正確'),
  currency: (v) => (v === undefined ? okv(DEFAULT_CURRENCY) : isCurrency(v) ? okv(v) : bad(`不支援的幣別「${v}」`)),
  amount: (v) => (Number.isSafeInteger(v) && v > 0 && v <= MAX_AMOUNT_MINOR ? okv(v) : bad('金額不正確')),
  weekdays: (required) => (v) => {
    if (v === undefined && !required) return okv([]);
    if (!Array.isArray(v) || v.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return bad('星期設定不正確');
    const days = [...new Set(v)].sort();
    if (required && days.length === 0) return bad('至少要選一天');
    return okv(days);
  },
  tags: (v) => {
    if (v === undefined) return okv([]);
    if (!Array.isArray(v) || v.length > 20) return bad('標籤不正確');
    const tags = [];
    for (const tag of v) {
      if (typeof tag !== 'string' || !tag.trim() || tag.trim().length > 30) return bad('標籤不正確');
      if (!tags.includes(tag.trim())) tags.push(tag.trim());
    }
    return okv(tags);
  },
  subtasks: (withDone) => (v) => {
    if (v === undefined) return okv([]);
    if (!Array.isArray(v) || v.length > 50) return bad('子任務不正確');
    const list = [];
    for (const item of v) {
      if (!item || !isValidId(item.id) || typeof item.title !== 'string' || !item.title.trim() || item.title.length > 200) {
        return bad('子任務不正確');
      }
      if (withDone && typeof (item.done ?? false) !== 'boolean') return bad('子任務不正確');
      list.push(withDone ? { id: item.id, title: item.title.trim(), done: item.done ?? false } : { id: item.id, title: item.title.trim() });
    }
    return okv(list);
  },
  schedules: (v) => {
    if (!Array.isArray(v) || v.length === 0 || v.length > 100) return bad('排程不正確');
    const list = [];
    for (const item of v) {
      if (!item || !isValidDateKey(item.from)) return bad('排程起始日不正確');
      const days = F.weekdays(true)(item.days);
      if (!days.ok) return bad('排程星期不正確');
      list.push({ from: item.from, days: days.value });
    }
    list.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
    return okv(list);
  },
  ranges: (v) => {
    if (v === undefined) return okv([]);
    if (!Array.isArray(v) || v.length > 200) return bad('封存期間不正確');
    for (const item of v) {
      if (!item || !isValidDateKey(item.from) || !isValidDateKey(item.to) || item.to < item.from) return bad('封存期間不正確');
    }
    return okv(v.map((item) => ({ from: item.from, to: item.to })));
  },
  rule: (v) => {
    if (!v || typeof v !== 'object') return bad('重複規則不正確');
    if (!REPEAT_FREQS.includes(v.freq)) return bad('重複頻率不正確');
    const rule = { freq: v.freq, weekdays: [], monthDay: null, monthEnd: 'last' };
    if (v.freq === 'weekly') {
      const days = F.weekdays(true)(v.weekdays);
      if (!days.ok) return bad('每週重複至少要選一天');
      rule.weekdays = days.value;
    }
    if (v.freq === 'monthly') {
      if (!Number.isInteger(v.monthDay) || v.monthDay < 1 || v.monthDay > 31) return bad('每月日期不正確');
      if (!MONTH_END_POLICIES.includes(v.monthEnd ?? 'last')) return bad('月底規則不正確');
      rule.monthDay = v.monthDay;
      rule.monthEnd = v.monthEnd ?? 'last';
    }
    return okv(rule);
  },
  plain: (v) => okv(v),
};

const common = { id: F.id, createdAt: F.ts, updatedAt: F.ts };

/** 各集合的欄位規則。 */
export const SPECS = {
  tasks: {
    ...common,
    title: F.text(1, 200),
    note: F.text(0, 2000, ''),
    dueDate: F.dateOrNull,
    priority: F.oneOf(PRIORITIES),
    tags: F.tags,
    subtasks: F.subtasks(true),
    done: F.bool(),
    completedAt: F.tsOrNull,
    archived: F.bool(false),
    archivedAt: F.tsOrNull,
    seriesId: F.idOrNull,
    occurrenceDate: F.dateOrNull,
    skipped: F.bool(false),
  },
  series: {
    ...common,
    title: F.text(1, 200),
    note: F.text(0, 2000, ''),
    priority: F.oneOf(PRIORITIES),
    tags: F.tags,
    subtasks: F.subtasks(false),
    rule: F.rule,
    startDate: F.date,
    endDate: F.dateOrNull,
    archived: F.bool(false),
  },
  habits: {
    ...common,
    name: F.text(1, 100),
    createdDate: F.date,
    schedules: F.schedules,
    archived: F.bool(),
    archivedDate: F.dateOrNull,
    archivedRanges: F.ranges,
  },
  checkins: { id: F.id, habitId: F.id, date: F.date, createdAt: F.tsOrNull },
  reviews: { ...common, weekStart: F.date, note: F.text(0, 5000, '') },
  transactions: {
    ...common,
    type: F.oneOf(TXN_TYPES),
    date: F.date,
    amountMinor: F.amount,
    currency: F.currency,
    categoryId: F.idOrNull,
    accountId: F.idOrNull,
    note: F.text(0, 500, ''),
    subscriptionId: F.idOrNull,
    chargeDate: F.dateOrNull,
    source: F.oneOf(TXN_SOURCES, 'manual'),
    importKey: (v) => (v === undefined || v === null ? okv(null) : typeof v === 'string' && v.length <= 200 ? okv(v) : bad('匯入識別不正確')),
  },
  accounts: { ...common, name: F.text(1, 50), kind: F.oneOf(ACCOUNT_KINDS, 'other'), archived: F.bool(false) },
  categories: { ...common, name: F.text(1, 50), type: F.oneOf(TXN_TYPES), archived: F.bool(false) },
  budgets: { ...common, categoryId: F.id, currency: F.currency, amountMinor: F.amount },
  subscriptions: {
    ...common,
    name: F.text(1, 100),
    amountMinor: F.amount,
    currency: F.currency,
    cycleUnit: F.oneOf(CYCLE_UNITS),
    cycleEvery: F.int(1, 366),
    nextRenewal: F.date,
    anchorDay: F.intOrNull(1, 31),
    accountId: F.idOrNull,
    paymentMethod: F.text(0, 50, ''),
    categoryId: F.idOrNull,
    status: F.oneOf(SUB_STATUSES),
    archived: F.bool(false),
    remindDays: F.int(0, 60, 3),
    note: F.text(0, 500, ''),
  },
  rewards: { ...common, name: F.text(1, 100), cost: F.int(1, 1000000), icon: F.text(0, 8, '🎁'), archived: F.bool(false) },
  ledger: {
    id: F.id,
    createdAt: F.ts,
    kind: F.oneOf(LEDGER_KINDS),
    source: F.text(1, 200),
    xp: F.int(-1000000, 1000000),
    coins: F.int(-1000000, 1000000),
    label: F.text(0, 200, ''),
    date: F.date,
  },
  settings: {
    ...common,
    baseCurrency: F.currency,
    gameEnabled: F.bool(true),
    weekStart: (v) => (v === undefined ? okv(1) : v === 0 || v === 1 ? okv(v) : bad('每週起始日不正確')),
    upcomingDays: F.int(1, 365, 30),
  },
};

/** 驗證單筆資料，回傳 { ok, value, errors }。 */
export function validateRecord(collection, record) {
  const spec = SPECS[collection];
  if (!spec) return { ok: false, errors: [`未知的資料類型「${collection}」`] };
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return { ok: false, errors: ['格式不正確'] };
  const value = {};
  const errors = [];
  for (const [field, check] of Object.entries(spec)) {
    const result = check(record[field]);
    if (result.ok) value[field] = result.value;
    else errors.push(`「${field}」${result.error}`);
  }
  if (errors.length === 0) {
    if (collection === 'settings' && value.id !== 'settings') errors.push('設定的識別碼必須是 settings');
    if (collection === 'checkins' && value.id !== checkinId(value.habitId, value.date)) errors.push('打卡識別碼與習慣、日期不一致');
    if (collection === 'tasks' && value.done === false) value.completedAt = null;
    if (collection === 'habits' && !value.archived) value.archivedDate = null;
    if (collection === 'subscriptions' && value.cycleUnit !== 'day' && value.cycleEvery > 36) errors.push('「cycleEvery」數字不正確');
  }
  return { ok: errors.length === 0, value, errors };
}

const MAX_ERRORS = 20;

/**
 * 驗證並整理整份資料（只保留已知欄位）。
 * 回傳 { ok, errors: string[], warnings: string[], data }，ok 為 false 時 data 為 null。
 */
export function validateData(input) {
  const errors = [];
  const warnings = [];
  const addError = (message) => {
    if (errors.length < MAX_ERRORS) errors.push(message);
  };

  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['資料內容不是正確的格式。'], warnings, data: null };
  }
  for (const name of COLLECTIONS) {
    if (name === 'settings') continue;
    if (!Array.isArray(input[name])) addError(`缺少「${COLLECTION_LABELS[name]}」清單。`);
  }
  if (errors.length > 0) return { ok: false, errors, warnings, data: null };

  const data = {};
  for (const name of COLLECTIONS) {
    if (name === 'settings') continue;
    const seen = new Set();
    data[name] = [];
    input[name].forEach((record, index) => {
      const result = validateRecord(name, record);
      const where = `${COLLECTION_LABELS[name]}第 ${index + 1} 筆`;
      if (!result.ok) {
        addError(`${where}：${result.errors.slice(0, 3).join('、')}。`);
        return;
      }
      if (seen.has(result.value.id)) {
        if (name === 'checkins') return; // 同一習慣同一天重複打卡：合併
        addError(`${where}：識別碼「${result.value.id}」重複。`);
        return;
      }
      seen.add(result.value.id);
      data[name].push(result.value);
    });
    if (name === 'checkins' && data.checkins.length < input.checkins.length && errors.length === 0) {
      warnings.push(`有 ${input.checkins.length - data.checkins.length} 筆重複的打卡紀錄（同一習慣同一天），已自動合併為一筆。`);
    }
  }

  const settings = input.settings === undefined ? { ...DEFAULT_SETTINGS } : input.settings;
  const settingsResult = validateRecord('settings', settings);
  if (settingsResult.ok) data.settings = settingsResult.value;
  else addError(`設定：${settingsResult.errors.join('、')}。`);

  if (errors.length > 0) return { ok: false, errors, warnings, data: null };

  // 關聯檢查：缺少對應資料時只提出警告（同步途中可能暫時缺少），畫面會顯示「已刪除」。
  const habitIds = new Set(data.habits.map((habit) => habit.id));
  const orphanCheckins = data.checkins.filter((checkin) => !habitIds.has(checkin.habitId)).length;
  if (orphanCheckins) warnings.push(`有 ${orphanCheckins} 筆打卡紀錄找不到對應的習慣。`);

  return { ok: true, errors, warnings, data };
}

/** 各類資料筆數。 */
export function countData(data) {
  const counts = {};
  for (const name of COLLECTIONS) {
    if (name !== 'settings') counts[name] = data[name].length;
  }
  return counts;
}

/** 顯示用的筆數摘要，例如「任務 3 筆、習慣 2 筆…」（略過 0 筆）。 */
export function describeCounts(counts) {
  const parts = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([name, n]) => `${COLLECTION_LABELS[name]} ${n} 筆`);
  return parts.length ? parts.join('、') : '沒有資料';
}
