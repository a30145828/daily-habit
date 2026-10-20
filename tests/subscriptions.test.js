process.env.TZ = 'Asia/Taipei';

import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyData } from '../js/schema.js';
import {
  advanceRenewal,
  chargeTxnId,
  createReminderTask,
  createSubscription,
  dueReminders,
  estimateCost,
  estimateTotals,
  linkCharge,
  possibleDuplicates,
  recordCharge,
  renewalsBetween,
  upcomingRenewals,
  validateSubInput,
} from '../js/subscriptions.js';
import { createTxn } from '../js/finance.js';
import { monthSummary } from '../js/finance.js';

const now = new Date('2026-10-20T02:00:00Z');
const today = '2026-10-20';

function sub(extra = {}) {
  const v = validateSubInput({ name: '影音串流', amount: '390', currency: 'TWD', cycleUnit: 'month', cycleEvery: 1, nextRenewal: '2026-10-25', status: 'active', remindDays: 3, ...extra });
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  return createSubscription(v.value, now);
}

test('驗證：名稱、金額、週期範圍', () => {
  const bad = validateSubInput({ name: '', amount: '0', currency: 'TWD', cycleUnit: 'month', cycleEvery: 40, nextRenewal: 'x' });
  assert.ok(bad.errors.name && bad.errors.amount && bad.errors.cycleEvery && bad.errors.nextRenewal);
});

test('續費日：月繳以原本的日期為錨（1/31 → 2/28 → 3/31），年繳遇閏年', () => {
  assert.equal(advanceRenewal('2026-01-31', 'month', 1, 31), '2026-02-28');
  assert.equal(advanceRenewal('2026-02-28', 'month', 1, 31), '2026-03-31');
  assert.equal(advanceRenewal('2028-02-29', 'year', 1, 29), '2029-02-28');
  assert.equal(advanceRenewal('2026-10-20', 'week', 2), '2026-11-03');
  assert.equal(advanceRenewal('2026-10-20', 'day', 30), '2026-11-19');
  const s = sub({ nextRenewal: '2026-01-31' });
  assert.equal(s.anchorDay, 31);
  assert.deepEqual(renewalsBetween(s, '2026-01-01', '2026-05-31'), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']);
});

test('預估費用：月繳精確；年繳、季繳換算標示為估算；暫停的不計', () => {
  const monthly = sub();
  assert.deepEqual(estimateCost(monthly), { monthly: 390, annual: 4680, exactMonthly: true, exactAnnual: true });
  const yearly = sub({ amount: '1490', cycleUnit: 'year' });
  const e = estimateCost(yearly);
  assert.equal(e.monthly, 124); // 1490 / 12 = 124.17，四捨五入
  assert.equal(e.exactMonthly, false);
  assert.equal(e.annual, 1490);
  const usd = sub({ amount: '9.99', currency: 'USD' });
  const paused = { ...sub({ amount: '100' }), status: 'paused' };
  const totals = estimateTotals([monthly, yearly, usd, paused]);
  assert.deepEqual(totals.TWD, { monthly: 514, annual: 6170, estimated: true, count: 2 });
  assert.equal(totals.USD.monthly, 999, '不同幣別分開');
});

test('近期續費與到期提醒：只算使用中的訂閱；過期未記錄會標示', () => {
  const a = sub({ nextRenewal: '2026-10-22' });
  const b = sub({ name: '雲端空間', nextRenewal: '2026-10-15' }); // 已過期未記錄
  const c = { ...sub({ name: '已取消', nextRenewal: '2026-10-21' }), status: 'cancelled' };
  const list = upcomingRenewals([a, b, c], today, 30);
  assert.deepEqual(list.map((x) => [x.sub.name, x.date, x.overdue]), [
    ['雲端空間', '2026-10-15', true],
    ['影音串流', '2026-10-22', false],
    ['雲端空間', '2026-11-15', false], // 30 天內（到 11/19）；影音串流的 11/22 在範圍外
  ]);
  assert.deepEqual(dueReminders([a, b, c], today).map((x) => x.sub.name), ['雲端空間', '影音串流']);
});

test('記錄扣款：建立實際交易並推進續費日；同一次不能重複記錄', () => {
  const s = sub();
  let data = { ...emptyData(), subscriptions: [s] };
  const first = recordCharge(data, s.id, { chargeDate: '2026-10-25' }, now);
  assert.equal(first.ok, true);
  data = first.data;
  assert.equal(data.transactions.length, 1);
  assert.equal(data.transactions[0].id, chargeTxnId(s.id, '2026-10-25'));
  assert.equal(data.subscriptions[0].nextRenewal, '2026-11-25');
  const again = recordCharge(data, s.id, { chargeDate: '2026-10-25' }, now);
  assert.equal(again.ok, false);
  assert.match(again.error, /已經記錄/);
  assert.equal(monthSummary(data, '2026-10').TWD.expense, 390, '只計入一次');
});

test('既有交易（例如 CSV 匯入）可連結為扣款，不會重複計入', () => {
  const s = sub();
  const imported = createTxn({ type: 'expense', date: '2026-10-24', amountMinor: 390, currency: 'TWD', categoryId: null, accountId: null, note: 'STREAM*' }, now);
  let data = { ...emptyData(), subscriptions: [s], transactions: [imported] };
  assert.deepEqual(possibleDuplicates(data.transactions, s, '2026-10-25').map((t) => t.id), [imported.id]);
  const linked = linkCharge(data, imported.id, s.id, '2026-10-25', now);
  assert.equal(linked.ok, true);
  data = linked.data;
  assert.equal(data.transactions.length, 1);
  assert.equal(data.subscriptions[0].nextRenewal, '2026-11-25');
  assert.equal(recordCharge(data, s.id, { chargeDate: '2026-10-25' }, now).ok, false, '已連結後不能再建立');
  assert.equal(possibleDuplicates(data.transactions, s, '2026-10-25').length, 0, '已連結的不再提示');
});

test('提醒任務：id 固定，不會重複建立；截止日不早於今天', () => {
  const s = sub({ nextRenewal: '2026-10-21', remindDays: 3 });
  const data = { ...emptyData(), subscriptions: [s] };
  const first = createReminderTask(data, s, '2026-10-21', today, now);
  assert.equal(first.ok, true);
  assert.equal(first.task.dueDate, today);
  const second = createReminderTask(first.data, s, '2026-10-21', today, now);
  assert.equal(second.ok, false);
  assert.equal(second.exists, true);
});
