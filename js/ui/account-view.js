// 帳號與雲端同步：註冊、登入、登出、重設密碼；同步狀態、自動重試、衝突處理、本機資料匯入。
// 未設定 Supabase（js/config.js 為空）時，網站維持本機模式，這裡只顯示說明。

import { SUPABASE_ANON_KEY, SUPABASE_URL } from '../config.js';
import { createCloud, parseAuthRedirect } from '../cloud/api.js';
import {
  applyLocalImport,
  applyPullRows,
  applyPushResults,
  buildChanges,
  conflictCount,
  describeRecord,
  diffKeys,
  emptyMeta,
  getRecord,
  markPending,
  pendingCount,
  planLocalImport,
  resolveConflict,
  splitKey,
} from '../cloud/sync.js';
import { formatTimestamp } from '../dates.js';
import { createId } from '../ids.js';
import { COLLECTION_LABELS, describeCounts, hasUserData } from '../schema.js';
import { ACCOUNT_KEY_PREFIX, STORAGE_KEY, accountDataKey, loadData, saveData } from '../storage.js';
import {
  $,
  addNotice,
  app,
  button,
  card,
  commit,
  confirmAction,
  h,
  inputField,
  openFormDialog,
  registerView,
  removeNotice,
  render,
  replaceChildren,
  segmented,
  showToast,
} from './core.js';
import { settleRewards } from './game-view.js';
import { registerSettingsExtension } from './settings-view.js';

const SESSION_KEY = 'daily-habit:session';
const DEVICE_KEY = 'daily-habit:device';
const RETRY_DELAYS = [5, 15, 60, 300]; // 秒
const syncKey = (userId) => `${ACCOUNT_KEY_PREFIX}${userId}:sync`;

const cloud = {
  client: null,
  session: null,
  meta: null,
  status: 'idle', // idle、syncing、synced、pending、offline、error、expired、conflict
  error: '',
  syncing: false,
  again: false,
  pushTimer: null,
  retryTimer: null,
  retryAt: null,
  retryIndex: 0,
  authTab: 'signin',
  formMessage: null, // { type, text }
  unconfirmedEmail: null,
  loadFrom: null,
};

// ---------- 儲存 ----------

