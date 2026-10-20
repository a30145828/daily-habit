// 財務區域：收支、訂閱（subscriptions-view.js）、預算、分類與帳戶、CSV 匯入匯出。

import { applyImport, guessMapping, IMPORT_FIELDS, IMPORT_FIELD_LABELS, parseCsv, previewImport, subscriptionsCsv, transactionsCsv } from '../csv.js';
import { addMonthsToMonthKey, formatDateLabel, formatMonth, isValidMonthKey, monthKeyOf } from '../dates.js';
import { downloadText } from '../dom.js';
import {
  ACCOUNT_KIND_LABELS,
  TYPE_LABELS,
  accountTotals,
  accountUsage,
  activeAccounts,
  activeCategories,
  budgetStatus,
  categoryUsage,
  createAccount,
  createCategory,
  createTxn,
  deleteTxn,
  filterTxns,
  isDuplicateName,
  monthSummary,
  patchItem,
  removeBudget,
  setBudget,
  sortTxns,
  updateTxn,
  validateName,
  validateTxnInput,
} from '../finance.js';
import { CURRENCIES, amountToInput, formatMoney, parseAmount } from '../money.js';
import { ACCOUNT_KINDS } from '../schema.js';
import { unlinkCharge } from '../subscriptions.js';
import {
  app,
  button,
  card,
  commit,
  confirmAction,
  emptyState,
  h,
  inputField,
  openFormDialog,
  radioField,
  render,
  replaceChildren,
  segmented,
  selectField,
  showToast,
  textareaField,
  viewHead,
} from './core.js';
import { renderSubscriptions } from './subscriptions-view.js';

export const state = () =>
  (app.ui.finance ??= {
    tab: 'txns',
    month: monthKeyOf(app.todayKey),
    type: '',
    categoryId: '',
    accountId: '',
    query: '',
    filtersOpen: false,
    csv: null,
  });

const TABS = [
  { value: 'txns', label: '收支' },
  { value: 'subs', label: '訂閱' },
  { value: 'budgets', label: '預算' },
  { value: 'setup', label: '分類與帳戶' },
  { value: 'io', label: '匯入匯出' },
];

// ---------- 共用 ----------

export function baseCurrency() {
  return app.data.settings.baseCurrency;
}

export function currencyOptions() {
  return Object.entries(CURRENCIES).map(([code, info]) => ({ value: code, label: `${info.label}（${code}）` }));
}

export function categoryOptions(type, { includeNone = true, selected = null } = {}) {
  const list = app.data.categories.filter((c) => (!type || c.type === type) && (!c.archived || c.id === selected));
  return [...(includeNone ? [{ value: '', label: '未分類' }] : []), ...list.map((c) => ({ value: c.id, label: `${c.name}${c.archived ? '（已封存）' : ''}` }))];
}

export function accountOptions({ includeNone = true, selected = null } = {}) {
  const list = app.data.accounts.filter((a) => !a.archived || a.id === selected);
  return [...(includeNone ? [{ value: '', label: '未指定' }] : []), ...list.map((a) => ({ value: a.id, label: `${a.name}${a.archived ? '（已封存）' : ''}` }))];
}

export function nameOf(collection, id, fallback = '') {
  if (!id) return fallback;
  return app.data[collection].find((x) => x.id === id)?.name ?? '（已刪除）';
}

export function money(amountMinor, currency) {
  return formatMoney(amountMinor, currency);
}

function monthNav(field = 'month') {
  const s = state();
  const go = (value) => {
    s[field] = value;
    render();
  };
  return h(
    'div',
    { class: 'calendar-nav' },
    button('‹ 上月', () => go(addMonthsToMonthKey(s[field], -1)), { size: 'small', label: '上個月', focusKey: `${field}-prev` }),
    h(
      'div',
      { class: 'month-picker' },
      h('label', { for: `${field}-input`, class: 'visually-hidden' }, '選擇月份'),
      h('input', {
        id: `${field}-input`,
        type: 'month',
        value: s[field],
        dataset: { focusKey: `${field}-input` },
        onChange: (event) => isValidMonthKey(event.target.value) && go(event.target.value),
      }),
    ),
    button('下月 ›', () => go(addMonthsToMonthKey(s[field], 1)), { size: 'small', label: '下個月', focusKey: `${field}-next` }),
  );
}

