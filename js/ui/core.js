// 畫面共用的基礎：狀態、儲存、訊息、對話框、焦點管理、表單元件。
// 各區域（today、tasks、habits…）的畫面模組都從這裡取得狀態與工具。

import { formatLongDate, toDateKey } from '../dates.js';
import { h, replaceChildren } from '../dom.js';
import { emptyData } from '../schema.js';

export { h, replaceChildren };

export const VIEWS = ['today', 'tasks', 'habits', 'finance', 'growth', 'settings'];

/** 整個程式的狀態。 */
export const app = {
  storage: null,
  /** normal：正常；memory：無法儲存，只存在記憶體；recovery：資料損壞，等待使用者處理 */
  mode: 'normal',
  data: emptyData(),
  todayKey: toDateKey(),
  view: 'today',
  notices: [],
  corrupt: null, // { raw, errors }
  /** 把資料寫入儲存空間：(nextData, prevData) => { ok, message }。由 app.js 設定，雲端同步時會替換。 */
  persist: () => ({ ok: true }),
  /** 儲存前依序套用的轉換（例如遊戲化獎勵結算）：(nextData, prevData) => nextData */
  transforms: [],
  /** 各區域的畫面狀態（篩選、目前月份等），不會儲存。 */
  ui: {},
  dialogReturnKey: null,
  pendingFocusKey: null,
};

export const $ = (id) => document.getElementById(id);

const renderers = {};

/** 註冊區域的繪製函式：(panel) => void */
export function registerView(view, renderFn) {
  renderers[view] = renderFn;
}

// ---------- 儲存 ----------

/**
 * 嘗試儲存新資料；成功才更新畫面。失敗時保留原資料並顯示原因。
 * 回傳 true / false。
 */
export function commit(nextData, message) {
  if (app.mode === 'recovery') return false;
  let data = nextData;
  for (const transform of app.transforms) data = transform(data, app.data);
  const result = app.persist(data, app.data);
  if (!result.ok) {
    addNotice(result.message, 'error');
    render();
    return false;
  }
  app.data = data;
  render();
  if (message) showToast(message);
  return true;
}

/** 更新單一集合的便利函式：update('tasks', (tasks) => newTasks, '訊息') */
export function update(collection, change, message) {
  return commit({ ...app.data, [collection]: change(app.data[collection]) }, message);
}

/** 檢查是否已換日；換日時更新畫面並回傳 true。 */
export function checkDateChange() {
  const key = toDateKey();
  if (key === app.todayKey) return false;
  app.todayKey = key;
  render();
  showToast('已進入新的一天，今日資料已更新。');
  return true;
}

// ---------- 訊息 ----------

let noticeCounter = 0;

/** 顯示在頁面上方的訊息。type：error、warning、info、success。key 相同的訊息只保留一則。 */
export function addNotice(text, type = 'error', { dismissible = true, key = null, action = null } = {}) {
  if (key) app.notices = app.notices.filter((n) => n.key !== key);
  noticeCounter += 1;
  app.notices.push({ id: noticeCounter, text, type, dismissible, key, action });
  renderNotices();
}

export function removeNotice(key) {
  const before = app.notices.length;
  app.notices = app.notices.filter((n) => n.key !== key);
  if (app.notices.length !== before) renderNotices();
}

const NOTICE_LABELS = { error: '錯誤', warning: '注意', info: '提示', success: '完成' };

export function renderNotices() {
  const container = $('notices');
  if (!container) return;
  replaceChildren(
    container,
    app.notices.map((notice) =>
      h(
        'div',
        { class: `notice notice--${notice.type}`, role: notice.type === 'error' || notice.type === 'warning' ? 'alert' : 'status' },
        h('p', {}, h('strong', {}, `${NOTICE_LABELS[notice.type]}：`), notice.text),
        notice.action || notice.dismissible
          ? h(
              'div',
              { class: 'button-row' },
              notice.action ? button(notice.action.label, notice.action.onClick, { size: 'small' }) : null,
              notice.dismissible
                ? button(
                    '關閉訊息',
                    () => {
                      app.notices = app.notices.filter((n) => n.id !== notice.id);
                      renderNotices();
                      focusHeading();
                    },
                    { variant: 'ghost', size: 'small' },
                  )
                : null,
            )
          : null,
      ),
    ),
  );
}

