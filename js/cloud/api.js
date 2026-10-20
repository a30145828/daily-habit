// Supabase REST API 用戶端（不使用外部函式庫）：
// - 登入（GoTrue）：/auth/v1/signup、/auth/v1/token、/auth/v1/recover、/auth/v1/user、/auth/v1/logout
// - 資料（PostgREST）：/rest/v1/records（讀取）、/rest/v1/rpc/sync_push（寫入）
// 只使用公開的 anon 金鑰；資料權限由資料庫的 RLS 保護。

export class CloudError extends Error {
  /**
   * @param {string} message 給使用者看的中文訊息
   * @param {{ status?: number, code?: string, retryable?: boolean, authExpired?: boolean, offline?: boolean }} info
   */
  constructor(message, info = {}) {
    super(message);
    this.name = 'CloudError';
    Object.assign(this, { status: 0, code: '', retryable: false, authExpired: false, offline: false }, info);
  }
}

const AUTH_MESSAGES = {
  invalid_credentials: '電子郵件或密碼不正確。',
  invalid_grant: '電子郵件或密碼不正確。',
  email_not_confirmed: '這個帳號還沒完成電子郵件驗證，請到信箱點驗證連結（也可以按「重新寄送驗證信」）。',
  user_already_exists: '這個電子郵件已經註冊過，請直接登入，或使用「忘記密碼」。',
  email_exists: '這個電子郵件已經註冊過，請直接登入，或使用「忘記密碼」。',
  weak_password: '密碼強度不足，請至少使用 8 個字元。',
  same_password: '新密碼不能與目前的密碼相同。',
  over_email_send_rate_limit: '寄信太頻繁，請稍等幾分鐘再試。',
  over_request_rate_limit: '操作太頻繁，請稍後再試。',
  signup_disabled: '目前不開放註冊新帳號。',
  email_address_invalid: '電子郵件格式不正確。',
  validation_failed: '輸入的資料格式不正確。',
  user_not_found: '找不到這個帳號。',
};

const AUTH_EXPIRED_CODES = new Set(['session_not_found', 'refresh_token_not_found', 'refresh_token_already_used', 'bad_jwt', 'session_expired', 'PGRST301', 'PGRST303']);

function toError(status, body) {
  const code = body?.error_code ?? body?.code ?? body?.error ?? '';
  const raw = body?.msg ?? body?.message ?? body?.error_description ?? '';
  if (AUTH_EXPIRED_CODES.has(String(code)) || (status === 401 && /jwt|token/i.test(raw))) {
    return new CloudError('登入已過期，請重新登入。', { status, code: String(code), authExpired: true });
  }
  if (AUTH_MESSAGES[code]) return new CloudError(AUTH_MESSAGES[code], { status, code });
  if (status === 429) return new CloudError('操作太頻繁，請稍後再試。', { status, code: String(code), retryable: true });
  if (status >= 500 || status === 0) return new CloudError('雲端服務暫時無法使用，稍後會自動重試。', { status, code: String(code), retryable: true });
  if (status === 401 || status === 403 || code === '42501') return new CloudError('沒有權限執行這個操作，請重新登入。', { status, code: String(code), authExpired: status === 401 });
  return new CloudError(raw ? `雲端服務回應錯誤：${raw}` : `雲端服務回應錯誤（${status}）。`, { status, code: String(code) });
}

