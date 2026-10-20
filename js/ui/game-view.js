// 遊戲化畫面：角色成長、成就、獎勵商店、獎勵紀錄；以及今日摘要、設定開關、儲存時的獎勵結算。

import {
  KIND_LABELS,
  achievementStatus,
  avatarFor,
  createReward,
  isRefunded,
  ledgerHistory,
  levelInfo,
  reconcileRewards,
  redeemReward,
  refundRedemption,
  totals,
  validateReward,
  CHECKIN_REWARD,
  TASK_REWARDS,
} from '../game.js';
import { formatDateLabel } from '../dates.js';
import {
  addNotice,
  app,
  button,
  card,
  commit,
  confirmAction,
  emptyState,
  h,
  inputField,
  openFormDialog,
  render,
} from './core.js';
import { registerGrowthExtension } from './growth-view.js';
import { registerSettingsExtension } from './settings-view.js';
import { registerTodayExtension, summaryItem } from './today-view.js';

const state = () => (app.ui.game ??= { historyLimit: 20, lastLevel: null, celebrate: false });

function enabled() {
  return app.data.settings.gameEnabled;
}

function setEnabled(value) {
  const settings = { ...app.data.settings, gameEnabled: value, updatedAt: new Date().toISOString() };
  commit(
    { ...app.data, settings },
    value ? '已開啟遊戲化；關閉期間的完成紀錄已依目前狀態補算。' : '已關閉遊戲化。任務、習慣與財務功能不受影響。',
  );
}

function signed(n) {
  return n > 0 ? `+${n}` : String(n);
}

// ---------- 獎勵商店 ----------

function openRewardDialog(reward = null) {
  openFormDialog({
    title: reward ? '編輯獎勵' : '新增獎勵',
    body: () =>
      h(
        'div',
        {},
        inputField({ id: 'reward-name', label: '獎勵名稱', required: true, value: reward?.name ?? '', attrs: { maxlength: '100', placeholder: '例如：看一集喜歡的影集' } }),
        inputField({ id: 'reward-cost', label: '需要的金幣', type: 'number', required: true, value: reward?.cost ?? 50, attrs: { min: '1', inputmode: 'numeric' } }),
        inputField({ id: 'reward-icon', label: '圖示（一個表情符號）', value: reward?.icon ?? '🎁', attrs: { maxlength: '8' } }),
        h('p', { class: 'small muted' }, '金幣是遊戲點數，與財務模組的真實金額完全分開；兌換只是記錄你給自己的獎勵。'),
      ),
    onSubmit: (form) => {
      const result = validateReward({ name: form.elements['reward-name'].value, cost: form.elements['reward-cost'].value, icon: form.elements['reward-icon'].value });
      if (!result.ok) return Object.fromEntries(Object.entries(result.errors).map(([k, v]) => [`reward-${k}`, v]));
      if (reward) {
        const rewards = app.data.rewards.map((r) => (r.id === reward.id ? { ...r, ...result.value, updatedAt: new Date().toISOString() } : r));
        return commit({ ...app.data, rewards }, '已儲存獎勵。');
      }
      return commit({ ...app.data, rewards: [...app.data.rewards, createReward(result.value)] }, `已新增獎勵「${result.value.name}」。`);
    },
  });
}

async function redeem(reward) {
  const ok = await confirmAction({
    title: '兌換獎勵',
    message: `用 ${reward.cost} 金幣兌換「${reward.icon} ${reward.name}」？\n兌換後可以在獎勵紀錄中退回一次。`,
    confirmText: '兌換',
  });
  if (!ok) return;
  const result = redeemReward(app.data, reward.id, app.todayKey);
  if (!result.ok) return addNotice(result.error, 'warning', { key: 'redeem' });
  commit(result.data, `已兌換「${reward.name}」，好好享受！`);
}

async function refund(entry) {
  const ok = await confirmAction({ title: '退回兌換', message: `退回「${entry.label.replace(/^兌換：/, '')}」並歸還 ${-entry.coins} 金幣？每筆兌換只能退回一次。`, confirmText: '退回' });
  if (!ok) return;
  const result = refundRedemption(app.data, entry.id, app.todayKey);
  if (!result.ok) return addNotice(result.error, 'warning', { key: 'refund' });
  commit(result.data, '已退回兌換，金幣已歸還。');
}