/** 依幣別的收支摘要卡片。 */
function summaryCards(summary) {
  const currencies = Object.keys(summary);
  if (!currencies.length) return h('p', { class: 'muted' }, '這個月還沒有收支紀錄。');
  return h(
    'div',
    { class: 'money-summary' },
    currencies.map((currency) => {
      const row = summary[currency];
      return h(
        'dl',
        { class: 'money-card', 'aria-label': `${CURRENCIES[currency].label}收支` },
        h('dt', { class: 'money-currency' }, `${CURRENCIES[currency].label}（${currency}）`),
        h('dd', {}, h('span', {}, '收入'), h('strong', { class: 'amount amount--income' }, `+${money(row.income, currency)}`)),
        h('dd', {}, h('span', {}, '支出'), h('strong', { class: 'amount amount--expense' }, `-${money(row.expense, currency)}`)),
        h('dd', { class: 'money-net' }, h('span', {}, '收支差額'), h('strong', {}, money(row.net, currency))),
      );
    }),
    currencies.length > 1 ? h('p', { class: 'small muted' }, '不同幣別分開統計；沒有匯率資料，因此不換算相加。') : null,
  );
}

// ---------- 收支 ----------

export function openTxnDialog(txn = null, defaults = {}) {
  const initialType = txn?.type ?? defaults.type ?? 'expense';
  let categorySelect;
  openFormDialog({
    title: txn ? '編輯收支' : initialType === 'income' ? '新增收入' : '新增支出',
    body: () => {
      const fields = h(
        'div',
        {},
        radioField({
          id: 'txn-type',
          legend: '類型',
          value: initialType,
          options: [
            { value: 'expense', label: '支出' },
            { value: 'income', label: '收入' },
          ],
          onChange: (event) => {
            const select = categorySelect.querySelector('select');
            replaceChildren(select, categoryOptions(event.target.value).map((o) => h('option', { value: o.value }, o.label)));
          },
        }),
        inputField({ id: 'txn-date', label: '日期', type: 'date', required: true, value: txn?.date ?? defaults.date ?? app.todayKey }),
        h(
          'div',
          { class: 'field-row' },
          inputField({
            id: 'txn-amount',
            label: '金額',
            required: true,
            value: txn ? amountToInput(txn.amountMinor, txn.currency) : '',
            attrs: { inputmode: 'decimal', placeholder: '例如 120' },
          }),
          selectField({ id: 'txn-currency', label: '幣別', value: txn?.currency ?? baseCurrency(), options: currencyOptions() }),
        ),
        (categorySelect = selectField({
          id: 'txn-category',
          label: '分類',
          required: false,
          value: txn?.categoryId ?? '',
          options: categoryOptions(initialType, { selected: txn?.categoryId }),
        })),
        selectField({ id: 'txn-account', label: '帳戶', required: false, value: txn?.accountId ?? defaults.accountId ?? '', options: accountOptions({ selected: txn?.accountId }) }),
        textareaField({ id: 'txn-note', label: '備註', value: txn?.note ?? '', rows: 2, maxlength: 500 }),
        txn?.subscriptionId
          ? h('p', { class: 'notice notice--info small' }, `這筆是訂閱「${nameOf('subscriptions', txn.subscriptionId)}」${txn.chargeDate} 的扣款。`)
          : null,
      );
      return fields;
    },
    extraActions: txn?.subscriptionId
      ? [
          {
            label: '取消連結訂閱',
            onClick: (close) => {
              close();
              commit({ ...app.data, transactions: unlinkCharge(app.data.transactions, txn.id) }, '已取消與訂閱的連結（交易保留）。');
            },
          },
        ]
      : [],
    onSubmit: (form) => {
      const result = validateTxnInput({
        type: form.querySelector('input[name="txn-type"]:checked')?.value,
        date: form.elements['txn-date'].value,
        amount: form.elements['txn-amount'].value,
        currency: form.elements['txn-currency'].value,
        categoryId: form.elements['txn-category'].value,
        accountId: form.elements['txn-account'].value,
        note: form.elements['txn-note'].value,
      });
      if (!result.ok) {
        const map = { type: 'txn-type', date: 'txn-date', amount: 'txn-amount', currency: 'txn-currency', note: 'txn-note' };
        return Object.fromEntries(Object.entries(result.errors).map(([k, v]) => [map[k], v]));
      }
      if (txn) return commit({ ...app.data, transactions: updateTxn(app.data.transactions, txn.id, result.value) }, '已儲存變更。');
      state().month = monthKeyOf(result.value.date);
      return commit({ ...app.data, transactions: [...app.data.transactions, createTxn(result.value)] }, `已新增${TYPE_LABELS[result.value.type]}。`);
    },
  });
}

