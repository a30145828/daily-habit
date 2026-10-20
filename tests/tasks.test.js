process.env.TZ = 'Asia/Taipei';

import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyData } from '../js/schema.js';
import { createSeries, materialize, virtualOccurrence } from '../js/recurrence.js';
import {
  applyFilters,
  createTask,
  deleteTask,
  dueStatus,
  dueTodayTasks,
  overdueTasks,
  parseTags,
  setTaskArchived,
  setTaskDone,
  sortTasks,
  taskView,
  thisWeekTasks,
  toggleSubtask,
  updateTask,
  validateTaskInput,
  viewCounts,
} from '../js/tasks.js';

const now = new Date('2026-10-20T02:00:00Z'); // 台灣 10/20（二）10:00
const today = '2026-10-20';

function make(title, dueDate = null, priority = 'medium', extra = {}) {
  const input = validateTaskInput({ title, dueDate, priority, ...extra });
  assert.equal(input.ok, true, JSON.stringify(input.errors));
  return createTask(input.value, now);
}

function data(tasks, series = []) {
  return { ...emptyData(), tasks, series };
}

test('名稱不可空白；標籤與子任務會整理', () => {
  assert.equal(validateTaskInput({ title: '   ' }).errors.title, '請輸入任務名稱。');
  const ok = validateTaskInput({ title: ' 買菜 ', tags: '家裡、 #採買,家裡', subtasks: [{ title: '牛奶' }, { title: '  ' }] });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.title, '買菜');
  assert.deepEqual(ok.value.tags, ['家裡', '採買']);
  assert.equal(ok.value.subtasks.length, 1);
  assert.equal(ok.value.subtasks[0].title, '牛奶');
  assert.ok(validateTaskInput({ title: 'a', dueDate: '2026-02-30' }).errors.dueDate);
  assert.ok(validateTaskInput({ title: 'a', priority: 'urgent' }).errors.priority);
  assert.deepEqual(parseTags('a，b、c, a'), ['a', 'b', 'c']);
});

test('完成、取消完成、封存、刪除、編輯', () => {
  const a = make('A');
  const b = make('B');
  let tasks = setTaskDone([a, b], a.id, true, now);
  assert.equal(tasks[0].done, true);
  assert.ok(tasks[0].completedAt);
  tasks = setTaskDone(tasks, a.id, false, now);
  assert.equal(tasks[0].completedAt, null);
  tasks = setTaskArchived(tasks, b.id, true, now);
  assert.equal(taskView(data(tasks), 'all', today).some((t) => t.id === b.id), false, '封存後不在全部');
  assert.equal(taskView(data(tasks), 'archived', today)[0].id, b.id);
  tasks = updateTask(tasks, a.id, { title: 'A2', note: 'n', dueDate: today, priority: 'low', tags: ['x'], subtasks: [] }, now);
  assert.equal(tasks[0].title, 'A2');
  assert.deepEqual(deleteTask(tasks, a.id).map((t) => t.id), [b.id]);
});

test('子任務切換', () => {
  const task = make('A', null, 'medium', { subtasks: [{ id: 'st_1', title: '一' }, { id: 'st_2', title: '二' }] });
  const [after] = toggleSubtask([task], task.id, 'st_2', now);
  assert.deepEqual(after.subtasks.map((s) => s.done), [false, true]);
});

test('今日、逾期、本週與沒有截止日期的分類', () => {
  const tasks = [
    make('今天', today),
    make('昨天', '2026-10-19'),
    make('週日', '2026-10-25'),
    make('下週一', '2026-10-26'),
    make('無日期'),
  ];
  const d = data([...tasks, make('十月一日', '2026-10-01')]);
  const doneOld = { ...make('完成的', '2026-10-01'), done: true, completedAt: now.toISOString() };
  d.tasks.push(doneOld);
  assert.deepEqual(dueTodayTasks(d, today).map((t) => t.title), ['今天']);
  assert.deepEqual(overdueTasks(d, today).map((t) => t.title).sort(), ['十月一日', '昨天'].sort());
  assert.deepEqual(thisWeekTasks(d, today, 1).map((t) => t.title).sort(), ['今天', '週日'].sort());
  assert.deepEqual(thisWeekTasks(d, today, 0).map((t) => t.title), ['今天'], '週日起始時本週到週六');
  assert.ok(taskView(d, 'all', today).some((t) => t.title === '無日期'));
  assert.deepEqual(taskView(d, 'done', today).map((t) => t.title), ['完成的']);
});