// ---------- 區塊 ----------

function characterCard() {
  const s = state();
  const t = totals(app.data.ledger);
  const info = levelInfo(t.xp);
  const avatar = avatarFor(info.level);
  const achievements = achievementStatus(app.data, app.todayKey);
  const celebrate = s.lastLevel !== null && info.level > s.lastLevel;
  s.lastLevel = info.level;
  return card(
    'game-character',
    '角色成長',
    h(
      'div',
      { class: 'character' },
      h(
        'div',
        { class: `avatar${celebrate ? ' level-up' : ''}`, style: `--progress: ${Math.round(info.progress * 100)}%`, 'aria-hidden': 'true' },
        h('span', { class: 'avatar-icon' }, avatar.icon),
      ),
      h(
        'div',
        { class: 'character-info' },
        h('p', { class: 'character-level' }, `Lv.${info.level}`, h('span', { class: 'muted' }, `・${avatar.name}`)),
        h('progress', { max: String(info.needed), value: String(info.inLevel), 'aria-label': `升級進度 ${Math.round(info.progress * 100)}%` }),
        h('p', { class: 'small' }, `本級 ${info.inLevel} / ${info.needed} 經驗值，再 ${info.needed - info.inLevel} 點升到 Lv.${info.level + 1}`),
      ),
    ),
    h(
      'ul',
      { class: 'summary', 'aria-label': '角色數值' },
      summaryItem('累積經驗值', `${t.xp}`),
      summaryItem('金幣', `🪙 ${t.coins}`, { tone: t.coins < 0 ? 'alert' : '' }),
      summaryItem('成就', `${achievements.filter((a) => a.unlocked).length} / ${achievements.length}`),
    ),
    t.coins < 0 ? h('p', { class: 'small notice notice--warning' }, '金幣為負數：有已領取的獎勵被撤銷（例如取消完成）。負數期間不能兌換，完成任務或打卡後會回升。') : null,
    celebrate ? h('p', { class: 'notice notice--success', role: 'status' }, `🎉 升級到 Lv.${info.level}！`) : null,
  );
}

function achievementsCard() {
  const list = achievementStatus(app.data, app.todayKey);
  return card(
    'game-achievements',
    '成就',
    h(
      'ul',
      { class: 'achievement-list' },
      list.map((a) =>
        h(
          'li',
          { class: `achievement${a.unlocked ? ' is-unlocked' : ''}` },
          h('span', { class: 'achievement-icon', 'aria-hidden': 'true' }, a.unlocked ? a.icon : '🔒'),
          h(
            'div',
            {},
            h('p', { class: 'achievement-name' }, a.name, h('span', { class: 'badge badge--muted' }, a.type)),
            h('p', { class: 'small muted' }, a.description, `（+${a.xp} 經驗值、+${a.coins} 金幣）`),
            h('p', { class: 'small' }, a.unlocked ? `✓ 已解鎖（${formatDateLabel(a.unlockedOn)}）` : `未解鎖・進度 ${a.value} / ${a.goal}`),
          ),
        ),
      ),
    ),
  );
}