async function deleteTxnFlow(txn) {
  const ok = await confirmAction({
    title: '刪除收支紀錄',
    message: `確定要刪除 ${txn.date} 的${TYPE_LABELS[txn.type]} ${money(txn.amountMinor, txn.currency)}${txn.note ? `（${txn.note}）` : ''}嗎？\n刪除後無法復原。`,
    confirmText: '刪除',
    danger: true,
  });
  if (ok) commit({ ...app.data, transactions: deleteTxn(app.data.transactions, txn.id) }, '已刪除收支紀錄。');
}

function txnItem(txn) {
  const category = nameOf('categories', txn.categoryId, '未分類');
  const label = `${txn.date} ${TYPE_LABELS[txn.type]} ${money(txn.amountMinor, txn.currency)}${txn.note ? ` ${txn.note}` : ''}`;
  return h(
    'li',
    { class: 'txn' },
    h(
      'div',
      { class: 'txn-main' },
      h('p', { class: 'txn-title' }, category, txn.note ? h('span', { class: 'muted' }, `・${txn.note}`) : null),
      h(
        'p',
        { class: 'todo-meta' },
        h('span', { class: `badge ${txn.type === 'income' ? 'badge--done' : ''}` }, TYPE_LABELS[txn.type]),
        txn.accountId ? h('span', { class: 'badge' }, nameOf('accounts', txn.accountId)) : null,
        txn.subscriptionId ? h('span', { class: 'badge badge--repeat' }, `🔁 訂閱：${nameOf('subscriptions', txn.subscriptionId)}`) : null,
        txn.source === 'csv' ? h('span', { class: 'badge badge--muted' }, 'CSV 匯入') : null,
      ),
    ),
    h('p', { class: `amount amount--${txn.type}` }, `${txn.type === 'income' ? '+' : '-'}${money(txn.amountMinor, txn.currency)}`),
    h(
      'div',
      { class: 'todo-actions' },
      button('編輯', () => openTxnDialog(txn), { variant: 'ghost', size: 'small', focusKey: `txn-edit-${txn.id}`, label: `編輯 ${label}` }),
      button('刪除', () => deleteTxnFlow(txn), { variant: 'ghost-danger', size: 'small', focusKey: `txn-delete-${txn.id}`, label: `刪除 ${label}` }),
    ),
  );
}

function renderTxnResults(container) {
  const s = state();
  const filters = { month: s.month, type: s.type, categoryId: s.categoryId, accountId: s.accountId, query: s.query };
  const list = sortTxns(filterTxns(app.data, filters));
  const byDate = new Map();
  for (const txn of list) {
    if (!byDate.has(txn.date)) byDate.set(txn.date, []);
    byDate.get(txn.date).push(txn);
  }
  const filtered = s.type || s.categoryId || s.accountId || s.query;
  replaceChildren(
    container,
    h('p', { class: 'small muted', role: 'status' }, `${filtered ? '符合條件' : '本月'}：${list.length} 筆`),
    list.length
      ? [...byDate.entries()].map(([date, txns]) =>
          h('section', { class: 'txn-day', 'aria-label': formatDateLabel(date) }, h('h4', { class: 'txn-date' }, formatDateLabel(date)), h('ul', { class: 'txn-list' }, txns.map(txnItem))),
        )
      : emptyState(filtered ? '沒有符合條件的紀錄' : '這個月還沒有收支紀錄', filtered ? null : '按「＋ 支出」或「＋ 收入」開始記帳，也可以到「匯入匯出」匯入 CSV。'),
  );
}

