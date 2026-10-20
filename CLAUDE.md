# CLAUDE.md

給協助維護本專案的 AI 與開發者的說明。專案擁有者是初學者，請保持簡單、可直接部署在 GitHub Pages。

## 專案概要

- 每日待辦與習慣管理工具，純前端：原生 HTML、CSS、JavaScript（ES Modules），**沒有建置流程、沒有外部相依套件、沒有 CDN、沒有後端**。
- 部署：GitHub Pages，從 `main` 分支根目錄發布，網址在子路徑 `/daily-habit/` 下。所有資源必須用**相對路徑**（`css/style.css`、`js/app.js`），不可用 `/` 開頭的絕對路徑。
- 介面文字一律使用繁體中文。

## 結構

| 檔案 | 用途 |
| --- | --- |
| `index.html` | 頁面骨架、對話框（`<dialog>`）、導覽 |
| `css/style.css` | 樣式；手機（約 375px）底部導覽，768px 以上改為頂部導覽；支援深色模式 |
| `js/app.js` | 畫面繪製與事件處理（唯一碰 DOM 的業務模組） |
| `js/dom.js` | `h()` 建立元素；**一律以文字節點加入使用者輸入，不使用 innerHTML** |
| `js/dates.js` | 當地日期鍵 `YYYY-MM-DD`、加減日、距午夜毫秒數 |
| `js/todos.js` | 待辦驗證、建立、篩選、排序、今日／逾期 |
| `js/habits.js` | 習慣、打卡（去重）、七天紀錄、連續天數 |
| `js/stats.js` | 統計數字 |
| `js/schema.js` | 資料格式版本、`validateData`、`migrateData` |
| `js/backup.js` | 備份產生、檔名、驗證 |
| `js/storage.js` | localStorage 讀寫、損壞與寫入失敗處理 |
| `js/sample.js` | 使用者按鈕觸發的範例資料（不得含真實個資） |
| `tests/*.test.js` | `node --test` 測試 |
| `scripts/browser-check.cjs` | 選用的 Playwright 端到端檢查 |

邏輯模組（`dates`、`todos`、`habits`、`stats`、`schema`、`backup`、`storage`、`sample`、`ids`）**不可存取 DOM 或 `window`**，以便在 Node.js 測試。`storage.js` 的函式接收 storage 物件參數。

## 指令

```bash
npm test                       # 執行所有單元測試（node --test，Node 18+，無需安裝套件）
python3 -m http.server 8000    # 本機預覽 http://localhost:8000/（不能用 file:// 開啟）

# 選用：瀏覽器檢查（需 Playwright + Chromium）
BASE_URL=http://localhost:8000/ node scripts/browser-check.cjs
```

## 日期規則（重要）

- 「今天」一律依使用者裝置的**當地日期**：`toDateKey(new Date())`。
- **禁止**用 `toISOString().slice(0, 10)` 取得日期（那是 UTC，台灣 00:00–07:59 會變成前一天）。
- 日期鍵格式固定 `YYYY-MM-DD`，可直接字串比較。
- 測試在檔案開頭設定 `process.env.TZ = 'Asia/Taipei'`，修改日期邏輯時務必保留台灣凌晨與跨午夜的測試。
- `app.js` 以午夜計時器、每分鐘檢查、`visibilitychange`／`focus` 事件更新「今天」。

## 資料格式與相容性（修改時必須遵守）

localStorage key：`daily-habit:data`（另有 `daily-habit:meta` 只存上次匯出時間；`daily-habit:corrupt-*`、`daily-habit:before-v*` 為保留的舊資料，不可自動刪除）。

儲存格式（版本 1）：

```json
{
  "version": 1,
  "savedAt": "ISO 時間",
  "todos": [{ "id": "t_…", "title": "", "note": "", "dueDate": "YYYY-MM-DD 或 null", "priority": "high|medium|low", "done": false, "createdAt": "ISO", "updatedAt": "ISO", "completedAt": "ISO 或 null" }],
  "habits": [{ "id": "h_…", "name": "", "createdDate": "YYYY-MM-DD", "archived": false, "archivedDate": "YYYY-MM-DD 或 null", "createdAt": "ISO", "updatedAt": "ISO" }],
  "checkins": [{ "habitId": "h_…", "date": "YYYY-MM-DD", "createdAt": "ISO 或 null" }]
}
```

備份檔格式：`{ "app": "daily-habit", "version": 1, "exportedAt": "ISO", "data": { todos, habits, checkins } }`。

規則：

1. **不可以清空或覆蓋使用者資料作為修復方式。** 讀取失敗時進入救援畫面，原始內容保持不動；離開救援前先另存到 `daily-habit:corrupt-*`。
2. 寫入失敗時不套用變更（`commit()` 先存再更新畫面）。
3. 要改資料格式時：
   - `schema.js` 的 `CURRENT_VERSION` 加 1；
   - 在 `MIGRATIONS` 新增「舊版本 → 新版本」轉換函式，**不可刪除舊的轉換**；
   - 更新 `validateData`；
   - 新增測試：舊版本的 localStorage 資料與舊版本備份檔都能轉換並通過驗證；
   - `storage.js` 升級時會先把舊原始資料存到 `daily-habit:before-v<舊版本>`。
4. 不可更改 `STORAGE_KEY`、備份的 `app` 識別值或已存在欄位的意義；新增欄位需提供預設值。
5. 新版程式必須能匯入所有舊版本的備份；遇到比程式新的版本要拒絕並說明，不可覆蓋。
6. 打卡同一習慣同一天只能一筆（`setCheckin`、`dedupeCheckins`）。

## 其他慣例

- 使用者輸入只能透過 `h()`／`textContent` 顯示；`aria-label` 等屬性用 `setAttribute`。
- 可重新繪製的按鈕與輸入框要有 `data-focus-key`，讓鍵盤焦點在重繪後留在原處。
- 狀態不能只用顏色區分，需搭配文字或符號（✓、✕、○ 等）。
- 不要把使用者資料、備份檔（`daily-habit-backup-*.json`）提交到儲存庫。
- 修改後至少執行 `npm test`；改到畫面時，盡量用瀏覽器在約 375px 與桌面寬度檢查。
