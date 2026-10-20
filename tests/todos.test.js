process.env.TZ = 'Asia/Taipei';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTodo,
  deleteTodo,
  dueStatus,
  dueTodayTodos,
  filterTodos,
  overdueTodos,
  setTodoDone,
  sortTodos,
  updateTodo,
  validateTodoInput,
} from '../js/todos.js';

const now = new Date('2026-10-20T02:00:00Z');
const today = '2026-10-20';

function make(title, dueDate = null, priority = 'medium') {
  return createTodo({ title, note: '', dueDate, priority }, now);
}

test('名稱不可空白（含只有空白字元）', () => {
  assert.equal(validateTodoInput({ title: '' }).ok, false);
  assert.equal(validateTodoInput({ title: '   ' }).errors.title, '請輸入待辦名稱。');
  const ok = validateTodoInput({ title: '  買菜 ', note: ' 記得帶袋子 ', dueDate: '', priority: 'high' });
  assert.deepEqual(ok, { ok: true, value: { title: '買菜', note: '記得帶袋子', dueDate: null, priority: 'high' } });
});

test('截止日期與優先程度驗證', () => {
  assert.equal(validateTodoInput({ title: 'a', dueDate: '2026-02-30' }).errors.dueDate, '截止日期格式不正確。');
  assert.ok(validateTodoInput({ title: 'a', priority: 'urgent' }).errors.priority);
});

test('篩選全部、未完成、已完成', () => {
  const a = make('A');
  const b = make('B');
  const todos = setTodoDone([a, b], b.id, true, now);
  assert.deepEqual(filterTodos(todos, 'all').map((t) => t.title), ['A', 'B']);
  assert.deepEqual(filterTodos(todos, 'open').map((t) => t.title), ['A']);
  assert.deepEqual(filterTodos(todos, 'done').map((t) => t.title), ['B']);
});

test('今天到期與已逾期只包含未完成，且沒有截止日期的不列入', () => {
  const todos = [
    make('今天', today),
    make('昨天', '2026-10-19'),
    make('明天', '2026-10-21'),
    make('無日期'),
  ];
  const doneOverdue = make('已完成的逾期', '2026-10-01');
  const all = [...todos, ...setTodoDone([doneOverdue], doneOverdue.id, true, now)];
  assert.deepEqual(dueTodayTodos(all, today).map((t) => t.title), ['今天']);
  assert.deepEqual(overdueTodos(all, today).map((t) => t.title), ['昨天']);
  assert.deepEqual(filterTodos(all, 'all').length, 5);
});

test('跨午夜後，昨天到期的待辦變為逾期', () => {
  const todo = make('報告', '2026-10-20');
  assert.equal(dueStatus(todo, '2026-10-20'), 'today');
  assert.equal(dueStatus(todo, '2026-10-21'), 'overdue');
  assert.equal(dueStatus(make('x'), today), 'none');
});

test('取消完成會清除完成時間', () => {
  const todo = make('A');
  const done = setTodoDone([todo], todo.id, true, now);
  assert.equal(done[0].done, true);
  assert.ok(done[0].completedAt);
  const undone = setTodoDone(done, todo.id, false, now);
  assert.equal(undone[0].done, false);
  assert.equal(undone[0].completedAt, null);
});

test('編輯與刪除不影響其他待辦', () => {
  const a = make('A');
  const b = make('B');
  const edited = updateTodo([a, b], a.id, { title: 'A2', note: 'n', dueDate: today, priority: 'low' }, now);
  assert.equal(edited[0].title, 'A2');
  assert.equal(edited[1], b);
  assert.deepEqual(deleteTodo(edited, a.id).map((t) => t.id), [b.id]);
});

test('排序：未完成在前，依截止日、優先程度', () => {
  const todos = [make('無日期高', null, 'high'), make('明天低', '2026-10-21', 'low'), make('明天高', '2026-10-21', 'high'), make('昨天', '2026-10-19')];
  assert.deepEqual(sortTodos(todos).map((t) => t.title), ['昨天', '明天高', '明天低', '無日期高']);
});
