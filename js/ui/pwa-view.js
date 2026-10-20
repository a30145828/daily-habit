// 安裝到主畫面與離線使用：註冊 service worker（sw.js），並在設定頁提供安裝說明。
// 推播通知目前不提供（只有站內提醒），避免宣稱所有裝置都能準時通知。

import { app, button, card, h, render } from './core.js';
import { registerSettingsExtension } from './settings-view.js';

const pwa = { installPrompt: null, registered: false, error: '' };

function isStandalone() {
  return window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function isIos() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

async function install() {
  const prompt = pwa.installPrompt;
  if (!prompt) return;
  pwa.installPrompt = null;
  await prompt.prompt();
  render();
}

export function installPwa() {
  const secure = location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname);
  if ('serviceWorker' in navigator && secure) {
    navigator.serviceWorker
      .register('./sw.js')
      .then(() => {
        pwa.registered = true;
      })
      .catch(() => {
        pwa.error = '離線功能無法啟用（瀏覽器拒絕註冊）。網站仍可正常使用。';
      });
  }
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    pwa.installPrompt = event;
    if (app.view === 'settings') render();
  });
  window.addEventListener('appinstalled', () => {
    pwa.installPrompt = null;
    if (app.view === 'settings') render();
  });

  registerSettingsExtension({
    order: 60,
    render: () =>
      card(
        'settings-install',
        '安裝到主畫面與離線使用',
        isStandalone()
          ? h('p', {}, '✓ 你正在使用已安裝的版本。')
          : pwa.installPrompt
            ? [h('p', {}, '可以把這個網站安裝到主畫面或桌面，像 App 一樣開啟。'), button('安裝到主畫面', install, { variant: 'primary', focusKey: 'pwa-install' })]
            : isIos()
              ? h('p', {}, 'iPhone／iPad：請用 Safari 開啟本網站，按下方的「分享」按鈕，再選「加入主畫面」。')
              : h('p', {}, '如果瀏覽器支援，網址列或選單會出現「安裝」或「加到主畫面」的選項（Chrome、Edge、Android 版 Chrome 支援）。'),
        h(
          'ul',
          { class: 'bullets small' },
          h('li', {}, '開啟過一次之後，沒有網路也能開啟網站並使用；資料原本就存在這台裝置。'),
          h('li', {}, '已登入時，離線期間的變更會排入待同步，恢復連線後自動上傳。'),
          h('li', {}, '提醒目前只顯示在網站內（今日頁）；本工具尚未提供推播通知，請不要依賴它在固定時間通知你。'),
        ),
        pwa.error ? h('p', { class: 'small notice notice--warning' }, pwa.error) : null,
      ),
  });
}
