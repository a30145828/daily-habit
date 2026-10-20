// 在有日光節約時間的時區確認日期加減不會跳過或重複日期。
process.env.TZ = 'America/Los_Angeles';

import test from 'node:test';
import assert from 'node:assert/strict';
import { addDays, lastNDays, toDateKey } from '../js/dates.js';

test('日光節約時間切換日前後，日期加減正確', () => {
  assert.equal(addDays('2026-03-07', 1), '2026-03-08');
  assert.equal(addDays('2026-03-08', 1), '2026-03-09');
  assert.equal(addDays('2026-11-01', 1), '2026-11-02');
  assert.equal(new Set(lastNDays('2026-03-10', 7)).size, 7);
});

test('洛杉磯晚上 8 點（UTC 已是隔天）仍為當地日期', () => {
  assert.equal(toDateKey(new Date('2026-10-21T03:00:00Z')), '2026-10-20');
});
