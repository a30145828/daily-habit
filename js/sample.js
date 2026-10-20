// 範例資料：只在使用者按下「載入範例資料」時加入，內容不含任何個人資料。
// 名稱都以「（範例）」開頭，方便辨識與刪除。

import { addDays } from './dates.js';
import { createHabit, setCheckin } from './habits.js';
import { createId } from './ids.js';
import { createSeries } from './recurrence.js';
import { createTask } from './tasks.js';

export function buildSampleData(todayKey, now = new Date()) {
  const task = (title, note, dueDate, priority, tags = [], subtasks = []) =>
    createTask(
      { title, note, dueDate, priority, tags, subtasks: subtasks.map((t) => ({ id: createId('st'), title: t, done: false })) },
      now,
    );

  const tasks = [
    task('（範例）繳交每月報告', '昨天就該完成，這筆會出現在「逾期」。', addDays(todayKey, -1), 'high', ['工作']),
    task('（範例）買牛奶和雞蛋', '', todayKey, 'medium', ['家裡'], ['牛奶', '雞蛋', '吐司']),
    task('（範例）整理書桌', '可以分成桌面與抽屜兩次整理。', addDays(todayKey, 2), 'low', ['家裡']),
    task('（範例）讀完一本書', '沒有截止日期的任務，會出現在「全部」。', null, 'low', ['學習']),
  ];
  const finished = task('（範例）回覆一封信', '', todayKey, 'medium', ['工作']);
  tasks.push({ ...finished, done: true, completedAt: now.toISOString() });

  const series = [
    createSeries(
      {
        title: '（範例）倒垃圾',
        note: '每週二、五重複。',
        priority: 'medium',
        tags: ['家裡'],
        subtasks: [],
        rule: { freq: 'weekly', weekdays: [2, 5], monthDay: null, monthEnd: 'last' },
        startDate: addDays(todayKey, -14),
      },
      now,
    ),
    createSeries(
      {
        title: '（範例）繳信用卡費',
        note: '每月 31 日；沒有 31 日的月份改在月底。',
        priority: 'high',
        tags: ['財務'],
        subtasks: [],
        rule: { freq: 'monthly', weekdays: [], monthDay: 31, monthEnd: 'last' },
        startDate: todayKey,
      },
      now,
    ),
  ];

  const startDate = addDays(todayKey, -13);
  const habit = (name, days) => {
    const created = createHabit(name, days, startDate, now);
    return { ...created, schedules: [{ from: startDate, days }] };
  };
  const habits = [
    habit('（範例）喝水 8 杯', [0, 1, 2, 3, 4, 5, 6]),
    habit('（範例）伸展 10 分鐘', [0, 1, 2, 3, 4, 5, 6]),
    habit('（範例）上健身房', [1, 3, 5]),
  ];

  let checkins = [];
  const pattern = [
    [-13, -12, -11, -9, -8, -7, -6, -5, -4, -2, -1],
    [-12, -10, -7, -5, -3, -1],
    [-13, -11, -9, -6, -4, -2],
  ];
  pattern.forEach((offsets, index) => {
    for (const offset of offsets) checkins = setCheckin(checkins, habits[index].id, addDays(todayKey, offset), true, now);
  });

  return { tasks, series, habits, checkins };
}

/** 把範例資料加入現有資料（不刪除原有內容）。 */
export function mergeSample(data, sample) {
  const merged = { ...data };
  for (const [name, list] of Object.entries(sample)) merged[name] = [...data[name], ...list];
  return merged;
}
