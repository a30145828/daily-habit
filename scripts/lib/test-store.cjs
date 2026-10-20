// 瀏覽器檢查共用：在頁面中讀寫網站實際使用的儲存區。
// 用法：await context.addInitScript(TEST_STORE)，之後以 storeGet／storeSet／storeKeys 讀寫。

/** 注入頁面：網站使用大容量儲存（IndexedDB）時讀寫它，否則讀寫 localStorage。讀取前先等背景寫入完成。 */
function TEST_STORE() {
  const openDb = () =>
    new Promise((resolve, reject) => {
      const request = indexedDB.open('daily-habit', 1);
      request.onupgradeneeded = () => {
        for (const name of ['kv', 'meta']) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  const run = async (mode, fn) => {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('kv', mode);
        const request = fn(tx.objectStore('kv'));
        tx.oncomplete = () => resolve(request.result);
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  };
  const idb = () => window.dailyHabitStorage?.backend === 'indexeddb';
  window.__testStore = {
    async get(key) {
      await window.dailyHabitStorage?.flush();
      return idb() ? ((await run('readonly', (store) => store.get(key))) ?? null) : localStorage.getItem(key);
    },
    async set(key, value) {
      await window.dailyHabitStorage?.flush();
      if (idb()) await run('readwrite', (store) => store.put(value, key));
      else localStorage.setItem(key, value);
    },
    async keys() {
      await window.dailyHabitStorage?.flush();
      return idb() ? run('readonly', (store) => store.getAllKeys()) : Object.keys(localStorage);
    },
  };
}
const storeGet = (page, key) => page.evaluate((k) => window.__testStore.get(k), key);
const storeSet = (page, key, value) => page.evaluate(([k, v]) => window.__testStore.set(k, v), [key, value]);
const storeKeys = (page) => page.evaluate(() => window.__testStore.keys());

module.exports = { TEST_STORE, storeGet, storeSet, storeKeys };
