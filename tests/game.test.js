process.env.TZ = 'Asia/Taipei';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACHIEVEMENTS,
  CHECKIN_REWARD,
  TASK_REWARDS,
  achievementStatus,
  createReward,
  levelInfo,
  pendingRewards,
  reconcileRewards,
  redeemReward,
  refundRedemption,
  totals,
  xpForLevel,
} from '../js/game.js';
import { ALL_DAYS, createHabit, setCheckin } from '../js/habits.js';
import { validateRecord, emptyData } from '../js/schema.js';
import { createTask, deleteTask, setTaskDone, updateTask } from '../js/tasks.js';

const now = new Date('2026-10-20T02:00:00Z');
const today = '2026-10-20';

function task(title = 'A', priority = 'medium') {
  return createTask({ title, note: '', dueDate: null, priority, tags: [], subtasks: [] }, now);
}

/** 模擬每次儲存都結算一次。 */
function settle(data) {
  return reconcileRewards(data, today, now);
}

function withTasks(tasks, extra = {}) {
  return settle({ ...emptyData(), tasks, ...extra });
}

const taskEntries = (data) => data.ledger.filter((e) => e.source.startsWith('task:'));

test('等級：0、100、300、600 經驗值', () => {
  assert.equal(xpForLevel(1), 0);
  assert.equal(xpForLevel(2), 100);
  assert.equal(xpForLevel(4), 600);
  assert.equal(levelInfo(0).level, 1);
  assert.equal(levelInfo(99).level, 1);
  assert.equal(levelInfo(100).level, 2);
  const info = levelInfo(450);
  assert.deepEqual([info.level, info.inLevel, info.needed], [3, 150, 300]);
  assert.equal(levelInfo(-50).level, 1, '負經驗值視為 0');
});

test('完成任務只領一次；重複儲存不會重複領取', () => {
  const t = task('A', 'high');
  let data = withTasks(setTaskDone([t], t.id, true, now));
  assert.equal(taskEntries(data).length, 1);
  assert.deepEqual(totals(taskEntries(data)), { xp: TASK_REWARDS.high.xp, coins: TASK_REWARDS.high.coins, rawXp: TASK_REWARDS.high.xp });
  data = settle(data);
  data = settle(data);
  assert.equal(taskEntries(data).length, 1);
});

test('取消完成會撤銷；反覆取消、重新完成也不能多領', () => {
  const t = task('A', 'medium');
  let data = withTasks(setTaskDone([t], t.id, true, now));
  for (let i = 0; i < 5; i++) {
    data = settle({ ...data, tasks: setTaskDone(data.tasks, t.id, false, now) });
    assert.equal(totals(taskEntries(data)).xp, 0, '取消後歸零');
    data = settle({ ...data, tasks: setTaskDone(data.tasks, t.id, true, now) });
    assert.equal(totals(taskEntries(data)).xp, TASK_REWARDS.medium.xp, '重新完成後只有一份');
  }
  assert.equal(taskEntries(data).length, 11, '每次變更都有可追溯的紀錄');
  assert.deepEqual(taskEntries(data).map((e) => e.kind).slice(0, 3), ['award', 'revoke', 'award']);
  assert.equal(new Set(data.ledger.map((e) => e.id)).size, data.ledger.length, 'id 不重複');
});

test('修改優先程度與刪除已完成任務，以相同規則補差額', () => {
  const t = task('A', 'low');
  let data = withTasks(setTaskDone([t], t.id, true, now));
  data = settle({ ...data, tasks: updateTask(data.tasks, t.id, { ...data.tasks[0], priority: 'high' }, now) });
  assert.equal(totals(taskEntries(data)).xp, TASK_REWARDS.high.xp);
  data = settle({ ...data, tasks: deleteTask(data.tasks, t.id) });
  assert.equal(totals(taskEntries(data)).xp, 0);
  assert.equal(taskEntries(data).at(-1).kind, 'revoke');
});

