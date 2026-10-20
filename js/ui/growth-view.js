// 成長區域：角色成長（遊戲化，由 game-view.js 登記）與每週回顧。

import { addDays, formatDateLabel, formatShortDate, weekdayLabel } from '../dates.js';
import { saveReviewNote, weekPeriod, weekReview } from '../review.js';
import { app, button, card, commit, h, heading, render, replaceChildren } from './core.js';

const state = () => (app.ui.growth ??= { weekStart: null });

/** 遊戲化畫面登記的區塊：() => 元素[] */
const extensions = [];

export function registerGrowthExtension(fn) {
  extensions.push(fn);
}

function pct(rate) {
  return rate === null ? '—' : `${Math.round(rate * 100)}%`;
}

function renderReview() {
  const s = state();
  const current = weekPeriod(app.todayKey, app.data.settings.weekStart).start;
  const weekStart = s.weekStart ?? current;
  const review = weekReview(app.data, weekStart, app.todayKey);
  const go = (start) => {
    s.weekStart = start;
    render();
  };
  const noteId = 'review-note';

  return card(
    'growth-review',
    '每週回顧',
    h(
      'div',
      { class: 'calendar-nav' },
      button('‹ 上週', () => go(addDays(weekStart, -7)), { size: 'small', focusKey: 'review-prev', label: '上一週' }),
      h('p', { class: 'review-period', 'aria-live': 'polite' }, `${formatShortDate(review.start)}（${weekdayLabel(review.start)}）至 ${formatDateLabel(review.end)}`),
      button('下週 ›', () => go(addDays(weekStart, 7)), {
        size: 'small',
        focusKey: 'review-next',
        label: '下一週',
        disabled: weekStart >= current,
      }),
    ),
    weekStart !== current ? button('回到本週', () => go(current), { variant: 'ghost', size: 'small', focusKey: 'review-current' }) : null,
    h(
      'ul',
      { class: 'summary', 'aria-label': '本週統計' },
      h('li', { class: 'summary-item' }, h('span', { class: 'summary-label' }, '完成任務'), h('span', { class: 'summary-value' }, `${review.tasksCompleted} 項`)),
      h(
        'li',
        { class: 'summary-item' },
        h('span', { class: 'summary-label' }, '習慣完成率'),
        h('span', { class: 'summary-value' }, pct(review.habitRate)),
        h('span', { class: 'small muted' }, `${review.habitDone} / ${review.habitScheduled} 個排定日`),
      ),
    ),
    review.isCurrent ? h('p', { class: 'small muted' }, `本週統計到今天（${formatDateLabel(review.countedEnd)}）為止。`) : null,
    review.habits.length
      ? h(
          'ul',
          { class: 'review-habits' },
          review.habits.map((item) =>
            h(
              'li',
              {},
              h('span', {}, item.habit.name, item.habit.archived ? '（已封存）' : ''),
              h('span', {}, `${pct(item.rate)}（${item.done}/${item.scheduled}${item.extra ? `，另 ${item.extra} 天非排定日` : ''}）`),
            ),
          ),
        )
      : h('p', { class: 'muted' }, '這一週沒有需要執行的習慣。'),
    review.completedTasks.length
      ? h(
          'details',
          { class: 'method' },
          h('summary', {}, `已完成的任務（${review.completedTasks.length}）`),
          h('ul', { class: 'bullets small' }, review.completedTasks.map((task) => h('li', {}, task.title))),
        )
      : null,
    h(
      'form',
      {
        class: 'review-form',
        novalidate: true,
        onSubmit: (event) => {
          event.preventDefault();
          const note = event.target.elements[noteId].value;
          app.pendingFocusKey = 'review-save';
          commit({ ...app.data, reviews: saveReviewNote(app.data.reviews, weekStart, note) }, note.trim() ? '已儲存回顧筆記。' : '已清除回顧筆記。');
        },
      },
      h('label', { for: noteId, class: 'field-label' }, '這週的回顧筆記'),
      (() => {
        const textarea = h('textarea', { id: noteId, name: noteId, rows: 4, maxlength: 5000, placeholder: '做得好的地方、遇到的困難、下週想調整的事…' });
        textarea.value = review.note;
        return textarea;
      })(),
      h('div', { class: 'button-row' }, button('儲存筆記', null, { variant: 'primary', type: 'submit', focusKey: 'review-save' })),
    ),
    h(
      'details',
      { class: 'method' },
      h('summary', {}, '統計期間與計算方式'),
      h(
        'ul',
        { class: 'bullets small' },
        h('li', {}, `期間：每週從${app.data.settings.weekStart === 1 ? '星期一' : '星期日'}開始共 7 天（可在「設定」修改）；本週只算到今天。`),
        h('li', {}, '完成任務：完成時間換算成你裝置的當地日期後，落在這一週的已完成任務（含重複任務的單次項目）。取消完成後不再計入。'),
        h('li', {}, '習慣完成率：所有習慣（含已封存）在這一週「排定日」的打卡數 ÷ 排定日數。建立前、非排定日、封存期間、未來，以及今天還沒打卡，都不計入。'),
      ),
    ),
  );
}

/** 版面：角色（遊戲化的第一個區塊）→ 每週回顧 → 其他遊戲化區塊（成就、商店、紀錄）。 */
export function renderGrowth(panel) {
  const parts = extensions.flatMap((fn) => fn());
  replaceChildren(panel, heading('growth', '成長'), parts.slice(0, 1), renderReview(), parts.slice(1));
}
