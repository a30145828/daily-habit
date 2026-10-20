// 訂閱：週期、續費日、預估費用、記錄扣款與提醒任務。
//
// 規則：
// - 週期：每 N 天／週／月／年（cycleUnit + cycleEvery）。月、年週期以 anchorDay（原本的扣款日）推算，
//   該月沒有那一天時改在月底，例如 1/31 → 2/28 → 3/31。
// - 「預估續費」只是依週期推算的日期與金額，不會計入收支；
//   只有「記錄扣款」（或把既有交易連結到訂閱）才會產生實際交易。
// - 同一個訂閱的同一個續費日只能對應一筆交易：記錄扣款的交易 id 固定為 x_sub_<訂閱id>_<YYYYMMDD>，
//   連結既有交易前也會檢查，避免同一筆支出重複計入。
// - 每月／全年預估：非「每 1 個月」的週期換算時標示為估算（年繳 ÷ 12、週繳 × 52 ÷ 12、日繳 × 365 ÷ 12）。
// - 到期提醒任務的 id 固定為 t_subrem_<訂閱id>_<YYYYMMDD>，重複建立不會產生第二筆。

import { addDays, addMonthsClamped, compareDateKeys, isValidDateKey } from './dates.js';
import { compactDate, createId } from './ids.js';
import { formatMoney, isCurrency, parseAmount } from './money.js';
import { CYCLE_UNITS, SUB_STATUSES } from './schema.js';

export const CYCLE_LABELS = { day: '天', week: '週', month: '個月', year: '年' };
export const STATUS_LABELS = { active: '使用中', paused: '暫停', cancelled: '已取消' };
export const MAX_CYCLE_EVERY = { day: 366, week: 52, month: 36, year: 10 };

/** 週期說明：每月、每年、每 3 個月、每 2 週。 */
export function describeCycle(unit, every) {
  if (every === 1) return { day: '每天', week: '每週', month: '每月', year: '每年' }[unit];
  return `每 ${every} ${CYCLE_LABELS[unit]}`;
}

/** 由某個續費日推算下一次。 */
export function advanceRenewal(date, unit, every, anchorDay = null) {
  if (unit === 'day') return addDays(date, every);
  if (unit === 'week') return addDays(date, 7 * every);
  const anchor = anchorDay ?? Number(date.slice(8, 10));
  return addMonthsClamped(date, unit === 'month' ? every : 12 * every, anchor);
}

export function validateSubInput(input) {
  const errors = {};
  const name = String(input.name ?? '').trim();
  if (!name) errors.name = '請輸入訂閱名稱。';
  else if (name.length > 100) errors.name = '名稱最多 100 字。';
  if (!isCurrency(input.currency)) errors.currency = '請選擇幣別。';
  const amount = isCurrency(input.currency) ? parseAmount(input.amount, input.currency) : { ok: false, error: '請先選擇幣別。' };
  if (!amount.ok) errors.amount = amount.error;
  const unit = input.cycleUnit;
  const every = Number(input.cycleEvery);
  if (!CYCLE_UNITS.includes(unit)) errors.cycleUnit = '請選擇週期單位。';
  else if (!Number.isInteger(every) || every < 1 || every > MAX_CYCLE_EVERY[unit]) {
    errors.cycleEvery = `週期需為 1～${MAX_CYCLE_EVERY[unit]} ${CYCLE_LABELS[unit]}。`;
  }
  if (!isValidDateKey(input.nextRenewal)) errors.nextRenewal = '請選擇下次續費日。';
  if (!SUB_STATUSES.includes(input.status ?? 'active')) errors.status = '狀態不正確。';
  const remindDays = Number(input.remindDays ?? 3);
  if (!Number.isInteger(remindDays) || remindDays < 0 || remindDays > 60) errors.remindDays = '提醒天數需為 0～60。';
  const paymentMethod = String(input.paymentMethod ?? '').trim();
  if (paymentMethod.length > 50) errors.paymentMethod = '付款方式最多 50 字。';
  const note = String(input.note ?? '').trim();
  if (note.length > 500) errors.note = '備註最多 500 字。';
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      name,
      amountMinor: amount.value,
      currency: input.currency,
      cycleUnit: unit,
      cycleEvery: every,
      nextRenewal: input.nextRenewal,
      anchorDay: unit === 'month' || unit === 'year' ? Number(input.nextRenewal.slice(8, 10)) : null,
      accountId: input.accountId || null,
      paymentMethod,
      categoryId: input.categoryId || null,
      status: input.status ?? 'active',
      remindDays,
      note,
    },
  };
}