function read(key) {
  try {
    return JSON.parse(app.storage?.getItem(key) ?? 'null');
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    app.storage?.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function deviceId() {
  let id = app.storage?.getItem(DEVICE_KEY);
  if (!id) {
    id = createId('dev');
    try {
      app.storage?.setItem(DEVICE_KEY, id);
    } catch {
      // 無法保存時每次重新產生，不影響同步
    }
  }
  return id;
}

function saveMeta() {
  if (cloud.session) write(syncKey(cloud.session.user.id), cloud.meta);
}

function redirectUrl() {
  return `${location.origin}${location.pathname}`;
}

// ---------- 進入與離開帳號 ----------

function enterAccount(session) {
  cloud.session = session;
  write(SESSION_KEY, session);
  app.session = { userId: session.user.id, email: session.user.email };
  cloud.meta = { ...emptyMeta(), ...(read(syncKey(session.user.id)) ?? {}) };
  cloud.loadFrom(accountDataKey(session.user.id));
  const base = app.persist;
  app.persist = (next, prev) => {
    const result = base(next, prev);
    if (result.ok && cloud.session) {
      cloud.meta = markPending(cloud.meta, diffKeys(prev, next));
      saveMeta();
      updateStatus();
      schedulePush();
    }
    return result;
  };
  updateStatus();
}

/** 移除這個帳號在這台裝置上的所有快取（登出時）。 */
function removeAccountCache(userId) {
  const prefix = `${ACCOUNT_KEY_PREFIX}${userId}:`;
  const keys = [];
  for (let i = 0; i < (app.storage?.length ?? 0); i += 1) {
    const key = app.storage.key(i);
    if (key?.startsWith(prefix)) keys.push(key);
  }
  for (const key of keys) app.storage.removeItem(key);
  app.storage?.removeItem(SESSION_KEY);
}

function leaveAccount() {
  clearTimeout(cloud.pushTimer);
  clearTimeout(cloud.retryTimer);
  const userId = cloud.session?.user.id;
  cloud.session = null;
  cloud.meta = null;
  cloud.status = 'idle';
  app.session = null;
  if (userId) removeAccountCache(userId);
  removeNotice('auth');
  cloud.loadFrom(STORAGE_KEY);
}

// ---------- 同步 ----------

function updateStatus() {
  if (!cloud.session || cloud.syncing) return;
  if (cloud.status === 'expired' || cloud.status === 'error') return;
  if (conflictCount(cloud.meta)) cloud.status = 'conflict';
  else if (!navigator.onLine) cloud.status = 'offline';
  else if (pendingCount(cloud.meta)) cloud.status = 'pending';
  else if (cloud.meta.lastSyncAt) cloud.status = 'synced';
}

function schedulePush(delay = 1000) {
  clearTimeout(cloud.pushTimer);
  cloud.pushTimer = setTimeout(() => syncNow(), delay);
}

function scheduleRetry() {
  clearTimeout(cloud.retryTimer);
  const seconds = RETRY_DELAYS[Math.min(cloud.retryIndex, RETRY_DELAYS.length - 1)];
  cloud.retryIndex += 1;
  cloud.retryAt = Date.now() + seconds * 1000;
  cloud.retryTimer = setTimeout(() => syncNow(), seconds * 1000);
}

async function ensureToken() {
  const session = cloud.session;
  if (session.expires_at - Date.now() / 1000 > 60) return session.access_token;
  const refreshed = await cloud.client.refresh(session.refresh_token);
  if (!refreshed) throw Object.assign(new Error('登入已過期，請重新登入。'), { authExpired: true });
  cloud.session = refreshed;
  write(SESSION_KEY, refreshed);
  return refreshed.access_token;
}

/** 套用同步得到的資料（不經過 commit，因此不會被當成本機的新變更）。 */
function adoptData(data) {
  if (data === app.data) return;
  const result = saveData(app.storage, data, new Date(), app.storageKey);
  if (!result.ok) throw new Error(result.message);
  app.data = data;
}

/**
 * 立即同步：先上傳本機變更，再下載雲端的新變更。full 為 true 時重新下載全部資料。
 */
export async function syncNow({ full = false } = {}) {
  if (!cloud.session || app.mode === 'recovery') return;
  if (cloud.syncing) {
    cloud.again = true;
    return;
  }
  if (!navigator.onLine) {
    cloud.status = 'offline';
    render();
    return;
  }
  clearTimeout(cloud.retryTimer);
  cloud.syncing = true;
  cloud.status = 'syncing';
  render();
  let pulled = 0;
  try {
    const token = await ensureToken();
    if (full) cloud.meta = { ...cloud.meta, cursor: 0 };
    for (let round = 0; round < 50; round += 1) {
      const changes = buildChanges(cloud.meta, app.data);
      if (!changes.length) break;
      const results = await cloud.client.push(token, changes, deviceId());
      const outcome = applyPushResults(cloud.meta, app.data, changes, results);
      cloud.meta = outcome.meta;
      adoptData(outcome.data);
      saveMeta();
      for (const { change } of outcome.rejected) {
        addNotice(`兌換「${(change.data?.label ?? '').replace(/^兌換：/, '')}」已取消：雲端的金幣餘額不足（可能已在其他裝置使用）。`, 'warning');
      }
      for (const { change, result } of outcome.invalid) {
        addNotice(`有一筆資料（${COLLECTION_LABELS[change.collection] ?? change.collection}）無法上傳：${result.reason ?? '格式不正確'}。這筆資料仍保留在這台裝置。`, 'error');
      }
    }
    for (let page = 0; page < 1000; page += 1) {
      const rows = await cloud.client.pull(token, cloud.meta.cursor, 500);
      const outcome = applyPullRows(cloud.meta, app.data, rows);
      cloud.meta = outcome.meta;
      adoptData(outcome.data);
      pulled += outcome.applied;
      saveMeta();
      if (rows.length < 500) break;
    }
    cloud.meta = { ...cloud.meta, lastSyncAt: new Date().toISOString() };
    saveMeta();
    cloud.retryIndex = 0;
    cloud.retryAt = null;
    cloud.error = '';
    cloud.status = 'idle';
    removeNotice('auth');
  } catch (error) {
    if (error.authExpired) {
      cloud.status = 'expired';
      addNotice('登入已過期，請到「設定」重新登入。在那之前，你的變更會先保存在這台裝置，重新登入後再同步。', 'warning', {
        key: 'auth',
        action: { label: '前往登入', onClick: () => (location.hash = '#settings') },
      });
    } else {
      cloud.status = 'error';
      cloud.error = error.message || '同步失敗。';
      if (error.offline) cloud.status = 'offline';
      scheduleRetry();
    }
  } finally {
    cloud.syncing = false;
  }
  updateStatus();
  render();
  if (pulled > 0) settleRewards(); // 其他裝置的變更可能影響獎勵結算
  if (cloud.again) {
    cloud.again = false;
    schedulePush(200);
  }
}

// ---------- 狀態列 ----------

function renderStatusBar() {
  const bar = $('status-bar');
  if (!bar) return;
  if (!cloud.client?.configured) return replaceChildren(bar);
  if (!cloud.session) return replaceChildren(bar, h('span', {}, '💾 本機模式：資料只存在這台裝置'));
  const pending = pendingCount(cloud.meta);
  const conflicts = conflictCount(cloud.meta);
  const last = cloud.meta.lastSyncAt ? formatTimestamp(cloud.meta.lastSyncAt).split(' ')[1] : null;
  const messages = {
    syncing: '🔄 同步中…',
    synced: `☁ 已同步${last ? `（${last}）` : ''}`,
    idle: pending ? `⏳ 待同步 ${pending} 筆` : `☁ 已同步${last ? `（${last}）` : ''}`,
    pending: `⏳ 待同步 ${pending} 筆`,
    offline: `📴 離線中${pending ? `：${pending} 筆變更待同步，恢復連線後自動上傳` : ''}`,
    error: `⚠ 同步失敗：${cloud.error}${cloud.retryAt ? `（約 ${Math.max(1, Math.round((cloud.retryAt - Date.now()) / 1000))} 秒後自動重試）` : ''}`,
    expired: '⚠ 登入已過期，請重新登入',
    conflict: `⚠ 有 ${conflicts} 筆衝突需要處理`,
  };
  replaceChildren(
    bar,
    h('span', { class: `sync-status sync-status--${cloud.status}` }, messages[cloud.status] ?? messages.idle),
    cloud.status === 'error' || cloud.status === 'offline'
      ? button('立即重試', () => syncNow(), { variant: 'ghost', size: 'small', focusKey: 'sync-retry' })
      : null,
    cloud.status === 'conflict' ? h('a', { href: '#settings', class: 'status-link' }, '前往處理') : null,
  );
}

// ---------- 登入表單 ----------

function setFormMessage(type, text) {
  cloud.formMessage = { type, text };
  render();
  document.getElementById('auth-message')?.focus();
}

async function withBusy(form, fn) {
  const buttons = [...form.querySelectorAll('button')];
  buttons.forEach((b) => (b.disabled = true));
  try {
    await fn();
  } catch (error) {
    if (error?.code === 'email_not_confirmed') cloud.unconfirmedEmail = form.elements['auth-email']?.value ?? null;
    setFormMessage('error', error.message || '發生錯誤，請稍後再試。');
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

function validateCredentials(email, password, { checkLength = false } = {}) {
  const errors = {};
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors['auth-email'] = '請輸入正確的電子郵件。';
  if (password !== null) {
    if (!password) errors['auth-password'] = '請輸入密碼。';
    else if (checkLength && password.length < 8) errors['auth-password'] = '密碼至少 8 個字元。';
  }
  return errors;
}

function showErrors(form, errors) {
  for (const [id, message] of Object.entries(errors)) {
    const el = form.querySelector(`#${id}-error`);
    if (el) {
      el.textContent = message;
      el.hidden = false;
    }
    form.querySelector(`#${id}`)?.setAttribute('aria-invalid', 'true');
  }
  form.querySelector('[aria-invalid="true"]')?.focus();
  return Object.keys(errors).length > 0;
}

function authForm() {
  const tab = cloud.authTab;
  const submitLabels = { signin: '登入', signup: '註冊', reset: '寄送重設密碼信' };
  const form = h(
    'form',
    {
      class: 'auth-form',
      novalidate: true,
      onSubmit: (event) => {
        event.preventDefault();
        const form = event.target;
        for (const el of form.querySelectorAll('.field-error')) el.hidden = true;
        for (const el of form.querySelectorAll('[aria-invalid]')) el.removeAttribute('aria-invalid');
        const email = form.elements['auth-email'].value.trim();
        const password = tab === 'reset' ? null : form.elements['auth-password'].value;
        const errors = validateCredentials(email, password, { checkLength: tab === 'signup' });
        if (tab === 'signup' && password !== form.elements['auth-password2'].value) errors['auth-password2'] = '兩次輸入的密碼不一致。';
        if (showErrors(form, errors)) return;
        withBusy(form, async () => {
          if (tab === 'signin') {
            const session = await cloud.client.signIn(email, password);
            await afterLogin(session);
          } else if (tab === 'signup') {
            const result = await cloud.client.signUp(email, password, redirectUrl());
            if (result.session) return afterLogin(result.session);
            cloud.unconfirmedEmail = email;
            setFormMessage('success', `已寄出驗證信到 ${email}。請到信箱點信中的連結完成註冊，連結會帶你回到這個網站並自動登入。沒收到信請檢查垃圾郵件匣。`);
          } else {
            await cloud.client.recover(email, redirectUrl());
            setFormMessage('success', `如果 ${email} 已經註冊，你會收到一封重設密碼的信。請點信中的連結回到這個網站設定新密碼。`);
          }
        });
      },
    },
    inputField({ id: 'auth-email', label: '電子郵件', type: 'email', required: true, attrs: { autocomplete: 'email', inputmode: 'email' } }),
    tab !== 'reset'
      ? inputField({
          id: 'auth-password',
          label: '密碼',
          type: 'password',
          required: true,
          hint: tab === 'signup' ? '至少 8 個字元。請不要使用與其他網站相同的密碼。' : null,
          attrs: { autocomplete: tab === 'signup' ? 'new-password' : 'current-password' },
        })
      : null,
    tab === 'signup' ? inputField({ id: 'auth-password2', label: '再輸入一次密碼', type: 'password', required: true, attrs: { autocomplete: 'new-password' } }) : null,
    h('div', { class: 'button-row' }, button(submitLabels[tab], null, { variant: 'primary', type: 'submit', focusKey: `auth-submit-${tab}` })),
  );
  return form;
}

async function afterLogin(session) {
  if (!session) throw new Error('登入失敗，請再試一次。');
  cloud.formMessage = null;
  cloud.unconfirmedEmail = null;
  enterAccount(session);
  render();
  showToast(`已登入 ${session.user.email}。`);
  await syncNow({ full: true });
}

function renderSignedOut() {
  return card(
    'account',
    '帳號與雲端同步',
    h('p', {}, '登入後，資料會同步到你的雲端帳號，可以在多台裝置使用。沒有登入時，資料只存在這個瀏覽器。'),
    segmented({
      name: 'auth-tab',
      legend: '帳號操作',
      value: cloud.authTab,
      options: [
        { value: 'signin', label: '登入' },
        { value: 'signup', label: '註冊' },
        { value: 'reset', label: '忘記密碼' },
      ],
      onChange: (value) => {
        cloud.authTab = value;
        cloud.formMessage = null;
        render();
      },
    }),
    cloud.formMessage
      ? h('p', { id: 'auth-message', tabindex: '-1', class: `notice notice--${cloud.formMessage.type}`, role: cloud.formMessage.type === 'error' ? 'alert' : 'status' }, cloud.formMessage.text)
      : null,
    authForm(),
    cloud.unconfirmedEmail
      ? button(
          '重新寄送驗證信',
          async () => {
            try {
              await cloud.client.resendConfirmation(cloud.unconfirmedEmail, redirectUrl());
              setFormMessage('success', `已重新寄送驗證信到 ${cloud.unconfirmedEmail}。`);
            } catch (error) {
              setFormMessage('error', error.message);
            }
          },
          { variant: 'ghost', size: 'small', focusKey: 'auth-resend' },
        )
      : null,
    h('p', { class: 'small muted' }, '登入後，這台裝置原本的本機資料不會自動上傳；你可以在登入後預覽並選擇是否匯入帳號。'),
  );
}

// ---------- 已登入 ----------

function openPasswordDialog({ recovery = false } = {}) {
  openFormDialog({
    title: recovery ? '設定新密碼' : '修改密碼',
    body: () =>
      h(
        'div',
        {},
        recovery ? h('p', {}, '你是從重設密碼的信件連結回來的，請設定新的密碼。') : null,
        inputField({ id: 'new-password', label: '新密碼', type: 'password', required: true, hint: '至少 8 個字元。', attrs: { autocomplete: 'new-password' } }),
        inputField({ id: 'new-password2', label: '再輸入一次新密碼', type: 'password', required: true, attrs: { autocomplete: 'new-password' } }),
      ),
    onSubmit: (form) => {
      const password = form.elements['new-password'].value;
      if (password.length < 8) return { 'new-password': '密碼至少 8 個字元。' };
      if (password !== form.elements['new-password2'].value) return { 'new-password2': '兩次輸入的密碼不一致。' };
      (async () => {
        try {
          const token = await ensureToken();
          await cloud.client.updatePassword(token, password);
          $('form-dialog').close();
          showToast('已更新密碼。');
        } catch (error) {
          const el = form.querySelector('#new-password-error');
          el.textContent = error.message;
          el.hidden = false;
        }
      })();
      return false;
    },
  });
}

async function logout() {
  const pending = pendingCount(cloud.meta);
  const conflicts = conflictCount(cloud.meta);
  const risky = pending > 0 || conflicts > 0;
  const ok = await confirmAction({
    title: '登出',
    message: risky
      ? `還有 ${pending} 筆變更尚未同步${conflicts ? `、${conflicts} 筆衝突未處理` : ''}，登出後這些變更會從這台裝置刪除而遺失。\n建議先按「取消」，等待同步完成，或到下方匯出備份。`
      : '登出後，這台裝置上這個帳號的資料快取會被清除（雲端資料不受影響），畫面會回到本機模式。',
    confirmText: risky ? '仍要登出' : '登出',
    danger: risky,
  });
  if (!ok) return;
  const token = cloud.session?.access_token;
  await Promise.race([cloud.client.signOut(token), new Promise((resolve) => setTimeout(resolve, 3000))]);
  leaveAccount();
  render();
  showToast('已登出，這台裝置上的帳號快取已清除。');
}

function renderConflicts() {
  const entries = Object.entries(cloud.meta.conflicts);
  if (!entries.length) return null;
  return h(
    'div',
    { class: 'notice notice--warning' },
    h('h4', {}, `有 ${entries.length} 筆資料在兩個地方都被修改了`),
    h('p', { class: 'small' }, '為了不覆蓋任何一邊，請逐筆選擇要保留的版本。選擇前，這台裝置會先顯示自己的版本。'),
    h(
      'ul',
      { class: 'conflict-list' },
      entries.map(([key, conflict]) => {
        const { collection, id } = splitKey(key);
        const local = getRecord(app.data, collection, id);
        const server = conflict.server.deleted ? null : conflict.server.data;
        const choose = (choice) => {
          const result = resolveConflict(cloud.meta, app.data, key, choice);
          cloud.meta = result.meta;
          adoptData(result.data);
          saveMeta();
          updateStatus();
          render();
          showToast(choice === 'local' ? '已保留這台裝置的版本，將上傳到雲端。' : '已改用雲端版本。');
          if (choice === 'local') schedulePush(100);
        };
        return h(
          'li',
          { class: 'conflict' },
          h('p', { class: 'conflict-title' }, `${COLLECTION_LABELS[collection] ?? collection}`),
          h(
            'dl',
            { class: 'details' },
            h('dt', {}, '這台裝置'),
            h('dd', {}, describeRecord(collection, local), local?.updatedAt ? `（${formatTimestamp(local.updatedAt)}）` : ''),
            h('dt', {}, '雲端'),
            h('dd', {}, describeRecord(collection, server), server?.updatedAt ? `（${formatTimestamp(server.updatedAt)}）` : ''),
          ),
          h(
            'div',
            { class: 'button-row' },
            button('保留這台裝置的版本', () => choose('local'), { size: 'small', focusKey: `conflict-local-${key}` }),
            button('使用雲端版本', () => choose('server'), { size: 'small', focusKey: `conflict-server-${key}` }),
          ),
        );
      }),
    ),
  );
}

function renderLocalImport() {
  if (cloud.meta.localImportDone) return null;
  const local = loadData(app.storage, new Date(), STORAGE_KEY);
  if (local.status !== 'ok' || !hasUserData(local.data)) return null;
  const plan = planLocalImport(app.data, local.data);
  if (plan.addCount === 0) return null;
  const counts = Object.fromEntries(Object.entries(plan.additions).map(([k, v]) => [k, v.length]));
  return h(
    'div',
    { class: 'notice notice--info' },
    h('h4', {}, '匯入這台裝置的本機資料？'),
    h('p', {}, `這台裝置在登入前有本機資料。可以把它們加入你的帳號：${describeCounts(counts)}。`),
    h('p', { class: 'small' }, `帳號中已經有相同項目的 ${plan.skipCount} 筆會保留帳號的版本、不重複加入；設定不會匯入。本機資料本身不會被刪除，重複匯入也不會產生重複資料。`),
    h(
      'div',
      { class: 'button-row' },
      button(
        `匯入 ${plan.addCount} 筆到帳號`,
        async () => {
          const ok = await confirmAction({ title: '匯入本機資料', message: `把 ${plan.addCount} 筆本機資料加入帳號 ${cloud.session.user.email}，並同步到雲端？`, confirmText: '匯入' });
          if (!ok) return;
          const fresh = loadData(app.storage, new Date(), STORAGE_KEY);
          const latestPlan = planLocalImport(app.data, fresh.data);
          if (commit(applyLocalImport(app.data, latestPlan), `已匯入 ${latestPlan.addCount} 筆本機資料，正在同步。`)) {
            cloud.meta = { ...cloud.meta, localImportDone: true };
            saveMeta();
            render();
          }
        },
        { variant: 'primary', size: 'small', focusKey: 'local-import' },
      ),
      button(
        '不要匯入',
        () => {
          cloud.meta = { ...cloud.meta, localImportDone: true };
          saveMeta();
          render();
        },
        { variant: 'ghost', size: 'small', focusKey: 'local-import-skip' },
      ),
    ),
  );
}

function renderSignedIn() {
  const pending = pendingCount(cloud.meta);
  return card(
    'account',
    '帳號與雲端同步',
    h(
      'dl',
      { class: 'details' },
      h('dt', {}, '帳號'),
      h('dd', {}, cloud.session.user.email),
      h('dt', {}, '同步狀態'),
      h('dd', { 'aria-live': 'polite' }, $('status-bar')?.textContent.replace('立即重試', '').replace('前往處理', '') || '—'),
      h('dt', {}, '上次同步'),
      h('dd', {}, cloud.meta.lastSyncAt ? formatTimestamp(cloud.meta.lastSyncAt) : '尚未同步'),
      h('dt', {}, '待同步'),
      h('dd', {}, `${pending} 筆`),
    ),
    renderConflicts(),
    renderLocalImport(),
    h(
      'div',
      { class: 'button-row' },
      button('立即同步', () => syncNow(), { variant: 'primary', size: 'small', focusKey: 'sync-now' }),
      button('重新下載全部資料', () => syncNow({ full: true }), { size: 'small', focusKey: 'sync-full' }),
      button('修改密碼', () => openPasswordDialog(), { size: 'small', focusKey: 'change-password' }),
      button('登出', logout, { variant: 'ghost-danger', size: 'small', focusKey: 'logout' }),
    ),
    h(
      'p',
      { class: 'small muted' },
      '變更會先存在這台裝置，再自動上傳；離線時的變更會在恢復連線後上傳。兩台裝置同時修改同一筆資料時，會在這裡請你選擇保留哪個版本，不會自動覆蓋。',
    ),
  );
}

function renderNotConfigured() {
  return card(
    'account',
    '帳號與雲端同步',
    h('p', {}, '雲端同步尚未設定：網站目前以本機模式運作，資料只存在這個瀏覽器，所有功能都可以正常使用。'),
    h('p', { class: 'small muted' }, '網站管理者可以依照 README「設定雲端同步（Supabase）」的步驟建立 Supabase 專案，並在 js/config.js 填入公開的網址與 anon 金鑰後啟用。'),
  );
}

// ---------- 安裝 ----------

/**
 * 登記帳號與同步功能（由 app.js 呼叫）。
 * loadFrom(key)：切換資料位置（本機或帳號快取）。startupHooks：啟動時要執行的步驟。
 */
export function installAccount({ loadFrom, startupHooks }) {
  cloud.loadFrom = loadFrom;
  cloud.client = createCloud({ url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY });
  registerView('status', renderStatusBar);
  registerSettingsExtension({
    order: 10,
    render: () => (!cloud.client.configured ? renderNotConfigured() : cloud.session ? renderSignedIn() : renderSignedOut()),
  });
  if (!cloud.client.configured) return;

  startupHooks.push(async () => {
    let recovery = false;
    const redirect = parseAuthRedirect(location.hash);
    if (redirect) {
      history.replaceState(null, '', `${location.pathname}${location.search}#${redirect.error ? 'settings' : 'today'}`);
      app.view = redirect.error ? 'settings' : 'today';
      if (redirect.error) addNotice(redirect.error, 'error', { key: 'auth-link' });
      else {
        enterAccount(redirect.session);
        recovery = redirect.type === 'recovery';
        addNotice(recovery ? '請設定新的密碼。' : '電子郵件驗證完成，已登入。', 'success', { key: 'auth-link' });
      }
    } else {
      const saved = read(SESSION_KEY);
      if (saved?.access_token && saved.user?.id) enterAccount(saved);
    }
    if (cloud.session) {
      setTimeout(() => syncNow({ full: !cloud.meta.lastSyncAt }), 0);
      if (recovery) setTimeout(() => openPasswordDialog({ recovery: true }), 50);
    }
  });

  window.addEventListener('online', () => syncNow());
  window.addEventListener('offline', () => {
    updateStatus();
    render();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) syncNow();
  });
  setInterval(() => {
    if (!document.hidden && cloud.session && !cloud.syncing) syncNow();
  }, 60 * 1000);
  // 其他分頁同步後，更新這個分頁的同步狀態
  window.addEventListener('storage', (event) => {
    if (event.storageArea && event.storageArea !== app.storage) return;
    if (cloud.session && event.key === syncKey(cloud.session.user.id)) {
      cloud.meta = { ...emptyMeta(), ...(read(event.key) ?? {}) };
      updateStatus();
      render();
    }
    if (event.key === SESSION_KEY && cloud.session && !event.newValue) {
      // 其他分頁登出：這個分頁也回到本機模式
      leaveAccount();
      render();
    }
  });
}
