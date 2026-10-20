// 收支：交易、分類、帳戶、預算與每月統計。
// - 金額以最小貨幣單位整數儲存（見 money.js），不同幣別分開統計，不直接相加。
// - 收支統計只計算「實際交易」；訂閱的預估續費不計入（見 subscriptions.js）。
// - 帳戶的「記帳累計」只是記帳紀錄的加總，不代表已與銀行核對的餘額。

import { isValidDateKey, monthKeyOf } from './dates.js';
import { createId } from './ids.js';
import { formatAmountNumber, isCurrency, parseAmount, sumByCurrency } from './money.js';
import { ACCOUNT_KINDS, TXN_TYPES } from './schema.js';

export const TYPE_LABELS = { expense: '支出', income: '收入' };
export const ACCOUNT_KIND_LABELS = { cash: '現金', bank: '銀行', card: '信用卡', ewallet: '電子支付', other: '其他' };
export const NOTE_MAX_LENGTH = 500;

// ---------- 交易 ----------

/**
 * 檢查交易表單輸入（amount 為使用者輸入的文字）。
 * 回傳 { ok: true, value } 或 { ok: false, errors: { 欄位: 訊息 } }。
 */
export function validateTxnInput(input) {
  const errors = {};
  const type = input.type;
  const currency = input.currency;
  if (!TXN_TYPES.includes(type)) errors.type = '請選擇收入或支出。';
  if (!isValidDateKey(input.date)) errors.date = '請選擇正確的日期。';
  if (!isCurrency(currency)) errors.currency = '請選擇幣別。';
  const amount = isCurrency(currency) ? parseAmount(input.amount, currency) : { ok: false, error: '請先選擇幣別。' };
  if (!amount.ok) errors.amount = amount.error;
  const note = String(input.note ?? '').trim();
  if (note.length > NOTE_MAX_LENGTH) errors.note = `備註最多 ${NOTE_MAX_LENGTH} 字。`;
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      type,
      date: input.date,
      amountMinor: amount.value,
      currency,
      categoryId: input.categoryId || null,
      accountId: input.accountId || null,
      note,
    },
  };
}

export function createTxn(value, now = new Date(), extra = {}) {
  const timestamp = now.toISOString();
  return {
    id: createId('x'),
    type: value.type,
    date: value.date,
    amountMinor: value.amountMinor,
    currency: value.currency,
    categoryId: value.categoryId,
    accountId: value.accountId,
    note: value.note,
    subscriptionId: null,
    chargeDate: null,
    source: 'manual',
    importKey: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...extra,
  };
}

export function updateTxn(txns, id, value, now = new Date()) {
  return txns.map((txn) => (txn.id === id ? { ...txn, ...value, updatedAt: now.toISOString() } : txn));
}

export function deleteTxn(txns, id) {
  return txns.filter((txn) => txn.id !== id);
}

// ---------- 查詢與統計 ----------

function nameOf(list, id) {
  return list.find((item) => item.id === id)?.name ?? '';
}

/** 篩選：{ month, type, categoryId, accountId, query }。query 比對備註、分類、帳戶與金額。 */
export function filterTxns(data, filters = {}) {
  const q = String(filters.query ?? '').trim().toLowerCase();
  return data.transactions.filter((txn) => {
    if (filters.month && monthKeyOf(txn.date) !== filters.month) return false;
    if (filters.type && txn.type !== filters.type) return false;
    if (filters.categoryId && txn.categoryId !== filters.categoryId) return false;
    if (filters.accountId && txn.accountId !== filters.accountId) return false;
    if (!q) return true;
    const text = [
      txn.note,
      nameOf(data.categories, txn.categoryId),
      nameOf(data.accounts, txn.accountId),
      formatAmountNumber(txn.amountMinor, txn.currency),
      formatAmountNumber(txn.amountMinor, txn.currency, { grouping: false }),
    ]
      .join('\n')
      .toLowerCase();
    return q.split(/\s+/).every((word) => text.includes(word));
  });
}

/** 依日期新到舊排序。 */
export function sortTxns(txns) {
  return txns.slice().sort((a, b) => (a.date === b.date ? b.createdAt.localeCompare(a.createdAt) : a.date < b.date ? 1 : -1));
}

/**
 * 收支統計（依幣別分開）：{ TWD: { income, expense, net, count }, USD: {…} }。
 */