function shopCard() {
  const coins = totals(app.data.ledger).coins;
  const rewards = app.data.rewards.filter((r) => !r.archived);
  const archived = app.data.rewards.filter((r) => r.archived);
  const rewardRow = (reward) => {
    const affordable = coins >= reward.cost;
    return h(
      'li',
      { class: `reward${reward.archived ? ' is-archived' : ''}` },
      h('span', { class: 'achievement-icon', 'aria-hidden': 'true' }, reward.icon),
      h('div', { class: 'reward-main' }, h('p', { class: 'achievement-name' }, reward.name), h('p', { class: 'small' }, `🪙 ${reward.cost} 金幣${!reward.archived && !affordable ? `（還差 ${reward.cost - coins}）` : ''}`)),
      h(
        'div',
        { class: 'todo-actions' },
        reward.archived
          ? null
          : button('兌換', () => redeem(reward), { variant: 'primary', size: 'small', disabled: !affordable, focusKey: `redeem-${reward.id}`, label: `用 ${reward.cost} 金幣兌換「${reward.name}」${affordable ? '' : '（金幣不足）'}` }),
        button('編輯', () => openRewardDialog(reward), { variant: 'ghost', size: 'small', focusKey: `reward-edit-${reward.id}`, label: `編輯獎勵「${reward.name}」` }),
        button(
          reward.archived ? '取消封存' : '封存',
          () => commit({ ...app.data, rewards: app.data.rewards.map((r) => (r.id === reward.id ? { ...r, archived: !r.archived, updatedAt: new Date().toISOString() } : r)) }),
          { variant: 'ghost', size: 'small', focusKey: `reward-archive-${reward.id}`, label: `${reward.archived ? '取消封存' : '封存'}獎勵「${reward.name}」` },
        ),
      ),
    );
  };
  return card(
    'game-shop',
    '獎勵商店',
    h('p', { class: 'small muted' }, `目前有 🪙 ${coins} 金幣。自訂給自己的獎勵，用完成任務與習慣得到的金幣兌換；金幣與真實金錢無關。`),
    button('＋ 新增獎勵', () => openRewardDialog(), { size: 'small', focusKey: 'reward-add' }),
    rewards.length ? h('ul', { class: 'reward-list' }, rewards.map(rewardRow)) : emptyState('還沒有獎勵', '例如：看一集影集（50 金幣）、買一杯手搖飲（120 金幣）。'),
    archived.length ? h('details', { class: 'method' }, h('summary', {}, `已封存的獎勵（${archived.length}）`), h('ul', { class: 'reward-list' }, archived.map(rewardRow))) : null,
  );
}

function historyCard() {
  const s = state();
  const history = ledgerHistory(app.data.ledger);
  const shown = history.slice(0, s.historyLimit);
  return card(
    'game-history',
    '獎勵紀錄',
    h('p', { class: 'small muted' }, '每一筆經驗值與金幣的變動都會留下紀錄，包含獲得、撤銷、成就、兌換與退回。'),
    shown.length
      ? h(
          'ul',
          { class: 'ledger-list' },
          shown.map((entry) =>
            h(
              'li',
              { class: `ledger ledger--${entry.kind}` },
              h('span', { class: 'badge ledger-kind' }, KIND_LABELS[entry.kind]),
              h('div', { class: 'ledger-main' }, h('p', {}, entry.label), h('p', { class: 'small muted' }, formatDateLabel(entry.date))),
              h('p', { class: 'ledger-delta' }, entry.xp ? `${signed(entry.xp)} 經驗` : '', entry.xp && entry.coins ? '・' : '', entry.coins ? `${signed(entry.coins)} 金幣` : ''),
              entry.kind === 'redeem'
                ? h(
                    'div',
                    { class: 'ledger-action' },
                    isRefunded(app.data.ledger, entry.id)
                      ? h('span', { class: 'small muted' }, '已退回')
                      : button('退回', () => refund(entry), { variant: 'ghost', size: 'small', focusKey: `refund-${entry.id}`, label: `退回兌換：${entry.label}` }),
                  )
                : null,
            ),
          ),
        )
      : h('p', { class: 'muted' }, '還沒有紀錄。完成任務或習慣打卡就會獲得經驗值與金幣。'),
    history.length > shown.length
      ? button(`顯示更多（還有 ${history.length - shown.length} 筆）`, () => ((s.historyLimit += 50), render()), { variant: 'ghost', size: 'small', focusKey: 'history-more' })
      : null,
    h(
      'details',
      { class: 'method' },
      h('summary', {}, '獎勵規則'),
      h(
        'ul',
        { class: 'bullets small' },
        h('li', {}, `完成任務：優先程度高 +${TASK_REWARDS.high.xp} 經驗、+${TASK_REWARDS.high.coins} 金幣；中 +${TASK_REWARDS.medium.xp}、+${TASK_REWARDS.medium.coins}；低 +${TASK_REWARDS.low.xp}、+${TASK_REWARDS.low.coins}。`),
        h('li', {}, `習慣打卡（含補登）：每個習慣每天 +${CHECKIN_REWARD.xp} 經驗、+${CHECKIN_REWARD.coins} 金幣。`),
        h('li', {}, '同一個任務、同一天的打卡只會給一份獎勵。取消完成、取消打卡或刪除時會撤銷；重新完成會再給回，但加總永遠最多一份，不能反覆領取。'),
        h('li', {}, '修改優先程度時會補上差額。'),
        h('li', {}, '撤銷後金幣可能變成負數：照實顯示，負數或不足時不能兌換；已兌換的獎勵不會被收回。'),
        h('li', {}, '成就達成時給一次獎勵，之後永久保留，不會重複領取，也不會因為取消完成而撤銷。'),
        h('li', {}, '每筆兌換可以退回一次，退回後金幣歸還。'),
        h('li', {}, '關閉遊戲化時不計算獎勵；重新開啟時會依當下的完成狀態一次補齊。'),
      ),
    ),
  );
}

