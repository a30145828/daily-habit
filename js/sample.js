// 範例資料：只在使用者按下「載入範例資料」時加入，內容不含任何個人資料。

import { addDays } from './dates.js';
import { createHabit } from './habits.js';
import { createTodo } from './todos.js';

export function buildSampleData(todayKey, now = new Date()) {
  const todo = (title, note, dueDate, priority) => createTodo({ title, note, dueDate, priority }, now);

  const todos = [
    todo('（範例）繳交每月報告', '昨天就該完成，這筆會出現在「已逾期」。', addDays(todayKey, -1), 'high'),
    todo('（範例）買牛奶和雞蛋', '', todayKey, 'medium'),
    todo('（範例）整理書桌', '可以分成桌面與抽屜兩次整理。', addDays(todayKey, 2), 'low'),
    todo('（範例）讀完一本書', '沒有截止日期的待辦，只會出現在「所有待辦」。', null, 'low'),
  ];
  const finished = todo('（範例）回覆一封信', '', todayKey, 'medium');
  todos.push({ ...finished, done: true, completedAt: now.toISOString() });

  const startDate = addDays(todayKey, -6);
  const habit = (name) => ({ ...createHabit(name, now), createdDate: startDate });
  const habits = [habit('（範例）喝水 8 杯'), habit('（範例）伸展 10 分鐘'), habit('（範例）睡前閱讀')];

  const checkins = [];
  const pattern = [
    [-6, -5, -4, -2, -1],
    [-5, -3, -1],
    [-6, -4, -3, -2],
  ];
  pattern.forEach((offsets, index) => {
    for (const offset of offsets) {
      checkins.push({ habitId: habits[index].id, date: addDays(todayKey, offset), createdAt: now.toISOString() });
    }
  });

  return { todos, habits, checkins };
}