export function createSubscription(value, now = new Date()) {
  const timestamp = now.toISOString();
  return { id: createId('sub'), ...value, archived: false, createdAt: timestamp, updatedAt: timestamp };
}

export function patchSubscription(subs, id, changes, now = new Date()) {
  return subs.map((s) => (s.id === id ? { ...s, ...changes, updatedAt: now.toISOString() } : s));
}

export function deleteSubscription(subs, id) {
  return subs.filter((s) => s.id !== id);
}

/** 會產生續費的訂閱（使用中且未封存）。 */
export function activeSubscriptions(subs) {
  return subs.filter((s) => s.status === 'active' && !s.archived);
}

/** 訂閱在 [from, to] 之間的預估續費日（從 nextRenewal 起推算）。 */
export function renewalsBetween(sub, from, to, max = 400) {
  const dates = [];
  let date = sub.nextRenewal;
  for (let i = 0; i < max && compareDateKeys(date, to) <= 0; i += 1) {
    if (compareDateKeys(date, from) >= 0) dates.push(date);
    date = advanceRenewal(date, sub.cycleUnit, sub.cycleEvery, sub.anchorDay);
  }
  return dates;
}

/**
 * 近期續費（預估）：今天起 days 天內，以及「已過續費日但尚未記錄扣款」的項目。
 * 回傳 [{ sub, date, overdue }]，依日期排序。
 */
export function upcomingRenewals(subs, todayKey, days = 30) {
  const end = addDays(todayKey, days);
  const list = [];
  for (const sub of activeSubscriptions(subs)) {
    if (compareDateKeys(sub.nextRenewal, todayKey) < 0) list.push({ sub, date: sub.nextRenewal, overdue: true });
    for (const date of renewalsBetween(sub, todayKey, end)) list.push({ sub, date, overdue: false });
  }
  return list.sort((a, b) => (a.date === b.date ? a.sub.name.localeCompare(b.sub.name) : a.date < b.date ? -1 : 1));
}

