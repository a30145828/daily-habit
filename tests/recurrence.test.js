process.env.TZ = 'Asia/Taipei';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSeries,
  describeRule,
  endSeriesFrom,
  materialize,
  nextOccurrence,
  occurrenceId,
  occurrencesBetween,
  overdueOccurrence,
  splitSeries,
  validateRule,
  virtualOccurrence,
  virtualOccurrencesBetween,
} from '../js/recurrence.js';

const now = new Date('2026-10-20T02:00:00Z');

function series(rule, startDate = '2026-01-01', extra = {}) {
  return { ...createSeries({ title: 'x', note: '', priority: 'medium', tags: [], subtasks: [], rule: { weekdays: [], monthDay: null, monthEnd: 'last', ...rule }, startDate }, now), ...extra };
}

test('規則驗證', () => {
  assert.equal(validateRule({ freq: 'weekly', weekdays: [] }).ok, false);
  assert.equal(validateRule({ freq: 'monthly', monthDay: 32 }).ok, false);
  assert.deepEqual(validateRule({ freq: 'weekly', weekdays: [5, 1, 1] }).value.weekdays, [1, 5]);
  assert.equal(validateRule({ freq: 'monthly', monthDay: 31, monthEnd: 'skip' }).value.monthEnd, 'skip');
});

test('每日、每週指定星期', () => {
  assert.equal(occurrencesBetween(series({ freq: 'daily' }), '2026-10-01', '2026-10-31').length, 31);
  const weekly = series({ freq: 'weekly', weekdays: [1, 3] });
  assert.deepEqual(occurrencesBetween(weekly, '2026-10-19', '2026-10-25'), ['2026-10-19', '2026-10-21']);
  assert.equal(describeRule(weekly.rule), '每週一、三');
});

test('每月 31 日：沒有 31 日的月份改在月底', () => {
  const s = series({ freq: 'monthly', monthDay: 31, monthEnd: 'last' });
  assert.deepEqual(occurrencesBetween(s, '2026-01-01', '2026-06-30'), [
    '2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30',
  ]);
});

test('每月 31 日：沒有 31 日的月份跳過', () => {
  const s = series({ freq: 'monthly', monthDay: 31, monthEnd: 'skip' });
  assert.deepEqual(occurrencesBetween(s, '2026-01-01', '2026-06-30'), ['2026-01-31', '2026-03-31', '2026-05-31']);
});

test('閏年 2 月 29 日與 30 日', () => {
  const s29 = series({ freq: 'monthly', monthDay: 29, monthEnd: 'skip' });
  assert.deepEqual(occurrencesBetween(s29, '2027-02-01', '2028-03-01'), [
    '2027-03-29', '2027-04-29', '2027-05-29', '2027-06-29', '2027-07-29', '2027-08-29', '2027-09-29',
    '2027-10-29', '2027-11-29', '2027-12-29', '2028-01-29', '2028-02-29',
  ]);
  const s30 = series({ freq: 'monthly', monthDay: 30, monthEnd: 'last' });
  assert.deepEqual(occurrencesBetween(s30, '2028-02-01', '2028-02-29'), ['2028-02-29']);
});

test('起訖日與跨年', () => {
  const s = series({ freq: 'daily' }, '2026-12-30', { endDate: '2027-01-02' });
  assert.deepEqual(occurrencesBetween(s, '2026-12-01', '2027-12-31'), ['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']);
  assert.equal(nextOccurrence(s, '2027-01-03'), null);
});

test('虛擬項目與實體項目：id 固定，存成實體後不再重複產生', () => {
  const s = series({ freq: 'daily' }, '2026-10-18');
  const occ = virtualOccurrence(s, '2026-10-20');
  assert.equal(occ.id, occurrenceId(s.id, '2026-10-20'));
  const saved = materialize(occ, { done: true }, now);
  assert.equal(saved.virtual, undefined);
  assert.equal(saved.id, occ.id);
  const list = virtualOccurrencesBetween(s, [saved], '2026-10-19', '2026-10-21').map((t) => t.occurrenceDate);
  assert.deepEqual(list, ['2026-10-19', '2026-10-21']);
});