let toastTimer = null;

export function showToast(message) {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove('is-visible');
    toast.textContent = '';
  }, 3500);
}

// ---------- 焦點管理（鍵盤操作時，重新繪製後焦點不會跑掉） ----------

export function focusHeading() {
  const heading = document.querySelector('.view:not([hidden]) h2');
  heading?.focus({ preventScroll: true });
}

export function focusByKey(key) {
  if (!key) return false;
  const target = [...document.querySelectorAll(`[data-focus-key="${CSS.escape(key)}"]`)].find(
    (element) => !element.closest('[hidden]') && !element.closest('dialog:not([open])'),
  );
  if (!target) return false;
  target.focus({ preventScroll: true });
  return true;
}

export function focusPending() {
  const key = app.pendingFocusKey;
  app.pendingFocusKey = null;
  return focusByKey(key);
}

// ---------- 繪製 ----------

export function render() {
  const active = document.activeElement;
  const activeInDialog = Boolean(active?.closest?.('dialog'));
  const activeKey = active?.dataset?.focusKey;

  $('today-label').textContent = `今天是 ${formatLongDate(app.todayKey)}`;
  renderNotices();
  renderers.status?.();

  const recovery = app.mode === 'recovery';
  $('tabs').hidden = recovery;
  $('view-recovery').hidden = !recovery;
  for (const view of VIEWS) {
    const panel = $(`view-${view}`);
    panel.hidden = recovery || view !== app.view;
    if (panel.hidden) panel.textContent = ''; // 只保留目前區域的內容，避免隱藏區域留下過時的元素
  }
  if (!recovery) $('view-recovery').textContent = '';

  if (recovery) {
    renderers.recovery?.($('view-recovery'));
  } else {
    for (const link of document.querySelectorAll('.tab')) {
      if (link.dataset.view === app.view) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    renderers[app.view]?.($(`view-${app.view}`));
  }

  if (focusPending()) return;
  if (!activeInDialog && active && active !== document.body && !active.isConnected) {
    if (!focusByKey(activeKey)) focusHeading();
  }
}

// ---------- 共用元件 ----------

export function heading(view, text) {
  return h('h2', { id: `heading-${view}`, class: 'view-title', tabindex: '-1' }, text);
}

export function viewHead(view, title, ...actions) {
  return h('div', { class: 'view-head' }, heading(view, title), actions.length ? h('div', { class: 'button-row' }, actions) : null);
}

export function emptyState(title, text, ...actions) {
  return h(
    'div',
    { class: 'empty-state' },
    h('p', { class: 'empty-title' }, title),
    text ? h('p', {}, text) : null,
    actions.length ? h('div', { class: 'button-row' }, actions) : null,
  );
}

export function button(text, onClick, { variant = 'secondary', size = '', focusKey, label, type = 'button', pressed, disabled } = {}) {
  return h(
    'button',
    {
      type,
      class: `btn btn--${variant}${size ? ` btn--${size}` : ''}`,
      onClick,
      'aria-label': label,
      'aria-pressed': pressed === undefined ? null : String(pressed),
      disabled: disabled || null,
      dataset: focusKey ? { focusKey } : undefined,
    },
    text,
  );
}

export function section(id, title, ...children) {
  return h('section', { class: 'section', 'aria-labelledby': id }, h('h3', { id, class: 'section-title' }, title), children);
}

export function card(id, title, ...children) {
  return h('section', { class: 'card', 'aria-labelledby': id }, h('h3', { id }, title), children);
}

/**
 * 分段選擇（原生 radio，鍵盤可用方向鍵切換）。
 * options：[{ value, label }]
 */
export function segmented({ name, legend, options, value, onChange, focusPrefix = name }) {
  return h(
    'fieldset',
    { class: 'filter' },
    h('legend', { class: 'visually-hidden' }, legend),
    h(
      'div',
      { class: 'segmented' },
      options.map((option) =>
        h(
          'label',
          {},
          h('input', {
            type: 'radio',
            name,
            value: option.value,
            checked: value === option.value,
            dataset: { focusKey: `${focusPrefix}-${option.value}` },
            onChange: () => onChange(option.value),
          }),
          h('span', {}, option.label),
        ),
      ),
    ),
  );
}

// ---------- 表單欄位 ----------

function errorNode(id) {
  return h('p', { id: `${id}-error`, class: 'field-error', hidden: true });
}

function labelNode(id, label, required) {
  return h(
    'label',
    { for: id },
    label,
    ' ',
    h('span', { class: required ? 'required' : 'optional' }, required ? '（必填）' : '（選填）'),
  );
}

/** 文字、日期、數字輸入欄位。 */
export function inputField({ id, name = id, label, value = '', type = 'text', required = false, hint, attrs = {} }) {
  return h(
    'div',
    { class: 'field' },
    labelNode(id, label, required),
    hint ? h('p', { class: 'field-hint', id: `${id}-hint` }, hint) : null,
    h('input', {
      id,
      name,
      type,
      value: value ?? '',
      required,
      autocomplete: 'off',
      'aria-describedby': `${id}-error${hint ? ` ${id}-hint` : ''}`,
      ...attrs,
    }),
    errorNode(id),
  );
}

export function textareaField({ id, name = id, label, value = '', rows = 3, maxlength = 2000 }) {
  const textarea = h('textarea', { id, name, rows, maxlength, 'aria-describedby': `${id}-error` });
  textarea.value = value ?? '';
  return h('div', { class: 'field' }, labelNode(id, label, false), textarea, errorNode(id));
}

/** 下拉選單。options：[{ value, label }] */
export function selectField({ id, name = id, label, value, options, required = true, hint, onChange }) {
  return h(
    'div',
    { class: 'field' },
    labelNode(id, label, required),
    hint ? h('p', { class: 'field-hint', id: `${id}-hint` }, hint) : null,
    h(
      'select',
      { id, name, 'aria-describedby': `${id}-error${hint ? ` ${id}-hint` : ''}`, onChange },
      options.map((option) => h('option', { value: option.value, selected: option.value === value }, option.label)),
    ),
    errorNode(id),
  );
}

/** 單選按鈕組（例如優先程度）。 */
export function radioField({ id, name = id, legend, value, options, onChange }) {
  return h(
    'fieldset',
    { class: 'field', id },
    h('legend', {}, legend),
    h(
      'div',
      { class: 'segmented' },
      options.map((option) =>
        h(
          'label',
          {},
          h('input', { type: 'radio', name, value: option.value, checked: option.value === value, onChange }),
          h('span', {}, option.label),
        ),
      ),
    ),
    errorNode(id),
  );
}

/** 星期多選（週一在前）。 */
export function weekdayField({ id, name = id, legend, value = [], hint }) {
  const names = ['日', '一', '二', '三', '四', '五', '六'];
  return h(
    'fieldset',
    { class: 'field', id, 'aria-describedby': `${id}-error` },
    h('legend', {}, legend),
    hint ? h('p', { class: 'field-hint' }, hint) : null,
    h(
      'div',
      { class: 'segmented segmented--days' },
      [1, 2, 3, 4, 5, 6, 0].map((day) =>
        h(
          'label',
          {},
          h('input', { type: 'checkbox', name, value: String(day), checked: value.includes(day), 'aria-label': `星期${names[day]}` }),
          h('span', { 'aria-hidden': 'true' }, names[day]),
        ),
      ),
    ),
    errorNode(id),
  );
}

export function readWeekdays(form, name) {
  return [...form.querySelectorAll(`input[name="${name}"]:checked`)].map((input) => Number(input.value));
}

/** 顯示欄位錯誤：errors 為 { 欄位 id: 訊息 }。回傳是否有錯誤，並把焦點移到第一個錯誤欄位。 */
export function showFieldErrors(form, errors) {
  for (const element of form.querySelectorAll('[aria-invalid]')) element.removeAttribute('aria-invalid');
  for (const element of form.querySelectorAll('.field-error')) {
    element.hidden = true;
    element.textContent = '';
  }
  let first = null;
  for (const [id, message] of Object.entries(errors)) {
    const error = form.querySelector(`#${CSS.escape(id)}-error`);
    const input = form.querySelector(`#${CSS.escape(id)}`);
    if (error) {
      error.textContent = message;
      error.hidden = false;
    }
    if (input) {
      input.setAttribute('aria-invalid', 'true');
      const focusable = input.matches('fieldset') ? input.querySelector('input') : input;
      first ??= focusable;
    }
  }
  first?.focus();
  return Object.keys(errors).length > 0;
}

// ---------- 對話框 ----------

export function openDialog(dialog) {
  app.dialogReturnKey = document.activeElement?.dataset?.focusKey ?? null;
  dialog.showModal();
}

export function setupDialogs() {
  for (const dialog of document.querySelectorAll('dialog')) {
    dialog.addEventListener('close', () => {
      // 對話框關閉後，把焦點還給開啟它的按鈕（若按鈕已重新繪製，依 data-focus-key 找回）。
      setTimeout(() => {
        const active = document.activeElement;
        if (active && active !== document.body && active.isConnected && !active.closest('dialog:not([open])')) return;
        if (!focusByKey(app.dialogReturnKey)) focusHeading();
      }, 0);
    });
  }
}

/**
 * 表單對話框。
 * - body(form)：回傳要放進表單的元素。
 * - onSubmit(form)：回傳 true 表示完成（關閉對話框）；回傳錯誤物件 { 欄位 id: 訊息 } 會顯示在欄位下方。
 * - extraActions：額外按鈕（例如刪除），放在取消左邊。
 */
export function openFormDialog({ title, body, submitText = '儲存', onSubmit, extraActions = [], wide = false, focusId }) {
  const dialog = $('form-dialog');
  dialog.classList.toggle('dialog--wide', wide);
  const form = h('form', { class: 'dialog-body', novalidate: true });
  const close = () => dialog.close();
  replaceChildren(
    form,
    h('h2', { class: 'dialog-title', id: 'form-dialog-title' }, title),
    body(form),
    h(
      'div',
      { class: 'dialog-actions' },
      extraActions.map((action) => button(action.label, () => action.onClick(close, form), { variant: action.variant ?? 'ghost' })),
      h('span', { class: 'spacer' }),
      button(submitText ? '取消' : '關閉', close),
      submitText ? button(submitText, null, { variant: 'primary', type: 'submit' }) : null,
    ),
  );
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const result = onSubmit(form);
    if (result === true) close();
    else if (result && typeof result === 'object') showFieldErrors(form, result);
  });
  replaceChildren(dialog, form);
  openDialog(dialog);
  const first = focusId ? form.querySelector(`#${CSS.escape(focusId)}`) : form.querySelector('input:not([type=hidden]), select, textarea');
  first?.focus();
  return { dialog, form, close };
}

