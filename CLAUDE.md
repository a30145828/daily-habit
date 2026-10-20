# CLAUDE.md

給協助維護本專案的 AI 與開發者的說明。專案擁有者是初學者，請保持簡單、可直接部署在 GitHub Pages。

## 範圍

本專案包含三個互相整合的模組：個人管理中心 2.0（任務、習慣、回顧）、個人財務與訂閱中心、遊戲化習慣養成；以及可選的 Supabase 登入與雲端同步。
**不在範圍內**：研究管理、文獻管理、文件知識庫、AI 問答（不使用任何 AI API）。開發進度與驗收結果在 `docs/PROGRESS.md`。

## 原則

- 原生 HTML、CSS、JavaScript（ES Modules），**沒有建置流程、沒有 npm 相依套件、沒有 CDN、沒有自建後端**。雲端同步直接從瀏覽器呼叫 Supabase REST API（`js/cloud/api.js`），不引入 supabase-js。
- GitHub Pages 從 `main` 根目錄發布，網址在 `/daily-habit/` 子路徑：所有資源用**相對路徑**。
- 介面文字一律繁體中文；手機約 375px 與桌面都要可用；可點擊區域至少 44×44px；狀態不能只靠顏色。
- 本機模式（`js/config.js` 為空）必須永遠可用；雲端功能是附加的。

## 結構

| 位置 | 用途 |
| --- | --- |
| `js/app.js` | 進入點：讀取資料、路由（`#today` 等）、日期更新、跨分頁、登記各模組 |
| `js/ui/core.js` | 共用狀態 `app`、`commit()`（存檔→畫面）、訊息、焦點管理、表單元件、對話框 |
| `js/ui/*-view.js` | 各區域畫面；`today-view`、`settings-view`、`growth-view` 提供 `register…Extension` 讓其他模組加入區塊 |
| `js/ui/account-view.js` | 帳號、同步排程、狀態列、衝突、本機資料匯入 |
| `js/ui/game-view.js` | 遊戲化畫面；在 `app.transforms` 登記獎勵結算 |
| 邏輯模組 `js/*.js`、`js/cloud/*.js` | 純函式，**不可存取 DOM 或 window**（`storage.js` 接收 storage 參數），以便 `node --test` |
| `supabase/migrations/*.sql` | 資料表、RLS、`sync_push` 函式（可重複執行） |
| `supabase/tests/rls_test.sql` | 權限與同步規則測試（交易內執行並 rollback） |
| `scripts/browser-check.cjs` | 本機功能的 Playwright 檢查（群組：general tasks habits review finance game） |
| `scripts/cloud-check.cjs`、`scripts/dev/` | 雲端同步檢查與本機 Supabase 相容環境 |

資料流程：畫面呼叫 `commit(nextData)` → 依序套用 `app.transforms`（例如遊戲化結算）→ `app.persist`（寫入 localStorage；登入時另外比對差異、加入同步佇列）→ 成功才更新 `app.data` 並重新繪製。寫入失敗時不套用變更。

## 指令

```bash
npm test                                         # 單元測試
python3 -m http.server 8000                      # 本機預覽 http://localhost:8000/
BASE_URL=http://localhost:8000/ node scripts/browser-check.cjs [截圖資料夾] [群組…]   # 需 Playwright
# 模擬 /daily-habit/ 子路徑：在上一層資料夾啟動伺服器，BASE_URL 改為 http://localhost:8000/daily-habit/
scripts/dev/local-supabase.sh start              # 本機 Supabase 相容環境（見 scripts/dev/README.md）
psql -h localhost -p 54322 -U postgres -v ON_ERROR_STOP=1 -f supabase/tests/rls_test.sql
```

## 日期與金額規則

- 「今天」依裝置當地日期：`toDateKey(new Date())`。**禁止** `toISOString().slice(0, 10)`（台灣 00:00–07:59 會變成前一天）。
- 日期鍵（`YYYY-MM-DD`，代表一天）與時間戳（ISO 字串，代表瞬間）不可混用；統計某天完成的事，要把時間戳轉成當地日期（`review.js` 的 `localDateOf`）。
- 日期加減用 `dates.js`（以 UTC 日曆計算，不受日光節約時間影響）。月底規則：`monthDayIn`、`addMonthsClamped`。
- 測試檔開頭設定 `process.env.TZ = 'Asia/Taipei'`；修改日期邏輯時保留台灣午夜、跨月、閏年的測試。
- 依日期寫入的操作（打卡、新增今天的任務、提醒任務）前先 `checkDateChange()`，避免手機休眠後寫入舊日期。
- 金額一律為**最小貨幣單位整數**（`amountMinor`）；新台幣以元為單位、不可有小數。不同幣別分開統計，**不可相加**。預估（訂閱）與實際交易分開。