export function summarize(txns) {
  const result = {};
  for (const txn of txns) {
    const row = (result[txn.currency] ??= { income: 0, expense: 0, net: 0, count: 0 });
    row[txn.type] += txn.amountMinor;
    row.net += txn.type === 'income' ? txn.amountMinor : -txn.amountMinor;
    row.count += 1;
  }
  return result;
}

export function monthSummary(data, monthKey) {
  return summarize(data.transactions.filter((txn) => monthKeyOf(txn.date) === monthKey));
}

/** 帳戶的記帳累計淨額（依幣別），僅供參考，不是銀行餘額。 */
export function accountTotals(data, accountId) {
  return sumByCurrency(
    data.transactions
      .filter((txn) => txn.accountId === accountId)
      .map((txn) => ({ currency: txn.currency, amountMinor: txn.type === 'income' ? txn.amountMinor : -txn.amountMinor })),
  );
}

// ---------- 分類與帳戶 ----------

export function validateName(name, max = 50) {
  const value = String(name ?? '').trim();
  if (!value) return { ok: false, error: '請輸入名稱。' };
  if (value.length > max) return { ok: false, error: `名稱最多 ${max} 字。` };
  return { ok: true, value };
}

export function createCategory(name, type, now = new Date()) {
  const timestamp = now.toISOString();
  return { id: createId('cat'), name, type, archived: false, createdAt: timestamp, updatedAt: timestamp };
}

export function createAccount(name, kind = 'other', now = new Date()) {
  const timestamp = now.toISOString();
  return { id: createId('acc'), name, kind: ACCOUNT_KINDS.includes(kind) ? kind : 'other', archived: false, createdAt: timestamp, updatedAt: timestamp };
}

export function patchItem(list, id, changes, now = new Date()) {
  return list.map((item) => (item.id === id ? { ...item, ...changes, updatedAt: now.toISOString() } : item));
}

/** 名稱是否重複（同類型、不分大小寫）。 */
export function isDuplicateName(list, name, { exceptId = null, type = null } = {}) {
  const lower = name.trim().toLowerCase();
  return list.some((item) => item.id !== exceptId && (!type || item.type === type) && item.name.trim().toLowerCase() === lower);
}

/** 分類被多少交易、預算與訂閱使用（使用中的分類只能封存，不能刪除）。 */
export function categoryUsage(data, categoryId) {
  return (
    data.transactions.filter((t) => t.categoryId === categoryId).length +
    data.budgets.filter((b) => b.categoryId === categoryId).length +
    data.subscriptions.filter((s) => s.categoryId === categoryId).length
  );
}

export function accountUsage(data, accountId) {
  return data.transactions.filter((t) => t.accountId === accountId).length + data.subscriptions.filter((s) => s.accountId === accountId).length;
}

export function activeCategories(data, type = null) {
  return data.categories.filter((c) => !c.archived && (!type || c.type === type));
}

export function activeAccounts(data) {
  return data.accounts.filter((a) => !a.archived);
}

// ---------- 預算 ----------

export function budgetId(categoryId, currency) {
  return `b_${categoryId}_${currency}`;
}

/** 新增或修改某分類某幣別的每月預算。 */
export function setBudget(budgets, categoryId, currency, amountMinor, now = new Date()) {
  const id = budgetId(categoryId, currency);
  const timestamp = now.toISOString();
  const existing = budgets.find((b) => b.id === id);
  if (existing) return budgets.map((b) => (b.id === id ? { ...b, amountMinor, updatedAt: timestamp } : b));
  return [...budgets, { id, categoryId, currency, amountMinor, createdAt: timestamp, updatedAt: timestamp }];
}

export function removeBudget(budgets, id) {
  return budgets.filter((b) => b.id !== id);
}

/**
 * 某月的預算使用狀況：[{ budget, category, spent, remaining, ratio }]。
 * spent 為該月該分類、同幣別的支出合計；remaining 可能為負數（超支）。
 */
export function budgetStatus(data, monthKey) {
  return data.budgets
    .map((budget) => {
      const spent = data.transactions
        .filter((t) => t.type === 'expense' && t.categoryId === budget.categoryId && t.currency === budget.currency && monthKeyOf(t.date) === monthKey)
        .reduce((sum, t) => sum + t.amountMinor, 0);
      return {
        budget,
        category: data.categories.find((c) => c.id === budget.categoryId) ?? null,
        spent,
        remaining: budget.amountMinor - spent,
        ratio: spent / budget.amountMinor,
      };
    })
    .sort((a, b) => b.ratio - a.ratio);
}
