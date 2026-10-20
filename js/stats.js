// 統計數字：給「今日」頁摘要與各頁計數使用。

import { activeHabits, isCheckedIn, recentHistory } from './habits.js';
import { dueTodayTodos, overdueTodos } from './todos.js';

/** 待辦數量：{ all, open, done }。 */
export function todoCounts(todos) {
  const done = todos.filter((todo) => todo.done).length;
  return { all: todos.length, open: todos.length - done, done };
}

/** 今日摘要。 */
export function todaySummary(state, todayKey) {
  const habits = activeHabits(state.habits);
  const habitsDone = habits.filter((habit) => isCheckedIn(state.checkins, habit.id, todayKey)).length;
  return {
    dueToday: dueTodayTodos(state.todos, todayKey).length,
    overdue: overdueTodos(state.todos, todayKey).length,
    habitsTotal: habits.length,
    habitsDone,
  };
}

/**
 * 最近 days 天的完成率：只計算習慣已建立（且未封存）的日子。
 * 今天還沒打卡時不列入分母（今天還沒結束），打卡後才計入。
 * 回傳 { done, possible }，possible 為 0 時代表還沒有可計算的日子。
 */
export function habitCompletion(habit, checkins, todayKey, days = 7) {
  const history = recentHistory(habit, checkins, todayKey, days);
  const counted = history.filter((day) => day.status === 'done' || day.status === 'missed');
  return {
    done: counted.filter((day) => day.status === 'done').length,
    possible: counted.length,
  };
}
