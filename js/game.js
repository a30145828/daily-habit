// 遊戲化：經驗值、金幣、等級、成就與獎勵兌換。
// 金幣是遊戲點數，與財務模組的真實金額完全無關。
//
// 獎勵規則（帳本 ledger 只新增、不修改）：
// 1. 每個獎勵來源有「應得獎勵」：
//    - 任務 task:<任務id>：已完成（且未略過）→ 依優先程度給予；未完成或已刪除 → 0。
//    - 習慣打卡 checkin:<打卡id>：該天有打卡 → 固定獎勵；取消打卡 → 0。補登與當天打卡規則相同。
// 2. 每次資料變更後「結算」：帳本中該來源的加總若與應得獎勵不同，就新增一筆差額紀錄
//    （正數為「獲得」、負數為「撤銷」）。因此：
//    - 同一任務完成或同一天打卡只會領到一份；取消完成再完成，加總最多仍是一份，不能反覆獲取。
//    - 修改優先程度、刪除已完成的任務、取消補登，都以同樣方式補差額。
// 3. 撤銷後金幣可能變成負數（例如已兌換獎勵後再取消完成）：餘額照實顯示，負數或不足時不能兌換；
//    已兌換的獎勵不會被自動收回。
// 4. 成就：達成條件時新增一筆「成就」紀錄（id 固定為 l_ach_<成就id>），永久保留，不會重複領取，也不會撤銷。
// 5. 兌換：新增一筆負金幣紀錄；可「退回」一次（id 固定為 l_rf_<兌換id>），退回後金幣歸還。
// 6. 關閉遊戲化時不結算；重新開啟時依當下完成狀態一次補齊，結果與一直開啟相同。
// 7. 帳本紀錄的 id 固定（l_<來源>_<序號>），雲端同步時同一筆不會重複入帳。

import { longestStreak } from './habits.js';
import { createId } from './ids.js';
import { PRIORITY_LABELS } from './tasks.js';

export const TASK_REWARDS = { high: { xp: 30, coins: 6 }, medium: { xp: 20, coins: 4 }, low: { xp: 10, coins: 2 } };
export const CHECKIN_REWARD = { xp: 15, coins: 3 };
export const KIND_LABELS = { award: '獲得', revoke: '撤銷', achievement: '成就', redeem: '兌換', refund: '退回' };

/** 成就定義：progress(stats) 回傳目前數值；達到 goal 時解鎖。 */
export const ACHIEVEMENTS = [
  { id: 'first_task', type: '首次完成', name: '踏出第一步', description: '完成第一個任務', icon: '🚩', goal: 1, stat: 'tasksDone', xp: 20, coins: 10 },
  { id: 'first_checkin', type: '首次完成', name: '好的開始', description: '第一次習慣打卡', icon: '🌱', goal: 1, stat: 'checkins', xp: 20, coins: 10 },
  { id: 'tasks_10', type: '累積完成', name: '行動派', description: '累積完成 10 個任務', icon: '✅', goal: 10, stat: 'tasksDone', xp: 50, coins: 20 },
  { id: 'tasks_50', type: '累積完成', name: '效率達人', description: '累積完成 50 個任務', icon: '🏅', goal: 50, stat: 'tasksDone', xp: 150, coins: 60 },
  { id: 'checkins_30', type: '累積完成', name: '習慣養成中', description: '累積 30 次習慣打卡', icon: '📅', goal: 30, stat: 'checkins', xp: 80, coins: 30 },
  { id: 'checkins_100', type: '累積完成', name: '百次打卡', description: '累積 100 次習慣打卡', icon: '💯', goal: 100, stat: 'checkins', xp: 200, coins: 80 },
  { id: 'streak_7', type: '連續達成', name: '一週不間斷', description: '任一習慣連續達成 7 個排定日', icon: '🔥', goal: 7, stat: 'bestStreak', xp: 70, coins: 25 },
  { id: 'streak_30', type: '連續達成', name: '月月堅持', description: '任一習慣連續達成 30 個排定日', icon: '🏆', goal: 30, stat: 'bestStreak', xp: 250, coins: 100 },
  { id: 'first_review', type: '首次完成', name: '自我回顧', description: '寫下第一篇每週回顧', icon: '📝', goal: 1, stat: 'reviews', xp: 20, coins: 10 },
];

/** 角色外觀依等級成長。 */
export const AVATAR_STAGES = [
  { minLevel: 1, icon: '🌱', name: '新芽' },
  { minLevel: 3, icon: '🌿', name: '嫩葉' },
  { minLevel: 5, icon: '🌳', name: '小樹' },
  { minLevel: 8, icon: '🌸', name: '開花' },
  { minLevel: 12, icon: '🍎', name: '結果' },
  { minLevel: 18, icon: '🏞️', name: '森林' },
];