/** 確認對話框，回傳 Promise<boolean>。 */
export function confirmAction({ title, message, confirmText = '確定', danger = false }) {
  const dialog = $('confirm-dialog');
  if (typeof dialog.showModal !== 'function') return Promise.resolve(window.confirm(`${title}\n\n${message}`));
  $('confirm-title').textContent = title;
  $('confirm-message').textContent = message;
  const ok = $('confirm-ok');
  ok.textContent = confirmText;
  ok.className = `btn ${danger ? 'btn--danger' : 'btn--primary'}`;
  dialog.returnValue = '';
  openDialog(dialog);
  $('confirm-cancel').focus();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
  });
}

/**
 * 三選一對話框（例如重複任務「只改這次／這次及未來」）。
 * choices：[{ value, label, variant }]，回傳 Promise<value | null>。
 */
export function chooseAction({ title, message, choices }) {
  return new Promise((resolve) => {
    let chosen = null;
    const { dialog } = openFormDialog({
      title,
      submitText: null,
      body: () =>
        h(
          'div',
          {},
          h('p', { class: 'confirm-message' }, message),
          h(
            'div',
            { class: 'choice-list' },
            choices.map((choice) =>
              button(
                choice.label,
                () => {
                  chosen = choice.value;
                  $('form-dialog').close();
                },
                { variant: choice.variant ?? 'secondary', focusKey: `choice-${choice.value}` },
              ),
            ),
          ),
        ),
      onSubmit: () => true,
    });
    dialog.addEventListener('close', () => resolve(chosen), { once: true });
  });
}
