process.env.TZ = 'Asia/Taipei';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activeHabits,
  archivedHabits,
  createHabit,
  currentStreak,
  dedupeCheckins,
  isCheckedIn,
  recentHistory,
  setCheckin,
  setHabitArchived,
  toggleCheckin,
  validateHabitName,
} from '../js/habits.js';
import { habitCompletion, todaySummary } from '../js/stats.js';

const now = new Date('2026-10-20T02:00:00Z'); // 台灣 10/20 10:00
const today = '2026-10-20';

test('習慣名稱不可空白', () => {
  assert.equal(validateHabitName('  ').ok, false);
  assert.deepEqual(validateHabitName(' 喝水 '), { ok: true, value: '喝水' });
});

test('台灣凌晨建立的習慣，建立日期為台灣當天', () => {
  const habit = createHabit('早起', new Date('2026-10-20T16:10:00Z')); // 台灣 10/21 00:10
  assert.equal(habit.createdDate, '2026-10-21');
});

test('同一天重複打卡只保留一筆', () => {
  const habit = createHabit('喝水', now);
  let checkins = setCheckin([], habit.id, today, true, now);
  checkins = setCheckin(checkins, habit.id, today, true, now);
  assert.equal(checkins.length, 1);
  assert.equal(isCheckedIn(checkins, habit.id, today), true);
});

test('取消打卡與切換', () => {
  const habit = createHabit('喝水', now);
  let checkins = toggleCheckin([], habit.id, today, now);
  assert.equal(checkins.length, 1);
  checkins = toggleCheckin(checkins, habit.id, today, now);
  assert.equal(checkins.length, 0);
});

test('取消打卡會一併移除既有的重複紀錄', () => {
  const dup = [
    { habitId: 'h_1', date: today, createdAt: null },
    { habitId: 'h_1', date: today, createdAt: null },
    { habitId: 'h_2', date: today, createdAt: null },
  ];
  assert.deepEqual(setCheckin(dup, 'h_1', today, false, now), [dup[2]]);
});

test('dedupeCheckins 合併重複打卡', () => {
  const list = [
    { habitId: 'h_1', date: today },
    { habitId: 'h_1', date: today },
    { habitId: 'h_1', date: '2026-10-19' },
  ];
  const result = dedupeCheckins(list);
  assert.equal(result.removed, 1);
  assert.equal(result.checkins.length, 2);
});

test('最近七天紀錄：建立之前不算漏打卡', () => {
  const habit = { ...createHabit('運動', now), createdDate: '2026-10-17' };
  const checkins = [{ habitId: habit.id, date: '2026-10-18', createdAt: null }];
  const history = recentHistory(habit, checkins, today);
  assert.deepEqual(history.map((d) => d.date), [
    '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20',
  ]);
  assert.deepEqual(history.map((d) => d.status), [
    'not-started', 'not-started', 'not-started', 'missed', 'done', 'missed', 'pending',
  ]);
  assert.deepEqual(habitCompletion(habit, checkins, today), { done: 1, possible: 3 });
  const withToday = [...checkins, { habitId: habit.id, date: today, createdAt: null }];
  assert.deepEqual(habitCompletion(habit, withToday, today), { done: 2, possible: 4 });
});

test('封存後不列入今日習慣，但保留紀錄；還原後恢復', () => {
  const a = createHabit('A', now);
  const b = createHabit('B', new Date(now.getTime() + 1000));
  const checkins = setCheckin([], a.id, '2026-10-19', true, now);
  let habits = setHabitArchived([a, b], a.id, true, now);
  assert.deepEqual(activeHabits(habits).map((h) => h.name), ['B']);
  assert.deepEqual(archivedHabits(habits).map((h) => h.name), ['A']);
  assert.equal(habits[0].archivedDate, today);
  assert.equal(isCheckedIn(checkins, a.id, '2026-10-19'), true);
  const summary = todaySummary({ todos: [], habits, checkins }, today);
  assert.equal(summary.habitsTotal, 1);
  // 封存日之後顯示為已封存，而不是漏打卡
  const archived = habits[0];
  assert.equal(recentHistory({ ...archived, createdDate: '2026-10-10' }, checkins, '2026-10-22').at(-1).status, 'archived');
  habits = setHabitArchived(habits, a.id, false, now);
  assert.equal(activeHabits(habits).length, 2);
  assert.equal(habits[0].archivedDate, null);
});

test('連續打卡天數：今天還沒打卡時從昨天算起', () => {
  const id = 'h_x';
  const checkins = ['2026-10-17', '2026-10-18', '2026-10-19'].map((date) => ({ habitId: id, date }));
  assert.equal(currentStreak(id, checkins, today), 3);
  assert.equal(currentStreak(id, [...checkins, { habitId: id, date: today }], today), 4);
  assert.equal(currentStreak(id, checkins, '2026-10-21'), 0);
});

test('今日摘要統計', () => {
  const a = createHabit('A', now);
  const b = createHabit('B', now);
  const summary = todaySummary(
    {
      todos: [
        { id: 't1', done: false, dueDate: today },
        { id: 't2', done: false, dueDate: '2026-10-01' },
        { id: 't3', done: true, dueDate: '2026-10-01' },
      ].map((t) => ({ title: t.id, priority: 'medium', createdAt: now.toISOString(), ...t })),
      habits: [a, b],
      checkins: setCheckin([], a.id, today, true, now),
    },
    today,
  );
  assert.deepEqual(summary, { dueToday: 1, overdue: 1, habitsTotal: 2, habitsDone: 1 });
});