test('逾期：只列最近一次未處理；略過或完成後之前的不再出現', () => {
  const s = series({ freq: 'daily' }, '2026-10-15');
  let result = overdueOccurrence(s, [], '2026-10-20');
  assert.equal(result.task.occurrenceDate, '2026-10-19');
  assert.equal(result.missedCount, 5);
  const skipped = materialize(virtualOccurrence(s, '2026-10-19'), { skipped: true }, now);
  assert.equal(overdueOccurrence(s, [skipped], '2026-10-20'), null);
  // 跨午夜：隔天 10/20 未完成，變成逾期
  result = overdueOccurrence(s, [skipped], '2026-10-21');
  assert.equal(result.task.occurrenceDate, '2026-10-20');
  assert.equal(result.missedCount, 1);
});

test('只修改這次：其他日期不受影響', () => {
  const s = series({ freq: 'weekly', weekdays: [2] }, '2026-10-06');
  const edited = materialize(virtualOccurrence(s, '2026-10-20'), { title: '這次改名', dueDate: '2026-10-21' }, now);
  const others = virtualOccurrencesBetween(s, [edited], '2026-10-01', '2026-11-03');
  assert.deepEqual(others.map((t) => t.occurrenceDate), ['2026-10-06', '2026-10-13', '2026-10-27', '2026-11-03']);
  assert.ok(others.every((t) => t.title === 'x'));
});

test('修改這次及未來：舊規則在前一天結束，過去已完成的不變', () => {
  const s = series({ freq: 'weekly', weekdays: [2] }, '2026-10-06');
  const pastDone = materialize(virtualOccurrence(s, '2026-10-13'), { done: true, completedAt: now.toISOString() }, now);
  const futureEdited = materialize(virtualOccurrence(s, '2026-10-27'), { title: '個別修改' }, now);
  const futureDone = materialize(virtualOccurrence(s, '2026-11-03'), { done: true, completedAt: now.toISOString() }, now);
  const input = { title: '新名稱', note: '', priority: 'high', tags: [], subtasks: [], rule: { freq: 'weekly', weekdays: [2, 4], monthDay: null, monthEnd: 'last' } };
  const result = splitSeries([s], [pastDone, futureEdited, futureDone], s.id, '2026-10-20', input, now);
  const old = result.series.find((x) => x.id === s.id);
  assert.equal(old.endDate, '2026-10-19');
  assert.equal(result.created.startDate, '2026-10-20');
  assert.ok(result.tasks.some((t) => t.id === pastDone.id), '過去已完成保留');
  assert.ok(!result.tasks.some((t) => t.id === futureEdited.id), '未來未完成的個別修改改由新規則產生');
  const moved = result.tasks.find((t) => t.occurrenceDate === '2026-11-03');
  assert.equal(moved.seriesId, result.created.id);
  assert.equal(moved.done, true, '未來已完成的保留並改掛新規則');
  assert.deepEqual(occurrencesBetween(old, '2026-10-01', '2026-12-31'), ['2026-10-06', '2026-10-13']);
  assert.deepEqual(occurrencesBetween(result.created, '2026-10-20', '2026-10-31'), ['2026-10-20', '2026-10-22', '2026-10-27', '2026-10-29']);
});

test('從第一次就修改：直接以新規則取代', () => {
  const s = series({ freq: 'daily' }, '2026-10-20');
  const input = { title: 'y', note: '', priority: 'low', tags: [], subtasks: [], rule: { freq: 'daily', weekdays: [], monthDay: null, monthEnd: 'last' } };
  const result = splitSeries([s], [], s.id, '2026-10-20', input, now);
  assert.equal(result.series.length, 1);
  assert.equal(result.series[0].title, 'y');
});

test('刪除這次及之後：保留之前已完成的紀錄', () => {
  const s = series({ freq: 'daily' }, '2026-10-15');
  const done = materialize(virtualOccurrence(s, '2026-10-16'), { done: true }, now);
  const futureOpen = materialize(virtualOccurrence(s, '2026-10-22'), { title: 'z' }, now);
  const result = endSeriesFrom([s], [done, futureOpen], s.id, '2026-10-20', now);
  assert.equal(result.series[0].endDate, '2026-10-19');
  assert.deepEqual(result.tasks.map((t) => t.id), [done.id]);
  const all = endSeriesFrom([s], [done, futureOpen], s.id, s.startDate, now);
  assert.equal(all.series.length, 0);
  assert.deepEqual(all.tasks.map((t) => t.id), [done.id], '刪除整個重複任務仍保留已完成紀錄');
});
