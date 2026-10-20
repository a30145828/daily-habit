// 瀏覽器端到端檢查（選用）。需要已安裝 Playwright 與 Chromium。
// 用法：先啟動本機伺服器，再執行
//   BASE_URL=http://localhost:8000/ node scripts/browser-check.cjs [截圖輸出資料夾] [群組…]
// 群組：general tasks habits review finance game pwa（不指定時全部執行）。
// 每個情境都使用全新的瀏覽器資料，並把時間固定在台灣 2026-10-20（二）10:00，不會動到你平常使用的資料。
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'daily-habit-check-'));
const ONLY = process.argv.slice(3);
fs.mkdirSync(OUT, { recursive: true });
const URL = process.env.BASE_URL || 'http://localhost:8000/';
const KEY = 'daily-habit:data';
const START = new Date('2026-10-20T02:00:00Z'); // 台灣 2026-10-20（二）10:00

let failures = 0;
let passes = 0;
function check(cond, msg) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`);
  if (cond) passes += 1;
  else failures += 1;
}
async function gone(loc, timeout = 3000) {
  try {
    await loc.first().waitFor({ state: 'detached', timeout });
    return true;
  } catch {
    return false;
  }
}
async function vis(loc, timeout = 3000) {
  try {
    await loc.first().waitFor({ state: 'visible', timeout });
    return true;
  } catch {
    return false;
  }
}

/** 建立全新的瀏覽器情境。 */
async function open(browser, { mobile = true, time = START, hash = '' } = {}) {
  const ctx = await browser.newContext({
    viewport: mobile ? { width: 375, height: 812 } : { width: 1280, height: 900 },
    isMobile: mobile,
    hasTouch: mobile,
    timezoneId: 'Asia/Taipei',
    locale: 'zh-TW',
    acceptDownloads: true,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('dialog', (d) => {
    errors.push(`native dialog: ${d.message()}`);
    d.dismiss();
  });
  if (time) await page.clock.install({ time });
  await page.goto(URL + hash);
  await page.waitForSelector('.view:not([hidden]) h2');
  const read = () => page.evaluate((k) => JSON.parse(localStorage.getItem(k)), KEY);
  const go = async (view) => {
    await page.evaluate((v) => (location.hash = v), `#${view}`);
    await page.waitForSelector(`#view-${view}:not([hidden]) h2`);
  };
  const dialog = page.locator('#form-dialog');
  const save = () => dialog.getByRole('button', { name: '儲存', exact: true }).click();
  const confirmOk = () => page.locator('#confirm-ok').click();
  const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
  return { ctx, page, errors, read, go, dialog, save, confirmOk, shot };
}

async function addTask(t, { title, due, priority, tags, note, subtasks = [], repeat, weekdays = [], monthDay, monthEnd }) {
  await t.page.getByRole('button', { name: '＋ 新增任務' }).click();
  await t.page.fill('#task-title', title);
  if (note) await t.page.fill('#task-note', note);
  if (due !== undefined) await t.page.fill('#task-due', due ?? '');
  if (priority) await t.dialog.locator(`#task-priority label:has-text("${priority}")`).click();
  if (tags) await t.page.fill('#task-tags', tags);
  for (const sub of subtasks) {
    await t.dialog.getByRole('button', { name: '＋ 新增子任務' }).click();
    await t.dialog.locator('.subtask-editor li input').last().fill(sub);
  }
  if (repeat) {
    await t.page.selectOption('#task-repeat', repeat);
    for (const day of weekdays) await t.dialog.getByLabel(`星期${day}`).check();
    if (monthDay) await t.page.fill('#task-monthday', String(monthDay));
    if (monthEnd) await t.dialog.locator(`#task-monthend label:has-text("${monthEnd}")`).click();
  }
  await t.save();
}

async function setView(t, label) {
  await t.page.locator('.segmented label', { hasText: label }).first().click();
}

const visibleTitles = (t) => t.page.locator('#view-tasks .todo .todo-title').allInnerTexts();

// ===================== 任務 =====================

async function suiteTasks(browser) {
  const t = await open(browser, { hash: '#tasks' });
  const { page } = t;

  // 新增：名稱空白
  await page.getByRole('button', { name: '＋ 新增任務' }).click();
  await page.fill('#task-title', '   ');
  await t.save();
  check(await vis(page.locator('#task-title-error')), '任務名稱空白時顯示錯誤並不關閉對話框');
  await page.keyboard.press('Escape');

  await addTask(t, { title: '寫週報', due: '2026-10-20', priority: '高', tags: '工作、報告', note: '第三季', subtasks: ['整理數字', '寄出'] });
  let d = await t.read();
  const task = d.tasks.find((x) => x.title === '寫週報');
  check(task && task.priority === 'high' && task.tags.join() === '工作,報告' && task.subtasks.length === 2 && task.note === '第三季', '新增任務：名稱、備註、截止日、優先程度、標籤、子任務都有保存');
  check((await visibleTitles(t)).includes('寫週報'), '今日視圖顯示今天到期的任務');

  await addTask(t, { title: '繳費', due: '2026-10-18', priority: '中' });
  await addTask(t, { title: '週日整理', due: '2026-10-25', priority: '低', tags: '家裡' });
  await addTask(t, { title: '下週開會', due: '2026-10-27' });
  await addTask(t, { title: '有空再看', due: '' });

  const counts = await page.locator('input[name="task-view"] + span').allInnerTexts();
  check(counts.join(' ') === '今日（1） 逾期（1） 本週（2） 全部（5） 已完成（0） 已封存（0）', `各視圖數量正確：${counts.join(' ')}`);
  await setView(t, '逾期');
  check(JSON.stringify(await visibleTitles(t)) === '["繳費"]', '逾期視圖');
  await setView(t, '本週');
  check(JSON.stringify(await visibleTitles(t)) === '["寫週報","週日整理"]', '本週視圖（今天到週日）');
  await setView(t, '全部');
  check((await visibleTitles(t)).includes('有空再看'), '沒有截止日期的任務出現在「全部」');

  // 子任務
  await page.locator('.todo', { hasText: '寫週報' }).getByRole('checkbox', { name: '整理數字' }).click();
  await page.waitForTimeout(50);
  d = await t.read();
  check(d.tasks.find((x) => x.title === '寫週報').subtasks[0].done === true, '勾選子任務會保存');
  check(await vis(page.locator('.todo', { hasText: '寫週報' }).getByText('子任務 1/2')), '顯示子任務進度');

  // 完成／取消完成
  await page.getByRole('checkbox', { name: '寫週報' }).click();
  await page.waitForTimeout(50);
  check((await t.read()).tasks.find((x) => x.title === '寫週報').done === true, '標記完成');
  await setView(t, '已完成');
  check(JSON.stringify(await visibleTitles(t)) === '["寫週報"]', '已完成視圖');
  await page.getByRole('checkbox', { name: '寫週報' }).click();
  await page.waitForTimeout(50);
  check((await t.read()).tasks.find((x) => x.title === '寫週報').done === false, '取消完成');

  // 編輯
  await setView(t, '全部');
  await page.getByRole('button', { name: '編輯「下週開會」' }).click();
  check((await page.inputValue('#task-title')) === '下週開會', '編輯時帶入原內容');
  await page.fill('#task-title', '下週開會（改）');
  await page.fill('#task-tags', '工作');
  await t.save();
  check((await visibleTitles(t)).includes('下週開會（改）'), '編輯後更新');

  // 搜尋、篩選、排序
  await page.locator('details.filters summary').click();
  await page.fill('#task-search', '第三季');
  check(JSON.stringify(await visibleTitles(t)) === '["寫週報"]', '搜尋備註內容');
  await page.fill('#task-search', '寄出');
  check(JSON.stringify(await visibleTitles(t)) === '["寫週報"]', '搜尋子任務名稱');
  await page.fill('#task-search', '');
  await page.selectOption('#task-filter-tag', '工作');
  check(JSON.stringify((await visibleTitles(t)).sort()) === JSON.stringify(['下週開會（改）', '寫週報'].sort()), '標籤篩選');
  await page.selectOption('#task-filter-tag', '');
  await page.selectOption('#task-filter-priority', 'low');
  check(JSON.stringify(await visibleTitles(t)) === '["週日整理"]', '優先程度篩選');
  await page.selectOption('#task-filter-priority', '');
  await page.selectOption('#task-sort', 'title');
  const sorted = await visibleTitles(t);
  check(sorted.length === 5, `排序後仍顯示全部 ${sorted.length} 項`);
  await page.selectOption('#task-sort', 'due');

  // 封存
  await page.getByRole('button', { name: '封存「有空再看」' }).click();
  check(!(await visibleTitles(t)).includes('有空再看'), '封存後不在全部');
  await setView(t, '已封存');
  check(JSON.stringify(await visibleTitles(t)) === '["有空再看"]', '已封存視圖');
  await page.getByRole('button', { name: '取消封存「有空再看」' }).click();
  await setView(t, '全部');
  check((await visibleTitles(t)).includes('有空再看'), '取消封存後回到全部');

  // 刪除
  await page.getByRole('button', { name: '刪除「有空再看」' }).click();
  await page.locator('#confirm-cancel').click();
  check((await t.read()).tasks.some((x) => x.title === '有空再看'), '取消刪除時資料不變');
  await page.getByRole('button', { name: '刪除「有空再看」' }).click();
  await t.confirmOk();
  await page.waitForTimeout(100);
  check(!(await t.read()).tasks.some((x) => x.title === '有空再看'), '確認後刪除');

  // 月曆
  await page.getByRole('button', { name: '月曆' }).click();
  check(await vis(page.locator('.calendar-title', { hasText: '2026 年 10 月' })), '月曆顯示本月');
  await page.locator('.calendar-day[aria-label^="10/25（"]').click();
  check(await vis(page.locator('#view-tasks .todo-title', { hasText: '週日整理' })), '月曆選日期後顯示當天任務');
  await page.getByRole('button', { name: '＋ 在這天新增' }).click();
  check((await page.inputValue('#task-due')) === '2026-10-25', '在月曆新增時預設為選取的日期');
  await page.fill('#task-title', '月曆新增');
  await t.save();
  check((await t.read()).tasks.some((x) => x.title === '月曆新增' && x.dueDate === '2026-10-25'), '從月曆新增任務');
  await t.shot('tasks-calendar');

  // 重新整理後保留
  await page.reload();
  await page.waitForSelector('#view-tasks h2');
  check((await t.read()).tasks.length === 5, '重新整理後資料保留');
  check(t.errors.length === 0, `任務操作無 JavaScript 錯誤 ${t.errors.join(' | ')}`);
  await t.ctx.close();
}

