// 雲端同步設定（公開資訊）。
//
// 要啟用登入與雲端同步，請填入你的 Supabase 專案資料（步驟見 README「設定雲端同步」）：
// - SUPABASE_URL：Project Settings → API → Project URL，例如 https://abcdxyz.supabase.co
// - SUPABASE_ANON_KEY：Project Settings → API → Project API keys 的 anon / public（或 publishable）金鑰
//
// 這兩個值本來就是公開的（會出現在每個使用者的瀏覽器中），資料安全由資料庫的資料權限（RLS）保護。
// ⚠ 絕對不要把 service_role（secret）金鑰或資料庫密碼填在這裡或提交到 GitHub。
//
// 兩個值都留空時，網站只使用本機模式（資料只存在瀏覽器），所有功能照常可用。

export const SUPABASE_URL = '';
export const SUPABASE_ANON_KEY = '';
