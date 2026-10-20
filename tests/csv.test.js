process.env.TZ = 'Asia/Taipei';

import test from 'node:test';
import assert from 'node:assert/strict';
import { applyImport, guessMapping, parseAmountCell, parseCsv, parseDateCell, previewImport, toCsv, transactionsCsv } from '../js/csv.js';
import { createTxn } from '../js/finance.js';
import { emptyData } from '../js/schema.js';

const now = new Date('2026-10-20T02:00:00Z');

test('解析 CSV：BOM、引號、引號內逗號與換行、CRLF、分號分隔', () => {
  const rows = parseCsv('﻿日期,金額,備註\r\n2026-10-20,"1,200","午餐, 便當"\r\n2026-10-21,50,"第一行\n第二行"\r\n\r\n');
  assert.deepEqual(rows, [
    ['日期', '金額', '備註'],
    ['2026-10-20', '1,200', '午餐, 便當'],
    ['2026-10-21', '50', '第一行\n第二行'],
  ]);
  assert.deepEqual(parseCsv('a;b\n1;2'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCsv('a,"說 ""引號"""'), [['a', '說 "引號"']]);
});

test('產生 CSV：含 BOM、跳脫，並防止公式注入', () => {
  const csv = toCsv([['a,b', '=SUM(A1)', '-120', '"q"']]);
  assert.ok(csv.startsWith('﻿'));
  assert.equal(csv.trim().replace('﻿', ''), `"a,b",'=SUM(A1),-120,"""q"""`);
  assert.deepEqual(parseCsv(csv)[0], ['a,b', "'=SUM(A1)", '-120', '"q"']);
});

test('日期與金額欄位格式', () => {
  assert.equal(parseDateCell('2026/1/5'), '2026-01-05');
  assert.equal(parseDateCell('2026.10.20'), '2026-10-20');
  assert.equal(parseDateCell('2026/02/30'), null);
  assert.equal(parseDateCell('10/20/2026'), null);
  assert.deepEqual(parseAmountCell('-1,234', 'TWD'), { ok: true, value: 1234, negative: true });
  assert.deepEqual(parseAmountCell('(50.5)', 'USD'), { ok: true, value: 5050, negative: true });
  assert.equal(parseAmountCell('12.5', 'TWD').ok, false);
});

test('欄位對應猜測', () => {
  assert.deepEqual(guessMapping(['日期', '說明', '金額', '類別']), { date: 0, amount: 2, type: -1, category: 3, account: -1, note: 1, currency: -1 });
});

test('匯入預覽：驗證、錯誤列、重複提示（現有資料與檔案內）', () => {
  const existing = createTxn({ type: 'expense', date: '2026-10-01', amountMinor: 120, currency: 'TWD', categoryId: 'cat_food', accountId: 'acc_cash', note: '午餐' }, now);
  const data = { ...emptyData(), transactions: [existing] };
  const rows = parseCsv([
    '日期,金額,備註,類別,帳戶',
    '2026-10-01,-120,午餐,餐飲,現金', // 與現有重複
    '2026-10-02,-80,咖啡,餐飲,現金',
    '2026-10-02,-80,咖啡,餐飲,現金', // 檔案內重複
    '2026-10-03,52000,薪水,薪資,台灣銀行', // 收入、新帳戶
    '2026-13-01,-10,錯誤日期,,',
    '2026-10-04,-12.5,小數,,', // 新台幣不可小數
    '2026-10-05,-300,寵物用品,寵物,', // 新分類
  ].join('\n'));
  const mapping = guessMapping(rows[0]);
  const preview = previewImport(rows, mapping, { hasHeader: true, defaultCurrency: 'TWD', signMode: 'negative', defaultAccountId: null }, data);
  assert.deepEqual(preview.rows.map((r) => r.status), ['duplicate', 'ok', 'duplicate', 'ok', 'error', 'error', 'ok']);
  assert.deepEqual(preview.counts, { ok: 3, duplicate: 2, error: 2 });
  assert.equal(preview.rows[0].line, 2, '行號從標題列後算起');
  assert.equal(preview.rows[3].txn.type, 'income');
  assert.equal(preview.rows[3].txn.categoryId, 'cat_salary', '對應到既有分類');

  const result = applyImport(data, preview, {}, now);
  assert.equal(result.imported, 3);
  assert.equal(result.data.transactions.length, 4);
  assert.equal(result.createdCategories, 1, '只建立實際用到的新分類（寵物）');
  assert.equal(result.createdAccounts, 1, '新帳戶（台灣銀行）');
  assert.ok(result.data.transactions.slice(1).every((t) => t.source === 'csv' && t.importKey));

  // 再匯入同一個檔案：全部標示為重複，不會重複新增
  const again = previewImport(rows, mapping, { hasHeader: true, defaultCurrency: 'TWD', signMode: 'negative' }, result.data);
  assert.equal(again.counts.ok, 0);
  assert.equal(applyImport(result.data, again, {}, now).imported, 0);
});

test('類型欄位模式與負數錯誤提示', () => {
  const rows = parseCsv('日期,類型,金額\n2026-10-01,支出,100\n2026-10-02,收入,200\n2026-10-03,其他,1\n2026-10-04,支出,-5');
  const preview = previewImport(rows, guessMapping(rows[0]), { hasHeader: true, defaultCurrency: 'TWD', signMode: 'type' }, emptyData());
  assert.deepEqual(preview.rows.map((r) => r.status), ['ok', 'ok', 'error', 'error']);
});

test('匯出的收支 CSV 可以再匯入（欄位自動對應），且全部視為重複', () => {
  const t = createTxn({ type: 'expense', date: '2026-10-01', amountMinor: 999, currency: 'USD', categoryId: 'cat_food', accountId: 'acc_cash', note: 'a, "b"' }, now);
  const data = { ...emptyData(), transactions: [t] };
  const rows = parseCsv(transactionsCsv(data));
  const mapping = guessMapping(rows[0]);
  assert.ok(mapping.date >= 0 && mapping.amount >= 0 && mapping.type >= 0 && mapping.currency >= 0);
  const preview = previewImport(rows, mapping, { hasHeader: true, defaultCurrency: 'TWD', signMode: 'type' }, data);
  assert.deepEqual(preview.rows.map((r) => r.status), ['duplicate']);
  assert.equal(preview.rows[0].txn.amountMinor, 999);
});