// ===================== 重複任務 =====================

async function suiteRecurring(browser) {
  const t = await open(browser, { hash: '#tasks' });
  const { page } = t;

  await addTask(t, { title: '倒垃圾', due: '2026-10-13', repeat: 'weekly', weekdays: ['二', '五'] });
  let d = await t.read();
  check(d.series.length === 1 && d.series[0].rule.weekdays.join() === '2,5' && d.series[0].startDate === '2026-10-13', '新增每週二、五的重複任務');
  check(d.tasks.length === 0, '重複任務不預先產生大量資料');
  check(JSON.stringify(await visibleTitles(t)) === '["倒垃圾"]', '今日（週二）出現重複任務');
  await setView(t, '逾期');
  check(await vis(page.locator('.todo', { hasText: '倒垃圾' }).getByText('截止 10/16（五）')), '逾期只列最近一次未完成（10/16）');
  check(await vis(page.getByText('還有 1 次未完成')), '提示之前還有未完成次數');
  await page.getByRole('button', { name: '略過「倒垃圾」這一次' }).click();
  check((await visibleTitles(t)).length === 0, '略過後逾期清單清空');

  await setView(t, '今日');
  await page.getByRole('checkbox', { name: '倒垃圾' }).click();
  await page.waitForTimeout(50);
  d = await t.read();
  check(d.tasks.some((x) => x.id.startsWith('o_') && x.occurrenceDate === '2026-10-20' && x.done), '完成今天這一次，存成固定 id 的實體項目');
  await setView(t, '本週');
  check(await vis(page.locator('.todo', { hasText: '倒垃圾' }).getByText('截止 10/23（五）')), '本週仍有週五那一次');

  // 只修改這次
  await page.getByRole('button', { name: '編輯「倒垃圾」' }).click();
  await page.getByRole('button', { name: /只修改這次/ }).click();
  await page.fill('#task-title', '倒垃圾（資源回收）');
  await t.save();
  d = await t.read();
  check(d.tasks.some((x) => x.title === '倒垃圾（資源回收）' && x.occurrenceDate === '2026-10-23') && d.series[0].title === '倒垃圾', '只修改這次：規則不變');

  // 這次及未來
  await page.getByRole('button', { name: '月曆' }).click();
  await page.getByRole('button', { name: '下個月' }).click();
  await page.locator('.calendar-day[aria-label^="11/3（"]').click();
  await page.getByRole('button', { name: '編輯「倒垃圾」' }).click();
  await page.getByRole('button', { name: '這次及未來的項目' }).click();
  await page.fill('#task-title', '倒垃圾（新時間）');
  await t.dialog.getByLabel('星期五').uncheck();
  await t.dialog.getByLabel('星期四').check();
  await t.save();
  d = await t.read();
  const old = d.series.find((s) => s.title === '倒垃圾');
  const created = d.series.find((s) => s.title === '倒垃圾（新時間）');
  check(old && old.endDate === '2026-11-02' && created && created.startDate === '2026-11-03' && created.rule.weekdays.join() === '2,4', '這次及未來：舊規則在前一天結束，新規則從這次開始');
  check(d.tasks.some((x) => x.occurrenceDate === '2026-10-20' && x.done), '過去已完成的紀錄保留');
  await page.locator('.calendar-day[aria-label^="11/5（"]').click();
  check(await vis(page.locator('#view-tasks .todo-title', { hasText: '倒垃圾（新時間）' })), '新規則在週四產生');

  // 只刪除這次
  await page.getByRole('button', { name: '刪除「倒垃圾（新時間）」' }).click();
  await page.getByRole('button', { name: /只刪除這次/ }).click();
  check(await gone(page.locator('#view-tasks .todo-title', { hasText: '倒垃圾（新時間）' })), '只刪除這次：這天不再顯示');
  await page.locator('.calendar-day[aria-label^="11/10（"]').click();
  check(await vis(page.locator('#view-tasks .todo-title', { hasText: '倒垃圾（新時間）' })), '其他日期仍顯示');

  // 每月 31 日，月底規則
  await page.getByRole('button', { name: '回到本月' }).click();
  await page.getByRole('button', { name: '清單' }).click();
  await addTask(t, { title: '繳卡費', due: '2026-10-31', repeat: 'monthly', monthDay: 31, monthEnd: '改在該月最後一天' });
  await addTask(t, { title: '月底對帳', due: '2026-10-31', repeat: 'monthly', monthDay: 31, monthEnd: '該月跳過' });
  await page.getByRole('button', { name: '月曆' }).click();
  await page.getByRole('button', { name: '下個月' }).click();
  await page.locator('.calendar-day[aria-label^="11/30（"]').click();
  const nov = await page.locator('#view-tasks .todo-title').allInnerTexts();
  check(nov.includes('繳卡費') && !nov.includes('月底對帳'), '11 月沒有 31 日：「改在月底」出現在 11/30，「跳過」不出現');
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: '下個月' }).click();
  await page.locator('.calendar-day[aria-label^="2/28（"]').first().click();
  const feb = await page.locator('#view-tasks .todo-title').allInnerTexts();
  check(feb.includes('繳卡費') && !feb.includes('月底對帳'), '2027 年 2 月：改在 2/28，跳過的不出現');
  await page.getByRole('button', { name: '上個月' }).click();
  await page.locator('.calendar-day[aria-label^="1/31（"]').first().click();
  const jan = await page.locator('#view-tasks .todo-title').allInnerTexts();
  check(jan.includes('繳卡費') && jan.includes('月底對帳'), '1 月 31 日兩者都出現');
  await t.shot('tasks-recurring');
  check(t.errors.length === 0, `重複任務操作無 JavaScript 錯誤 ${t.errors.join(' | ')}`);
  await t.ctx.close();
}

// ===================== 午夜 =====================