// ---------- 等級 ----------

/** 升到第 level 級所需的累積經驗值：0、100、300、600、1000…（每級多 100）。 */
export function xpForLevel(level) {
  return 50 * level * (level - 1);
}

export function levelInfo(totalXp) {
  const xp = Math.max(0, totalXp);
  let level = 1;
  while (xpForLevel(level + 1) <= xp) level += 1;
  const start = xpForLevel(level);
  const next = xpForLevel(level + 1);
  return { level, xp, start, next, inLevel: xp - start, needed: next - start, progress: (xp - start) / (next - start) };
}

export function avatarFor(level) {
  return AVATAR_STAGES.filter((stage) => level >= stage.minLevel).at(-1);
}

// ---------- 帳本 ----------

export function totals(ledger) {
  let xp = 0;
  let coins = 0;
  for (const entry of ledger) {
    xp += entry.xp;
    coins += entry.coins;
  }
  return { xp: Math.max(0, xp), coins, rawXp: xp };
}

/** 說明文字上限 200 字（帳本欄位限制）。 */
function clip(text) {
  const value = String(text ?? '');
  return value.length > 200 ? `${value.slice(0, 199)}…` : value;
}

function sourceSlug(source) {
  return source.replace(/[^A-Za-z0-9_-]/g, '_');
}

/** 每個來源目前的加總：Map<source, { xp, coins, count }> */
function sumsBySource(ledger) {
  const map = new Map();
  for (const entry of ledger) {
    const row = map.get(entry.source) ?? { xp: 0, coins: 0, count: 0 };
    row.xp += entry.xp;
    row.coins += entry.coins;
    row.count += 1;
    map.set(entry.source, row);
  }
  return map;
}

/** 目前應得的獎勵：Map<source, { xp, coins, label }>（只含應得 > 0 的來源）。 */
function targets(data) {
  const map = new Map();
  for (const task of data.tasks) {
    if (task.done && !task.skipped) {
      const reward = TASK_REWARDS[task.priority];
      map.set(`task:${task.id}`, { ...reward, label: `完成任務：${task.title}（優先：${PRIORITY_LABELS[task.priority]}）` });
    }
  }
  const habitNames = new Map(data.habits.map((h) => [h.id, h.name]));
  for (const checkin of data.checkins) {
    map.set(`checkin:${checkin.id}`, { ...CHECKIN_REWARD, label: `習慣打卡：${habitNames.get(checkin.habitId) ?? '習慣'}（${checkin.date}）` });
  }
  return map;
}

/** 目前的統計數字（成就用）。 */
export function gameStats(data, todayKey) {
  return {
    tasksDone: data.tasks.filter((t) => t.done && !t.skipped).length,
    checkins: data.checkins.length,
    bestStreak: data.habits.reduce((best, habit) => Math.max(best, longestStreak(habit, data.checkins, todayKey)), 0),
    reviews: data.reviews.length,
  };
}

function nextId(base, existingIds) {
  let n = 0;
  while (existingIds.has(`${base}_${n}`)) n += 1;
  return `${base}_${n}`;
}

/**
 * 結算：依目前資料補上差額紀錄與新解鎖的成就。回傳新增的帳本紀錄（不修改 data）。
 * 遊戲化關閉時回傳空陣列。
 */
export function pendingRewards(data, todayKey, now = new Date()) {
  if (!data.settings.gameEnabled) return [];
  const timestamp = now.toISOString();
  const ids = new Set(data.ledger.map((e) => e.id));
  const sums = sumsBySource(data.ledger.filter((e) => e.kind === 'award' || e.kind === 'revoke'));
  const goals = targets(data);
  const entries = [];

  const sources = new Set([...sums.keys(), ...goals.keys()]);
  for (const source of sources) {
    const have = sums.get(source) ?? { xp: 0, coins: 0 };
    const want = goals.get(source) ?? { xp: 0, coins: 0, label: null };
    const dxp = want.xp - have.xp;
    const dcoins = want.coins - have.coins;
    if (dxp === 0 && dcoins === 0) continue;
    const id = nextId(`l_${sourceSlug(source)}`, ids);
    ids.add(id);
    const positive = dxp > 0 || dcoins > 0;
    const previousLabel = data.ledger.filter((e) => e.source === source).at(-1)?.label?.replace(/^(完成任務|習慣打卡)：/, '');
    entries.push({
      id,
      createdAt: timestamp,
      kind: positive ? 'award' : 'revoke',
      source,
      xp: dxp,
      coins: dcoins,
      label: clip(positive ? want.label : `撤銷：${previousLabel ?? source}（已取消完成、取消打卡或刪除）`),
      date: todayKey,
    });
  }

  const stats = gameStats(data, todayKey);
  for (const achievement of ACHIEVEMENTS) {
    const id = `l_ach_${achievement.id}`;
    if (ids.has(id) || stats[achievement.stat] < achievement.goal) continue;
    ids.add(id);
    entries.push({
      id,
      createdAt: timestamp,
      kind: 'achievement',
      source: `achievement:${achievement.id}`,
      xp: achievement.xp,
      coins: achievement.coins,
      label: `成就：${achievement.name}（${achievement.description}）`,
      date: todayKey,
    });
  }
  return entries;
}