function renderTxns() {
  const s = state();
  const results = h('div', {});
  const rerender = () => renderTxnResults(results);
  const node = h(
    'div',
    {},
    h(
      'div',
      { class: 'button-row' },
      button('＋ 支出', () => openTxnDialog(null, { type: 'expense' }), { variant: 'primary', focusKey: 'txn-add-expense' }),
      button('＋ 收入', () => openTxnDialog(null, { type: 'income' }), { focusKey: 'txn-add-income' }),
    ),
    monthNav(),
    h('h3', { class: 'section-title' }, `${formatMonth(s.month)}收支`),
    summaryCards(monthSummary(app.data, s.month)),
    h(
      'details',
      {
        class: 'filters',
        open: s.filtersOpen || Boolean(s.type || s.categoryId || s.accountId || s.query) || null,
        onToggle: (event) => {
          s.filtersOpen = event.target.open;
        },
      },
      h('summary', {}, '篩選與搜尋'),
      h(
        'div',
        { class: 'toolbar' },
        h(
          'div',
          { class: 'field field--search' },
          h('label', { for: 'txn-search' }, '搜尋'),
          h('input', {
            id: 'txn-search',
            type: 'search',
            value: s.query,
            placeholder: '備註、分類、帳戶、金額',
            autocomplete: 'off',
            dataset: { focusKey: 'txn-search' },
            onInput: (event) => {
              s.query = event.target.value;
              rerender();
            },
          }),
        ),
        h(
          'div',
          { class: 'toolbar-row' },
          selectField({
            id: 'txn-filter-type',
            label: '類型',
            required: null,
            value: s.type,
            options: [{ value: '', label: '全部' }, { value: 'expense', label: '支出' }, { value: 'income', label: '收入' }],
            onChange: (event) => ((s.type = event.target.value), rerender()),
          }),
          selectField({
            id: 'txn-filter-category',
            label: '分類',
            required: null,
            value: s.categoryId,
            options: [{ value: '', label: '全部分類' }, ...categoryOptions(null, { includeNone: false })],
            onChange: (event) => ((s.categoryId = event.target.value), rerender()),
          }),
          selectField({
            id: 'txn-filter-account',
            label: '帳戶',
            required: null,
            value: s.accountId,
            options: [{ value: '', label: '全部帳戶' }, ...accountOptions({ includeNone: false })],
            onChange: (event) => ((s.accountId = event.target.value), rerender()),
          }),
        ),
      ),
    ),
    results,
    h('p', { class: 'small muted' }, '這裡的金額是你手動記錄或匯入的資料，沒有連結銀行，也不代表已核對的帳戶餘額。'),
  );
  rerender();
  return node;
}

// ---------- 預算 ----------

function openBudgetDialog(existing = null) {
  openFormDialog({
    title: existing ? '修改預算' : '設定每月預算',
    body: () =>
      h(
        'div',
        {},
        existing
          ? h('p', {}, `分類：${nameOf('categories', existing.categoryId)}（${existing.currency}）`)
          : [
              selectField({ id: 'budget-category', label: '支出分類', value: '', options: categoryOptions('expense', { includeNone: false }) }),
              selectField({ id: 'budget-currency', label: '幣別', value: baseCurrency(), options: currencyOptions() }),
            ],
        inputField({
          id: 'budget-amount',
          label: '每月預算金額',
          required: true,
          value: existing ? amountToInput(existing.amountMinor, existing.currency) : '',
          attrs: { inputmode: 'decimal' },
        }),
      ),
    onSubmit: (form) => {
      const categoryId = existing?.categoryId ?? form.elements['budget-category'].value;
      const currency = existing?.currency ?? form.elements['budget-currency'].value;
      const amount = parseAmount(form.elements['budget-amount'].value, currency);
      if (!categoryId) return { 'budget-category': '請選擇分類。' };
      if (!amount.ok) return { 'budget-amount': amount.error };
      return commit({ ...app.data, budgets: setBudget(app.data.budgets, categoryId, currency, amount.value) }, '已儲存預算。');
    },
  });
}

