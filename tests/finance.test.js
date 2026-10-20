process.env.TZ = 'Asia/Taipei';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accountTotals,
  budgetStatus,
  categoryUsage,
  createTxn,
  filterTxns,
  monthSummary,
  setBudget,
  sortTxns,
  validateTxnInput,
} from '../js/finance.js';
import { emptyData } from '../js/schema.js';

const now = new Date('2026-10-20T02:00:00Z');

function txn(type, date, amount, currency = 'TWD', extra = {}) {
  const v = validateTxnInput({ type, date, amount, currency, categoryId: extra.categoryId ?? 'cat_food', accountId: extra.accountId ?? 'acc_cash', note: extra.note ?? '' });
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  return createTxn(v.value, now);
}

test('交易驗證', () => {
  const bad = validateTxnInput({ type: 'x', date: '2026-02-30', amount: '1.5', currency: 'TWD' });
  assert.ok(bad.errors.type && bad.errors.date && bad.errors.amount);
  assert.ok(validateTxnInput({ type: 'expense', date: '2026-10-20', amount: '10', currency: 'XYZ' }).errors.currency);
});

test('每月收支統計：依幣別分開，不同幣別不相加', () => {
  const data = {
    ...emptyData(),
    transactions: [
      txn('income', '2026-10-01', '50000'),
      txn('expense', '2026-10-05', '120'),
      txn('expense', '2026-10-31', '80'),
      txn('expense', '2026-11-01', '999'), // 下個月
      txn('expense', '2026-10-10', '9.99', 'USD'),
    ],
  };
  assert.deepEqual(monthSummary(data, '2026-10'), {
    TWD: { income: 50000, expense: 200, net: 49800, count: 3 },
    USD: { income: 0, expense: 999, net: -999, count: 1 },
  });
});

test('篩選：月份、分類、帳戶、文字（備註、分類名稱、金額）', () => {
  const data = {
    ...emptyData(),
    transactions: [
      txn('expense', '2026-10-05', '120', 'TWD', { note: '午餐便當' }),
      txn('expense', '2026-10-06', '1,500', 'TWD', { categoryId: 'cat_transport', note: '高鐵' }),
      txn('expense', '2026-09-30', '60', 'TWD', { note: '早餐' }),
    ],
  };
  assert.equal(filterTxns(data, { month: '2026-10' }).length, 2);
  assert.equal(filterTxns(data, { categoryId: 'cat_transport' }).length, 1);
  assert.equal(filterTxns(data, { query: '便當' }).length, 1);
  assert.equal(filterTxns(data, { query: '交通' }).length, 1, '分類名稱');
  assert.equal(filterTxns(data, { query: '1500' }).length, 1, '金額（不含千分位）');
  assert.equal(filterTxns(data, { query: '1,500' }).length, 1, '金額（含千分位）');
  assert.deepEqual(sortTxns(data.transactions).map((t) => t.date), ['2026-10-06', '2026-10-05', '2026-09-30']);
});

test('預算與剩餘預算（同幣別、同月份、只算支出），可為負數', () => {
  let budgets = setBudget([], 'cat_food', 'TWD', 3000, now);
  budgets = setBudget(budgets, 'cat_food', 'TWD', 2000, now); // 修改不重複
  assert.equal(budgets.length, 1);
  const data = {
    ...emptyData(),
    budgets,
    transactions: [txn('expense', '2026-10-01', '1500'), txn('expense', '2026-10-02', '800'), txn('expense', '2026-10-03', '10', 'USD'), txn('income', '2026-10-04', '500'), txn('expense', '2026-09-30', '700')],
  };
  const [row] = budgetStatus(data, '2026-10');
  assert.equal(row.spent, 2300);
  assert.equal(row.remaining, -300);
  assert.ok(row.ratio > 1);
});

test('分類使用情況與帳戶記帳累計', () => {
  const data = { ...emptyData(), transactions: [txn('income', '2026-10-01', '1000'), txn('expense', '2026-10-02', '300'), txn('expense', '2026-10-03', '5', 'USD')] };
  assert.deepEqual(accountTotals(data, 'acc_cash'), { TWD: 700, USD: -500 });
  assert.equal(categoryUsage(data, 'cat_food'), 3);
  assert.equal(categoryUsage(data, 'cat_transport'), 0);
});