## 資料格式與相容性（修改時必須遵守）

- 版本 2，集合定義與欄位驗證在 `js/schema.js`（`SPECS`）。本機位置 `daily-habit:data`；帳號快取 `daily-habit:u:<userId>:data`、同步狀態 `…:sync`；登入 `daily-habit:session`。保留鍵 `daily-habit:before-v*`、`daily-habit:corrupt-*` 不可自動刪除。
- 備份檔：`{ app: 'daily-habit', version, exportedAt, data }`；所有舊版本備份都必須能還原（`MIGRATIONS`），比程式新的版本要拒絕。
- 改格式時：`CURRENT_VERSION` 加 1、在 `MIGRATIONS` 加轉換（不可刪舊的）、更新 `SPECS`、新增「舊 localStorage 與舊備份可轉換」的測試；`storage.js` 會先把舊原始資料另存。雲端資料（`records.data`）同樣需要能被新版 `validateRecord` 讀取。
- **不可以清空或覆蓋使用者資料作為修復方式。** 讀取失敗進入救援畫面；離開前先另存原始內容。
- 固定 id（跨裝置不重複的關鍵，不可更改格式）：
  - 打卡 `c_<habitId>_<YYYYMMDD>`；重複任務單次 `o_<seriesId>_<YYYYMMDD>`；預算 `b_<categoryId>_<幣別>`
  - 訂閱扣款交易 `x_sub_<subId>_<YYYYMMDD>`；續費提醒任務 `t_subrem_<subId>_<YYYYMMDD>`；回顧 `rv_<YYYYMMDD>`
  - 帳本 `l_<來源>_<序號>`、成就 `l_ach_<id>`、退回 `l_rf_<兌換id>`
  - 預設分類、帳戶、設定使用固定 id 與固定時間戳 `DEFAULT_TIMESTAMP`
- 習慣排程有歷史（`schedules`）；修改只從今天起生效。封存期間記在 `archivedRanges`。
- 範例資料只能由使用者按鈕載入；`mergeSample` 略過已存在的 id；不得含真實個資。

## 遊戲化規則（game.js）

- 帳本只新增不修改。每次 commit 依「目前完成狀態」計算每個來源的應得獎勵，與帳本加總比較，**補差額**（award／revoke）。因此不能反覆領取，所有變動可追溯。
- 成就只領一次、不撤銷；兌換需餘額足夠；退回每筆一次；撤銷可使餘額為負。
- 遊戲化關閉時不結算；開啟時補齊。金幣與財務金額完全無關。

## 雲端同步規則

- `records` 表 + RLS（只能存取自己的資料）；`rev` 版本衝突偵測；每帳號 `seq` 以計數列鎖定確保順序；刪除用 tombstone；帳本不可修改；兌換在 `sync_push` 內以 advisory lock 檢查餘額。
- 用戶端：`diffKeys` 找出變更 → `pending`；上傳附 `base_rev`；衝突放入 `conflicts` 由使用者選擇，**不可無聲覆蓋**；帳本衝突採用雲端版本後重新結算。
- 下載後的資料以 `adoptData` 寫入（不經 commit，不會被當成新變更）；下載完成後才結算獎勵。
- 只使用公開 anon 金鑰；**service_role／secret 金鑰、資料庫密碼、JWT secret 絕不可出現在程式或儲存庫**。
- 修改 migration 時：保持可重複執行，並更新 `supabase/tests/rls_test.sql` 與 `tests/sync.test.js` 的記憶體伺服器（兩者規則必須一致）。

## 其他慣例

- 使用者輸入只能透過 `h()`／`textContent` 顯示，不使用 innerHTML。
- 可重新繪製的按鈕與輸入框要有 `data-focus-key`，重繪後焦點留在原處。
- 同一習慣同一天 0.4 秒內的重複點按會被忽略（`CHECKIN_REPEAT_GUARD_MS`）。
- 不要提交使用者資料、備份、CSV 匯出或任何金鑰（見 `.gitignore`）。
- 修改後至少執行 `npm test`；改到畫面時，盡量執行 `scripts/browser-check.cjs` 並檢查 375px 與桌面寬度。