function disabledCard() {
  return card(
    'game-off',
    '遊戲化已關閉',
    h('p', {}, '開啟後，完成任務與習慣可以獲得經驗值與金幣、升級角色、解鎖成就，並兌換自訂的獎勵。'),
    button('開啟遊戲化', () => setEnabled(true), { variant: 'primary', focusKey: 'game-enable' }),
  );
}

/** 登記遊戲化的結算、提示與各頁區塊（由 app.js 啟動時呼叫）。 */
export function installGame() {
  app.transforms.push((next) => reconcileRewards(next, app.todayKey));
  app.afterCommit.push((prev, next) => {
    if (!next.settings.gameEnabled || next.ledger.length === prev.ledger.length) return null;
    const added = next.ledger.slice(prev.ledger.length).filter((e) => e.kind === 'award' || e.kind === 'revoke' || e.kind === 'achievement');
    if (!added.length) return null;
    const xp = added.reduce((sum, e) => sum + e.xp, 0);
    const coins = added.reduce((sum, e) => sum + e.coins, 0);
    const before = levelInfo(totals(prev.ledger).xp).level;
    const after = levelInfo(totals(next.ledger).xp).level;
    const parts = [`${signed(xp)} 經驗值、${signed(coins)} 金幣`];
    for (const entry of added.filter((e) => e.kind === 'achievement')) parts.push(`🏅 解鎖${entry.label.split('（')[0]}`);
    if (after > before) parts.push(`🎉 升級到 Lv.${after}`);
    return `（${parts.join('；')}）`;
  });

  registerGrowthExtension(() => (enabled() ? [characterCard(), achievementsCard(), shopCard(), historyCard()] : [disabledCard()]));

  registerTodayExtension({
    order: 20,
    summary: () => {
      if (!enabled()) return null;
      const t = totals(app.data.ledger);
      return summaryItem('角色', `Lv.${levelInfo(t.xp).level}・🪙${t.coins}`, { href: '#growth' });
    },
  });

  registerSettingsExtension({
    order: 56,
    render: () =>
      h(
        'div',
        { class: 'pref-row' },
        h(
          'label',
          { class: 'checkbox-label' },
          h('input', { type: 'checkbox', checked: enabled(), dataset: { focusKey: 'game-toggle' }, onChange: (event) => setEnabled(event.target.checked) }),
          h('span', {}, '開啟遊戲化（經驗值、金幣、等級、成就、獎勵商店）'),
        ),
        h('p', { class: 'small muted' }, '關閉後隱藏遊戲化畫面並暫停計算獎勵，任務、習慣與財務功能完全不受影響；已有的紀錄會保留。'),
      ),
  });
}

/** 載入或同步資料後補做一次結算（例如從舊版升級、其他裝置的變更）。回傳是否有變更。 */
export function settleRewards() {
  if (app.mode === 'recovery') return false;
  const next = reconcileRewards(app.data, app.todayKey);
  if (next === app.data) return false;
  return commit(next);
}