/** 解析 JWT 的內容（不驗證簽章，只用來取得帳號 id 與到期時間；真正驗證由伺服器負責）。 */
export function decodeJwt(token) {
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(
      atob(payload.padEnd(payload.length + ((4 - (payload.length % 4)) % 4), '='))
        .split('')
        .map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
        .join(''),
    );
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/** 由登入回應整理出要保存的登入狀態。 */
export function toSession(body, nowMs = Date.now()) {
  if (!body?.access_token) return null;
  const claims = decodeJwt(body.access_token) ?? {};
  const expiresAt = Number(body.expires_at) || claims.exp || Math.floor(nowMs / 1000) + Number(body.expires_in || 3600);
  const user = body.user ?? { id: claims.sub, email: claims.email };
  if (!user?.id) return null;
  return { access_token: body.access_token, refresh_token: body.refresh_token, expires_at: expiresAt, user: { id: user.id, email: user.email ?? claims.email ?? '' } };
}

/**
 * 解析登入相關的網址片段（信件中的驗證或重設密碼連結會導回 #access_token=…）。
 * 回傳 null（不是登入回傳）、{ error }、或 { session, type }。
 */
export function parseAuthRedirect(hash, nowMs = Date.now()) {
  const text = String(hash ?? '').replace(/^#/, '');
  if (!/(^|&)(access_token|error|error_code)=/.test(text)) return null;
  const params = new URLSearchParams(text);
  if (params.get('error') || params.get('error_code')) {
    const code = params.get('error_code') ?? params.get('error');
    const messages = {
      otp_expired: '連結已過期或已使用過，請重新申請。',
      access_denied: '連結無效或已過期，請重新申請。',
    };
    return { error: messages[code] ?? `登入連結無法使用：${params.get('error_description') ?? code}` };
  }
  const session = toSession(Object.fromEntries(params.entries()), nowMs);
  return session ? { session, type: params.get('type') ?? 'signin' } : { error: '登入連結內容不完整，請重新申請。' };
}

/**
 * 建立雲端用戶端。
 * @param {{ url: string, anonKey: string, fetchImpl?: typeof fetch }} options
 */
export function createCloud({ url, anonKey, fetchImpl = (...args) => globalThis.fetch(...args) }) {
  const base = String(url ?? '').replace(/\/+$/, '');

  async function request(path, { method = 'GET', body, token, headers = {} } = {}) {
    let response;
    try {
      response = await fetchImpl(base + path, {
        method,
        headers: {
          apikey: anonKey,
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new CloudError('無法連線到雲端服務，請檢查網路；連線恢復後會自動同步。', { retryable: true, offline: true });
    }
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!response.ok) throw toError(response.status, json);
    return json;
  }

  const redirect = (to) => (to ? `?redirect_to=${encodeURIComponent(to)}` : '');

  return {
    configured: Boolean(base && anonKey),
    url: base,

    /** 註冊。需要信箱驗證時回傳 { session: null, user }；不需要時回傳 { session }。 */
    async signUp(email, password, redirectTo) {
      const body = await request(`/auth/v1/signup${redirect(redirectTo)}`, { method: 'POST', body: { email, password } });
      const session = toSession(body);
      return { session, user: body?.user ?? body };
    },

    async resendConfirmation(email, redirectTo) {
      await request(`/auth/v1/resend${redirect(redirectTo)}`, { method: 'POST', body: { type: 'signup', email } });
    },

    async signIn(email, password) {
      return toSession(await request('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } }));
    },

    async refresh(refreshToken) {
      return toSession(await request('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: refreshToken } }));
    },

    /** 登出（伺服器端撤銷）；失敗時不影響本機登出。 */
    async signOut(token) {
      try {
        await request('/auth/v1/logout', { method: 'POST', token });
      } catch {
        // 忽略：本機仍會清除登入狀態與快取
      }
    },

    async recover(email, redirectTo) {
      await request(`/auth/v1/recover${redirect(redirectTo)}`, { method: 'POST', body: { email } });
    },

    async updatePassword(token, password) {
      return request('/auth/v1/user', { method: 'PUT', token, body: { password } });
    },

    async getUser(token) {
      return request('/auth/v1/user', { token });
    },

    /** 上傳變更：changes 為 [{ collection, id, base_rev, deleted, data }]。 */
    async push(token, changes, deviceId) {
      return request('/rest/v1/rpc/sync_push', { method: 'POST', token, body: { p_changes: changes, p_device: deviceId } });
    },

    /** 依序號下載 cursor 之後的變更。 */
    async pull(token, cursor, limit = 500) {
      const query = `select=collection,id,data,deleted,rev,seq&seq=gt.${Number(cursor) || 0}&order=seq.asc&limit=${limit}`;
      return request(`/rest/v1/records?${query}`, { token });
    },
  };
}
