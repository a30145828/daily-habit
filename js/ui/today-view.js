// 今日區域：逾期與今天到期的任務、今日習慣，以及其他模組登記的摘要（近期續費、角色成長）。

import { habitsDueOn, isCheckedIn, activeHabits, isScheduledOn } from '../habits.js';
import { hasUserData } from '../schema.js';
import { dueTodayTasks, overdueTasks, sortTasks } from '../tasks.js';
import { app, button, h, heading, replaceChildren, section } from './core.js';
import { checkinButton, openNewHabitDialog, todayStatus } from './habits-view.js';
import { loadSampleData } from './settings-view.js';
import { openTaskDialog, renderTaskList } from './tasks-view.js';

/** 其他模組可登記今日頁的摘要卡片與區塊：{ order, summary?: () => 摘要項目, section?: () => 元素 } */
const extensions = [];

export function registerTodayExtension(extension) {
  extensions.push(extension);
  extensions.sort((a, b) => a.order - b.order);
}

export function summaryItem(label, value, { tone = '', href = null } = {}) {
  const content = [h('span', { class: 'summary-label' }, label), h('span', { class: 'summary-value' }, value)];
  return h('li', { class: `summary-item${tone ? ` summary-item--${tone}` : ''}` }, href ? h('a', { href, class: 'summary-link' }, content) : content);
}

function goAddHabit() {
  location.hash = '#habits';
  setTimeout(openNewHabitDialog, 0);
}

function renderWelcome(panel) {
  replaceChildren(
    panel,
    heading('today', '今日'),
    h(
      'div',
      { class: 'card welcome' },
      h('h3', {}, '歡迎使用！'),
      h('p', {}, '這裡會整理今天到期與逾期的任務、今天要完成的習慣、近期的訂閱續費，以及你的角色成長。'),
      h(
        'div',
        { class: 'button-row' },
        button('新增第一個任務', () => openTaskDialog({ defaultDue: app.todayKey }), { variant: 'primary', focusKey: 'welcome-task' }),
        button('新增第一個習慣', goAddHabit, { variant: 'primary', focusKey: 'welcome-habit' }),
      ),
      h('p', { class: 'muted' }, '想先看看效果？可以載入範例資料，之後隨時能刪除或封存。'),
      button('載入範例資料', loadSampleData, { focusKey: 'welcome-sample' }),
      h('p', { class: 'muted small' }, '未登入時資料只存在這個瀏覽器；到「設定」可以登入帳號啟用雲端同步，或匯出備份。'),
    ),
  );
}

export function renderToday(panel) {
  if (!hasUserData(app.data)) return renderWelcome(panel);

  const overdue = sortTasks(overdueTasks(app.data, app.todayKey));
  const dueToday = sortTasks(dueTodayTasks(app.data, app.todayKey, { includeDone: true }));
  const openToday = dueToday.filter((task) => !task.done).length;
  const due = habitsDueOn(app.data.habits, app.todayKey);
  const doneCount = due.filter((habit) => isCheckedIn(app.data.checkins, habit.id, app.todayKey)).length;
  const restDone = activeHabits(app.data.habits).filter(
    (habit) => !isScheduledOn(habit, app.todayKey) && isCheckedIn(app.data.checkins, habit.id, app.todayKey),
  );

  replaceChildren(
    panel,
    heading('today', '今日'),
    h(
      'ul',
      { class: 'summary', 'aria-label': '今日摘要' },
      summaryItem('已逾期', `${overdue.length} 項`, { tone: overdue.length ? 'alert' : '' }),
      summaryItem('今天到期', `${openToday} 項`),
      summaryItem('今日習慣', `${doneCount} / ${due.length}`),
      extensions.map((ext) => ext.summary?.()).filter(Boolean),
    ),
    overdue.length
      ? section('today-overdue', `⚠ 已逾期（${overdue.length}）`, renderTaskList(overdue, 'today'))
      : null,
    h(
      'section',
      { class: 'section', 'aria-labelledby': 'today-due' },
      h(
        'div',
        { class: 'section-head' },
        h('h3', { id: 'today-due', class: 'section-title' }, `今天到期（${openToday} 項未完成${dueToday.length > openToday ? `，${dueToday.length - openToday} 項已完成` : ''}）`),
        button('＋ 新增今天的任務', () => openTaskDialog({ defaultDue: app.todayKey }), { variant: 'primary', size: 'small', focusKey: 'today-add-task' }),
      ),
      dueToday.length
        ? renderTaskList(dueToday, 'today')
        : h('p', { class: 'muted' }, overdue.length ? '今天沒有到期的任務。' : '今天沒有到期的任務，也沒有逾期的任務。'),
    ),
    section(
      'today-habits',
      `今日習慣（${doneCount} / ${due.length} 完成）`,
      due.length || restDone.length
        ? h(
            'ul',
            { class: 'habit-list habit-list--compact' },
            [...due, ...restDone].map((habit) =>
              h(
                'li',
                { class: 'habit habit--compact' },
                h('div', { class: 'habit-info' }, h('p', { class: 'habit-name' }, habit.name), todayStatus(habit)),
                checkinButton(habit, 'today'),
              ),
            ),
          )
        : h(
            'div',
            {},
            h('p', { class: 'muted' }, activeHabits(app.data.habits).length ? '今天沒有排定的習慣。' : '目前沒有進行中的習慣。'),
            button('前往習慣', () => (location.hash = '#habits'), { focusKey: 'today-go-habit' }),
          ),
    ),
    extensions.map((ext) => ext.section?.()).filter(Boolean),
  );
}
