// 程式進入點：讀取資料、設定儲存方式、路由（網址 #區域）、日期更新與跨分頁同步。
// 各區域的畫面在 js/ui/ 底下。

import { msUntilNextMidnight } from './dates.js';
import { CURRENT_VERSION } from './schema.js';
import { STORAGE_KEY, loadData, saveData } from './storage.js';
import {
  VIEWS,
  $,
  addNotice,
  app,
  checkDateChange,
  focusHeading,
  focusPending,
  registerView,
  render,
  setupDialogs,
  showToast,
} from './ui/core.js';
import { installAccount } from './ui/account-view.js';
import { renderFinance } from './ui/finance-view.js';
import { installGame, settleRewards } from './ui/game-view.js';
import { openAppStorage } from './ui/idb-storage.js';
import { renderGrowth } from './ui/growth-view.js';
import { renderHabits } from './ui/habits-view.js';
import { installPwa } from './ui/pwa-view.js';
import { checkStorageUsage, renderRecovery, renderSettings } from './ui/settings-view.js';
import { installSubscriptionExtensions } from './ui/subscriptions-view.js';
import { renderTasks } from './ui/tasks-view.js';
import { renderToday } from './ui/today-view.js';

registerView('today', renderToday);
registerView('tasks', renderTasks);
registerView('habits', renderHabits);
registerView('finance', renderFinance);
installSubscriptionExtensions();
installGame();
installPwa();
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

/** 從儲存區重新讀取目前的資料並重新繪製。 */
function reloadCurrent(message) {
  const result = loadData(app.storage, new Date(), app.storageKey);
  if (result.status === 'corrupt') {
    app.mode = 'recovery';
    app.corrupt = { raw: result.raw, errors: result.errors };
  } else {
    app.mode = 'normal';
    app.corrupt = null;
    app.data = result.data;
    if (message) showToast(message);
  }
  render();
}

function handleStorageEvent(event) {
  // 改用大容量儲存後，舊的 localStorage 發出的事件不代表目前的資料
  if (event.storageArea && event.storageArea !== app.storage) return;
  if (app.mode === 'memory' || (event.key !== app.storageKey && event.key !== null)) return;
  reloadCurrent('已同步其他分頁的變更。');
}

/** 背景寫入失敗：變更已還原成上次成功保存的內容。 */
function handleWriteError(keys, error) {
  const quota = error?.name === 'QuotaExceededError';
  addNotice(
    quota
      ? '瀏覽器儲存空間已滿，最近的變更沒有保存。請先匯出備份並清理瀏覽器資料。'
      : '無法寫入瀏覽器儲存空間，最近的變更沒有保存。請重新整理頁面後再試。',
    'error',
    { key: 'storage-write' },
  );
  if (app.mode !== 'memory' && keys.includes(app.storageKey)) reloadCurrent();
}

/** 其他分頁修改了大容量儲存區的資料：轉成與 localStorage 相同的 storage 事件。 */
function handleExternalChange(key, oldValue, newValue) {
  window.dispatchEvent(new StorageEvent('storage', { key, oldValue, newValue, url: location.href }));
}

// ---------- 啟動 ----------

/** 啟動前的額外步驟（例如帳號登入狀態），由其他模組登記：async () => void */
export const startupHooks = [];
installAccount({ loadFrom, startupHooks });

async function init() {
  if (typeof HTMLDialogElement !== 'function') {
    addNotice('你的瀏覽器版本較舊，對話框可能無法使用，建議更新瀏覽器。', 'error');
  }
  const opened = await openAppStorage({ onError: handleWriteError, onExternalChange: handleExternalChange });
  app.storage = opened.storage;
  app.storageBackend = opened.backend;
  for (const notice of opened.notices) addNotice(notice.text, notice.type, { key: `storage-open-${notice.type}` });
  loadFrom(STORAGE_KEY);
  setupDialogs();
  setupDateWatch();
  window.addEventListener('hashchange', () => setView(viewFromHash(), true));
  window.addEventListener('storage', handleStorageEvent);
  app.view = viewFromHash();
  for (const hook of startupHooks) await hook();
  $('boot-message')?.remove();
  render();
  settleRewards();
  await checkStorageUsage();
}

init();
