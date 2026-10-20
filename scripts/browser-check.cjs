// 瀏覽器端到端檢查（選用）。需要已安裝 Playwright 與 Chromium。
// 用法：先啟動本機伺服器，再執行
//   BASE_URL=http://localhost:8000/ node scripts/browser-check.cjs [截圖輸出資料夾]
// 會以手機（375px）與電腦（1280px）寬度、Asia/Taipei 時區操作主要功能。
// 每個瀏覽器情境都使用全新的資料，不會動到你平常使用的瀏覽器資料。
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const OUT = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'daily-habit-check-'));
fs.mkdirSync(OUT, { recursive: true });
const URL = process.env.BASE_URL || 'http://localhost:8000/';
const KEY = 'daily-habit:data';
let failures = 0;
async function vis(loc) { try { await loc.first().waitFor({ state: 'visible', timeout: 3000 }); return true; } catch { return false; } }
function check(cond, msg) { console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) failures++; }

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, timezoneId: 'Asia/Taipei', locale: 'zh-TW', acceptDownloads: true, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('dialog', (d) => { errors.push('native dialog: ' + d.message()); d.dismiss(); });
  const stored = () => page.evaluate((k) => JSON.parse(localStorage.getItem(k)), KEY);

  await page.goto(URL);
  await page.waitForSelector('#view-today h2');
  check(await vis(page.getByText('歡迎使用！')), '第一次使用顯示歡迎與空白狀態');
  check((await page.evaluate((k) => localStorage.getItem(k), KEY)) === null, '未自動寫入範例資料');
  check(/今天是 \d{4} 年/.test(await page.textContent('#today-label')), '顯示今日日期');
  await page.screenshot({ path: path.join(OUT, 'm-01-empty.png'), fullPage: true });

  // 新增待辦：空白名稱
  await page.getByRole('button', { name: '新增第一筆待辦' }).click();
  check(await page.locator('#todo-dialog').evaluate((d) => d.open), '新增待辦對話框開啟');
  check((await page.inputValue('#todo-due')) !== '', '從今日頁新增，預設截止日為今天');
  await page.fill('#todo-title', '   ');
  await page.getByRole('button', { name: '儲存' }).first().click();
  check(await vis(page.locator('#todo-title-error')), '名稱空白時顯示錯誤');
  check((await page.evaluate(() => document.activeElement.id)) === 'todo-title', '錯誤時焦點回到名稱欄');
  const xss = '<img src=x onerror="window.__xss=1">';
  await page.fill('#todo-title', xss);
  await page.fill('#todo-note', '第一行\n<b>第二行</b>');
  await page.locator('#todo-form label:has-text("高")').click();
  await page.getByRole('button', { name: '儲存' }).first().click();
  check(!(await page.locator('#todo-dialog').evaluate((d) => d.open)), '儲存後對話框關閉');
  check(await vis(page.locator('.todo-title', { hasText: xss })), '使用者輸入以文字顯示');
  check((await page.locator('#view-today img').count()) === 0 && !(await page.evaluate(() => window.__xss)), '未被當成 HTML 執行');
  let data = await stored();
  check(data.version === 1 && data.todos.length === 1 && data.todos[0].priority === 'high', 'localStorage 有版本欄位與待辦');
  const todayKey = data.todos[0].dueDate;
  const expectedToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
  check(todayKey === expectedToday, `今日日期鍵依台灣時間 ${todayKey}`);

  // 所有待辦：新增逾期與無截止日
  await page.getByRole('link', { name: '所有待辦' }).click(); await page.waitForSelector('#view-todos:not([hidden])');
  await page.waitForSelector('#view-todos:not([hidden])');
  check(page.url().endsWith('#todos'), '網址 hash 切換到 #todos');
  const addTodo = async (title, due, prio) => {
    await page.getByRole('button', { name: '＋ 新增待辦' }).click();
    await page.fill('#todo-title', title);
    await page.fill('#todo-due', due);
    if (prio) await page.locator(`#todo-form label:has-text("${prio}")`).click();
    await page.getByRole('button', { name: '儲存' }).first().click();
  };
  const yesterday = await page.evaluate((k) => { const [y, m, d] = k.split('-').map(Number); const dt = new Date(y, m - 1, d - 1); return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`; }, todayKey);
  await addTodo('逾期的報告', yesterday, '中');
  await addTodo('沒有日期的事', '', '低');
  check((await page.locator('#view-todos .todo').count()) === 3, '所有待辦顯示 3 筆（含無截止日）');
  check(await vis(page.getByText('無截止日期')), '無截止日期的待辦可在所有待辦查看');

  // 完成 / 篩選
  await page.locator('.todo', { hasText: '沒有日期的事' }).locator('input[type=checkbox]').check();
  check((await stored()).todos.find((t) => t.title === '沒有日期的事').done === true, '標記完成已儲存');
  check(await vis(page.locator('.todo.is-done', { hasText: '沒有日期的事' }).getByText('✓ 已完成')), '完成狀態有文字標示');
  await page.locator('.filter label', { hasText: '已完成' }).click();
  check((await page.locator('#view-todos .todo').count()) === 1, '篩選已完成：1 筆');
  await page.locator('.filter label', { hasText: '未完成' }).click();
  check((await page.locator('#view-todos .todo').count()) === 2, '篩選未完成：2 筆');
  await page.locator('.filter label', { hasText: '全部' }).click();
  await page.locator('.todo', { hasText: '沒有日期的事' }).locator('input[type=checkbox]').uncheck();
  check((await stored()).todos.find((t) => t.title === '沒有日期的事').done === false, '取消完成已儲存');

  // 編輯
  await page.getByRole('button', { name: '編輯「沒有日期的事」' }).click();
  check((await page.inputValue('#todo-title')) === '沒有日期的事', '編輯時帶入原內容');
  await page.fill('#todo-title', '沒有日期的事（已修改）');
  await page.getByRole('button', { name: '儲存' }).first().click();
  check(await vis(page.getByText('沒有日期的事（已修改）')), '編輯後名稱更新');

  // 刪除：先取消再確認
  await page.getByRole('button', { name: '刪除「沒有日期的事（已修改）」' }).click();
  check(await page.locator('#confirm-dialog').evaluate((d) => d.open), '刪除前顯示確認');
  await page.locator('#confirm-cancel').click();
  check((await stored()).todos.length === 3, '取消刪除時資料不變');
  await page.getByRole('button', { name: '刪除「沒有日期的事（已修改）」' }).click();
  await page.locator('#confirm-ok').click();
  await page.waitForFunction((k) => JSON.parse(localStorage.getItem(k)).todos.length === 2, KEY, { timeout: 3000 }).catch(() => {});
  check((await stored()).todos.length === 2, '確認後刪除');
  await page.screenshot({ path: path.join(OUT, 'm-02-todos.png'), fullPage: true });

  // 今日頁
  await page.getByRole('link', { name: '今日' }).click(); await page.waitForSelector('#view-today:not([hidden])');
  const overdueSection = page.locator('section[aria-labelledby=today-overdue]');
  const dueSection = page.locator('section[aria-labelledby=today-due]');
  check(await overdueSection.getByText('逾期的報告').isVisible(), '今日頁：已逾期區顯示逾期待辦');
  check(await dueSection.getByText(xss).isVisible(), '今日頁：今天到期區顯示今天的待辦');
  check((await overdueSection.getByText(xss).count()) === 0, '今天到期的不在逾期區');

  // 習慣
  await page.getByRole('link', { name: '習慣' }).click(); await page.waitForSelector('#view-habits:not([hidden])');
  await page.getByRole('button', { name: '新增', exact: true }).click();
  check(await vis(page.locator('#habit-name-error')), '習慣名稱空白顯示錯誤');
  await page.fill('#habit-name', '喝水 8 杯');
  await page.press('#habit-name', 'Enter');
  check(await vis(page.locator('.habit-name', { hasText: '喝水 8 杯' })), '新增習慣');
  check((await page.evaluate(() => document.activeElement.id)) === 'habit-name' && (await page.inputValue('#habit-name')) === '', '新增後輸入框清空並保留焦點');
  await page.fill('#habit-name', '伸展');
  await page.press('#habit-name', 'Enter');
  data = await stored();
  check(data.habits.every((h) => h.createdDate === todayKey), '習慣建立日期為台灣今日');
  const weekStatuses = await page.locator('.habit.card').first().locator('.week .day').evaluateAll((els) => els.map((e) => e.className));
  check(weekStatuses.length === 7 && weekStatuses.slice(0, 6).every((c) => c.includes('not-started')) && weekStatuses[6].includes('pending'), '新習慣：建立前日期不算漏打卡，今天待打卡');

  await page.getByRole('button', { name: '為「喝水 8 杯」完成今天的打卡' }).click();
  data = await stored();
  check(data.checkins.length === 1 && data.checkins[0].date === todayKey, '打卡一筆，日期為今天');
  check((await page.evaluate(() => document.activeElement.getAttribute('aria-label'))) === '取消「喝水 8 杯」今天的打卡', '打卡後焦點留在同一按鈕');
  // 在另一個入口（今日頁）再打卡不會重複；先確認今日頁顯示已打卡
  await page.getByRole('link', { name: '今日' }).click(); await page.waitForSelector('#view-today:not([hidden])');
  check(await vis(page.locator('.habit--compact', { hasText: '喝水 8 杯' }).getByText('✓ 今天已打卡')), '今日頁顯示已打卡（文字標示）');
  await page.getByRole('button', { name: '為「伸展」完成今天的打卡' }).click();
  await page.waitForTimeout(500); // 實際操作間隔（0.4 秒內的連點會被忽略）
  await page.getByRole('button', { name: '取消「伸展」今天的打卡' }).click();
  data = await stored();
  check(data.checkins.length === 1, '取消打卡後移除紀錄');
  await page.screenshot({ path: path.join(OUT, 'm-03-today.png'), fullPage: true });

  // 改名、封存、還原
  await page.getByRole('link', { name: '習慣' }).click(); await page.waitForSelector('#view-habits:not([hidden])');
  await page.getByRole('button', { name: '修改「伸展」的名稱' }).click();
  await page.fill('#habit-name-edit', '');
  await page.locator('#habit-form button[type=submit]').click();
  check(await vis(page.locator('#habit-name-edit-error')), '改名空白顯示錯誤');
  await page.fill('#habit-name-edit', '伸展 10 分鐘');
  await page.locator('#habit-form button[type=submit]').click();
  check(await vis(page.locator('.habit-name', { hasText: '伸展 10 分鐘' })), '改名成功');
  await page.getByRole('button', { name: '封存「喝水 8 杯」' }).click();
  check(await vis(page.locator('section[aria-labelledby=habits-archived]').getByText('喝水 8 杯')), '封存後移到已封存');
  check((await stored()).checkins.length === 1, '封存保留打卡紀錄');
  await page.getByRole('link', { name: '今日' }).click(); await page.waitForSelector('#view-today:not([hidden])');
  check((await page.locator('.habit--compact', { hasText: '喝水 8 杯' }).count()) === 0, '封存的習慣不列入今日');
  await page.getByRole('link', { name: '習慣' }).click(); await page.waitForSelector('#view-habits:not([hidden])');
  await page.screenshot({ path: path.join(OUT, 'm-04-habits.png'), fullPage: true });
  await page.getByRole('button', { name: '還原「喝水 8 杯」' }).click();
  check(await vis(page.locator('section[aria-labelledby=habits-active]').getByText('喝水 8 杯')), '還原習慣');
  check(await page.locator('.habit.card', { hasText: '喝水 8 杯' }).locator('.day--done').count() === 1, '還原後仍保留打卡紀錄');

  // 重新整理後保留
  const before = await stored();
  await page.reload();
  await page.waitForSelector('#view-habits h2');
  check(await vis(page.locator('.habit-name', { hasText: '喝水 8 杯' })), '重新整理後資料保留');
  // 重新開啟（新分頁）
  const page2 = await ctx.newPage();
  await page2.goto(URL + '#todos');
  check((await page2.locator('#view-todos .todo').count()) === 2, '重新開啟（新分頁）資料保留');
  await page2.close();

  // 橫向捲動檢查
  for (const v of ['today', 'todos', 'habits', 'settings']) {
    await page.goto(URL + '#' + v);
    await page.waitForSelector(`#view-${v} h2`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    check(!overflow, `375px 寬度「${v}」無橫向捲動`);
  }

  // 匯出
  await page.goto(URL + '#settings');
  check(await vis(page.getByText('不會跨裝置或跨瀏覽器同步')), '說明資料不會跨裝置同步');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '下載備份檔' }).click()]);
  const fname = download.suggestedFilename();
  check(fname === `daily-habit-backup-${todayKey}.json`, `匯出檔名含日期：${fname}`);
  const exportPath = path.join(OUT, fname);
  await download.saveAs(exportPath);
  const exported = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
  check(exported.app === 'daily-habit' && exported.version === 1 && exported.data.todos.length === 2 && exported.data.habits.length === 2, '匯出內容正確');

  // 匯入無效備份
  const badPath = path.join(OUT, 'bad.json');
  fs.writeFileSync(badPath, JSON.stringify({ ...exported, data: { ...exported.data, checkins: [{ habitId: 'h_nope', date: '2026-13-40' }] } }));
  await page.setInputFiles('#import-file', badPath);
  check(await vis(page.getByText('✕ 無法使用這個備份檔')), '無效備份顯示錯誤');
  check(JSON.stringify((await stored()).todos) === JSON.stringify(before.todos), '無效備份不覆蓋現有資料');
  await page.screenshot({ path: path.join(OUT, 'm-05-import-invalid.png'), fullPage: true });
  await page.getByRole('button', { name: '關閉', exact: true }).click();

  // 匯入有效備份（只含 1 個待辦）
  const goodPath = path.join(OUT, 'good.json');
  fs.writeFileSync(goodPath, JSON.stringify({ ...exported, data: { todos: exported.data.todos.slice(0, 1), habits: [], checkins: [] } }));
  await page.setInputFiles('#import-file', goodPath);
  check(await vis(page.getByText('✓ 備份檔檢查通過')), '有效備份檢查通過');
  check(await vis(page.getByText('待辦 1 筆、習慣 0 個、打卡紀錄 0 筆')), '顯示備份筆數');
  check(await page.getByLabel('還原前，先下載目前資料的備份（建議）').isChecked(), '預設勾選先匯出目前資料');
  await page.screenshot({ path: path.join(OUT, 'm-06-import-preview.png'), fullPage: true });
  await page.getByRole('button', { name: '以此備份還原…' }).click();
  await page.locator('#confirm-cancel').click();
  check((await stored()).habits.length === 2, '取消還原時資料不變');
  await page.getByRole('button', { name: '以此備份還原…' }).click();
  const [preDownload] = await Promise.all([page.waitForEvent('download'), page.locator('#confirm-ok').click()]);
  check(/^daily-habit-backup-/.test(preDownload.suggestedFilename()), '還原前先下載目前資料');
  data = await stored();
  check(data.todos.length === 1 && data.habits.length === 0, '完整取代還原成功');

  // 範例資料
  await page.getByRole('button', { name: '載入範例資料' }).click();
  await page.locator('#confirm-ok').click();
  await page.waitForFunction((k) => JSON.parse(localStorage.getItem(k)).todos.length === 6, KEY, { timeout: 3000 }).catch(() => {});
  data = await stored();
  check(data.todos.length === 6 && data.habits.length === 3, '範例資料以加入方式載入');

  // 儲存失敗
  await page.goto(URL + '#habits');
  await page.evaluate(() => { const orig = Storage.prototype.setItem; window.__restore = () => (Storage.prototype.setItem = orig); Storage.prototype.setItem = function () { const e = new Error('full'); e.name = 'QuotaExceededError'; throw e; }; });
  const countBefore = (await stored()).habits.length;
  await page.fill('#habit-name', '不會被存到');
  await page.press('#habit-name', 'Enter');
  check(await vis(page.getByText('瀏覽器儲存空間已滿')), '儲存失敗顯示明確訊息');
  check((await page.locator('.habit-name', { hasText: '不會被存到' }).count()) === 0 && (await stored()).habits.length === countBefore, '儲存失敗時不套用變更');
  check((await page.inputValue('#habit-name')) === '不會被存到', '儲存失敗時保留輸入內容');
  await page.evaluate(() => window.__restore());

  // 資料損壞
  await page.evaluate((k) => localStorage.setItem(k, '{"version":1,"todos":[{"id":"bad"'), KEY);
  await page.reload();
  await page.waitForSelector('#heading-recovery');
  check(await vis(page.getByText('無法讀取已儲存的資料')), '資料損壞時顯示救援畫面');
  check((await page.evaluate((k) => localStorage.getItem(k), KEY)) === '{"version":1,"todos":[{"id":"bad"', '損壞資料未被覆寫');
  check(await page.locator('#tabs').isHidden(), '救援模式隱藏一般導覽');
  await page.screenshot({ path: path.join(OUT, 'm-07-recovery.png'), fullPage: true });
  const [rawDl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '下載原始資料' }).click()]);
  check(/^daily-habit-raw-/.test(rawDl.suggestedFilename()), '可下載原始損壞資料');
  await page.setInputFiles('#import-file', goodPath);
  await page.getByRole('button', { name: '以此備份還原…' }).click();
  await page.locator('#confirm-ok').click();
  await page.waitForSelector('#tabs:not([hidden])', { timeout: 3000 }).catch(() => {});
  const keys = await page.evaluate(() => Object.keys(localStorage));
  check(keys.some((k) => k.startsWith('daily-habit:corrupt-')), '從備份還原前已另存損壞資料');
  check((await stored()).todos.length === 1 && (await vis(page.locator('#tabs'))), '救援後回到一般畫面');

  check(errors.length === 0, `沒有 JavaScript 錯誤 ${errors.join(' | ')}`);
  await ctx.close();

  // 跨午夜
  const ctx2 = await browser.newContext({ viewport: { width: 375, height: 812 }, timezoneId: 'Asia/Taipei' });
  const p = await ctx2.newPage();
  await p.clock.install({ time: new Date('2026-10-20T15:59:00Z') }); // 台灣 10/20 23:59
  await p.goto(URL);
  await p.evaluate((k) => localStorage.setItem(k, JSON.stringify({ version: 1, todos: [{ id: 't_1', title: '今晚截止', note: '', dueDate: '2026-10-20', priority: 'medium', done: false, createdAt: '2026-10-20T01:00:00.000Z', updatedAt: '2026-10-20T01:00:00.000Z', completedAt: null }], habits: [{ id: 'h_1', name: '閱讀', createdDate: '2026-10-20', archived: false, archivedDate: null, createdAt: '2026-10-20T01:00:00.000Z', updatedAt: '2026-10-20T01:00:00.000Z' }], checkins: [{ habitId: 'h_1', date: '2026-10-20', createdAt: null }] })), KEY);
  await p.reload();
  await p.waitForSelector('#view-today h2');
  check((await p.textContent('#today-label')).includes('2026 年 10 月 20 日'), '台灣 23:59 顯示 10/20');
  check(await vis(p.locator('section[aria-labelledby=today-due]').getByText('今晚截止')), '午夜前：今天到期');
  check(await vis(p.getByText('✓ 今天已打卡')), '午夜前：習慣已打卡');
  await p.clock.runFor(2 * 60 * 1000);
  check((await p.textContent('#today-label')).includes('2026 年 10 月 21 日'), '跨午夜後日期自動更新為 10/21');
  check(await vis(p.locator('section[aria-labelledby=today-overdue]').getByText('今晚截止')), '跨午夜後：變成已逾期');
  check(await vis(p.getByText('○ 今天尚未打卡')), '跨午夜後：習慣變為今天尚未打卡');
  await ctx2.close();

  // 凌晨（UTC 仍是前一天）
  const ctx3 = await browser.newContext({ timezoneId: 'Asia/Taipei' });
  const p3 = await ctx3.newPage();
  await p3.clock.install({ time: new Date('2026-10-20T16:30:00Z') }); // 台灣 10/21 00:30
  await p3.goto(URL + '#habits');
  await p3.fill('#habit-name', '早起');
  await p3.press('#habit-name', 'Enter');
  await p3.getByRole('button', { name: '為「早起」完成今天的打卡' }).click();
  const d3 = await p3.evaluate((k) => JSON.parse(localStorage.getItem(k)), KEY);
  check(d3.habits[0].createdDate === '2026-10-21' && d3.checkins[0].date === '2026-10-21', '台灣凌晨 00:30 建立與打卡日期為 10/21（非 UTC 10/20）');
  await ctx3.close();

  // 電腦版
  const ctx4 = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'Asia/Taipei' });
  const d = await ctx4.newPage();
  await d.goto(URL);
  await d.getByRole('button', { name: '載入範例資料' }).click();
  check((await d.locator('.todo').count()) >= 2, '電腦版：範例資料載入（無既有資料時不需確認）');
  await d.screenshot({ path: path.join(OUT, 'd-01-today.png'), fullPage: true });
  check((await d.evaluate(() => document.activeElement.id)) === 'heading-today', '按鈕重繪後焦點移到區域標題（不遺失）');
  // 鍵盤操作：重新載入後從頁首 Tab 到導覽並 Enter
  await d.reload();
  await d.waitForSelector('#view-today h2');
  await d.keyboard.press('Tab'); // skip link
  let label = await d.evaluate(() => document.activeElement.textContent.trim());
  check(label === '跳到主要內容', '第一個 Tab 是「跳到主要內容」');
  await d.keyboard.press('Tab');
  await d.keyboard.press('Tab');
  label = await d.evaluate(() => document.activeElement.textContent.trim());
  check(label === '所有待辦', `Tab 到導覽「所有待辦」（${label}）`);
  await d.keyboard.press('Enter');
  await d.waitForSelector('#view-todos:not([hidden])');
  check((await d.evaluate(() => document.activeElement.id)) === 'heading-todos', '切換區域後焦點移到標題');
  // 鍵盤勾選
  const firstCb = d.locator('#view-todos .todo input[type=checkbox]').first();
  await firstCb.focus();
  await d.keyboard.press('Space');
  const focusKey = await d.evaluate(() => document.activeElement.dataset.focusKey);
  check(focusKey && focusKey.startsWith('todo-done-'), '鍵盤勾選後焦點仍在勾選框');
  // Esc 關閉對話框並回到按鈕
  await d.getByRole('button', { name: '＋ 新增待辦' }).click();
  await d.keyboard.press('Escape');
  await d.waitForTimeout(50);
  check((await d.evaluate(() => document.activeElement.dataset.focusKey)) === 'todos-add', 'Esc 關閉對話框後焦點回到開啟按鈕');
  await d.screenshot({ path: path.join(OUT, 'd-02-todos.png'), fullPage: true });
  await d.goto(URL + '#habits');
  await d.screenshot({ path: path.join(OUT, 'd-03-habits.png'), fullPage: true });
  await d.goto(URL + '#settings');
  await d.screenshot({ path: path.join(OUT, 'd-04-settings.png'), fullPage: true });
  check(!(await d.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)), '電腦版無橫向捲動');
  await ctx4.close();

  // localStorage 無法使用
  const ctx5 = await browser.newContext({ viewport: { width: 375, height: 812 } });
  await ctx5.addInitScript(() => { Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('denied', 'SecurityError'); } }); });
  const p5 = await ctx5.newPage();
  const errs5 = [];
  p5.on('pageerror', (e) => errs5.push(String(e)));
  await p5.goto(URL);
  check(await vis(p5.getByText('瀏覽器目前不允許儲存資料')), 'localStorage 無法使用時顯示警告');
  await p5.getByRole('button', { name: '新增第一個習慣' }).click();
  await p5.fill('#habit-name', '暫存習慣');
  await p5.press('#habit-name', 'Enter');
  check(await vis(p5.locator('.habit-name', { hasText: '暫存習慣' })) && errs5.length === 0, '無法儲存時仍可暫時使用');
  await ctx5.close();

  // ===== 交付前檢查追加項目 =====
  const blank = async (opts = {}) => {
    const c = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true, timezoneId: 'Asia/Taipei', acceptDownloads: true, ...opts });
    const pg = await c.newPage();
    const errs = [];
    pg.on('pageerror', (e) => errs.push(String(e)));
    return { c, pg, errs, read: () => pg.evaluate((k) => JSON.parse(localStorage.getItem(k)), KEY) };
  };

  // 部署子路徑：所有資源成功載入、樣式套用
  {
    const { c, pg } = await blank();
    const bad = [];
    const loaded = [];
    pg.on('response', (r) => { loaded.push(r.url()); if (r.status() >= 400) bad.push(`${r.status()} ${r.url()}`); });
    pg.on('requestfailed', (r) => bad.push(`failed ${r.url()}`));
    await pg.goto(URL);
    await pg.waitForSelector('#view-today h2');
    const base = new globalThis.URL(URL).pathname;
    check(bad.length === 0, `部署路徑 ${base} 下沒有載入失敗的資源 ${bad.join(' ')}`);
    check(loaded.some((u) => u.endsWith(`${base}css/style.css`)) && loaded.some((u) => u.endsWith(`${base}js/app.js`)), '樣式與程式由相對路徑載入');
    check((await pg.evaluate(() => getComputedStyle(document.body).backgroundColor)) !== 'rgba(0, 0, 0, 0)', '樣式已套用');
    if (base !== '/') {
      await pg.goto(URL.replace(/\/$/, ''));
      await pg.waitForSelector('#view-today h2');
      check(pg.url() === URL, '網址未加結尾斜線時會導向正確路徑並正常顯示');
    }
    await c.close();
  }

  // 手機觸控範圍與表單操作（點擊）
  {
    const { c, pg, errs, read } = await blank();
    await pg.goto(URL);
    await pg.getByRole('button', { name: '載入範例資料' }).tap();
    for (const v of ['today', 'todos', 'habits', 'settings']) {
      await pg.goto(URL + '#' + v);
      await pg.waitForSelector(`#view-${v}:not([hidden]) h2`);
      const small = await pg.evaluate(() =>
        [...document.querySelectorAll('button, a.tab, .segmented span, label.todo-check, input[type=text], input[type=date]')]
          .filter((e) => e.offsetParent)
          .map((e) => { const r = e.getBoundingClientRect(); return { t: (e.getAttribute('aria-label') || e.textContent).trim().slice(0, 12), w: r.width, h: r.height }; })
          .filter((x) => x.w < 44 || x.h < 44),
      );
      check(small.length === 0, `手機「${v}」可點擊元素至少 44×44px ${JSON.stringify(small)}`);
    }
    await pg.goto(URL + '#todos');
    await pg.waitForSelector('#view-todos:not([hidden]) h2');
    const title = '（範例）買牛奶和雞蛋';
    check((await pg.getByRole('checkbox', { name: title }).count()) === 1, '勾選框的名稱為待辦名稱');
    const box = await pg.locator('.todo', { hasText: title }).locator('label.todo-check').boundingBox();
    await pg.touchscreen.tap(box.x + 3, box.y + 3); // 點勾選框外圍
    await pg.waitForTimeout(100);
    check((await read()).todos.find((t) => t.title === title).done === true, '點擊勾選框外圍（44px 範圍內）即可完成');
    // 手機表單：點按新增、輸入、點按優先程度與儲存
    await pg.getByRole('button', { name: '＋ 新增待辦' }).tap();
    const dlg = await pg.locator('#todo-dialog').boundingBox();
    check(dlg.width <= 375 && dlg.x >= 0, '手機版對話框不超出畫面');
    await pg.locator('#todo-title').tap();
    await pg.keyboard.type('手機新增');
    await pg.locator('#todo-form label:has-text("低")').tap();
    await pg.locator('#todo-due').fill('2026-12-31');
    await pg.getByRole('button', { name: '儲存' }).first().tap();
    await pg.waitForTimeout(100);
    const t = (await read()).todos.find((x) => x.title === '手機新增');
    check(t && t.priority === 'low' && t.dueDate === '2026-12-31', '手機點按操作新增待辦（名稱、日期、優先程度）');
    await pg.locator('.tab', { hasText: '習慣' }).tap();
    await pg.waitForSelector('#view-habits:not([hidden]) h2');
    check(pg.url().endsWith('#habits'), '手機點按底部導覽切換區域');
    check(errs.length === 0, `手機操作無 JavaScript 錯誤 ${errs.join(' | ')}`);
    await c.close();
  }

  // 習慣重複操作：連點兩下、反覆打卡與取消、封存還原多次
  {
    const { c, pg, read } = await blank();
    await pg.goto(URL + '#habits');
    await pg.fill('#habit-name', '連點測試');
    await pg.press('#habit-name', 'Enter');
    await pg.getByRole('button', { name: '為「連點測試」完成今天的打卡' }).dblclick();
    await pg.waitForTimeout(100);
    check((await read()).checkins.length === 1, '連點兩下打卡：只記錄一筆，且不會被立即取消');
    for (let i = 0; i < 4; i++) {
      await pg.waitForTimeout(500);
      await pg.locator('.habit.card', { hasText: '連點測試' }).locator('.habit-actions button').first().click();
    }
    await pg.waitForTimeout(100);
    check((await read()).checkins.length === 1, '反覆打卡／取消四次後回到已打卡，仍只有一筆');
    // 從今日頁再按一次（取消），再回到習慣頁打卡
    await pg.waitForTimeout(500);
    await pg.goto(URL + '#today');
    await pg.getByRole('button', { name: '取消「連點測試」今天的打卡' }).click();
    await pg.waitForTimeout(500);
    await pg.goto(URL + '#habits');
    await pg.getByRole('button', { name: '為「連點測試」完成今天的打卡' }).click();
    check((await read()).checkins.length === 1, '跨頁面打卡與取消不會產生重複紀錄');
    // 加入過去的打卡紀錄，模擬多天歷史後封存／還原兩次
    await pg.evaluate((k) => {
      const d = JSON.parse(localStorage.getItem(k));
      const h = d.habits[0];
      h.createdDate = '2026-01-01';
      const today = d.checkins[0].date;
      const [y, m, dd] = today.split('-').map(Number);
      for (const off of [1, 2, 4]) {
        const dt = new Date(y, m - 1, dd - off);
        d.checkins.push({ habitId: h.id, date: `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`, createdAt: null });
      }
      localStorage.setItem(k, JSON.stringify(d));
    }, KEY);
    await pg.reload();
    await pg.waitForSelector('#view-habits h2');
    const doneBefore = await pg.locator('.habit.card', { hasText: '連點測試' }).locator('.day--done').count();
    for (let i = 0; i < 2; i++) {
      await pg.getByRole('button', { name: '封存「連點測試」' }).click();
      check((await pg.locator('.habit.is-archived', { hasText: '連點測試' }).locator('.day--done').count()) === doneBefore, `第 ${i + 1} 次封存後七天紀錄仍顯示 ${doneBefore} 天完成`);
      await pg.getByRole('button', { name: '還原「連點測試」' }).click();
    }
    check((await read()).checkins.length === 4 && doneBefore === 4, '封存與還原多次後打卡紀錄完整保留（4 筆）');
    const statuses = await pg.locator('.habit.card', { hasText: '連點測試' }).locator('.week .day').evaluateAll((els) => els.map((e) => e.className.replace('day day--', '')));
    check(JSON.stringify(statuses) === JSON.stringify(['missed', 'missed', 'done', 'missed', 'done', 'done', 'done']), `七天紀錄狀態正確 ${statuses}`);
    await c.close();
  }

  // Asia/Taipei 午夜前後打卡、以及頁面停在昨天時的保護
  {
    const { c, pg, read } = await blank({ viewport: { width: 1280, height: 900 }, isMobile: false, hasTouch: false });
    await pg.clock.install({ time: new Date('2026-10-20T15:59:00Z') }); // 台灣 10/20 23:59
    await pg.goto(URL + '#habits');
    await pg.fill('#habit-name', '午夜');
    await pg.press('#habit-name', 'Enter');
    await pg.getByRole('button', { name: '為「午夜」完成今天的打卡' }).click();
    check((await read()).checkins[0].date === '2026-10-20', '台灣 23:59 打卡記為 10/20');
    await pg.clock.runFor(2 * 60 * 1000); // 台灣 10/21 00:01
    check((await pg.textContent('#today-label')).includes('10 月 21 日'), '00:01 畫面自動換到 10/21');
    await pg.getByRole('button', { name: '為「午夜」完成今天的打卡' }).click();
    let ck = (await read()).checkins.map((x) => x.date).sort();
    check(JSON.stringify(ck) === '["2026-10-20","2026-10-21"]', `00:01 打卡記為 10/21，兩天各一筆 ${ck}`);
    const st = await pg.locator('.habit.card', { hasText: '午夜' }).locator('.week .day').evaluateAll((els) => els.map((e) => e.className.replace('day day--', '')));
    check(JSON.stringify(st.slice(-2)) === '["done","done"]' && st.slice(0, 4).every((x) => x === 'not-started'), `跨午夜七天紀錄：10/20 與今天皆完成，建立前不算漏 ${st}`);
    // 計時器沒有執行（例如手機休眠）而系統時間已到隔天
    await pg.clock.pauseAt(new Date('2026-10-21T15:59:30Z')); // 台灣 10/21 23:59:30
    await pg.clock.setSystemTime(new Date('2026-10-21T16:03:00Z')); // 台灣 10/22 00:03，計時器尚未觸發
    check((await pg.textContent('#today-label')).includes('10 月 21 日'), '（模擬）計時器尚未觸發，畫面仍停在 10/21');
    await pg.getByRole('button', { name: '取消「午夜」今天的打卡' }).click();
    ck = (await read()).checkins.map((x) => x.date).sort();
    check(JSON.stringify(ck) === '["2026-10-20","2026-10-21"]', '畫面停在昨天時按打卡按鈕，不會改動昨天的紀錄');
    check((await pg.textContent('#today-label')).includes('10 月 22 日'), '按下後畫面立即更新為 10/22');
    await pg.getByRole('button', { name: '為「午夜」完成今天的打卡' }).click();
    ck = (await read()).checkins.map((x) => x.date).sort();
    check(ck.at(-1) === '2026-10-22' && ck.length === 3, '更新後再按，記為 10/22');
    await c.close();
  }

  // 備份：匯出→清除→還原；損壞與不支援版本不覆蓋
  {
    const { c, pg, read } = await blank();
    await pg.goto(URL);
    await pg.getByRole('button', { name: '載入範例資料' }).click();
    await pg.goto(URL + '#settings');
    const original = await read();
    const [dl] = await Promise.all([pg.waitForEvent('download'), pg.getByRole('button', { name: '下載備份檔' }).click()]);
    const backupPath = path.join(OUT, 'roundtrip.json');
    await dl.saveAs(backupPath);
    await pg.getByRole('button', { name: '清除所有資料…' }).click();
    await pg.locator('#confirm-ok').click();
    await pg.waitForFunction((k) => JSON.parse(localStorage.getItem(k)).todos.length === 0, KEY);
    await pg.goto(URL + '#settings');
    await pg.setInputFiles('#import-file', backupPath);
    await pg.getByRole('button', { name: '以此備份還原…' }).click();
    await pg.locator('#confirm-ok').click();
    await pg.waitForFunction((k) => JSON.parse(localStorage.getItem(k)).todos.length > 0, KEY);
    const restored = await read();
    check(JSON.stringify({ t: restored.todos, h: restored.habits, c: restored.checkins }) === JSON.stringify({ t: original.todos, h: original.habits, c: original.checkins }), '匯出→清除→還原後資料與原本完全相同');
    await pg.reload();
    await pg.goto(URL + '#todos');
    check((await pg.locator('#view-todos .todo').count()) === original.todos.length, '還原後重新整理仍保留');

    const exported = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
    const cases = [
      ['不支援的新版本（version 2）', JSON.stringify({ ...exported, version: 2 }), /版本 2/],
      ['缺少版本', JSON.stringify({ ...exported, version: undefined }), /缺少資料版本/],
      ['檔案被截斷（損壞 JSON）', fs.readFileSync(backupPath, 'utf8').slice(0, 200), /JSON/],
      ['其他程式的 JSON', JSON.stringify({ hello: 'world' }), /不是/],
      ['日期錯誤', JSON.stringify({ ...exported, data: { ...exported.data, todos: [{ ...exported.data.todos[0], dueDate: '2026-02-30' }] } }), /截止日期/],
      ['識別碼重複', JSON.stringify({ ...exported, data: { ...exported.data, habits: [exported.data.habits[0], exported.data.habits[0]] } }), /重複/],
      ['空檔案', '', /空/],
    ];
    await pg.goto(URL + '#settings');
    for (const [name, text, re] of cases) {
      const before = await pg.evaluate((k) => localStorage.getItem(k), KEY);
      const f = path.join(OUT, 'case.json');
      fs.writeFileSync(f, text);
      await pg.setInputFiles('#import-file', f);
      const visible = await vis(pg.getByText('✕ 無法使用這個備份檔'));
      const msg = await pg.locator('.import-preview').textContent();
      const restoreBtn = await pg.getByRole('button', { name: '以此備份還原…' }).count();
      const after = await pg.evaluate((k) => localStorage.getItem(k), KEY);
      check(visible && re.test(msg) && restoreBtn === 0 && before === after, `備份「${name}」被拒絕、無還原按鈕、資料未變更`);
      await pg.getByRole('button', { name: '關閉', exact: true }).click();
    }
    await c.close();
  }

  // localStorage 中為不支援的新版本資料：不覆寫
  {
    const { c, pg } = await blank();
    await pg.goto(URL);
    const future = JSON.stringify({ version: 99, todos: [], habits: [], checkins: [] });
    await pg.evaluate(([k, v]) => localStorage.setItem(k, v), [KEY, future]);
    await pg.reload();
    check(await vis(pg.getByText('無法讀取已儲存的資料')), '瀏覽器內為較新版本資料時顯示救援畫面');
    check((await pg.evaluate((k) => localStorage.getItem(k), KEY)) === future, '較新版本資料未被覆寫');
    await c.close();
  }

  await browser.close();
  console.log(failures === 0 ? `\nALL PASSED（截圖：${OUT}）` : `\n${failures} FAILED（截圖：${OUT}）`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