async function suiteMidnight(browser) {
  const t = await open(browser, { hash: '#tasks', time: new Date('2026-10-20T15:58:00Z') }); // 台灣 23:58
  const { page } = t;
  await addTask(t, { title: '今晚截止', due: '2026-10-20' });
  await addTask(t, { title: '每天喝水', due: '2026-10-20', repeat: 'daily' });
  check(JSON.stringify((await visibleTitles(t)).sort()) === JSON.stringify(['今晚截止', '每天喝水'].sort()), '23:58 今日有兩項');
  await page.clock.runFor(3 * 60 * 1000); // 00:01
  check((await page.textContent('#today-label')).includes('10 月 21 日'), '跨午夜後日期自動更新');
  check(JSON.stringify(await visibleTitles(t)) === '["每天喝水"]', '跨午夜：今日只剩新的重複項目');
  await setView(t, '逾期');
  check(JSON.stringify((await visibleTitles(t)).sort()) === JSON.stringify(['今晚截止', '每天喝水'].sort()), '跨午夜：昨天的兩項變逾期');
  check(t.errors.length === 0, `午夜情境無 JavaScript 錯誤 ${t.errors.join(' | ')}`);
  await t.ctx.close();
}

// ===================== 習慣 =====================

async function suiteHabits(browser) {
  const t = await open(browser, { hash: '#habits' });
  const { page } = t;
  await page.getByRole('button', { name: '＋ 新增習慣' }).click();
  await t.save();
  check(await vis(page.locator('#habit-name-error')), '習慣名稱空白顯示錯誤');
  await page.fill('#habit-name', '喝水');
  await t.save();
  await page.getByRole('button', { name: '＋ 新增習慣' }).click();
  await page.fill('#habit-name', '健身');
  await t.dialog.locator('#habit-schedule label:has-text("每週指定星期")').click();
  await t.save();
  check(await vis(page.locator('#habit-days-error')), '每週排程沒選星期時顯示錯誤');
  await t.dialog.getByLabel('星期一').check();
  await t.dialog.getByLabel('星期三').check();
  await t.save();
  let d = await t.read();
  check(d.habits.length === 2 && d.habits[1].schedules[0].days.join() === '1,3' && d.habits[1].createdDate === '2026-10-20', '新增每天與每週一、三的習慣');

  await t.go('today');
  const todayHabits = await page.locator('#view-today .habit-name').allInnerTexts();
  check(JSON.stringify(todayHabits) === '["喝水"]', `今日只列出今天（週二）排定的習慣：${todayHabits}`);
  await page.getByRole('button', { name: '為「喝水」完成今天的打卡' }).click();
  d = await t.read();
  check(d.checkins.length === 1 && d.checkins[0].id === `c_${d.habits[0].id}_20261020`, '今日打卡，id 固定');
  await page.waitForTimeout(500); // 防連點：同一習慣 0.4 秒內的重複點按會被忽略
  await page.getByRole('button', { name: '取消「喝水」今天的打卡' }).dblclick();
  await page.waitForTimeout(100);
  check((await t.read()).checkins.length === 0, '取消打卡（連點兩下只處理一次）');
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: '為「喝水」完成今天的打卡' }).click();

  // 月份紀錄與補登
  await t.go('habits');
  await page.getByRole('button', { name: '「喝水」的月份紀錄與補登' }).click();
  check(await page.locator('.calendar-day[aria-label^="10/21（"]').isDisabled(), '未來日期不能打卡');
  check(await page.locator('.calendar-day[aria-label^="10/19（"]').isDisabled(), '建立日之前不能打卡');
  await page.locator('#form-dialog').getByRole('button', { name: '關閉', exact: true }).click();

  // 把建立日改早，模擬已使用一段時間（補登過去）
  await page.evaluate((k) => {
    const data = JSON.parse(localStorage.getItem(k));
    for (const h of data.habits) {
      h.createdDate = '2026-10-01';
      h.schedules[0].from = '2026-10-01';
    }
    localStorage.setItem(k, JSON.stringify(data));
  }, KEY);
  await page.reload();
  await page.waitForSelector('#view-habits h2');
  await page.getByRole('button', { name: '「喝水」的月份紀錄與補登' }).click();
  await page.locator('.calendar-day[aria-label^="10/15（"]').click();
  await page.locator('.calendar-day[aria-label^="10/16（"]').click();
  d = await t.read();
  check(d.checkins.map((c) => c.date).sort().join() === '2026-10-15,2026-10-16,2026-10-20', '補登過去日期');
  check(await vis(page.locator('#form-dialog').getByText(/本月完成率：/)), '月份紀錄顯示完成率');
  await page.waitForTimeout(500);
  await page.locator('.calendar-day[aria-label^="10/16（"]').click();
  check((await t.read()).checkins.length === 2, '在月份紀錄取消補登');
  await t.shot('habits-month');
  await page.locator('#form-dialog').getByRole('button', { name: '關閉', exact: true }).click();

  const stats = await page.locator('.habit.card', { hasText: '喝水' }).locator('.habit-stats').innerText();
  // 10/1～10/20 每天排定共 20 天（今天已打卡，所以今天也計入），完成 10/15、10/20 兩天
  check(stats.includes('近 30 天 10%（2/20）'), `完成率只算排定日：${stats.replace(/\n/g, ' ')}`);
  const week = await page.locator('.habit.card', { hasText: '健身' }).locator('.week .day').evaluateAll((els) => els.map((e) => e.className.replace('day day--', '')));
  check(JSON.stringify(week) === '["missed","rest","rest","rest","rest","missed","rest"]', `每週一、三的習慣：非排定日不算漏打卡 ${week}`);

  // 編輯排程不改寫過去
  const before = await page.locator('.habit.card', { hasText: '健身' }).locator('.habit-stats').innerText();
  await page.getByRole('button', { name: '編輯「健身」' }).click();
  await t.dialog.locator('#habit-schedule label:has-text("每天")').click();
  await t.save();
  d = await t.read();
  const gym = d.habits.find((h) => h.name === '健身');
  check(gym.schedules.length === 2 && gym.schedules[1].from === '2026-10-20' && gym.schedules[1].days.length === 7, '修改排程從今天起生效');
  const after = await page.locator('.habit.card', { hasText: '健身' }).locator('.habit-stats').innerText();
  const recentPart = (text) => text.split('近 30 天')[1]?.trim();
  check(recentPart(before) === recentPart(after) && recentPart(before) === '0%（0/5）', `修改排程後過去統計不變：${recentPart(before)} → ${recentPart(after)}`);
  const weekAfter = await page.locator('.habit.card', { hasText: '健身' }).locator('.week .day').evaluateAll((els) => els.map((e) => e.className.replace('day day--', '')));
  check(JSON.stringify(weekAfter.slice(0, 6)) === JSON.stringify(week.slice(0, 6)) && weekAfter[6] === 'pending', '過去六天的狀態不變，今天改為待打卡');

  // 封存與還原
  await page.getByRole('button', { name: '封存「喝水」' }).click();
  check(await vis(page.locator('#habits-archived')), '封存後出現在已封存區');
  check((await t.read()).checkins.length === 2, '封存保留打卡紀錄');
  await t.go('today');
  check(!(await page.locator('#view-today .habit-name', { hasText: '喝水' }).count()), '封存的習慣不在今日');
  await t.go('habits');
  await page.getByRole('button', { name: '還原「喝水」' }).click();
  check((await page.locator('.habit.card', { hasText: '喝水' }).locator('.day--done').count()) >= 1, '還原後紀錄仍在');
  await t.shot('habits');
  check(t.errors.length === 0, `習慣操作無 JavaScript 錯誤 ${t.errors.join(' | ')}`);
  await t.ctx.close();
}

// ===================== 回顧 =====================

async function suiteReview(browser) {
  const t = await open(browser, { hash: '#tasks' });
  const { page } = t;
  await addTask(t, { title: '本週完成的事', due: '2026-10-20' });
  await page.getByRole('checkbox', { name: '本週完成的事' }).click();
  await page.waitForTimeout(50);
  await t.go('habits');
  await page.getByRole('button', { name: '＋ 新增習慣' }).click();
  await page.fill('#habit-name', '閱讀');
  await t.save();
  await page.getByRole('button', { name: '為「閱讀」完成今天的打卡' }).click();
  await t.go('growth');
  check(await vis(page.getByText('2026/10/19（一）至 10/25（日）')), '回顧顯示統計期間');
  const summary = await page.getByRole('list', { name: '本週統計' }).innerText();
  check(summary.includes('1 項') && summary.includes('100%') && summary.includes('1 / 1'), `回顧統計：${summary.replace(/\n/g, ' ')}`);
  check(await vis(page.getByText('統計期間與計算方式')), '顯示計算方式說明');
  await page.fill('#review-note', '這週開始固定閱讀。');
  await page.getByRole('button', { name: '儲存筆記' }).click();
  await page.reload();
  await page.waitForSelector('#view-growth h2');
  check((await page.inputValue('#review-note')) === '這週開始固定閱讀。', '回顧筆記重新整理後保留');
  await page.getByRole('button', { name: '上一週' }).click();
  check(await vis(page.getByText('2026/10/12（一）至 10/18（日）')) && (await page.inputValue('#review-note')) === '', '切換到上一週');
  check(await page.getByRole('button', { name: '下一週' }).isEnabled(), '上一週可以往後切換');
  await page.getByRole('button', { name: '下一週' }).click();
  check(await page.getByRole('button', { name: '下一週' }).isDisabled(), '本週不能切換到未來');
  await t.shot('growth-review');
  check(t.errors.length === 0, `回顧操作無 JavaScript 錯誤 ${t.errors.join(' | ')}`);
  await t.ctx.close();
}