test('習慣打卡（含補登）同一天只領一次；取消打卡撤銷', () => {
  const h = { ...createHabit('跑步', ALL_DAYS, '2026-10-01', now), schedules: [{ from: '2026-10-01', days: ALL_DAYS }] };
  let data = settle({ ...emptyData(), habits: [h], checkins: setCheckin([], h.id, '2026-10-15', true, now) });
  const sum = () => totals(data.ledger.filter((e) => e.source.startsWith('checkin:')));
  assert.equal(sum().xp, CHECKIN_REWARD.xp, '補登也給一份');
  data = settle({ ...data, checkins: setCheckin(data.checkins, h.id, '2026-10-15', true, now) });
  assert.equal(sum().xp, CHECKIN_REWARD.xp, '重複打卡不再給');
  data = settle({ ...data, checkins: setCheckin(data.checkins, h.id, '2026-10-15', false, now) });
  assert.equal(sum().xp, 0);
});

test('成就只解鎖一次，之後條件不再成立也不撤銷', () => {
  const t = task();
  let data = withTasks(setTaskDone([t], t.id, true, now));
  assert.ok(data.ledger.some((e) => e.id === 'l_ach_first_task'));
  data = settle({ ...data, tasks: setTaskDone(data.tasks, t.id, false, now) });
  data = settle({ ...data, tasks: setTaskDone(data.tasks, t.id, true, now) });
  assert.equal(data.ledger.filter((e) => e.kind === 'achievement').length, 1);
  const status = achievementStatus(data, today);
  assert.equal(status.find((a) => a.id === 'first_task').unlocked, true);
  assert.equal(status.find((a) => a.id === 'tasks_10').value, 1);
  assert.equal(ACHIEVEMENTS.length, new Set(ACHIEVEMENTS.map((a) => a.id)).size);
});

test('兌換：金幣不足不能兌換；可退回一次；撤銷後金幣可為負數', () => {
  const t = task('A', 'high'); // 6 金幣 + 首次完成 10 金幣 = 16
  const reward = createReward({ name: '看一集影集', cost: 15, icon: '📺' }, now);
  let data = withTasks(setTaskDone([t], t.id, true, now), { rewards: [reward] });
  assert.equal(totals(data.ledger).coins, 16);
  const ok = redeemReward(data, reward.id, today, now);
  assert.equal(ok.ok, true);
  data = ok.data;
  assert.equal(totals(data.ledger).coins, 1);
  assert.equal(redeemReward(data, reward.id, today, now).ok, false, '金幣不足');
  // 取消完成：撤銷 6 金幣 → 餘額 -5
  data = settle({ ...data, tasks: setTaskDone(data.tasks, t.id, false, now) });
  assert.equal(totals(data.ledger).coins, -5);
  assert.equal(redeemReward(data, reward.id, today, now).ok, false, '負數不能兌換');
  // 退回兌換
  const refunded = refundRedemption(data, ok.entry.id, today, now);
  assert.equal(refunded.ok, true);
  data = refunded.data;
  assert.equal(totals(data.ledger).coins, 10);
  assert.equal(refundRedemption(data, ok.entry.id, today, now).ok, false, '不能退回兩次');
});

test('關閉遊戲化時不結算；重新開啟後補齊，結果與一直開啟相同', () => {
  const t = task('A', 'medium');
  const off = { ...emptyData(), settings: { ...emptyData().settings, gameEnabled: false }, tasks: setTaskDone([t], t.id, true, now) };
  assert.deepEqual(pendingRewards(off, today, now), []);
  const on = settle({ ...off, settings: { ...off.settings, gameEnabled: true } });
  assert.equal(totals(taskEntries(on)).xp, TASK_REWARDS.medium.xp);
});

test('帳本紀錄都能通過資料驗證（長名稱會截斷）', () => {
  const t = task('長'.repeat(200), 'high');
  const data = withTasks(setTaskDone([t], t.id, true, now));
  for (const entry of data.ledger) assert.equal(validateRecord('ledger', entry).ok, true, JSON.stringify(validateRecord('ledger', entry).errors));
});
