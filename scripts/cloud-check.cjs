// 雲端同步端到端檢查（開發用）。需要本機的 Supabase 相容環境（見 scripts/dev/README.md）與 Playwright。
// 用法：
//   BASE_URL=http://localhost:8765/daily-habit/ SUPABASE_URL=http://localhost:54321 SUPABASE_ANON_KEY=... \
//   MAIL_DIR=/tmp/dhstack/mail node scripts/cloud-check.cjs [截圖資料夾]
// 選用 PWA_URL：另一份已在 js/config.js 填好測試環境設定的網站網址，用來測試「安裝版離線 + 同步」（service worker 不經過攔截）。
// 透過攔截 js/config.js 指向測試環境，不需要修改程式碼；每個帳號都是新註冊的測試帳號。
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'daily-habit-cloud-'));
fs.mkdirSync(OUT, { recursive: true });
const URL = process.env.BASE_URL || 'http://localhost:8765/daily-habit/';
const SB_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
const SB_KEY = process.env.SUPABASE_ANON_KEY;
const MAIL_DIR = process.env.MAIL_DIR || '/tmp/dhstack/mail';
const RUN = Date.now().toString(36);
const PASSWORD = 'test-password-123';

let failures = 0;
let passes = 0;
function check(cond, msg) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`);
  if (cond) passes += 1;
  else failures += 1;
}
async function vis(loc, timeout = 8000) {
  try {
    await loc.first().waitFor({ state: 'visible', timeout });
    return true;
  } catch {
    return false;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 讀取最新一封寄給 email 的信中的驗證連結（解開 quoted-printable）。 */
async function mailLink(email, after) {
  for (let i = 0; i < 40; i++) {
    const files = fs.readdirSync(MAIL_DIR).map((f) => path.join(MAIL_DIR, f)).filter((f) => fs.statSync(f).mtimeMs >= after).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    for (const file of files) {
      const raw = fs.readFileSync(file, 'utf8');
      if (!raw.split('\r\n', 1)[0].includes(email)) continue;
      const body = raw.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
      const match = body.match(/https?:\/\/[^"\s<>]*\/verify\?[^"\s<>]*/);
      if (match) return match[0].replace(/&amp;/g, '&');
    }
    await sleep(250);
  }
  return null;
}

async function device(browser, name, { mobile = true } = {}) {
  const ctx = await browser.newContext({
    viewport: mobile ? { width: 375, height: 812 } : { width: 1280, height: 900 },
    isMobile: mobile,
    hasTouch: mobile,
    timezoneId: 'Asia/Taipei',
    locale: 'zh-TW',
    // 以攔截 config.js 的方式指定測試環境；service worker 的請求不一定經過攔截，因此這裡關閉。
    serviceWorkers: 'block',
  });
  await ctx.route('**/js/config.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: `export const SUPABASE_URL = ${JSON.stringify(SB_URL)};\nexport const SUPABASE_ANON_KEY = ${JSON.stringify(SB_KEY)};\n` }),
  );
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => d.dismiss());
  await page.goto(URL);
  await page.waitForSelector('.view:not([hidden]) h2');
  const go = async (view) => {
    await page.evaluate((v) => (location.hash = v), `#${view}`);
    await page.waitForSelector(`#view-${view}:not([hidden]) h2`);
  };
  const status = () => page.locator('#status-bar').innerText();
  const waitStatus = async (re, timeout = 15000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (re.test(await status())) return true;
      await sleep(200);
    }
    return false;
  };
  const local = (key) => page.evaluate((k) => localStorage.getItem(k), key);
  const keys = () => page.evaluate(() => Object.keys(localStorage));
  /** 本機變更後：等待自動上傳（變更會合併 1 秒後上傳）完成。 */
  const settle = async () => {
    await sleep(1500);
    return waitStatus(/已同步|衝突|失敗|離線/);
  };
  const syncNow = async () => {
    await go('settings');
    await page.getByRole('button', { name: '立即同步' }).click();
    await waitStatus(/已同步|衝突|失敗/);
  };
  const shot = (n) => page.screenshot({ path: path.join(OUT, `${name}-${n}.png`), fullPage: true });
  return { name, ctx, page, errors, go, status, waitStatus, settle, local, keys, syncNow, shot };
}