// ===================== 財務 =====================

async function addTxn(t, { type = '支出', date, amount, currency, category, account, note }) {
  await t.page.getByRole('button', { name: type === '收入' ? '＋ 收入' : '＋ 支出' }).click();
  if (date) await t.page.fill('#txn-date', date);
  await t.page.fill('#txn-amount', amount);
  if (currency) await t.page.selectOption('#txn-currency', currency);
  if (category) await t.page.selectOption('#txn-category', { label: category });
  if (account) await t.page.selectOption('#txn-account', { label: account });
  if (note) await t.page.fill('#txn-note', note);
  await t.save();
}

async function financeTab(t, label) {
  await t.page.locator('.segmented label', { has: t.page.locator('input[name="finance-tab"]'), hasText: label }).click();
}

async function suiteFinance(browser) {
  const t = await open(browser, { hash: '#finance' });
  const { page } = t;

  // 驗證
  await page.getByRole('button', { name: '＋ 支出' }).click();
  await t.save();
  check(await vis(page.locator('#txn-amount-error')), '金額空白顯示錯誤');
  await page.fill('#txn-amount', '12.5');
  await t.save();
  check((await page.textContent('#txn-amount-error')).includes('不可有小數'), '新台幣不可有小數');
  await page.fill('#txn-amount', '120');
  await page.selectOption('#txn-category', { label: '餐飲' });
  await page.fill('#txn-note', '午餐便當');
  await t.save();
  let d = await t.read();
  check(d.transactions.length === 1 && d.transactions[0].amountMinor === 120 && d.transactions[0].date === '2026-10-20', '新增支出（預設今天、整數金額）');

  await addTxn(t, { type: '收入', amount: '42,000', category: '薪資', note: '十月薪資' });
  await addTxn(t, { amount: '9.99', currency: 'USD', category: '訂閱', note: '海外軟體' });
  await addTxn(t, { amount: '1500', category: '交通', note: '高鐵', date: '2026-10-05' });
  await addTxn(t, { amount: '300', category: '餐飲', note: '上個月聚餐', date: '2026-09-28' });
  check((await page.inputValue('#month-input')) === '2026-09', '新增其他月份的紀錄後切換到該月，方便確認');
  await page.getByRole('button', { name: '下個月', exact: true }).click();
  d = await t.read();
  check(d.transactions.find((x) => x.currency === 'USD').amountMinor === 999, '美元金額以分儲存（9.99 → 999）');
  const summary = await page.locator('.money-summary').innerText();
  check(summary.includes('+NT$42,000') && summary.includes('-NT$1,620') && summary.includes('NT$40,380') && summary.includes('-US$9.99'), `十月收支依幣別分開：${summary.replace(/\n/g, ' ')}`);
  check(await vis(page.getByText('不同幣別分開統計')), '提示不同幣別不相加');
  check((await page.locator('.txn').count()) === 4, '只顯示本月（十月）的紀錄');
  await page.getByRole('button', { name: '上個月', exact: true }).click();
  check((await page.locator('.txn').count()) === 1 && (await page.locator('.money-summary').innerText()).includes('-NT$300'), '切換到九月');
  await page.getByRole('button', { name: '下個月', exact: true }).click();

  // 篩選與搜尋
  await page.locator('details.filters summary').click();
  await page.fill('#txn-search', '便當');
  check((await page.locator('.txn').count()) === 1, '文字搜尋（備註）');
  await page.fill('#txn-search', '1,500');
  check((await page.locator('.txn').count()) === 1, '文字搜尋（金額）');
  await page.fill('#txn-search', '');
  await page.selectOption('#txn-filter-category', { label: '餐飲' });
  check((await page.locator('.txn').count()) === 1, '分類篩選');
  await page.selectOption('#txn-filter-category', '');
  await page.selectOption('#txn-filter-type', 'income');
  check((await page.locator('.txn').count()) === 1, '類型篩選');
  await page.selectOption('#txn-filter-type', '');

  // 編輯與刪除
  await page.getByRole('button', { name: /^編輯 2026-10-05/ }).click();
  await page.fill('#txn-amount', '1490');
  await t.save();
  check((await t.read()).transactions.find((x) => x.note === '高鐵').amountMinor === 1490, '編輯金額');
  await page.getByRole('button', { name: /^刪除 2026-10-05/ }).click();
  await page.locator('#confirm-cancel').click();
  check((await t.read()).transactions.length === 5, '取消刪除時資料不變');
  await page.getByRole('button', { name: /^刪除 2026-10-05/ }).click();
  await t.confirmOk();
  await page.waitForTimeout(100);
  check((await t.read()).transactions.length === 4, '確認後刪除');
  await t.shot('finance-txns');

  // 預算
  await financeTab(t, '預算');
  await page.getByRole('button', { name: '＋ 設定預算' }).click();
  await page.selectOption('#budget-category', { label: '餐飲' });
  await page.fill('#budget-amount', '100');
  await t.save();
  check(await vis(page.getByText('超出預算')) && (await page.locator('.budget').innerText()).includes('超支 NT$20'), '預算超支提示（120 / 100）');
  await page.getByRole('button', { name: '修改「餐飲」預算' }).click();
  await page.fill('#budget-amount', '3,000');
  await t.save();
  check((await page.locator('.budget').innerText()).includes('剩餘 NT$2,880'), '剩餘預算');
  check((await t.read()).budgets.length === 1, '修改預算不會重複建立');

  // 分類與帳戶
  await financeTab(t, '分類與帳戶');
  await page.getByRole('button', { name: '＋ 新增帳戶' }).click();
  await page.fill('#item-name', '台灣銀行');
  await t.save();
  await page.getByRole('button', { name: '＋ 新增分類' }).click();
  await page.fill('#item-name', '寵物');
  await t.save();
  check((await t.read()).categories.some((c) => c.name === '寵物'), '新增分類');
  check((await page.getByRole('button', { name: '刪除「餐飲」' }).count()) === 0, '使用中的分類不能刪除（只能封存）');
  await page.getByRole('button', { name: '刪除「寵物」' }).click();
  await t.confirmOk();
  await page.waitForTimeout(100);
  check(!(await t.read()).categories.some((c) => c.name === '寵物'), '未使用的分類可以刪除');
  await page.getByRole('button', { name: '封存「交通」' }).click();
  check((await t.read()).categories.find((c) => c.id === 'cat_transport').archived === true, '封存分類');
  check(await vis(page.getByText('不是銀行餘額')), '說明帳戶累計不是已核對的銀行餘額');

  // 主要幣別
  await t.go('settings');
  await page.selectOption('#settings-currency', 'USD');
  await t.go('finance');
  await financeTab(t, '收支');
  await page.getByRole('button', { name: '＋ 支出' }).click();
  check((await page.inputValue('#txn-currency')) === 'USD', '主要幣別改為美元後成為新增時的預設值');
  await page.keyboard.press('Escape');
  check(t.errors.length === 0, `收支操作無 JavaScript 錯誤 ${t.errors.join(' | ')}`);
  await t.ctx.close();
}

