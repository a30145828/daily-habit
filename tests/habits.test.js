process.env.TZ = 'Asia/Taipei';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_DAYS,
  activeHabits,
  archivedHabits,
  canCheckin,
  completionStats,
  createHabit,
  currentStreak,
  habitsDueOn,
  isCheckedIn,
  longestStreak,
  monthHistory,
  recentHistory,
  setCheckin,
  setHabitArchived,
  setHabitSchedule,
  validateHabitName,
  validateScheduleDays,
} from '../js/habits.js';
import { checkinId } from '../js/schema.js';

const now = new Date('2026-10-20T02:00:00Z'); // 台灣 10/20（二）10:00
const today = '2026-10-20';

function habit(days = ALL_DAYS, createdDate = '2026-10-01') {
  return { ...createHabit('運動', days, createdDate, now), createdDate, schedules: [{ from: createdDate, days }] };
}

function checks(h, dates) {
  return dates.reduce((list, date) => setCheckin(list, h.id, date, true, now), []);
}

test('名稱與排程驗證', () => {
  assert.equal(validateHabitName('  ').ok, false);
  assert.deepEqual(validateHabitName(' 喝水 '), { ok: true, value: '喝水' });
  assert.equal(validateScheduleDays([]).ok, false);
  assert.deepEqual(validateScheduleDays([5, 1, 1]).value, [1, 5]);
});

test('台灣凌晨建立的習慣，建立日期為台灣當天', () => {
  const created = createHabit('早起', ALL_DAYS, '2026-10-21', new Date('2026-10-20T16:10:00Z'));
  assert.equal(created.createdDate, '2026-10-21');
});

test('同一天重複打卡只有一筆，id 固定', () => {
  const h = habit();
  let list = setCheckin([], h.id, today, true, now);
  list = setCheckin(list, h.id, today, true, now);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, checkinId(h.id, today));
  assert.equal(setCheckin(list, h.id, today, false, now).length, 0);
});

test('不能為未來、建立日之前或封存中的習慣打卡；可以補登過去', () => {
  const h = habit(ALL_DAYS, '2026-10-10');
  assert.equal(canCheckin(h, '2026-10-21', today).ok, false);
  assert.match(canCheckin(h, '2026-10-21', today).error, /未來/);
  assert.equal(canCheckin(h, '2026-10-09', today).ok, false);
  assert.equal(canCheckin(h, '2026-10-12', today).ok, true, '補登過去');
  assert.equal(canCheckin(h, today, today).ok, true);
  const [archived] = setHabitArchived([h], h.id, true, today, now);
  assert.equal(canCheckin(archived, '2026-10-12', today).ok, false);
});

test('台灣午夜：00:30 的「今天」是新的一天，23:59 打的卡屬於前一天', () => {
  const h = habit(ALL_DAYS, '2026-10-01');
  const list = checks(h, ['2026-10-20']);
  // 跨午夜後：10/20 已完成，10/21 尚未打卡
  const history = recentHistory(h, list, '2026-10-21', 2);
  assert.deepEqual(history.map((d) => d.status), ['done', 'pending']);
});

test('每週排程：非排定日與建立之前不算漏打卡', () => {
  const h = habit([1, 3, 5], '2026-10-15'); // 一、三、五；10/15（四）建立
  const list = checks(h, ['2026-10-16']); // 五
  const history = recentHistory(h, list, today, 7); // 10/14～10/20
  assert.deepEqual(history.map((d) => d.status), ['not-started', 'rest', 'done', 'rest', 'rest', 'missed', 'rest']);
  assert.deepEqual(habitsDueOn([h], today), [], '今天（二）不是排定日');
  assert.equal(habitsDueOn([h], '2026-10-21').length, 1);
});

test('完成率只算排定日；今天還沒打卡不算；非排定日打卡另計', () => {
  const h = habit([1, 3, 5], '2026-10-01');
  const list = checks(h, ['2026-10-05', '2026-10-07', '2026-10-09', '2026-10-12', '2026-10-18' /* 日 */]);
  const stats = completionStats(h, list, '2026-10-01', '2026-10-31', today);
  // 10/1～10/20 的一三五：10/2、5、7、9、12、14、16、19 = 8 天，完成 4 天
  assert.deepEqual({ done: stats.done, scheduled: stats.scheduled, extra: stats.extra }, { done: 4, scheduled: 8, extra: 1 });
  assert.equal(stats.rate, 0.5);
});

test('修改排程不改寫過去的統計', () => {
  const h = habit(ALL_DAYS, '2026-10-01');
  const list = checks(h, ['2026-10-01', '2026-10-02']);
  const before = completionStats(h, list, '2026-10-01', '2026-10-19', today);
  const [changed] = setHabitSchedule([h], h.id, [6], today, now); // 今天起只有週六
  const after = completionStats(changed, list, '2026-10-01', '2026-10-19', today);
  assert.deepEqual(after, before);
  assert.equal(changed.schedules.length, 2);
  assert.equal(changed.schedules[1].from, today);
  // 同一天再改一次：取代今天的變更，不累積
  const [again] = setHabitSchedule([changed], h.id, [0, 6], today, now);
  assert.equal(again.schedules.length, 2);
});

test('連續天數：非排定日不中斷；今天未打卡從昨天算；最長連續', () => {
  const h = habit([1, 3, 5], '2026-10-01');
  const list = checks(h, ['2026-10-12', '2026-10-14', '2026-10-16', '2026-10-19']);
  assert.equal(currentStreak(h, list, today), 4);
  assert.equal(currentStreak(h, list, '2026-10-22'), 0, '10/21（三）漏掉');
  assert.equal(longestStreak(h, list, today), 4);
});

test('封存保留紀錄；封存期間不算漏打卡；還原後恢復', () => {
  const h = habit(ALL_DAYS, '2026-10-01');
  const list = checks(h, ['2026-10-05']);
  let habits = setHabitArchived([h], h.id, true, '2026-10-06', now);
  assert.deepEqual(activeHabits(habits), []);
  assert.equal(archivedHabits(habits).length, 1);
  habits = setHabitArchived(habits, h.id, false, '2026-10-10', now);
  assert.deepEqual(habits[0].archivedRanges, [{ from: '2026-10-07', to: '2026-10-09' }]);
  const stats = completionStats(habits[0], list, '2026-10-05', '2026-10-10', '2026-10-11');
  // 10/5 完成、10/6 漏、10/7～9 封存不算、10/10 漏
  assert.deepEqual([stats.done, stats.scheduled], [1, 3]);
  assert.equal(isCheckedIn(list, h.id, '2026-10-05'), true);
});

test('月份紀錄格子', () => {
  const h = habit(ALL_DAYS, '2026-10-10');
  const grid = monthHistory(h, checks(h, ['2026-10-12']), '2026-10', today, 1);
  assert.equal(grid.length, 42);
  const byDate = Object.fromEntries(grid.map((d) => [d.date, d.status]));
  assert.equal(byDate['2026-10-09'], 'not-started');
  assert.equal(byDate['2026-10-12'], 'done');
  assert.equal(byDate['2026-10-11'], 'missed');
  assert.equal(byDate['2026-10-20'], 'pending');
  assert.equal(byDate['2026-10-21'], 'future');
});