async function signUp(d, email) {
  await d.go('settings');
  await d.page.locator('.segmented label', { hasText: '註冊' }).click();
  await d.page.fill('#auth-email', email);
  await d.page.fill('#auth-password', PASSWORD);
  await d.page.fill('#auth-password2', PASSWORD);
  const before = Date.now() - 1000;
  await d.page.getByRole('button', { name: '註冊', exact: true }).click();
  const sent = await vis(d.page.getByText(`已寄出驗證信到 ${email}`));
  const link = await mailLink(email, before);
  return { sent, link };
}

async function signIn(d, email, password = PASSWORD) {
  await d.go('settings');
  await d.page.locator('.segmented label', { hasText: '登入' }).first().click();
  await d.page.fill('#auth-email', email);
  await d.page.fill('#auth-password', password);
  await d.page.getByRole('button', { name: '登入', exact: true }).click();
}

async function addTask(d, title) {
  await d.go('tasks');
  await d.page.getByRole('button', { name: '＋ 新增任務' }).click();
  await d.page.fill('#task-title', title);
  await d.page.locator('#form-dialog').getByRole('button', { name: '儲存', exact: true }).click();
}

async function taskTitles(d) {
  await d.go('tasks');
  await d.page.locator('.segmented label', { hasText: '全部' }).first().click();
  return d.page.locator('#view-tasks .todo-title').allInnerTexts();
}

async function editTask(d, from, to) {
  await d.go('tasks');
  await d.page.locator('.segmented label', { hasText: '全部' }).first().click();
  await d.page.getByRole('button', { name: `編輯「${from}」` }).click();
  await d.page.fill('#task-title', to);
  await d.page.locator('#form-dialog').getByRole('button', { name: '儲存', exact: true }).click();
}