async function suiteSubscriptions(browser) {
  const t = await open(browser, { hash: '#finance' });
  const { page } = t;
  await financeTab(t, '訂閱');
  const addSub = async ({ name, amount, every = '1', unit = 'month', next, currency }) => {
    await page.getByRole('button', { name: '＋ 新增訂閱' }).click();
    await page.fill('#sub-name', name);
    await page.fill('#sub-amount', amount);
    if (currency) await page.selectOption('#sub-currency', currency);
    await page.fill('#sub-every', every);
    await page.selectOption('#sub-unit', unit);
    await page.fill('#sub-next', next);
    await t.save();
  };
  await page.getByRole('button', { name: '＋ 新增訂閱' }).click();
  await t.save();
  check(await vis(page.locator('#sub-name-error')) && await vis(page.locator('#sub-next-error')), '訂閱必填欄位錯誤');
  await page.keyboard.press('Escape');
  await addSub({ name: '影音串流', amount: '390', next: '2026-10-22' });
  await addSub({ name: '雲端空間', amount: '1490', unit: 'year', next: '2027-01-31' });
  await addSub({ name: '海外工具', amount: '9.99', currency: 'USD', next: '2026-10-21' });
  const estimate = await page.locator('#sub-estimate').locator('..').innerText();
  check(estimate.includes('NT$514') && estimate.includes('NT$6,170') && estimate.includes('含估算') && estimate.includes('US$9.99'), `預估：每月 390 + 1490/12、全年 6,170，美元分開：${estimate.replace(/\n/g, ' ').slice(0, 160)}`);
  const upcoming = await page.locator('.renewal-list').first().innerText();
  check(upcoming.includes('影音串流') && upcoming.includes('海外工具') && upcoming.includes('預估') && !upcoming.includes('雲端空間'), '近期續費（30 天內）只列出接下來會扣款的');

  // 今日頁站內提醒
  await t.go('today');
  check((await page.locator('.summary').innerText()).includes('7 天內續費'), '今日摘要顯示近期續費');
  check(await vis(page.locator('section[aria-labelledby=today-renewals]')), '今日頁顯示續費提醒');
  await page.getByRole('button', { name: '為「影音串流」2026-10-22 的續費建立提醒任務' }).click();
  let d = await t.read();
  const remind = d.tasks.find((x) => x.id.startsWith('t_subrem_'));
  check(remind && remind.dueDate === '2026-10-20' && remind.title === '續費提醒：影音串流', '建立提醒任務（截止日不早於今天）');
  check(await vis(page.locator('section[aria-labelledby=today-renewals]').getByText('✓ 已建立提醒任務')) && (await page.getByRole('button', { name: '為「影音串流」2026-10-22 的續費建立提醒任務' }).count()) === 0, '已建立後不再顯示建立按鈕，避免重複');
  check((await page.locator('#view-today .todo-title', { hasText: '續費提醒：影音串流' }).count()) === 1, '提醒任務出現在今日任務');

  // 記錄扣款（未來日期擋下）
  await t.go('finance');
  await page.getByRole('button', { name: '記錄「影音串流」2026-10-22 的扣款' }).click();
  await t.dialog.getByRole('button', { name: '建立扣款紀錄' }).click();
  check((await page.textContent('#charge-date-error')).includes('不能是未來'), '扣款日不能是未來日期');
  await page.fill('#charge-date', '2026-10-20');
  await t.dialog.getByRole('button', { name: '建立扣款紀錄' }).click();
  d = await t.read();
  const sub = d.subscriptions.find((x) => x.name === '影音串流');
  check(d.transactions.length === 1 && d.transactions[0].subscriptionId === sub.id && d.transactions[0].chargeDate === '2026-10-22' && sub.nextRenewal === '2026-11-22', '記錄扣款：建立實際支出並推進下次續費日');
  await financeTab(t, '收支');
  check((await page.locator('.money-summary').innerText()).includes('-NT$390'), '扣款計入十月支出（一次）');
  check(await vis(page.getByText('🔁 訂閱：影音串流')), '交易標示所屬訂閱');

  // 既有交易連結（避免重複記帳）
  await addTxn(t, { amount: '9.99', currency: 'USD', note: 'TOOL*CHARGE', date: '2026-10-19' });
  await financeTab(t, '訂閱');
  await page.getByRole('button', { name: '記錄「海外工具」2026-10-21 的扣款' }).click();
  check(await vis(t.dialog.getByText('可能已經記錄過')), '找到金額相同、日期相近的既有支出');
  await t.dialog.getByRole('button', { name: /連結為這次扣款/ }).click();
  d = await t.read();
  check(d.transactions.length === 2 && d.transactions.find((x) => x.note === 'TOOL*CHARGE').chargeDate === '2026-10-21', '連結既有交易，不新增第二筆');
  check(d.subscriptions.find((x) => x.name === '海外工具').nextRenewal === '2026-11-21', '連結後推進下次續費日');

  // 暫停、取消、封存、刪除
  await page.getByRole('button', { name: '暫停「雲端空間」' }).click();
  const est2 = await page.locator('#sub-estimate').locator('..').innerText();
  check(est2.includes('NT$390') && !est2.includes('NT$514'), '暫停的訂閱不計入預估');
  await page.getByRole('button', { name: '恢復「雲端空間」' }).click();
  await page.getByRole('button', { name: '將「雲端空間」標示為已取消' }).click();
  check((await t.read()).subscriptions.find((x) => x.name === '雲端空間').status === 'cancelled', '取消訂閱');
  await page.getByRole('button', { name: '刪除「影音串流」' }).click();
  check(await vis(page.getByText('只能封存，不能刪除')), '已有扣款紀錄的訂閱不能刪除');
  await page.getByRole('button', { name: '封存「影音串流」' }).click();
  check((await t.read()).subscriptions.find((x) => x.name === '影音串流').archived === true, '封存訂閱');
  await t.shot('finance-subs');
  check(t.errors.length === 0, `訂閱操作無 JavaScript 錯誤 ${t.errors.join(' | ')}`);
  await t.ctx.close();
}

async function suiteCsv(browser) {
  const t = await open(browser, { hash: '#finance' });
  const { page } = t;
  await addTxn(t, { amount: '120', category: '餐飲', note: '午餐', date: '2026-10-01' });
  await financeTab(t, '匯入匯出');
  const csvPath = path.join(OUT, 'bank.csv');
  fs.writeFileSync(
    csvPath,
    '﻿日期,金額,說明,類別,帳戶\r\n' +
      '2026/10/01,-120,午餐,餐飲,現金\r\n' + // 與現有重複
      '2026/10/02,-80,咖啡,餐飲,現金\r\n' +
      '2026/10/02,-80,咖啡,餐飲,現金\r\n' + // 檔案內重複
      '2026/10/05,"52,000",薪水,薪資,台灣銀行\r\n' +
      '2026/13/01,-10,錯誤日期,,\r\n' +
      '2026/10/06,-300,"飼料, 罐頭",寵物,\r\n',
  );
  await page.setInputFiles('#csv-file', csvPath);
  check((await page.inputValue('#csv-map-date')) === '0' && (await page.inputValue('#csv-map-note')) === '2' && (await page.inputValue('#csv-sign')) === 'negative', '自動對應欄位（日期、說明、負數為支出）');
  await page.getByRole('button', { name: '3. 預覽與檢查' }).click();
  check(await vis(page.getByText('可匯入 3 筆、可能重複 2 筆、錯誤 1 筆')), '預覽：可匯入、重複、錯誤筆數');
  check(await vis(page.getByText('會新增分類：寵物（支出）')) && await vis(page.getByText('會新增帳戶：台灣銀行')), '預覽列出會新增的分類與帳戶');
  check((await page.locator('.csv-table tbody tr').count()) === 6, '預覽表格逐列顯示');
  await page.getByRole('button', { name: '確認匯入 3 筆' }).click();
  await page.locator('#confirm-cancel').click();
  check((await t.read()).transactions.length === 1, '取消確認時不匯入');
  await page.getByRole('button', { name: '確認匯入 3 筆' }).click();
  await t.confirmOk();
  await page.waitForTimeout(150);
  let d = await t.read();
  check(d.transactions.length === 4 && d.transactions.filter((x) => x.source === 'csv').length === 3, '匯入 3 筆（略過重複與錯誤）');
  check(d.transactions.some((x) => x.note === '飼料, 罐頭'), '引號內的逗號正確解析');
  // 再匯入同一個檔案
  await page.setInputFiles('#csv-file', csvPath);
  await page.getByRole('button', { name: '3. 預覽與檢查' }).click();
  check(await vis(page.getByText('可匯入 0 筆、可能重複 5 筆')), '同一個檔案再匯入：全部標示為可能重複');
  check(await page.getByRole('button', { name: '確認匯入 0 筆' }).isDisabled(), '沒有可匯入的資料時不能確認');
  await page.getByRole('button', { name: '取消匯入' }).first().click();

  // 匯出
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '匯出收支 CSV' }).click()]);
  const exportPath = path.join(OUT, dl.suggestedFilename());
  await dl.saveAs(exportPath);
  const content = fs.readFileSync(exportPath, 'utf8');
  check(dl.suggestedFilename() === 'daily-habit-transactions-2026-10-20.csv' && content.startsWith('﻿日期,類型,金額,幣別') && content.includes('"飼料, 罐頭"'), '匯出收支 CSV（含 BOM、標題、引號）');
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '匯出訂閱 CSV' }).click()]);
  check(dl2.suggestedFilename() === 'daily-habit-subscriptions-2026-10-20.csv', '匯出訂閱 CSV');
  // 匯出的檔案可以再匯入（全部重複）
  await page.setInputFiles('#csv-file', exportPath);
  check((await page.inputValue('#csv-sign')) === 'type', '匯出的 CSV 再匯入時自動使用「類型」欄位');
  await page.getByRole('button', { name: '3. 預覽與檢查' }).click();
  check(await vis(page.getByText('可匯入 0 筆、可能重複 4 筆')), '匯出後再匯入不會重複記帳');
  await t.shot('finance-csv');
  check(t.errors.length === 0, `CSV 操作無 JavaScript 錯誤 ${t.errors.join(' | ')}`);
  await t.ctx.close();
}

