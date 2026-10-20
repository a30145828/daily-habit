process.env.TZ = 'Asia/Taipei';

import test from 'node:test';
import assert from 'node:assert/strict';
import { ALL_DAYS, createHabit, setCheckin } from '../js/habits.js';
import { localDateOf, reviewId, saveReviewNote, weekPeriod, weekReview } from '../js/review.js';
import { emptyData } from '../js/schema.js';
import { createTask, setTaskDone } from '../js/tasks.js';

const now = new Date('2026-10-20T02:00:00Z');
const today = '2026-10-21'; // 星期三

test('完成時間以台灣日期歸屬到週：週日 23:30 與週一 00:30', () => {
  assert.equal(localDateOf('2026-10-18T15:30:00.000Z'), '2026-10-18'); // 台灣週日 23:30
  assert.equal(localDateOf('2026-10-18T16:30:00.000Z'), '2026-10-19'); // 台灣週一 00:30（UTC 仍是 10/18）
  const a = createTask({ title: '週日深夜', note: '', dueDate: null, priority: 'low', tags: [], subtasks: [] }, now);
  const b = createTask({ title: '週一凌晨', note: '', dueDate: null, priority: 'low', tags: [], subtasks: [] }, now);
  const tasks = [
    { ...a, done: true, completedAt: '2026-10-18T15:30:00.000Z' },
    { ...b, done: true, completedAt: '2026-10-18T16:30:00.000Z' },
  ];
  const data = { ...emptyData(), tasks };
  assert.deepEqual(weekReview(data, '2026-10-19', today).completedTasks.map((t) => t.title), ['週一凌晨']);
  assert.deepEqual(weekReview(data, '2026-10-12', today).completedTasks.map((t) => t.title), ['週日深夜']);
});

test('取消完成後不再計入', () => {
  const a = createTask({ title: 'A', note: '', dueDate: null, priority: 'low', tags: [], subtasks: [] }, now);
  let tasks = setTaskDone([a], a.id, true, now);
  assert.equal(weekReview({ ...emptyData(), tasks }, '2026-10-19', today).tasksCompleted, 1);
  tasks = setTaskDone(tasks, a.id, false, now);
  assert.equal(weekReview({ ...emptyData(), tasks }, '2026-10-19', today).tasksCompleted, 0);
});

test('習慣完成率：本週只算到今天，今天未打卡不計', () => {
  const h = { ...createHabit('跑步', [1, 3, 5], '2026-10-01', now), schedules: [{ from: '2026-10-01', days: [1, 3, 5] }] };
  const checkins = setCheckin([], h.id, '2026-10-19', true, now); // 週一完成，週三（今天）未打卡
  const review = weekReview({ ...emptyData(), habits: [h], checkins }, '2026-10-19', today);
  assert.equal(review.habitDone, 1);
  assert.equal(review.habitScheduled, 1);
  assert.equal(review.habitRate, 1);
  assert.equal(review.countedEnd, today);
  assert.equal(review.isCurrent, true);
});

test('週期間與筆記', () => {
  assert.deepEqual(weekPeriod('2026-10-25', 1), { start: '2026-10-19', end: '2026-10-25' });
  assert.deepEqual(weekPeriod('2026-10-25', 0), { start: '2026-10-25', end: '2026-10-31' });
  let reviews = saveReviewNote([], '2026-10-19', ' 這週不錯 ', now);
  assert.equal(reviews[0].id, reviewId('2026-10-19'));
  assert.equal(reviews[0].note, '這週不錯');
  reviews = saveReviewNote(reviews, '2026-10-19', '更新', now);
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].note, '更新');
  assert.equal(saveReviewNote(reviews, '2026-10-19', '  ', now).length, 0, '清空時刪除');
});