function renderBudgets() {
  const s = state();
  const rows = budgetStatus(app.data, s.month);
  return h(
    'div',
    {},
    button('＋ 設定預算', () => openBudgetDialog(), { variant: 'primary', focusKey: 'budget-add' }),
    monthNav(),
    h('h3', { class: 'section-title' }, `${formatMonth(s.month)}預算`),
    rows.length
      ? h(
          'ul',
          { class: 'budget-list' },
          rows.map((row) => {
            const { budget } = row;
            const name = row.category?.name ?? '（已刪除的分類）';
            const over = row.remaining < 0;
            return h(
              'li',
              { class: `budget card${over ? ' is-over' : ''}` },
              h('div', { class: 'budget-head' }, h('h4', {}, name, ' ', h('span', { class: 'small muted' }, budget.currency)), over ? h('span', { class: 'badge badge--overdue' }, '⚠ 超出預算') : null),
              h('progress', { max: String(budget.amountMinor), value: String(Math.min(row.spent, budget.amountMinor)), 'aria-label': `${name}預算使用 ${Math.round(row.ratio * 100)}%` }),
              h(
                'p',
                { class: 'small' },
                `已用 ${money(row.spent, budget.currency)} / 預算 ${money(budget.amountMinor, budget.currency)}（${Math.round(row.ratio * 100)}%），`,
                over ? h('strong', { class: 'amount--expense' }, `超支 ${money(-row.remaining, budget.currency)}`) : `剩餘 ${money(row.remaining, budget.currency)}`,
              ),
              h(
                'div',
                { class: 'button-row' },
                button('修改', () => openBudgetDialog(budget), { variant: 'ghost', size: 'small', focusKey: `budget-edit-${budget.id}`, label: `修改「${name}」預算` }),
                button(
                  '移除',
                  async () => {
                    if (await confirmAction({ title: '移除預算', message: `移除「${name}」的每月預算？收支紀錄不受影響。`, confirmText: '移除', danger: true })) {
                      commit({ ...app.data, budgets: removeBudget(app.data.budgets, budget.id) }, '已移除預算。');
                    }
                  },
                  { variant: 'ghost-danger', size: 'small', focusKey: `budget-remove-${budget.id}`, label: `移除「${name}」預算` },
                ),
              ),
            );
          }),
        )
      : emptyState('還沒有設定預算', '為支出分類設定每月預算，就能看到已用與剩餘金額。'),
    h('p', { class: 'small muted' }, '預算只計算同一幣別、該月份、該分類的支出；訂閱的預估續費不計入，只有實際記錄的扣款才會計入。'),
  );
}

// ---------- 分類與帳戶 ----------

function openNameDialog({ title, value = '', extra = null, onSave }) {
  openFormDialog({
    title,
    body: () => h('div', {}, inputField({ id: 'item-name', label: '名稱', required: true, value, attrs: { maxlength: '50' } }), extra ? extra() : null),
    onSubmit: (form) => {
      const name = validateName(form.elements['item-name'].value);
      if (!name.ok) return { 'item-name': name.error };
      return onSave(name.value, form);
    },
  });
}

function itemRow(item, { collection, usage, detail }) {
  const label = item.name;
  const remove = async () => {
    const ok = await confirmAction({ title: '刪除', message: `刪除「${label}」？`, confirmText: '刪除', danger: true });
    if (ok) commit({ ...app.data, [collection]: app.data[collection].filter((x) => x.id !== item.id) }, `已刪除「${label}」。`);
  };
  return h(
    'li',
    { class: `setup-item${item.archived ? ' is-archived' : ''}` },
    h('div', {}, h('p', { class: 'setup-name' }, label, item.archived ? '（已封存）' : ''), h('p', { class: 'small muted' }, detail)),
    h(
      'div',
      { class: 'todo-actions' },
      button(
        '改名',
        () =>
          openNameDialog({
            title: '修改名稱',
            value: item.name,
            onSave: (name) =>
              isDuplicateName(app.data[collection], name, { exceptId: item.id, type: item.type })
                ? { 'item-name': '已有相同名稱。' }
                : commit({ ...app.data, [collection]: patchItem(app.data[collection], item.id, { name }) }, '已修改名稱。'),
          }),
        { variant: 'ghost', size: 'small', focusKey: `rename-${item.id}`, label: `修改「${label}」名稱` },
      ),
      button(item.archived ? '取消封存' : '封存', () => commit({ ...app.data, [collection]: patchItem(app.data[collection], item.id, { archived: !item.archived }) }, item.archived ? `已取消封存「${label}」。` : `已封存「${label}」，舊紀錄仍保留。`), {
        variant: 'ghost',
        size: 'small',
        focusKey: `archive-${item.id}`,
        label: `${item.archived ? '取消封存' : '封存'}「${label}」`,
      }),
      usage === 0
        ? button('刪除', remove, { variant: 'ghost-danger', size: 'small', focusKey: `delete-${item.id}`, label: `刪除「${label}」` })
        : null,
    ),
  );
}

