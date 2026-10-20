# 開發者測試工具（進階，選用）

一般使用與部署**不需要**這個資料夾。這裡的工具用來在本機架設「與 Supabase 相容」的測試環境，
在不動到正式 Supabase 專案的情況下，實際測試登入、資料權限與雲端同步。

| 檔案 | 用途 |
| --- | --- |
| `local-supabase.sh` | 啟動／停止本機測試環境：PostgreSQL 16、supabase/auth（登入服務）、PostgREST、API 閘道、測試信箱 |
| `gateway.cjs` | 模擬 Supabase 的 API 閘道：`/auth/v1` → 登入服務、`/rest/v1` → PostgREST，檢查 apikey、加上 CORS；`/__offline/on`、`/__offline/off` 可模擬雲端故障 |

## 使用方式

```bash
# 1. 啟動測試環境（第一次會下載 supabase/auth 與 PostgREST，約 25 MB）
scripts/dev/local-supabase.sh start
#    → 印出 SUPABASE_URL、SUPABASE_ANON_KEY、MAIL_DIR

# 2. 資料權限測試（在測試資料庫執行，結束時 rollback）
psql -h localhost -p 54322 -U postgres -v ON_ERROR_STOP=1 -f supabase/tests/rls_test.sql

# 3. 雲端同步端到端測試（另開終端機先啟動網站：在上一層資料夾執行 python3 -m http.server 8765）
BASE_URL=http://localhost:8765/daily-habit/ SUPABASE_URL=http://localhost:54321 \
SUPABASE_ANON_KEY=<上面印出的值> MAIL_DIR=/tmp/dhstack/mail node scripts/cloud-check.cjs

# 4. 停止
scripts/dev/local-supabase.sh stop
```

注意：

- 測試環境的 JWT 密鑰、資料庫密碼都是寫死的測試值，**只能用在本機測試**。
- 註冊與重設密碼的信件不會真的寄出，而是存成 `MAIL_DIR` 底下的檔案。
- 以 root 執行時，PostgreSQL 需要一般使用者身分（預設 `pgtest`，可用 `useradd -m pgtest` 建立）。