(async () => {
  if (!SB_KEY) {
    console.error('請設定 SUPABASE_ANON_KEY');
    process.exit(2);
  }
  const browser = await chromium.launch();
  const emailA = `alice-${RUN}@example.test`;
  const emailB = `bob-${RUN}@example.test`;

  // ===== 裝置 A：先在本機模式使用，再註冊 =====
  const A = await device(browser, 'A');
  check((await A.status()).includes('本機模式'), '設定好雲端後，未登入時狀態列顯示本機模式');
  await addTask(A, '本機時建立的任務');
  const { sent, link } = await signUp(A, emailA);
  check(sent && Boolean(link), '註冊後提示寄出驗證信，並收到含驗證連結的信');
  check(!(await A.local('daily-habit:session')), '驗證前沒有登入');
  await A.page.goto(link);
  await A.page.waitForSelector('.view:not([hidden]) h2');
  check(await vis(A.page.getByText('電子郵件驗證完成，已登入')), '點驗證連結後回到網站並自動登入');
  check(!A.page.url().includes('access_token'), '登入資訊不會留在網址上');
  check(await A.waitStatus(/已同步/), `完成第一次同步：${await A.status()}`);
  const session = JSON.parse(await A.local('daily-habit:session'));
  const userA = session.user.id;
  check((await taskTitles(A)).length === 0, '登入後顯示帳號的資料（本機資料不會自動上傳）');

  // 本機資料匯入
  await A.go('settings');
  check(await vis(A.page.getByText('匯入這台裝置的本機資料？')), '登入後提示可匯入本機資料');
  check(await vis(A.page.getByText(/任務 1 筆/)), '匯入前預覽筆數');
  await A.page.getByRole('button', { name: /匯入 \d+ 筆到帳號/ }).click();
  await A.page.locator('#confirm-ok').click();
  await A.settle();
  check((await taskTitles(A)).includes('本機時建立的任務'), '匯入後出現在帳號資料中');
  await A.go('settings');
  check(!(await vis(A.page.getByText('匯入這台裝置的本機資料？'), 1000)), '匯入完成後不再提示（不會重複匯入）');
  check(Boolean(await A.local('daily-habit:data')), '本機資料本身保留，沒有被刪除');

  // ===== 裝置 B：同一帳號 =====
  const B = await device(browser, 'B', { mobile: false });
  await signIn(B, emailA);
  check(await B.waitStatus(/已同步/), '第二台裝置登入並同步');
  check((await taskTitles(B)).includes('本機時建立的任務'), '第二台裝置看到同一份資料');

  // 新增、修改、刪除同步
  await addTask(A, '從 A 新增');
  check((await A.settle()) && /已同步/.test(await A.status()), 'A 新增後自動上傳');
  await B.syncNow();
  check((await taskTitles(B)).includes('從 A 新增'), 'B 同步後看到 A 新增的任務');
  await editTask(B, '從 A 新增', '在 B 修改');
  await B.settle();
  await A.syncNow();
  check((await taskTitles(A)).includes('在 B 修改'), 'A 同步後看到 B 的修改');
  await A.go('tasks');
  await A.page.locator('.segmented label', { hasText: '全部' }).first().click();
  await A.page.getByRole('button', { name: '刪除「在 B 修改」' }).click();
  await A.page.locator('#confirm-ok').click();
  await A.settle();
  await B.syncNow();
  check(!(await taskTitles(B)).includes('在 B 修改'), '刪除同步到另一台裝置');
  await B.syncNow();
  await A.syncNow();
  check(!(await taskTitles(A)).includes('在 B 修改') && !(await taskTitles(B)).includes('在 B 修改'), '再次同步後刪除的資料不會重新出現');

  // ===== 衝突：兩台都修改同一筆 =====
  await addTask(A, '衝突測試');
  await A.settle();
  await B.syncNow();
  await B.ctx.setOffline(true);
  await editTask(B, '衝突測試', 'B 離線時的版本');
  check(await B.waitStatus(/離線中：1 筆變更待同步/), `離線時顯示待同步：${await B.status()}`);
  await editTask(A, '衝突測試', 'A 的版本');
  await A.settle();
  await B.ctx.setOffline(false);
  await B.page.evaluate(() => window.dispatchEvent(new Event('online')));
  check(await B.waitStatus(/衝突/), `恢復連線後偵測到衝突：${await B.status()}`);
  check((await taskTitles(B)).includes('B 離線時的版本'), '衝突時本機版本不會被覆蓋');
  await A.syncNow();
  check((await taskTitles(A)).includes('A 的版本'), '雲端版本也沒有被覆蓋');
  await B.go('settings');
  check(await vis(B.page.getByText('有 1 筆資料在兩個地方都被修改了')), '設定頁列出衝突，並顯示兩個版本');
  await B.shot('conflict');
  await B.page.getByRole('button', { name: '保留這台裝置的版本' }).click();
  await B.settle();
  await A.syncNow();
  check((await taskTitles(A)).includes('B 離線時的版本'), '選擇保留 B 的版本後，A 同步到相同內容');

  // ===== 離線佇列 =====
  await B.ctx.setOffline(true);
  await addTask(B, '離線新增 1');
  await addTask(B, '離線新增 2');
  check(await B.waitStatus(/離線中：2 筆變更待同步/), '離線時多筆變更排入佇列');
  await B.ctx.setOffline(false);
  await B.page.evaluate(() => window.dispatchEvent(new Event('online')));
  check(await B.waitStatus(/已同步/), '恢復連線後自動上傳');
  await A.syncNow();
  const titlesA = await taskTitles(A);
  check(titlesA.includes('離線新增 1') && titlesA.includes('離線新增 2'), 'A 收到 B 離線時的變更');

  // ===== 伺服器失敗與重試 =====
  await fetch(`${SB_URL}/__offline/on`);
  await addTask(A, '失敗後重試');
  check(await A.waitStatus(/同步失敗.*自動重試/), `雲端失敗時顯示失敗與自動重試：${await A.status()}`);
  check(await vis(A.page.locator('#status-bar').getByRole('button', { name: '立即重試' })), '提供立即重試按鈕');
  await fetch(`${SB_URL}/__offline/off`);
  await A.page.locator('#status-bar').getByRole('button', { name: '立即重試' }).click();
  check(await A.waitStatus(/已同步/), '按立即重試後同步成功');

  // ===== 金幣兌換：兩台裝置離線各自兌換 =====
  await A.go('tasks');
  await A.page.locator('.segmented label', { hasText: '全部' }).first().click();
  await A.page.getByRole('checkbox', { name: '失敗後重試' }).click();
  await A.go('growth');
  await A.page.getByRole('button', { name: '＋ 新增獎勵' }).click();
  await A.page.fill('#reward-name', '小獎勵');
  await A.page.fill('#reward-cost', '10');
  await A.page.locator('#form-dialog').getByRole('button', { name: '儲存', exact: true }).click();
  await A.settle();
  await B.syncNow();
  const coins = (d) => d.page.evaluate((uid) => JSON.parse(localStorage.getItem(`daily-habit:u:${uid}:data`)).ledger.reduce((s, e) => s + e.coins, 0), userA);
  const startCoins = await coins(A);
  check(startCoins >= 10 && startCoins < 20 && (await coins(B)) === startCoins, `兩台裝置金幣一致（${startCoins}），只夠兌換一次`);
  await A.ctx.setOffline(true);
  await B.ctx.setOffline(true);
  for (const d of [A, B]) {
    await d.go('growth');
    await d.page.getByRole('button', { name: /兌換「小獎勵」/ }).click();
    await d.page.locator('#confirm-ok').click();
  }
  await A.ctx.setOffline(false);
  await A.page.evaluate(() => window.dispatchEvent(new Event('online')));
  await A.settle();
  await B.ctx.setOffline(false);
  await B.page.evaluate(() => window.dispatchEvent(new Event('online')));
  await B.settle();
  check(await vis(B.page.getByText(/已取消：雲端的金幣餘額不足/)), '第二台的兌換被雲端拒絕並提示');
  await A.syncNow();
  check((await coins(A)) === startCoins - 10 && (await coins(B)) === startCoins - 10, '兩台裝置的金幣一致，只扣一次');

  // ===== 登入權杖更新 =====
  await A.page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('daily-habit:session'));
    s.expires_at = Math.floor(Date.now() / 1000) + 10;
    localStorage.setItem('daily-habit:session', JSON.stringify(s));
  });
  await A.page.reload();
  await A.page.waitForSelector('.view:not([hidden]) h2');
  await A.syncNow();
  const refreshed = JSON.parse(await A.local('daily-habit:session'));
  check(refreshed.expires_at > Date.now() / 1000 + 600, '登入快到期時自動更新權杖');

  // ===== 另一個帳號：資料隔離 =====
  const C = await device(browser, 'C');
  const signupB = await signUp(C, emailB);
  await C.page.goto(signupB.link);
  await C.page.waitForSelector('.view:not([hidden]) h2');
  await C.waitStatus(/已同步/);
  check((await taskTitles(C)).length === 0, '另一個帳號看不到 A 的任何資料');
  const tokenB = JSON.parse(await C.local('daily-habit:session')).access_token;
  const tryRead = await fetch(`${SB_URL}/rest/v1/records?select=id&user_id=eq.${userA}`, { headers: { apikey: SB_KEY, authorization: `Bearer ${tokenB}` } }).then((r) => r.json());
  check(Array.isArray(tryRead) && tryRead.length === 0, '直接呼叫 API 指定 A 的 user_id 也讀不到（資料權限）');
  const tryWrite = await fetch(`${SB_URL}/rest/v1/records`, {
    method: 'POST',
    headers: { apikey: SB_KEY, authorization: `Bearer ${tokenB}`, 'content-type': 'application/json' },
    body: JSON.stringify({ user_id: userA, collection: 'tasks', id: 't_hack', data: { id: 't_hack', title: 'x' } }),
  });
  check(tryWrite.status === 403 || tryWrite.status === 401, `不能寫入 A 的資料（HTTP ${tryWrite.status}）`);
  const anon = await fetch(`${SB_URL}/rest/v1/records?select=id`, { headers: { apikey: SB_KEY } });
  check(anon.status === 401, `未登入不能讀取（HTTP ${anon.status}）`);

  // ===== 登出：清除快取 =====
  await A.go('settings');
  await A.page.getByRole('button', { name: '登出' }).click();
  await A.page.locator('#confirm-ok').click();
  await vis(A.page.getByText('已登出'));
  const leftover = (await A.keys()).filter((k) => k.startsWith(`daily-habit:u:${userA}`) || k === 'daily-habit:session');
  check(leftover.length === 0, `登出後清除帳號快取與登入資訊（剩餘：${leftover.join(',') || '無'}）`);
  check((await A.status()).includes('本機模式') && (await taskTitles(A)).includes('本機時建立的任務') && !(await taskTitles(A)).includes('離線新增 1'), '登出後回到本機資料，看不到帳號資料');

  // ===== 忘記密碼 =====
  await A.go('settings');
  await A.page.locator('.segmented label', { hasText: '忘記密碼' }).click();
  await A.page.fill('#auth-email', emailA);
  const before = Date.now() - 1000;
  await A.page.getByRole('button', { name: '寄送重設密碼信' }).click();
  check(await vis(A.page.getByText(/你會收到一封重設密碼的信/)), '送出重設密碼申請');
  const resetLink = await mailLink(emailA, before);
  check(Boolean(resetLink && resetLink.includes('type=recovery')), '收到重設密碼信');
  await A.page.goto(resetLink);
  await A.page.waitForSelector('.view:not([hidden]) h2');
  check(await vis(A.page.getByRole('heading', { name: '設定新密碼' })), '從信件連結回來後顯示設定新密碼');
  await A.page.fill('#new-password', 'new-password-456');
  await A.page.fill('#new-password2', 'new-password-456');
  await A.page.locator('#form-dialog').getByRole('button', { name: '儲存', exact: true }).click();
  check(await vis(A.page.getByText('已更新密碼')), '更新密碼成功');
  await A.go('settings');
  await A.page.getByRole('button', { name: '登出' }).click();
  await A.page.locator('#confirm-ok').click();
  await signIn(A, emailA, PASSWORD);
  check(await vis(A.page.getByText('電子郵件或密碼不正確')), '舊密碼不能再登入');
  await signIn(A, emailA, 'new-password-456');
  check(await A.waitStatus(/已同步/), '新密碼可以登入並同步');
  check((await taskTitles(A)).includes('離線新增 1'), '重新登入後下載帳號資料');
  await A.shot('signed-in');


  // ===== 安裝版離線：離線開啟、離線修改、恢復連線後同步（需要 PWA_URL：已填好 config.js 的網站） =====
  if (process.env.PWA_URL) {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, timezoneId: 'Asia/Taipei' });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e)));
    await page.goto(process.env.PWA_URL);
    await page.waitForSelector('.view:not([hidden]) h2');
    const d = { page, go: async (v) => { await page.evaluate((x) => (location.hash = x), `#${v}`); await page.waitForSelector(`#view-${v}:not([hidden]) h2`); } };
    const emailD = `dora-${RUN}@example.test`;
    await d.go('settings');
    await page.locator('.segmented label', { hasText: '註冊' }).click();
    await page.fill('#auth-email', emailD);
    await page.fill('#auth-password', PASSWORD);
    await page.fill('#auth-password2', PASSWORD);
    const t0 = Date.now() - 1000;
    await page.getByRole('button', { name: '註冊', exact: true }).click();
    const linkD = await mailLink(emailD, t0);
    await page.goto(linkD);
    await page.waitForSelector('.view:not([hidden]) h2');
    const statusD = () => page.locator('#status-bar').innerText();
    const waitD = async (re) => {
      for (let i = 0; i < 75; i++) {
        if (re.test(await statusD())) return true;
        await sleep(200);
      }
      return false;
    };
    check(await waitD(/已同步/), '已設定雲端的網站：註冊並登入');
    await page.evaluate(async () => navigator.serviceWorker.ready);
    await page.reload();
    await page.waitForSelector('.view:not([hidden]) h2');
    await ctx.setOffline(true);
    await page.reload();
    await page.waitForSelector('.view:not([hidden]) h2', { timeout: 10000 });
    check(await waitD(/離線中/), `離線開啟已安裝的網站，狀態顯示離線：${await statusD()}`);
    await d.go('tasks');
    await page.getByRole('button', { name: '＋ 新增任務' }).click();
    await page.fill('#task-title', '安裝版離線新增');
    await page.locator('#form-dialog').getByRole('button', { name: '儲存', exact: true }).click();
    check(await waitD(/離線中：1 筆變更待同步/), '離線修改排入待同步');
    await ctx.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    check(await waitD(/已同步/), '恢復連線後自動同步');
    const tokenD = JSON.parse(await page.evaluate(() => localStorage.getItem('daily-habit:session'))).access_token;
    const rows = await fetch(`${SB_URL}/rest/v1/records?select=data&collection=eq.tasks`, { headers: { apikey: SB_KEY, authorization: `Bearer ${tokenD}` } }).then((r) => r.json());
    check(rows.some((r) => r.data.title === '安裝版離線新增'), '雲端收到離線時新增的任務');
    check(errs.length === 0, `安裝版離線情境沒有 JavaScript 錯誤 ${errs.join(' | ')}`);
    await ctx.close();
  }

  for (const d of [A, B, C]) check(d.errors.length === 0, `裝置 ${d.name} 沒有 JavaScript 錯誤 ${d.errors.join(' | ')}`);
  await browser.close();
  console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}：${passes} 項通過（截圖：${OUT}）`);
  process.exit(failures ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