function renderSetup() {
  const categoryList = (type) =>
    h(
      'ul',
      { class: 'setup-list' },
      app.data.categories
        .filter((c) => c.type === type)
        .map((c) => {
          const usage = categoryUsage(app.data, c.id);
          return itemRow(c, { collection: 'categories', usage, detail: usage ? `使用中（${usage} 筆，只能封存）` : '尚未使用' });
        }),
    );
  return h(
    'div',
    {},
    card(
      'setup-categories',
      '收支分類',
      button(
        '＋ 新增分類',
        () =>
          openNameDialog({
            title: '新增分類',
            extra: () => radioField({ id: 'cat-type', legend: '類型', value: 'expense', options: [{ value: 'expense', label: '支出' }, { value: 'income', label: '收入' }] }),
            onSave: (name, form) => {
              const type = form.querySelector('input[name="cat-type"]:checked').value;
              if (isDuplicateName(app.data.categories, name, { type })) return { 'item-name': '已有相同名稱的分類。' };
              return commit({ ...app.data, categories: [...app.data.categories, createCategory(name, type)] }, `已新增分類「${name}」。`);
            },
          }),
        { size: 'small', focusKey: 'cat-add' },
      ),
      h('h4', {}, '支出'),
      categoryList('expense'),
      h('h4', {}, '收入'),
      categoryList('income'),
    ),
    card(
      'setup-accounts',
      '帳戶',
      button(
        '＋ 新增帳戶',
        () =>
          openNameDialog({
            title: '新增帳戶',
            extra: () => selectField({ id: 'acc-kind', label: '帳戶類型', value: 'bank', options: ACCOUNT_KINDS.map((k) => ({ value: k, label: ACCOUNT_KIND_LABELS[k] })) }),
            onSave: (name, form) => {
              if (isDuplicateName(app.data.accounts, name)) return { 'item-name': '已有相同名稱的帳戶。' };
              return commit({ ...app.data, accounts: [...app.data.accounts, createAccount(name, form.elements['acc-kind'].value)] }, `已新增帳戶「${name}」。`);
            },
          }),
        { size: 'small', focusKey: 'acc-add' },
      ),
      h(
        'ul',
        { class: 'setup-list' },
        app.data.accounts.map((a) => {
          const usage = accountUsage(app.data, a.id);
          const totals = accountTotals(app.data, a.id);
          const totalText = Object.entries(totals)
            .map(([cur, amount]) => money(amount, cur))
            .join('、');
          return itemRow(a, {
            collection: 'accounts',
            usage,
            detail: `${ACCOUNT_KIND_LABELS[a.kind]}・${usage ? `${usage} 筆紀錄` : '尚未使用'}${totalText ? `・記帳累計淨額 ${totalText}（未與銀行核對）` : ''}`,
          });
        }),
      ),
      h('p', { class: 'small muted' }, '「記帳累計淨額」只是這個帳戶的收入減支出紀錄，不是銀行餘額；本工具第一版不連結銀行帳戶。'),
    ),
  );
}

// ---------- 匯入匯出 ----------

async function handleCsvFile(file) {
  const s = state();
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) {
    s.csv = { error: '檔案太大（上限 5 MB）。' };
    return render();
  }
  let rows;
  try {
    rows = parseCsv(await file.text());
  } catch {
    s.csv = { error: '無法讀取這個檔案。' };
    return render();
  }
  if (rows.length === 0) {
    s.csv = { error: '檔案中沒有資料。' };
    return render();
  }
  const mapping = guessMapping(rows[0]);
  const hasHeader = mapping.date >= 0 || mapping.amount >= 0;
  s.csv = {
    fileName: file.name,
    rows,
    mapping,
    options: { hasHeader, defaultCurrency: baseCurrency(), signMode: mapping.type >= 0 ? 'type' : 'negative', defaultAccountId: '' },
    preview: null,
    includeDuplicates: false,
  };
  app.pendingFocusKey = 'csv-preview';
  render();
}