// ===================== 遊戲化 =====================

async function suiteGame(browser) {
  const t = await open(browser, { hash: '#tasks' });
  const { page } = t;
  const coins = async () => (await t.read()).ledger.reduce((sum, e) => sum + e.coins, 0);
  const xp = async () => (await t.read()).ledger.reduce((sum, e) => sum + e.xp, 0);

  await addTask(t, { title: '重要報告', due: '2026-10-20', priority: '高' });
  await page.getByRole('checkbox', { name: '重要報告' }).click();
  await page.waitForTimeout(100);
  check(await vis(page.locator('#toast', { hasText: '+50 經驗值、+16 金幣' })), '完成任務時提示獲得的經驗值與金幣（含首次完成成就）');
  let d = await t.read();
  check(d.ledger.length === 2 && (await xp()) === 50 && (await coins()) === 16, '帳本：任務獎勵 30/6 + 成就「踏出第一步」20/10');

  // 反覆取消與完成
  for (let i = 0; i < 3; i++) {
    await page.getByRole('checkbox', { name: '重要報告' }).click();
    await page.waitForTimeout(80);
    await page.getByRole('checkbox', { name: '重要報告' }).click();
    await page.waitForTimeout(80);
  }
  check((await xp()) === 50 && (await coins()) === 16, '反覆取消、重新完成不會多領');
  d = await t.read();
  check(d.ledger.filter((e) => e.kind === 'achievement').length === 1, '成就不會重複領取');
  check(new Set(d.ledger.map((e) => e.id)).size === d.ledger.length, '帳本 id 不重複');

  // 習慣：打卡與補登相同規則
  await t.go('habits');
  await page.getByRole('button', { name: '＋ 新增習慣' }).click();
  await page.fill('#habit-name', '冥想');
  await t.save();
  await page.getByRole('button', { name: '為「冥想」完成今天的打卡' }).click();
  await page.waitForTimeout(100);
  check((await coins()) === 16 + 3 + 10, '打卡 +3 金幣，加上首次打卡成就 +10');
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: '取消「冥想」今天的打卡' }).click();
  await page.waitForTimeout(100);
  check((await coins()) === 16 + 10, '取消打卡撤銷打卡獎勵（成就保留）');

  // 成長頁：角色、成就、商店
  await t.go('growth');
  check(await vis(page.locator('.character-level', { hasText: 'Lv.1' })), '顯示等級');
  check(await vis(page.getByText(/再 \d+ 點升到 Lv.2/)), '顯示升級進度');
  check((await page.locator('.achievement.is-unlocked').count()) === 2, '已解鎖兩個成就');
  await page.getByRole('button', { name: '＋ 新增獎勵' }).click();
  await page.fill('#reward-name', '看電影');
  await page.fill('#reward-cost', '20');
  await t.save();
  await page.getByRole('button', { name: '＋ 新增獎勵' }).click();
  await page.fill('#reward-name', '新耳機');
  await page.fill('#reward-cost', '500');
  await t.save();
  check(await page.getByRole('button', { name: /兌換「新耳機」（金幣不足）/ }).isDisabled(), '金幣不足時不能兌換');
  await page.getByRole('button', { name: /兌換「看電影」/ }).click();
  await t.confirmOk();
  await page.waitForTimeout(100);
  check((await coins()) === 6, '兌換後扣除金幣（26 - 20）');
  check(await vis(page.locator('.ledger--redeem')), '獎勵紀錄顯示兌換');

  // 撤銷造成負數：取消完成高優先任務（-6）
  await t.go('tasks');
  await setView(t, '已完成');
  await page.getByRole('checkbox', { name: '重要報告' }).click();
  await page.waitForTimeout(100);
  check((await coins()) === 0, '撤銷任務獎勵後餘額 0');
  await t.go('growth');
  await page.getByRole('button', { name: /退回兌換/ }).click();
  await t.confirmOk();
  await page.waitForTimeout(100);
  check((await coins()) === 20, '退回兌換歸還金幣');
  check((await page.getByRole('button', { name: /退回兌換/ }).count()) === 0 && (await vis(page.getByText('已退回'))), '每筆兌換只能退回一次');
  check((await page.locator('.ledger--revoke').count()) >= 1, '獎勵紀錄保留撤銷紀錄');
  await t.shot('growth-game');

  // 關閉遊戲化
  await t.go('settings');
  await page.getByLabel(/開啟遊戲化/).uncheck();
  await t.go('growth');
  check(await vis(page.getByRole('heading', { name: '遊戲化已關閉' })) && (await page.locator('.character').count()) === 0, '關閉後成長頁隱藏角色，只保留回顧');
  await t.go('today');
  check(!(await page.locator('.summary').innerText()).includes('Lv.'), '今日摘要不再顯示等級');
  const before = (await t.read()).ledger.length;
  await t.go('tasks');
  await setView(t, '全部');
  await page.getByRole('checkbox', { name: '重要報告' }).click();
  await page.waitForTimeout(100);
  check((await t.read()).ledger.length === before, '關閉期間任務仍可完成，但不計算獎勵');
  await t.go('growth');
  await page.getByRole('button', { name: '開啟遊戲化' }).click();
  await page.waitForTimeout(100);
  check((await coins()) === 26 && (await xp()) === 70, '重新開啟後依目前完成狀態補齊（與一直開啟相同）');
  check(t.errors.length === 0, `遊戲化操作無 JavaScript 錯誤 ${t.errors.join(' | ')}`);
  await t.ctx.close();
}

