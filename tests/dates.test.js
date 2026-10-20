// 日期判斷測試：固定使用 Asia/Taipei（UTC+8，無日光節約時間）。
process.env.TZ = 'Asia/Taipei';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays,
  formatDateLabel,
  isValidDateKey,
  lastNDays,
  msUntilNextMidnight,
  parseDateKey,
  toDateKey,
} from '../js/dates.js';

test('測試環境時區為 Asia/Taipei', () => {
  assert.equal(new Date('2026-10-20T00:00:00Z').getTimezoneOffset(), -480);
});

test('台灣凌晨 00:30 應為當天，而不是 UTC 的前一天', () => {
  // 2026-10-20 16:30 UTC = 台灣 2026-10-21 00:30
  const date = new Date('2026-10-20T16:30:00Z');
  assert.equal(date.toISOString().slice(0, 10), '2026-10-20'); // 錯誤做法會得到前一天
  assert.equal(toDateKey(date), '2026-10-21');
});

test('台灣 07:59 仍是當天；23:59 不會跳到隔天', () => {
  assert.equal(toDateKey(new Date('2026-10-20T23:59:00Z')), '2026-10-21'); // 台灣 10/21 07:59
  assert.equal(toDateKey(new Date('2026-10-21T15:59:59Z')), '2026-10-21'); // 台灣 10/21 23:59:59
  assert.equal(toDateKey(new Date('2026-10-21T16:00:00Z')), '2026-10-22'); // 台灣 10/22 00:00
});

test('跨年與月底', () => {
  assert.equal(toDateKey(new Date('2026-12-31T16:00:00Z')), '2027-01-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2028-03-01', -1), '2028-02-29');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});

test('isValidDateKey 拒絕不存在或格式錯誤的日期', () => {
  assert.equal(isValidDateKey('2026-10-20'), true);
  assert.equal(isValidDateKey('2028-02-29'), true);
  for (const bad of ['2026-02-29', '2026-13-01', '2026-00-10', '2026-1-5', '20261020', '', null, 20261020, '2026-10-20T00:00']) {
    assert.equal(isValidDateKey(bad), false, String(bad));
  }
});

test('parseDateKey 回傳當地日期，且與 toDateKey 互逆', () => {
  const date = parseDateKey('2026-10-20');
  assert.equal(date.getDate(), 20);
  assert.equal(toDateKey(date), '2026-10-20');
  assert.throws(() => parseDateKey('2026-02-30'));
});

test('lastNDays 回傳由舊到新的七天', () => {
  assert.deepEqual(lastNDays('2026-10-02', 7), [
    '2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02',
  ]);
});

test('msUntilNextMidnight 以台灣午夜計算', () => {
  // 台灣 2026-10-20 23:59:00
  assert.equal(msUntilNextMidnight(new Date('2026-10-20T15:59:00Z')), 60_000);
  // 台灣 2026-10-21 00:00:00 → 下一個午夜在 24 小時後
  assert.equal(msUntilNextMidnight(new Date('2026-10-20T16:00:00Z')), 24 * 3600_000);
});

test('formatDateLabel 顯示月/日與星期', () => {
  assert.equal(formatDateLabel('2026-10-20'), '10/20（二）');
});

import {
  addMonthsClamped,
  dayOfWeek,
  daysInMonth,
  diffDays,
  monthDayIn,
  monthGrid,
  monthRange,
  startOfWeek,
} from '../js/dates.js';

test('月份天數與閏年', () => {
  assert.equal(daysInMonth(2026, 2), 28);
  assert.equal(daysInMonth(2028, 2), 29);
  assert.equal(daysInMonth(2026, 4), 30);
  assert.deepEqual(monthRange('2026-02'), { start: '2026-02-01', end: '2026-02-28' });
});

test('每月指定日期：該月沒有這一天時依規則處理', () => {
  assert.equal(monthDayIn('2026-02', 31, 'last'), '2026-02-28');
  assert.equal(monthDayIn('2026-02', 31, 'skip'), null);
  assert.equal(monthDayIn('2026-04', 31, 'last'), '2026-04-30');
  assert.equal(monthDayIn('2028-02', 30, 'last'), '2028-02-29');
  assert.equal(monthDayIn('2026-03', 31, 'skip'), '2026-03-31');
});

test('跨月加月份會以原本的日期為準（1/31 → 2/28 → 3/31）', () => {
  assert.equal(addMonthsClamped('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonthsClamped('2026-01-31', 2), '2026-03-31');
  assert.equal(addMonthsClamped('2026-02-28', 1, 31), '2026-03-31');
  assert.equal(addMonthsClamped('2026-12-15', 1), '2027-01-15');
  assert.equal(addMonthsClamped('2026-01-15', -1), '2025-12-15');
});

test('星期與週起始日', () => {
  assert.equal(dayOfWeek('2026-10-20'), 2);
  assert.equal(startOfWeek('2026-10-20', 1), '2026-10-19');
  assert.equal(startOfWeek('2026-10-19', 1), '2026-10-19');
  assert.equal(startOfWeek('2026-10-25', 1), '2026-10-19'); // 星期日屬於前一週（週一起始）
  assert.equal(startOfWeek('2026-10-25', 0), '2026-10-25');
});

test('日期差與月曆格子', () => {
  assert.equal(diffDays('2026-10-20', '2026-11-02'), 13);
  assert.equal(diffDays('2026-12-31', '2027-01-01'), 1);
  const grid = monthGrid('2026-10', 1);
  assert.equal(grid.length, 42);
  assert.equal(grid[0], '2026-09-28');
  assert.equal(dayOfWeek(grid[0]), 1);
});