function csvMappingForm() {
  const s = state();
  const csv = s.csv;
  const header = csv.rows[0];
  const columnOptions = [{ value: '-1', label: '（不使用）' }, ...header.map((cell, i) => ({ value: String(i), label: csv.options.hasHeader ? `${cell || `第 ${i + 1} 欄`}` : `第 ${i + 1} 欄（例：${cell}）` }))];
  const update = (fn) => {
    fn();
    csv.preview = null;
    render();
  };
  return h(
    'div',
    { class: 'csv-step' },
    h('h4', {}, `2. 對應欄位（檔案：${csv.fileName}，共 ${csv.rows.length} 列）`),
    h(
      'label',
      { class: 'checkbox-label' },
      h('input', { type: 'checkbox', checked: csv.options.hasHeader, dataset: { focusKey: 'csv-header' }, onChange: (event) => update(() => (csv.options.hasHeader = event.target.checked)) }),
      h('span', {}, '第一列是標題（不匯入）'),
    ),
    h(
      'div',
      { class: 'toolbar-row' },
      IMPORT_FIELDS.map((field) =>
        selectField({
          id: `csv-map-${field}`,
          label: IMPORT_FIELD_LABELS[field],
          required: field === 'date' || field === 'amount',
          value: String(csv.mapping[field]),
          options: columnOptions,
          onChange: (event) => update(() => (csv.mapping[field] = Number(event.target.value))),
        }),
      ),
      selectField({
        id: 'csv-sign',
        label: '收支判斷',
        value: csv.options.signMode,
        options: [
          { value: 'type', label: '使用「類型」欄位' },
          { value: 'negative', label: '負數為支出、正數為收入' },
          { value: 'expense', label: '全部視為支出' },
          { value: 'income', label: '全部視為收入' },
        ],
        onChange: (event) => update(() => (csv.options.signMode = event.target.value)),
      }),
      selectField({ id: 'csv-currency', label: '預設幣別（沒有幣別欄位時）', value: csv.options.defaultCurrency, options: currencyOptions(), onChange: (event) => update(() => (csv.options.defaultCurrency = event.target.value)) }),
      selectField({ id: 'csv-account', label: '預設帳戶（沒有帳戶欄位時）', required: false, value: csv.options.defaultAccountId, options: accountOptions(), onChange: (event) => update(() => (csv.options.defaultAccountId = event.target.value)) }),
    ),
    h(
      'div',
      { class: 'button-row' },
      button(
        '3. 預覽與檢查',
        () => {
          if (csv.mapping.date < 0 || csv.mapping.amount < 0) {
            csv.mappingError = '請指定「日期」與「金額」欄位。';
          } else if (csv.options.signMode === 'type' && csv.mapping.type < 0) {
            csv.mappingError = '收支判斷選「使用類型欄位」時，請指定「類型」欄位。';
          } else {
            csv.mappingError = null;
            csv.preview = previewImport(csv.rows, csv.mapping, csv.options, app.data);
          }
          app.pendingFocusKey = 'csv-result';
          render();
        },
        { variant: 'primary', focusKey: 'csv-preview' },
      ),
      button('取消匯入', () => ((s.csv = null), render()), { focusKey: 'csv-cancel' }),
    ),
    csv.mappingError ? h('p', { class: 'field-error', role: 'alert' }, csv.mappingError) : null,
  );
}

const STATUS_TEXT = { ok: '✓ 可匯入', duplicate: '⚠ 可能重複', error: '✕ 錯誤' };