async function suiteGameMigration(browser) {
  // 第一版的資料升級後，過去完成的任務與打卡會補記獎勵
  const t = await open(browser, { hash: '#growth' });
  const { page } = t;
  const v1 = {
    version: 1,
    savedAt: '2026-10-19T00:00:00.000Z',
    todos: [{ id: 't_old1', title: '舊的完成任務', note: '', dueDate: null, priority: 'low', done: true, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z', completedAt: '2026-10-02T00:00:00.000Z' }],
    habits: [{ id: 'h_old1', name: '舊習慣', createdDate: '2026-10-10', archived: false, archivedDate: null, createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z' }],
    checkins: [{ habitId: 'h_old1', date: '2026-10-18', createdAt: null }],
  };
  await page.evaluate((d) => localStorage.setItem('daily-habit:data', JSON.stringify(d)), v1);
  await page.reload();
  await page.waitForSelector('#view-growth h2');
  await page.waitForTimeout(150);
  const d = await t.read();
  check(d.version === 2 && d.ledger.some((e) => e.source === 'task:t_old1') && d.ledger.some((e) => e.source.startsWith('checkin:')), '從第一版升級後補記歷史完成的獎勵');
  await page.reload();
  await page.waitForSelector('#view-growth h2');
  check((await t.read()).ledger.length === d.ledger.length, '重新整理不會重複補記');
  check(t.errors.length === 0, `升級補記無 JavaScript 錯誤 ${t.errors.join(' | ')}`);
  await t.ctx.close();
}

// ===================== 通用：部署、版面、鍵盤、備份、儲存 =====================

async function suiteGeneral(browser) {
  // 部署子路徑：所有資源成功載入
  {
    const t = await open(browser, { time: null });
    const { page } = t;
    const bad = [];
    const loaded = [];
    page.on('response', (r) => {
      loaded.push(r.url());
      if (r.status() >= 400) bad.push(`${r.status()} ${r.url()}`);
    });
    page.on('requestfailed', (r) => bad.push(`failed ${r.url()}`));
    await page.reload();
    await page.waitForSelector('#view-today h2');
    const base = new globalThis.URL(URL).pathname;
    check(bad.length === 0, `部署路徑 ${base} 下沒有載入失敗的資源 ${bad.join(' ')}`);
    check(loaded.filter((u) => u.includes('/js/')).length >= 15 && loaded.some((u) => u.endsWith(`${base}css/style.css`)), `樣式與 ${loaded.filter((u) => u.includes('/js/')).length} 個程式檔以相對路徑載入`);
    if (base !== '/') {
      await page.goto(URL.replace(/\/$/, ''));
      await page.waitForSelector('#view-today h2');
      check(page.url().startsWith(URL), '網址沒有結尾斜線時也能正常開啟');
    }
    await t.go('settings');
    // js/config.js 是否已填入 Supabase：兩種情況都要能以本機模式使用
    const configured = await page.evaluate(async (u) => Boolean((await import(u)).SUPABASE_URL), new globalThis.URL('js/config.js', URL).href);
    const statusText = (await page.locator('#status-bar').innerText()).trim();
    if (configured) {
      check(await vis(page.getByText('登入後，資料會同步到你的雲端帳號')), '已設定 Supabase、未登入時設定頁顯示登入與註冊');
      check(statusText.includes('本機模式'), `已設定雲端、未登入時狀態列顯示本機模式（${statusText}）`);
    } else {
      check(await vis(page.getByText('雲端同步尚未設定')), '未設定 Supabase 時說明以本機模式運作');
      check(statusText === '', '未設定雲端時不顯示同步狀態');
    }
    check(t.errors.length === 0, `無 JavaScript 錯誤 ${t.errors.join(' | ')}`);
    await t.ctx.close();
  }

  // 手機與電腦：每個區域無橫向捲動、觸控範圍
  for (const mobile of [true, false]) {
    const t = await open(browser, { mobile });
    const { page } = t;
    await page.getByRole('button', { name: '載入範例資料' }).click();
    await page.waitForTimeout(100);
    const label = mobile ? '手機 375px' : '電腦 1280px';
    for (const view of ['today', 'tasks', 'habits', 'finance', 'growth', 'settings']) {
      await t.go(view);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check(overflow <= 0, `${label}「${view}」無橫向捲動（${overflow}）`);
      if (mobile) {
        const small = await page.evaluate(() =>
          [...document.querySelectorAll('.view:not([hidden]) button, a.tab, .view:not([hidden]) .segmented span, label.todo-check, .view:not([hidden]) input[type=text], .view:not([hidden]) input[type=date], .view:not([hidden]) select')]
            .filter((e) => e.offsetParent)
            .map((e) => {
              const r = e.getBoundingClientRect();
              return { t: (e.getAttribute('aria-label') || e.textContent || e.id).trim().slice(0, 14), w: Math.round(r.width), h: Math.round(r.height) };
            })
            .filter((x) => x.w < 44 || x.h < 44),
        );
        check(small.length === 0, `${label}「${view}」可點擊元素至少 44×44px ${JSON.stringify(small.slice(0, 5))}`);
      }
      await t.shot(`${mobile ? 'm' : 'd'}-${view}`);
    }
    // 財務的每個分頁
    await t.go('finance');
    for (const tab of ['訂閱', '預算', '分類與帳戶', '匯入匯出']) {
      await page.locator('.segmented label', { hasText: tab }).click();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check(overflow <= 0, `${label} 財務「${tab}」無橫向捲動`);
    }
    // 對話框不超出畫面
    await t.go('tasks');
    await page.getByRole('button', { name: '＋ 新增任務' }).click();
    await page.selectOption('#task-repeat', 'weekly');
    const box = await page.locator('#form-dialog').boundingBox();
    const vw = await page.evaluate(() => window.innerWidth);
    check(box.x >= 0 && box.x + box.width <= vw, `${label} 任務表單對話框在畫面內`);
    await page.keyboard.press('Escape');
    check(t.errors.length === 0, `${label} 無 JavaScript 錯誤 ${t.errors.join(' | ')}`);
    await t.ctx.close();
  }

  // 鍵盤操作
  {
    const t = await open(browser, { mobile: false });
    const { page } = t;
    await page.getByRole('button', { name: '載入範例資料' }).click();
    await page.reload();
    await page.waitForSelector('#view-today h2');
    await page.keyboard.press('Tab');
    check((await page.evaluate(() => document.activeElement.textContent.trim())) === '跳到主要內容', '第一個 Tab 是「跳到主要內容」');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    check((await page.evaluate(() => document.activeElement.textContent.trim())) === '任務', 'Tab 到導覽「任務」');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#view-tasks:not([hidden])');
    check((await page.evaluate(() => document.activeElement.id)) === 'heading-tasks', '切換區域後焦點移到標題');
    await page.locator('#view-tasks input[type=checkbox]').first().focus();
    await page.keyboard.press('Space');
    await page.waitForTimeout(100);
    check(String(await page.evaluate(() => document.activeElement.dataset.focusKey)).startsWith('task-done-'), '鍵盤勾選後焦點仍在勾選框');
    await page.getByRole('button', { name: '＋ 新增任務' }).focus();
    await page.keyboard.press('Enter');
    check((await page.evaluate(() => document.activeElement.id)) === 'task-title', '開啟表單後焦點在第一個欄位');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(50);
    check((await page.evaluate(() => document.activeElement.dataset.focusKey)) === 'tasks-add', 'Esc 關閉對話框後焦點回到開啟按鈕');
    // 方向鍵切換視圖（原生 radio）
    await page.locator('input[name="task-view"]').first().focus();
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(50);
    check((await page.locator('input[name="task-view"]:checked').getAttribute('value')) === 'overdue', '方向鍵切換任務視圖');
    check(t.errors.length === 0, `鍵盤操作無 JavaScript 錯誤 ${t.errors.join(' | ')}`);
    await t.ctx.close();
  }

  // 使用者輸入以文字顯示
  {
    const t = await open(browser, { hash: '#tasks' });
    const { page } = t;
    const xss = '<img src=x onerror="window.__xss=1">';
    await addTask(t, { title: xss, note: '<b>粗體</b>', tags: '<script>' });
    await setView(t, '全部');
    check(await vis(page.locator('.todo-title', { hasText: xss })), '任務名稱以文字顯示');
    check((await page.locator('#view-tasks img, #view-tasks b').count()) === 0 && !(await page.evaluate(() => window.__xss)), '輸入內容沒有被當成 HTML 執行');
    await t.ctx.close();
  }

  // 完整備份：匯出、清除、還原；無效備份不覆蓋
  {
    const t = await open(browser, { hash: '#settings' });
    const { page } = t;
    await page.getByRole('button', { name: '載入範例資料' }).click();
    await page.waitForTimeout(100);
    const original = await t.read();
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '下載備份檔' }).click()]);
    check(dl.suggestedFilename() === 'daily-habit-backup-2026-10-20.json', `備份檔名含日期：${dl.suggestedFilename()}`);
    const backupPath = path.join(OUT, 'full-backup.json');
    await dl.saveAs(backupPath);
    const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
    check(backup.app === 'daily-habit' && backup.version === 2 && backup.data.transactions.length > 0 && backup.data.ledger.length > 0, '備份包含任務、財務與遊戲紀錄');
    await page.getByRole('button', { name: '清除所有資料…' }).click();
    await t.confirmOk();
    await page.waitForTimeout(100);
    check((await t.read()).tasks.length === 0, '清除所有資料');
    await page.setInputFiles('#import-file', backupPath);
    check(await vis(page.getByText('✓ 備份檔檢查通過')), '備份檢查通過並顯示筆數');
    await page.getByRole('button', { name: '以此備份還原…' }).click();
    await t.confirmOk();
    await page.waitForTimeout(150);
    const restored = await t.read();
    // 還原時資料會依規格重新整理欄位順序，因此用與欄位順序無關的方式比較內容
    const stable = (v) => (v && typeof v === 'object' ? (Array.isArray(v) ? `[${v.map(stable).join(',')}]` : `{${Object.keys(v).sort().map((k) => `${k}:${stable(v[k])}`).join(',')}}`) : JSON.stringify(v));
    const strip = (d) => stable(['tasks', 'series', 'habits', 'checkins', 'transactions', 'subscriptions', 'budgets', 'rewards', 'ledger'].map((k) => d[k]));
    check(strip(restored) === strip(original), '還原後資料與匯出時完全相同（含財務與獎勵紀錄）');

    const v1Path = path.join(OUT, 'v1-backup.json');
    fs.writeFileSync(v1Path, JSON.stringify({ app: 'daily-habit', version: 1, exportedAt: '2026-10-01T00:00:00.000Z', data: { todos: [{ id: 't_v1', title: '第一版的待辦', note: '', dueDate: null, priority: 'low', done: false, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', completedAt: null }], habits: [], checkins: [] } }));
    await page.setInputFiles('#import-file', v1Path);
    check(await vis(page.getByText('還原時會自動轉換為版本 2')), '第一版備份可還原並提示會轉換');
    await page.getByRole('button', { name: '取消', exact: true }).click();

    const cases = [
      ['不支援的新版本', JSON.stringify({ ...backup, version: 3 }), /版本 3/],
      ['檔案被截斷', fs.readFileSync(backupPath, 'utf8').slice(0, 300), /JSON/],
      ['其他程式的檔案', JSON.stringify({ hello: 1 }), /不是/],
      ['錯誤日期', JSON.stringify({ ...backup, data: { ...backup.data, tasks: [{ ...backup.data.tasks[0], dueDate: '2026-02-30' }] } }), /2026-02-30/],
      ['錯誤金額', JSON.stringify({ ...backup, data: { ...backup.data, transactions: [{ ...backup.data.transactions[0], amountMinor: -5 }] } }), /金額/],
      ['重複識別碼', JSON.stringify({ ...backup, data: { ...backup.data, habits: [backup.data.habits[0], backup.data.habits[0]] } }), /重複/],
    ];
    for (const [name, text, re] of cases) {
      const before = await page.evaluate((k) => localStorage.getItem(k), KEY);
      const file = path.join(OUT, 'bad.json');
      fs.writeFileSync(file, text);
      await page.setInputFiles('#import-file', file);
      const shown = await vis(page.getByText('✕ 無法使用這個備份檔'));
      const message = await page.locator('.import-preview').innerText();
      const after = await page.evaluate((k) => localStorage.getItem(k), KEY);
      check(shown && re.test(message) && before === after && (await page.getByRole('button', { name: '以此備份還原…' }).count()) === 0, `無效備份（${name}）被拒絕，資料未變更`);
      await page.getByRole('button', { name: '關閉', exact: true }).click();
    }
    await t.ctx.close();
  }

  // 儲存失敗、資料損壞、無法使用 localStorage
  {
    const t = await open(browser, { hash: '#tasks' });
    const { page } = t;
    await addTask(t, { title: '已存在的任務' });
    await page.evaluate(() => {
      Storage.prototype.setItem = function () {
        const e = new Error('full');
        e.name = 'QuotaExceededError';
        throw e;
      };
    });
    await addTask(t, { title: '存不進去' });
    check(await vis(page.getByText('瀏覽器儲存空間已滿')), '儲存失敗時顯示明確訊息');
    check(!(await vis(page.locator('.todo-title', { hasText: '存不進去' }), 500)), '儲存失敗時不套用變更');
    await page.reload();
    await page.waitForSelector('#view-tasks h2');
    await page.evaluate((k) => localStorage.setItem(k, '{"version":2,"tasks":[{"id":'), KEY);
    await page.reload();
    check(await vis(page.getByText('無法讀取已儲存的資料')), '資料損壞時顯示救援畫面');
    check((await page.evaluate((k) => localStorage.getItem(k), KEY)) === '{"version":2,"tasks":[{"id":', '損壞的資料沒有被覆寫');
    await page.getByRole('button', { name: '改用空白資料開始…' }).click();
    await t.confirmOk();
    await page.waitForTimeout(150);
    const keys = await page.evaluate(() => Object.keys(localStorage));
    check(keys.some((k) => k.startsWith('daily-habit:corrupt-')), '改用空白資料前另存了損壞的原始內容');
    await t.ctx.close();
  }
  {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 812 } });
    await ctx.addInitScript(() => Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('denied', 'SecurityError'); } }));
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e)));
    await page.goto(URL);
    check(await vis(page.getByText('瀏覽器目前不允許儲存資料')), '無法使用 localStorage 時顯示警告，仍可暫時使用');
    check(errs.length === 0, `無法儲存時沒有 JavaScript 錯誤 ${errs.join(' | ')}`);
    await ctx.close();
  }
}

