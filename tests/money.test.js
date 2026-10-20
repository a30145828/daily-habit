import test from 'node:test';
import assert from 'node:assert/strict';
import { formatMoney, parseAmount, sumByCurrency, amountToInput } from '../js/money.js';

test('金額以最小單位整數儲存，不受浮點誤差影響', () => {
  assert.deepEqual(parseAmount('0.1', 'USD'), { ok: true, value: 10 });
  assert.deepEqual(parseAmount('0.2', 'USD'), { ok: true, value: 20 });
  // 0.1 + 0.2 在浮點數是 0.30000000000000004，整數相加則精確
  assert.equal(10 + 20, 30);
  assert.equal(formatMoney(30, 'USD'), 'US$0.30');
  assert.deepEqual(parseAmount('1,234.5', 'USD'), { ok: true, value: 123450 });
  assert.deepEqual(parseAmount('NT$1,200', 'TWD'), { ok: true, value: 1200 });
});

test('新台幣不可有小數；小數位數依幣別', () => {
  assert.equal(parseAmount('12.5', 'TWD').ok, false);
  assert.equal(parseAmount('12.345', 'USD').ok, false);
  assert.equal(parseAmount('100', 'JPY').value, 100);
});

test('拒絕 0、負數、非數字與過大的金額', () => {
  assert.equal(parseAmount('0', 'TWD').ok, false);
  assert.equal(parseAmount('-5', 'TWD').ok, false);
  assert.equal(parseAmount('abc', 'TWD').ok, false);
  assert.equal(parseAmount('', 'TWD').ok, false);
  assert.equal(parseAmount('99999999999999999', 'TWD').ok, false);
});

test('顯示與輸入格式', () => {
  assert.equal(formatMoney(1234567, 'TWD'), 'NT$1,234,567');
  assert.equal(formatMoney(-999, 'USD'), '-US$9.99');
  assert.equal(amountToInput(123450, 'USD'), '1234.50');
});

test('不同幣別分開加總', () => {
  assert.deepEqual(sumByCurrency([
    { currency: 'TWD', amountMinor: 100 },
    { currency: 'USD', amountMinor: 999 },
    { currency: 'TWD', amountMinor: 50 },
  ]), { TWD: 150, USD: 999 });
});