function csvPreview() {
  const s = state();
  const csv = s.csv;
  const p = csv.preview;
  const importCount = p.counts.ok + (csv.includeDuplicates ? p.counts.duplicate : 0);
  const shown = p.rows.slice(0, 200);
  return h(
    'div',
    { class: 'csv-step' },
    h('h4', { id: 'csv-result-heading', tabindex: '-1', dataset: { focusKey: 'csv-result' } }, '3. 預覽結果'),
    h('p', { role: 'status' }, `可匯入 ${p.counts.ok} 筆、可能重複 ${p.counts.duplicate} 筆、錯誤 ${p.counts.error} 筆（錯誤的列不會匯入）。`),
    p.newCategories.length ? h('p', { class: 'small' }, `會新增分類：${p.newCategories.map((c) => `${c.name}（${c.type === 'income' ? '收入' : '支出'}）`).join('、')}`) : null,
    p.newAccounts.length ? h('p', { class: 'small' }, `會新增帳戶：${p.newAccounts.map((a) => a.name).join('、')}`) : null,
    p.counts.duplicate
      ? h(
          'label',
          { class: 'checkbox-label' },
          h('input', { type: 'checkbox', checked: csv.includeDuplicates, dataset: { focusKey: 'csv-dup' }, onChange: (event) => ((csv.includeDuplicates = event.target.checked), render()) }),
          h('span', {}, `仍要匯入 ${p.counts.duplicate} 筆可能重複的資料（預設略過，避免重複記帳）`),
        )
      : null,
    h(
      'div',
      { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': '匯入預覽表格' },
      h(
        'table',
        { class: 'csv-table' },
        h('thead', {}, h('tr', {}, ['行', '狀態', '日期', '類型', '金額', '分類', '備註', '說明'].map((t) => h('th', { scope: 'col' }, t)))),
        h(
          'tbody',
          {},
          shown.map((row) =>
            h(
              'tr',
              { class: `row--${row.status}` },
              h('td', {}, String(row.line)),
              h('td', {}, STATUS_TEXT[row.status]),
              h('td', {}, row.txn?.date ?? ''),
              h('td', {}, row.txn ? TYPE_LABELS[row.txn.type] : ''),
              h('td', {}, row.txn ? money(row.txn.amountMinor, row.txn.currency) : ''),
              h('td', {}, row.categoryName),
              h('td', {}, row.txn?.note ?? ''),
              h('td', {}, row.errors.join('；')),
            ),
          ),
        ),
      ),
    ),
    p.rows.length > shown.length ? h('p', { class: 'small muted' }, `只顯示前 ${shown.length} 列。`) : null,
    h(
      'div',
      { class: 'button-row' },
      button(
        `確認匯入 ${importCount} 筆`,
        async () => {
          if (!importCount) return;
          const ok = await confirmAction({ title: '確認匯入', message: `將新增 ${importCount} 筆收支紀錄。匯入後可以個別編輯或刪除。`, confirmText: '匯入' });
          if (!ok) return;
          const result = applyImport(app.data, csv.preview, { includeDuplicates: csv.includeDuplicates });
          if (commit(result.data, `已匯入 ${result.imported} 筆收支${result.createdCategories ? `，新增 ${result.createdCategories} 個分類` : ''}${result.createdAccounts ? `，新增 ${result.createdAccounts} 個帳戶` : ''}。`)) {
            s.csv = null;
            render();
          }
        },
        { variant: 'primary', focusKey: 'csv-confirm', disabled: importCount === 0 },
      ),
      button('取消匯入', () => ((s.csv = null), render()), { focusKey: 'csv-cancel2' }),
    ),
  );
}

function renderIo() {
  const s = state();
  const csv = s.csv;
  return h(
    'div',
    {},
    card(
      'io-export',
      '匯出 CSV',
      h('p', {}, '匯出的 CSV 可用 Excel 或 Google 試算表開啟（UTF-8 編碼）。檔案含有你的財務資料，請妥善保存，不要上傳到公開的地方。'),
      h(
        'div',
        { class: 'button-row' },
        button('匯出收支 CSV', () => {
          const name = `daily-habit-transactions-${app.todayKey}.csv`;
          downloadText(name, transactionsCsv(app.data), 'text/csv');
          showToast(`已下載 ${name}`);
        }, { focusKey: 'export-txn' }),
        button('匯出訂閱 CSV', () => {
          const name = `daily-habit-subscriptions-${app.todayKey}.csv`;
          downloadText(name, subscriptionsCsv(app.data), 'text/csv');
          showToast(`已下載 ${name}`);
        }, { focusKey: 'export-sub' }),
      ),
      h('p', { class: 'small muted' }, '要備份全部資料（含任務、習慣、遊戲紀錄），請到「設定」下載完整 JSON 備份。'),
    ),
    card(
      'io-import',
      '匯入收支 CSV',
      h('p', {}, '可匯入銀行或其他記帳工具匯出的 CSV。步驟：選檔 → 對應欄位 → 預覽與檢查 → 確認。可能重複的資料預設會略過。'),
      h(
        'div',
        { class: 'field' },
        h('label', { for: 'csv-file', class: 'field-label' }, '1. 選擇 CSV 檔'),
        h('input', { id: 'csv-file', type: 'file', accept: '.csv,text/csv', class: 'file-input', dataset: { focusKey: 'csv-file' }, onChange: (event) => handleCsvFile(event.target.files?.[0]) }),
      ),
      csv?.error ? h('p', { class: 'field-error', role: 'alert' }, csv.error) : null,
      csv?.rows ? csvMappingForm() : null,
      csv?.preview ? csvPreview() : null,
    ),
  );
}

// ---------- 區域 ----------

export function renderFinance(panel) {
  const s = state();
  const renderers = { txns: renderTxns, subs: renderSubscriptions, budgets: renderBudgets, setup: renderSetup, io: renderIo };
  replaceChildren(
    panel,
    viewHead('finance', '財務'),
    segmented({ name: 'finance-tab', legend: '財務功能', value: s.tab, options: TABS, onChange: (value) => ((s.tab = value), render()) }),
    renderers[s.tab](),
  );
}