// ===================== 安裝與離線 =====================

async function suitePwa(browser) {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, timezoneId: 'Asia/Taipei' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(URL);
  await page.waitForSelector('#view-today h2');
  const manifestHref = await page.getAttribute('link[rel=manifest]', 'href');
  const manifest = await page.evaluate(async (href) => (await fetch(href)).json(), manifestHref);
  check(manifest.name === '每日管理中心' && manifest.display === 'standalone' && manifest.start_url === './#today' && manifest.icons.length >= 3, '安裝設定（manifest）可讀取，含名稱、獨立視窗模式與圖示');
  const iconOk = await page.evaluate(async () => (await fetch('icons/icon-512.png')).ok);
  check(iconOk, '圖示檔可載入');
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  check(scope === URL, `離線快取已啟用，範圍為網站路徑（${scope}）`);
  await page.reload();
  await page.waitForSelector('#view-today h2');
  check(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)), '重新整理後頁面由離線快取控管');

  // 離線
  await ctx.setOffline(true);
  await page.reload();
  await page.waitForSelector('#view-today h2', { timeout: 10000 });
  check(await vis(page.getByText('歡迎使用！')), '離線時仍可開啟網站');
  for (const view of ['tasks', 'habits', 'finance', 'growth', 'settings']) {
    await page.evaluate((v) => (location.hash = v), `#${view}`);
    await page.waitForSelector(`#view-${view}:not([hidden]) h2`);
  }
  check(true, '離線時六個區域都能切換');
  await page.evaluate(() => (location.hash = '#tasks'));
  await page.getByRole('button', { name: '＋ 新增任務' }).click();
  await page.fill('#task-title', '離線新增的任務');
  await page.locator('#form-dialog').getByRole('button', { name: '儲存', exact: true }).click();
  const saved = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)).tasks.map((t) => t.title), KEY);
  check(saved.includes('離線新增的任務'), '離線時新增的資料保存在裝置上');
  await page.reload();
  await page.waitForSelector('#view-tasks h2');
  await page.locator('.segmented label', { hasText: '全部' }).first().click();
  check(await vis(page.locator('.todo-title', { hasText: '離線新增的任務' })), '離線重新整理後資料仍在');
  await page.evaluate(() => (location.hash = '#settings'));
  check(await vis(page.getByRole('heading', { name: '安裝到主畫面與離線使用' })) && (await vis(page.getByText('尚未提供推播通知'))), '設定頁說明安裝方式與推播限制');
  await ctx.setOffline(false);
  check(errors.length === 0, `離線操作無 JavaScript 錯誤 ${errors.join(' | ')}`);
  await ctx.close();
}

const SUITES = {
  general: [suiteGeneral],
  tasks: [suiteTasks, suiteRecurring, suiteMidnight],
  habits: [suiteHabits],
  review: [suiteReview],
  finance: [suiteFinance, suiteSubscriptions, suiteCsv],
  game: [suiteGame, suiteGameMigration],
  pwa: [suitePwa],
};

(async () => {
  const browser = await chromium.launch();
  for (const [name, suites] of Object.entries(SUITES)) {
    if (ONLY.length && !ONLY.includes(name)) continue;
    console.log(`\n## ${name}`);
    for (const suite of suites) {
      try {
        await suite(browser);
      } catch (error) {
        check(false, `${suite.name} 發生例外：${error.message.split('\n').slice(0, 3).join(' ')}`);
      }
    }
  }
  await browser.close();
  console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}：${passes} 項通過（截圖：${OUT}）`);
  process.exit(failures ? 1 : 0);
})();