test('跨午夜：今天到期變逾期', () => {
  const task = make('報告', '2026-10-20');
  assert.equal(dueStatus(task, '2026-10-20'), 'today');
  assert.equal(dueStatus(task, '2026-10-21'), 'overdue');
});

test('搜尋（名稱、備註、標籤、子任務）與篩選', () => {
  const tasks = [
    make('寫報告', null, 'high', { tags: ['工作'], note: '第三季' }),
    make('買菜', null, 'low', { tags: ['家裡'], subtasks: [{ title: '牛奶' }] }),
  ];
  assert.deepEqual(applyFilters(tasks, { query: '牛奶' }).map((t) => t.title), ['買菜']);
  assert.deepEqual(applyFilters(tasks, { query: '第三季' }).map((t) => t.title), ['寫報告']);
  assert.deepEqual(applyFilters(tasks, { query: '工作' }).map((t) => t.title), ['寫報告']);
  assert.deepEqual(applyFilters(tasks, { tag: '家裡' }).map((t) => t.title), ['買菜']);
  assert.deepEqual(applyFilters(tasks, { priority: 'high' }).map((t) => t.title), ['寫報告']);
});

test('排序方式', () => {
  const tasks = [make('b 無日期高', null, 'high'), make('a 明天低', '2026-10-21', 'low'), make('c 明天高', '2026-10-21', 'high'), make('d 昨天', '2026-10-19')];
  assert.deepEqual(sortTasks(tasks, 'due').map((t) => t.title), ['d 昨天', 'c 明天高', 'a 明天低', 'b 無日期高']);
  assert.deepEqual(sortTasks(tasks, 'priority').map((t) => t.priority), ['high', 'high', 'medium', 'low']);
  assert.deepEqual(sortTasks(tasks, 'title').map((t) => t.title[0]), ['a', 'b', 'c', 'd']);
});

test('重複任務出現在今日、本週，完成後不再重複出現', () => {
  const series = createSeries(
    { title: '倒垃圾', note: '', priority: 'medium', tags: [], subtasks: [], rule: { freq: 'weekly', weekdays: [2, 5], monthDay: null, monthEnd: 'last' }, startDate: '2026-10-01' },
    now,
  );
  let d = data([], [series]);
  assert.deepEqual(dueTodayTasks(d, today).map((t) => t.occurrenceDate), ['2026-10-20']);
  assert.deepEqual(thisWeekTasks(d, today).map((t) => t.occurrenceDate), ['2026-10-20', '2026-10-23']);
  // 逾期只列最近一次未處理（10/16 五）
  const overdue = overdueTasks(d, today);
  assert.equal(overdue.length, 1);
  assert.equal(overdue[0].occurrenceDate, '2026-10-16');
  assert.equal(overdue[0].missedCount, 5); // 10/2、10/6、10/9、10/13、10/16
  // 完成今天這次
  const done = materialize(virtualOccurrence(series, today), { done: true, completedAt: now.toISOString() }, now);
  d = data([done], [series]);
  assert.equal(dueTodayTasks(d, today).length, 0);
  assert.equal(overdueTasks(d, today).length, 0, '最近一次已完成，之前錯過的不再列為逾期');
  assert.equal(taskView(d, 'done', today)[0].id, done.id);
  const counts = viewCounts(d, today);
  assert.equal(counts.done, 1);
  assert.equal(counts.all, 2, '全部：已完成的這次 + 下一次（10/23）');
});