/** 回傳結算後的資料（沒有變化時回傳原物件）。 */
export function reconcileRewards(data, todayKey, now = new Date()) {
  const entries = pendingRewards(data, todayKey, now);
  return entries.length ? { ...data, ledger: [...data.ledger, ...entries] } : data;
}

/** 成就狀態：[{ ...定義, unlocked, unlockedAt, value }] */
export function achievementStatus(data, todayKey) {
  const stats = gameStats(data, todayKey);
  return ACHIEVEMENTS.map((achievement) => {
    const entry = data.ledger.find((e) => e.id === `l_ach_${achievement.id}`);
    return { ...achievement, unlocked: Boolean(entry), unlockedOn: entry?.date ?? null, value: Math.min(stats[achievement.stat], achievement.goal) };
  });
}

// ---------- 獎勵商店 ----------

export function validateReward(input) {
  const errors = {};
  const name = String(input.name ?? '').trim();
  if (!name) errors.name = '請輸入獎勵名稱。';
  else if (name.length > 100) errors.name = '名稱最多 100 字。';
  const cost = Number(String(input.cost ?? '').trim());
  if (!Number.isInteger(cost) || cost < 1 || cost > 1000000) errors.cost = '金幣需為 1～1,000,000 的整數。';
  const icon = String(input.icon ?? '🎁').trim() || '🎁';
  if (icon.length > 8) errors.icon = '圖示太長。';
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { name, cost, icon } };
}

export function createReward(value, now = new Date()) {
  const timestamp = now.toISOString();
  return { id: createId('rw'), ...value, archived: false, createdAt: timestamp, updatedAt: timestamp };
}

/**
 * 兌換獎勵：餘額（金幣）需大於或等於所需金幣。回傳 { ok, data, entry } 或 { ok: false, error }。
 */
export function redeemReward(data, rewardId, todayKey, now = new Date()) {
  const reward = data.rewards.find((r) => r.id === rewardId && !r.archived);
  if (!reward) return { ok: false, error: '找不到這個獎勵。' };
  const { coins } = totals(data.ledger);
  if (coins < reward.cost) return { ok: false, error: `金幣不足：需要 ${reward.cost}，目前 ${coins}。` };
  const entry = {
    id: createId('l_rd'),
    createdAt: now.toISOString(),
    kind: 'redeem',
    source: `reward:${reward.id}`,
    xp: 0,
    coins: -reward.cost,
    label: clip(`兌換：${reward.icon} ${reward.name}`),
    date: todayKey,
  };
  return { ok: true, data: { ...data, ledger: [...data.ledger, entry] }, entry };
}

export function refundId(redeemId) {
  return `l_rf_${redeemId}`;
}

export function isRefunded(ledger, redeemId) {
  return ledger.some((e) => e.id === refundId(redeemId));
}

/** 退回一次兌換（每筆只能退回一次）。 */
export function refundRedemption(data, redeemId, todayKey, now = new Date()) {
  const entry = data.ledger.find((e) => e.id === redeemId && e.kind === 'redeem');
  if (!entry) return { ok: false, error: '找不到這筆兌換紀錄。' };
  if (isRefunded(data.ledger, redeemId)) return { ok: false, error: '這筆兌換已經退回過了。' };
  const refund = {
    id: refundId(redeemId),
    createdAt: now.toISOString(),
    kind: 'refund',
    source: `refund:${redeemId}`,
    xp: 0,
    coins: -entry.coins,
    label: `退回：${entry.label.replace(/^兌換：/, '')}`,
    date: todayKey,
  };
  return { ok: true, data: { ...data, ledger: [...data.ledger, refund] } };
}

/** 帳本依時間新到舊。 */
export function ledgerHistory(ledger) {
  return ledger.slice().sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1));
}
