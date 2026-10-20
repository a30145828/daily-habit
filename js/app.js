// 程式進入點：讀取資料、設定儲存方式、路由（網址 #區域）、日期更新與跨分頁同步。
// 各區域的畫面在 js/ui/ 底下。

import { msUntilNextMidnight } from './dates.js';
import { CURRENT_VERSION } from './schema.js';
import { STORAGE_KEY, getBrowserStorage, loadData, saveData } from './storage.js';
import {
  VIEWS,
  $,
  addNotice,
  app,
  checkDateChange,
  focusHeading,
  focusPending,
  h,
  heading,
  registerView,
  render,
  replaceChildren,
  setupDialogs,
  showToast,
} from './ui/core.js';
import { renderGrowth } from './ui/growth-view.js';
import { renderHabits } from './ui/habits-view.js';
import { renderRecovery, renderSettings } from './ui/settings-view.js';
import { renderTasks } from './ui/tasks-view.js';
import { renderToday } from './ui/today-view.js';

function placeholder(view, title, text) {
  return (panel) => replaceChildren(panel, heading(view, title), h('div', { class: 'empty-state' }, h('p', { class: 'empty-title' }, '開發中'), h('p', {}, text)));
}

registerView('today', renderToday);
registerView('tasks', renderTasks);
registerView('habits', renderHabits);
registerView('finance', placeholder('finance', '財務', '個人財務與訂閱中心將在下一階段加入。'));
registerView('growth', renderGrowth);
registerView('settings', renderSettings);
registerView('recovery', renderRecovery);

/** 讀取指定位置的資料，並設定對應的儲存方式。 */
export function loadFrom(key) {
  app.storageKey = key;
  const result = loadData(app.storage, new Date(), key);
  if (result.status === 'unavailable') {
    app.mode = 'memory';
    app.persist = () => ({ ok: true });
    addNotice(
      '瀏覽器目前不允許儲存資料（可能是隱私設定或無痕模式）。你仍可以使用，但關閉頁面後資料會消失，請記得用「匯出備份」保存。',
      'warning',
      { dismissible: false, key: 'storage' },
    );
    app.data = result.data;
    return result;
  }
  app.persist = (nextData) => saveData(app.storage, nextData, new Date(), app.storageKey);
  if (result.status === 'corrupt') {
    app.mode = 'recovery';
    app.corrupt = { raw: result.raw, errors: result.errors };
    return result;
  }
  app.mode = 'normal';
  app.corrupt = null;
  app.data = result.data;
  for (const warning of result.warnings ?? []) addNotice(warning, 'info');
  if (result.migratedFrom && result.migratedFrom !== CURRENT_VERSION) {
    addNotice(
      `已將資料從版本 ${result.migratedFrom} 升級為版本 ${CURRENT_VERSION}（新增標籤、子任務、重複任務、財務與成長等功能）。升級前的原始資料已另存一份。`,
      'success',
      { key: 'migrated' },
    );
  }
  return result;
}

function viewFromHash() {
  const view = location.hash.replace('#', '');
  return VIEWS.includes(view) ? view : 'today';
}

function setView(view, moveFocus) {
  app.view = view;
  render();
  if (moveFocus) {
    window.scrollTo(0, 0);
    if (!focusPending()) focusHeading();
  }
}

// ---------- 日期更新 ----------

let midnightTimer = null;

function scheduleMidnight() {
  clearTimeout(midnightTimer);
  midnightTimer = setTimeout(() => {
    checkDateChange();
    scheduleMidnight();
  }, msUntilNextMidnight() + 500);
}

function setupDateWatch() {
  scheduleMidnight();
  setInterval(checkDateChange, 60 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      checkDateChange();
      scheduleMidnight();
    }
  });
  window.addEventListener('focus', checkDateChange);
}

// ---------- 跨分頁 ----------

function handleStorageEvent(event) {
  if (app.mode === 'memory' || (event.key !== app.storageKey && event.key !== null)) return;
  const result = loadData(app.storage, new Date(), app.storageKey);
  if (result.status === 'corrupt') {
    app.mode = 'recovery';
    app.corrupt = { raw: result.raw, errors: result.errors };
  } else {
    app.mode = 'normal';
    app.corrupt = null;
    app.data = result.data;
    showToast('已同步其他分頁的變更。');
  }
  render();
}

// ---------- 啟動 ----------

/** 啟動前的額外步驟（例如帳號登入狀態），由其他模組登記：async () => void */
export const startupHooks = [];

async function init() {
  if (typeof HTMLDialogElement !== 'function') {
    addNotice('你的瀏覽器版本較舊，對話框可能無法使用，建議更新瀏覽器。', 'error');
  }
  app.storage = getBrowserStorage();
  loadFrom(STORAGE_KEY);
  setupDialogs();
  setupDateWatch();
  window.addEventListener('hashchange', () => setView(viewFromHash(), true));
  window.addEventListener('storage', handleStorageEvent);
  app.view = viewFromHash();
  for (const hook of startupHooks) await hook();
  $('boot-message')?.remove();
  render();
}

init();
