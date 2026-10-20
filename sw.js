// 離線快取（service worker）：讓網站在沒有網路時也能開啟。
// 策略：網站本身的檔案「先連網路、失敗才用快取」，所以有網路時永遠拿到最新版，
// 不需要每次發布都改版本號；離線時使用上次成功下載的版本。
// 程式與樣式檔一律向伺服器確認是否有新版（cache: 'no-cache'），避免瀏覽器沿用
// GitHub Pages 約 10 分鐘的暫存，造成剛發布後看不到新功能或新舊檔案混用。
// 雲端同步（Supabase，不同網域）的請求不經過快取。
// 新增或改名網站檔案時，請同步更新 APP_SHELL（tests/pwa.test.js 會檢查是否遺漏）。

const CACHE = 'daily-habit-app-v2';

const APP_SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/style.css',
  'js/app.js',
  'js/backup.js',
  'js/config.js',
  'js/csv.js',
  'js/dates.js',
  'js/dom.js',
  'js/finance.js',
  'js/game.js',
  'js/habits.js',
  'js/ids.js',
  'js/money.js',
  'js/recurrence.js',
  'js/review.js',
  'js/sample.js',
  'js/schema.js',
  'js/storage.js',
  'js/subscriptions.js',
  'js/tasks.js',
  'js/cloud/api.js',
  'js/cloud/sync.js',
  'js/ui/account-view.js',
  'js/ui/core.js',
  'js/ui/finance-view.js',
  'js/ui/game-view.js',
  'js/ui/growth-view.js',
  'js/ui/habits-view.js',
  'js/ui/pwa-view.js',
  'js/ui/settings-view.js',
  'js/ui/subscriptions-view.js',
  'js/ui/tasks-view.js',
  'js/ui/today-view.js',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(APP_SHELL.map((url) => new Request(url, { cache: 'no-cache' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith('daily-habit-') && key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // 雲端 API 等外部請求不快取

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        const response = await fetch(request.mode === 'navigate' ? request : new Request(request.url, { cache: 'no-cache' }));
        if (response.ok && response.type === 'basic') cache.put(request, response.clone());
        return response;
      } catch (error) {
        const cached = await cache.match(request, { ignoreSearch: request.mode === 'navigate' });
        if (cached) return cached;
        if (request.mode === 'navigate') {
          const shell = (await cache.match('index.html')) || (await cache.match('./'));
          if (shell) return shell;
        }
        throw error;
      }
    })(),
  );
});