/** 需要在今日頁提醒的續費：已過期未記錄，或在訂閱設定的提醒天數內。 */
export function dueReminders(subs, todayKey) {
  return activeSubscriptions(subs)
    .filter((sub) => compareDateKeys(sub.nextRenewal, addDays(todayKey, sub.remindDays)) <= 0)
    .map((sub) => ({ sub, date: sub.nextRenewal, overdue: compareDateKeys(sub.nextRenewal, todayKey) < 0 }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * 每月與全年預估（最小單位，四捨五入）。exact 為 false 時表示是換算出來的估算。
 * 回傳 { monthly, annual, exactMonthly, exactAnnual }。
 */
export function estimateCost(sub) {
  const { amountMinor: a, cycleUnit: unit, cycleEvery: n } = sub;
  const perYear = { day: (a * 365) / n, week: (a * 52) / n, month: (a * 12) / n, year: a / n }[unit];
  return {
    monthly: Math.round(perYear / 12),
    annual: Math.round(perYear),
    exactMonthly: unit === 'month' && n === 1,
    exactAnnual: (unit === 'year' && n === 1) || (unit === 'month' && 12 % n === 0),
  };
}

/** 使用中訂閱的預估合計（依幣別分開）：{ TWD: { monthly, annual, estimated: bool, count } } */
export function estimateTotals(subs) {
  const totals = {};
  for (const sub of activeSubscriptions(subs)) {
    const e = estimateCost(sub);
    const row = (totals[sub.currency] ??= { monthly: 0, annual: 0, estimated: false, count: 0 });
    row.monthly += e.monthly;
    row.annual += e.annual;
    row.estimated ||= !e.exactMonthly || !e.exactAnnual;
    row.count += 1;
  }
  return totals;
}

// ---------- 扣款紀錄 ----------

export function chargeTxnId(subId, date) {
  return `x_sub_${subId}_${compactDate(date)}`;
}

/** 某續費日是否已有對應的交易。 */
export function chargeFor(txns, subId, chargeDate) {
  return txns.find((t) => t.subscriptionId === subId && t.chargeDate === chargeDate) ?? null;
}

/**
 * 可能是同一筆扣款的既有交易：尚未連結任何訂閱、支出、同幣別同金額、日期在續費日前後 days 天內。
 */
export function possibleDuplicates(txns, sub, chargeDate, days = 3) {
  const from = addDays(chargeDate, -days);
  const to = addDays(chargeDate, days);
  return txns.filter(
    (t) =>
      !t.subscriptionId &&
      t.type === 'expense' &&
      t.currency === sub.currency &&
      t.amountMinor === sub.amountMinor &&
      t.date >= from &&
      t.date <= to,
  );
}

/** 記錄或連結扣款後，若這是目前的續費日，推進到下一次。 */
function advanceIfCurrent(subs, sub, chargeDate, now) {
  if (sub.nextRenewal !== chargeDate) return subs;
  return patchSubscription(subs, sub.id, { nextRenewal: advanceRenewal(chargeDate, sub.cycleUnit, sub.cycleEvery, sub.anchorDay) }, now);
}

/**
 * 記錄一次扣款：建立實際支出交易並推進下次續費日。
 * input：{ chargeDate, date, amountMinor, accountId, note }
 * 回傳 { ok: true, data } 或 { ok: false, error }。
 */
export function recordCharge(data, subId, input, now = new Date()) {
  const sub = data.subscriptions.find((s) => s.id === subId);
  if (!sub) return { ok: false, error: '找不到這個訂閱。' };
  if (chargeFor(data.transactions, subId, input.chargeDate) || data.transactions.some((t) => t.id === chargeTxnId(subId, input.chargeDate))) {
    return { ok: false, error: `${input.chargeDate} 這次續費已經記錄過，不會重複建立。` };
  }
  const timestamp = now.toISOString();
  const txn = {
    id: chargeTxnId(subId, input.chargeDate),
    type: 'expense',
    date: input.date ?? input.chargeDate,
    amountMinor: input.amountMinor ?? sub.amountMinor,
    currency: sub.currency,
    categoryId: sub.categoryId,
    accountId: input.accountId ?? sub.accountId,
    note: input.note ?? `訂閱：${sub.name}`,
    subscriptionId: sub.id,
    chargeDate: input.chargeDate,
    source: 'subscription',
    importKey: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  return {
    ok: true,
    data: { ...data, transactions: [...data.transactions, txn], subscriptions: advanceIfCurrent(data.subscriptions, sub, input.chargeDate, now) },
    txn,
  };
}

/** 把既有交易連結為某次續費的扣款（不新增交易，避免重複計入）。 */
export function linkCharge(data, txnId, subId, chargeDate, now = new Date()) {
  const sub = data.subscriptions.find((s) => s.id === subId);
  const txn = data.transactions.find((t) => t.id === txnId);
  if (!sub || !txn) return { ok: false, error: '找不到訂閱或交易。' };
  if (txn.type !== 'expense') return { ok: false, error: '只有支出可以連結訂閱。' };
  const existing = chargeFor(data.transactions, subId, chargeDate);
  if (existing && existing.id !== txnId) return { ok: false, error: `${chargeDate} 這次續費已經連結了另一筆交易。` };
  const transactions = data.transactions.map((t) =>
    t.id === txnId ? { ...t, subscriptionId: subId, chargeDate, updatedAt: now.toISOString() } : t,
  );
  return { ok: true, data: { ...data, transactions, subscriptions: advanceIfCurrent(data.subscriptions, sub, chargeDate, now) } };
}

/** 取消交易與訂閱的連結（交易本身保留；不會改回續費日）。 */
export function unlinkCharge(txns, txnId, now = new Date()) {
  return txns.map((t) => (t.id === txnId ? { ...t, subscriptionId: null, chargeDate: null, updatedAt: now.toISOString() } : t));
}

// ---------- 提醒任務 ----------

export function reminderTaskId(subId, date) {
  return `t_subrem_${subId}_${compactDate(date)}`;
}

/**
 * 建立「續費提醒」任務（截止日為續費日前 remindDays 天，但不早於今天）。
 * 已存在時回傳 { ok: false, exists: true }，不會重複建立。
 */
export function createReminderTask(data, sub, renewalDate, todayKey, now = new Date()) {
  const id = reminderTaskId(sub.id, renewalDate);
  if (data.tasks.some((t) => t.id === id)) return { ok: false, exists: true, error: '這次續費的提醒任務已經建立過了。' };
  let due = addDays(renewalDate, -sub.remindDays);
  if (compareDateKeys(due, todayKey) < 0) due = todayKey;
  const timestamp = now.toISOString();
  const task = {
    id,
    title: `續費提醒：${sub.name}`,
    note: `${renewalDate} 預計扣款 ${formatMoney(sub.amountMinor, sub.currency)}。這是預估，實際扣款後請到「財務 → 訂閱」記錄。`,
    dueDate: due,
    priority: 'medium',
    tags: ['訂閱'],
    subtasks: [],
    done: false,
    completedAt: null,
    archived: false,
    archivedAt: null,
    seriesId: null,
    occurrenceDate: null,
    skipped: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  return { ok: true, data: { ...data, tasks: [...data.tasks, task] }, task };
}
