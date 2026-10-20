// 訂閱：清單、預估費用、近期續費、記錄扣款（避免重複記帳）、提醒任務；
// 以及今日頁的續費提醒與設定頁的主要幣別。

import { compareDateKeys, formatDateLabel, isValidDateKey } from '../dates.js';
import { CURRENCIES, amountToInput, parseAmount } from '../money.js';
import {
  CYCLE_LABELS,
  STATUS_LABELS,
  chargeFor,
  createReminderTask,
  createSubscription,
  deleteSubscription,
  describeCycle,
  dueReminders,
  estimateCost,
  estimateTotals,
  linkCharge,
  patchSubscription,
  possibleDuplicates,
  recordCharge,
  reminderTaskId,
  upcomingRenewals,
  validateSubInput,
} from '../subscriptions.js';
import {
  addNotice,
  app,
  button,
  checkDateChange,
  commit,
  confirmAction,
  emptyState,
  h,
  inputField,
  openFormDialog,
  section,
  selectField,
  textareaField,
} from './core.js';
import { accountOptions, baseCurrency, categoryOptions, currencyOptions, money, nameOf, state } from './finance-view.js';
import { registerSettingsExtension } from './settings-view.js';
import { registerTodayExtension, summaryItem } from './today-view.js';

// ---------- 表單 ----------

function openSubDialog(sub = null) {
  openFormDialog({
    title: sub ? '編輯訂閱' : '新增訂閱',
    wide: true,
    body: () =>
      h(
        'div',
        {},
        inputField({
          id: 'sub-name',
          label: '名稱',
          required: true,
          value: sub?.name ?? '',
          attrs: { maxlength: '100', placeholder: '例如：影音串流' },
        }),
        h(
          'div',
          { class: 'field-row' },
          inputField({
            id: 'sub-amount',
            label: '每期金額',
            required: true,
            value: sub ? amountToInput(sub.amountMinor, sub.currency) : '',
            attrs: { inputmode: 'decimal' },
          }),
          selectField({ id: 'sub-currency', label: '幣別', value: sub?.currency ?? baseCurrency(), options: currencyOptions() }),
        ),
        h(
          'div',
          { class: 'field-row' },
          inputField({
            id: 'sub-every',
            label: '每隔',
            type: 'number',
            required: true,
            value: sub?.cycleEvery ?? 1,
            attrs: { min: '1', max: '366', inputmode: 'numeric' },
          }),
          selectField({
            id: 'sub-unit',
            label: '週期單位',
            value: sub?.cycleUnit ?? 'month',
            options: Object.entries(CYCLE_LABELS).map(([value, label]) => ({ value, label })),
          }),
        ),
        h('p', { class: 'field-hint' }, '例：月繳 = 每 1 個月；年繳 = 每 1 年；季繳 = 每 3 個月；每兩週 = 每 2 週。'),
        inputField({
          id: 'sub-next',
          label: '下次續費日',
          type: 'date',
          required: true,
          value: sub?.nextRenewal ?? '',
          hint: '月繳、年繳會以這一天的日期為準；該月沒有這一天時改在月底（例如 31 日 → 2 月 28 日）。',
        }),
        h(
          'div',
          { class: 'field-row' },
          selectField({
            id: 'sub-account',
            label: '扣款帳戶',
            required: false,
            value: sub?.accountId ?? '',
            options: accountOptions({ selected: sub?.accountId }),
          }),
          inputField({
            id: 'sub-method',
            label: '付款方式',
            value: sub?.paymentMethod ?? '',
            attrs: { maxlength: '50', placeholder: '例如：信用卡末四碼以外的描述' },
          }),
        ),
        selectField({
          id: 'sub-category',
          label: '分類',
          required: false,
          value: sub?.categoryId ?? 'cat_subscription',
          options: categoryOptions('expense', { selected: sub?.categoryId }),
        }),
        inputField({
          id: 'sub-remind',
          label: '提前幾天提醒',
          type: 'number',
          value: sub?.remindDays ?? 3,
          attrs: { min: '0', max: '60', inputmode: 'numeric' },
        }),
        textareaField({ id: 'sub-note', label: '備註', value: sub?.note ?? '', rows: 2, maxlength: 500 }),
        h('p', { class: 'small muted' }, '請不要在備註或付款方式填寫完整卡號、密碼等敏感資料。'),
      ),
    onSubmit: (form) => {
      const result = validateSubInput({
        name: form.elements['sub-name'].value,
        amount: form.elements['sub-amount'].value,
        currency: form.elements['sub-currency'].value,
        cycleUnit: form.elements['sub-unit'].value,
        cycleEvery: form.elements['sub-every'].value,
        nextRenewal: form.elements['sub-next'].value,
        accountId: form.elements['sub-account'].value,
        paymentMethod: form.elements['sub-method'].value,
        categoryId: form.elements['sub-category'].value,
        status: sub?.status ?? 'active',
        remindDays: form.elements['sub-remind'].value,
        note: form.elements['sub-note'].value,
      });
      if (!result.ok) {
        const map = {
          name: 'sub-name',
          amount: 'sub-amount',
          currency: 'sub-currency',
          cycleUnit: 'sub-unit',
          cycleEvery: 'sub-every',
          nextRenewal: 'sub-next',
          paymentMethod: 'sub-method',
          remindDays: 'sub-remind',
          note: 'sub-note',
        };
        return Object.fromEntries(Object.entries(result.errors).map(([k, v]) => [map[k] ?? 'sub-name', v]));
      }
      if (sub)
        return commit({ ...app.data, subscriptions: patchSubscription(app.data.subscriptions, sub.id, result.value) }, '已儲存訂閱。');
      return commit(
        { ...app.data, subscriptions: [...app.data.subscriptions, createSubscription(result.value)] },
        `已新增訂閱「${result.value.name}」。`,
      );
    },
  });
}

/** 記錄扣款：可修改實際日期、金額與帳戶；若找到可能是同一筆的既有交易，提供「連結」而不重複建立。 */
export function openChargeDialog(sub, chargeDate) {
  const existing = chargeFor(app.data.transactions, sub.id, chargeDate);
  if (existing) {
    addNotice(`「${sub.name}」${chargeDate} 這次續費已經記錄過了。`, 'info', { key: 'charge' });
    return;
  }
  const duplicates = possibleDuplicates(app.data.transactions, sub, chargeDate);
  const { close } = openFormDialog({
    title: `記錄扣款：${sub.name}`,
    submitText: '建立扣款紀錄',
    body: () =>
      h(
        'div',
        {},
        h(
          'p',
          {},
          `預估續費日 ${formatDateLabel(chargeDate)}，預估金額 ${money(sub.amountMinor, sub.currency)}。確認實際扣款後才會建立支出紀錄。`,
        ),
        duplicates.length
          ? h(
              'div',
              { class: 'notice notice--warning' },
              h('p', {}, h('strong', {}, '可能已經記錄過：'), '以下支出的金額相同、日期相近，可能就是這次扣款。連結後不會重複計入支出。'),
              h(
                'ul',
                { class: 'bullets' },
                duplicates.map((t) =>
                  h(
                    'li',
                    {},
                    `${t.date} ${money(t.amountMinor, t.currency)} ${t.note ?? ''} `,
                    button(
                      '連結這筆',
                      () => {
                        const result = linkCharge(app.data, t.id, sub.id, chargeDate);
                        if (!result.ok) return addNotice(result.error, 'error');
                        if (commit(result.data, `已把 ${t.date} 的支出連結為「${sub.name}」的扣款。`)) close();
                      },
                      { size: 'small', label: `把 ${t.date} ${money(t.amountMinor, t.currency)} 連結為這次扣款` },
                    ),
                  ),
                ),
              ),
            )
          : null,
        inputField({ id: 'charge-date', label: '實際扣款日期', type: 'date', required: true, value: chargeDate }),
        inputField({
          id: 'charge-amount',
          label: `實際金額（${CURRENCIES[sub.currency].label}）`,
          required: true,
          value: amountToInput(sub.amountMinor, sub.currency),
          attrs: { inputmode: 'decimal' },
        }),
        selectField({
          id: 'charge-account',
          label: '扣款帳戶',
          required: false,
          value: sub.accountId ?? '',
          options: accountOptions({ selected: sub.accountId }),
        }),
      ),
    onSubmit: (form) => {
      const date = form.elements['charge-date'].value;
      const amount = parseAmount(form.elements['charge-amount'].value, sub.currency);
      const errors = {};
      if (!isValidDateKey(date)) errors['charge-date'] = '請選擇日期。';
      else if (compareDateKeys(date, app.todayKey) > 0) errors['charge-date'] = '實際扣款日不能是未來日期；尚未扣款前請不要記錄。';
      if (!amount.ok) errors['charge-amount'] = amount.error;
      if (Object.keys(errors).length) return errors;
      const result = recordCharge(app.data, sub.id, {
        chargeDate,
        date,
        amountMinor: amount.value,
        accountId: form.elements['charge-account'].value || null,
      });
      if (!result.ok) return { 'charge-date': result.error };
      return commit(
        result.data,
        `已記錄「${sub.name}」的扣款，下次續費日：${formatDateLabel(result.data.subscriptions.find((s) => s.id === sub.id).nextRenewal)}。`,
      );
    },
  });
}

function createReminder(sub, date) {
  checkDateChange();
  const result = createReminderTask(app.data, sub, date, app.todayKey);
  if (!result.ok) return addNotice(result.error, 'info', { key: 'reminder' });
  commit(result.data, `已建立提醒任務，截止日 ${formatDateLabel(result.task.dueDate)}。`);
}

function renewalRow(item, context) {
  const { sub, date, overdue } = item;
  const hasTask = app.data.tasks.some((t) => t.id === reminderTaskId(sub.id, date));
  const isNext = date === sub.nextRenewal;
  return h(
    'li',
    { class: 'renewal' },
    h(
      'div',
      { class: 'renewal-main' },
      h('p', { class: 'renewal-title' }, sub.name),
      h(
        'p',
        { class: 'todo-meta' },
        h(
          'span',
          { class: `badge ${overdue ? 'badge--overdue' : 'badge--today'}` },
          overdue ? `⚠ ${formatDateLabel(date)} 已過，尚未記錄扣款` : `${formatDateLabel(date)} 續費`,
        ),
        h('span', { class: 'badge badge--muted' }, '預估'),
        h('span', { class: 'badge' }, money(sub.amountMinor, sub.currency)),
      ),
    ),
    h(
      'div',
      { class: 'todo-actions' },
      isNext
        ? button('記錄扣款', () => openChargeDialog(sub, date), {
            size: 'small',
            focusKey: `${context}-charge-${sub.id}-${date}`,
            label: `記錄「${sub.name}」${date} 的扣款`,
          })
        : null,
      hasTask
        ? h('span', { class: 'small muted' }, '✓ 已建立提醒任務')
        : button('建立提醒任務', () => createReminder(sub, date), {
            variant: 'ghost',
            size: 'small',
            focusKey: `${context}-remind-${sub.id}-${date}`,
            label: `為「${sub.name}」${date} 的續費建立提醒任務`,
          }),
    ),
  );
}

function subCard(sub) {
  const e = estimateCost(sub);
  const label = sub.name;
  const setStatus = (status, message) =>
    commit({ ...app.data, subscriptions: patchSubscription(app.data.subscriptions, sub.id, { status }) }, message);
  const linked = app.data.transactions.filter((t) => t.subscriptionId === sub.id).length;
  return h(
    'li',
    { class: `card sub${sub.status !== 'active' || sub.archived ? ' is-archived' : ''}` },
    h(
      'div',
      { class: 'budget-head' },
      h('h4', {}, sub.name),
      h(
        'span',
        { class: `badge ${sub.status === 'active' ? 'badge--done' : 'badge--muted'}` },
        sub.archived ? '已封存' : STATUS_LABELS[sub.status],
      ),
    ),
    h(
      'p',
      {},
      h('strong', {}, money(sub.amountMinor, sub.currency)),
      ` / ${describeCycle(sub.cycleUnit, sub.cycleEvery)}`,
      sub.status === 'active' && !sub.archived ? `・下次 ${formatDateLabel(sub.nextRenewal)}` : '',
    ),
    h(
      'p',
      { class: 'small muted' },
      `每月${e.exactMonthly ? '' : '約'} ${money(e.monthly, sub.currency)}${e.exactMonthly ? '' : '（估算）'}・全年${e.exactAnnual ? '' : '約'} ${money(e.annual, sub.currency)}${e.exactAnnual ? '' : '（估算）'}`,
      sub.accountId || sub.paymentMethod
        ? `・付款：${[nameOf('accounts', sub.accountId), sub.paymentMethod].filter(Boolean).join('／')}`
        : '',
      linked ? `・已記錄 ${linked} 次扣款` : '',
    ),
    sub.note ? h('p', { class: 'todo-note' }, sub.note) : null,
    h(
      'div',
      { class: 'todo-actions' },
      button('編輯', () => openSubDialog(sub), {
        variant: 'ghost',
        size: 'small',
        focusKey: `sub-edit-${sub.id}`,
        label: `編輯「${label}」`,
      }),
      !sub.archived && sub.status === 'active'
        ? button('暫停', () => setStatus('paused', `已暫停「${label}」，暫停期間不計入預估。`), {
            variant: 'ghost',
            size: 'small',
            focusKey: `sub-pause-${sub.id}`,
            label: `暫停「${label}」`,
          })
        : null,
      !sub.archived && sub.status !== 'active'
        ? button(sub.status === 'paused' ? '恢復' : '重新啟用', () => setStatus('active', `已恢復「${label}」，請確認下次續費日。`), {
            variant: 'ghost',
            size: 'small',
            focusKey: `sub-resume-${sub.id}`,
            label: `恢復「${label}」`,
          })
        : null,
      !sub.archived && sub.status !== 'cancelled'
        ? button('取消訂閱', () => setStatus('cancelled', `已將「${label}」標示為取消。`), {
            variant: 'ghost',
            size: 'small',
            focusKey: `sub-cancel-${sub.id}`,
            label: `將「${label}」標示為已取消`,
          })
        : null,
      button(
        sub.archived ? '取消封存' : '封存',
        () =>
          commit(
            { ...app.data, subscriptions: patchSubscription(app.data.subscriptions, sub.id, { archived: !sub.archived }) },
            sub.archived ? `已取消封存「${label}」。` : `已封存「${label}」。`,
          ),
        {
          variant: 'ghost',
          size: 'small',
          focusKey: `sub-archive-${sub.id}`,
          label: `${sub.archived ? '取消封存' : '封存'}「${label}」`,
        },
      ),
      button(
        '刪除',
        async () => {
          if (linked) {
            addNotice(`「${label}」已有 ${linked} 筆扣款紀錄連結，為保留帳目只能封存，不能刪除。`, 'warning', { key: 'sub-delete' });
            return;
          }
          if (await confirmAction({ title: '刪除訂閱', message: `刪除「${label}」？`, confirmText: '刪除', danger: true })) {
            commit({ ...app.data, subscriptions: deleteSubscription(app.data.subscriptions, sub.id) }, '已刪除訂閱。');
          }
        },
        { variant: 'ghost-danger', size: 'small', focusKey: `sub-delete-${sub.id}`, label: `刪除「${label}」` },
      ),
    ),
  );
}

export function renderSubscriptions() {
  const totals = estimateTotals(app.data.subscriptions);
  const days = app.data.settings.upcomingDays;
  const upcoming = upcomingRenewals(app.data.subscriptions, app.todayKey, days);
  const active = app.data.subscriptions.filter((s) => s.status === 'active' && !s.archived);
  const inactive = app.data.subscriptions.filter((s) => s.status !== 'active' && !s.archived);
  const archived = app.data.subscriptions.filter((s) => s.archived);
  return h(
    'div',
    {},
    button('＋ 新增訂閱', () => openSubDialog(), { variant: 'primary', focusKey: 'sub-add' }),
    section(
      'sub-estimate',
      '預估訂閱費用',
      Object.keys(totals).length
        ? h(
            'div',
            { class: 'money-summary' },
            Object.entries(totals).map(([currency, row]) =>
              h(
                'dl',
                { class: 'money-card' },
                h('dt', { class: 'money-currency' }, `${CURRENCIES[currency].label}（${row.count} 個使用中）`),
                h('dd', {}, h('span', {}, `每月預估${row.estimated ? '（含估算）' : ''}`), h('strong', {}, money(row.monthly, currency))),
                h('dd', {}, h('span', {}, `全年預估${row.estimated ? '（含估算）' : ''}`), h('strong', {}, money(row.annual, currency))),
              ),
            ),
          )
        : h('p', { class: 'muted' }, '沒有使用中的訂閱。'),
      h(
        'p',
        { class: 'small muted' },
        '預估只依週期推算，不計入收支統計；年繳、季繳等換算成每月時為估算（年繳 ÷ 12、週繳 × 52 ÷ 12）。暫停與取消的訂閱不計入。',
      ),
    ),
    section(
      'sub-upcoming',
      `近期續費（${days} 天內，預估）`,
      upcoming.length
        ? h(
            'ul',
            { class: 'renewal-list' },
            upcoming.map((item) => renewalRow(item, 'sub')),
          )
        : h('p', { class: 'muted' }, `${days} 天內沒有續費。`),
      h(
        'p',
        { class: 'small muted' },
        '「記錄扣款」會建立一筆實際支出並推進下次續費日；同一次續費只能記錄一次。如果這筆扣款已經從 CSV 匯入，系統會提示你改用「連結」，避免重複計入。',
      ),
    ),
    section(
      'sub-active',
      `使用中（${active.length}）`,
      active.length
        ? h('ul', { class: 'sub-list' }, active.map(subCard))
        : emptyState('還沒有訂閱', '新增訂閱後，可以看到每月與全年預估費用，以及續費提醒。'),
    ),
    inactive.length
      ? section('sub-inactive', `暫停或已取消（${inactive.length}）`, h('ul', { class: 'sub-list' }, inactive.map(subCard)))
      : null,
    archived.length
      ? h(
          'details',
          { class: 'method' },
          h('summary', {}, `已封存（${archived.length}）`),
          h('ul', { class: 'sub-list' }, archived.map(subCard)),
        )
      : null,
  );
}

/** 在今日頁與設定頁登記訂閱相關的區塊（由 app.js 啟動時呼叫）。 */
export function installSubscriptionExtensions() {
  // 今日頁：續費提醒（站內提醒）
  registerTodayExtension({
    order: 10,
    summary: () => {
      const upcoming = upcomingRenewals(app.data.subscriptions, app.todayKey, 7);
      if (!app.data.subscriptions.length) return null;
      return summaryItem('7 天內續費', `${upcoming.length} 筆`, { tone: upcoming.some((u) => u.overdue) ? 'alert' : '', href: '#finance' });
    },
    section: () => {
      const reminders = dueReminders(app.data.subscriptions, app.todayKey);
      const upcoming = upcomingRenewals(app.data.subscriptions, app.todayKey, 7).filter(
        (u) => !reminders.some((r) => r.sub.id === u.sub.id && r.date === u.date),
      );
      const items = [...reminders, ...upcoming];
      if (!items.length) return null;
      return section(
        'today-renewals',
        `近期續費（${items.length}）`,
        h(
          'ul',
          { class: 'renewal-list' },
          items.map((item) => renewalRow(item, 'today')),
        ),
        h('p', { class: 'small muted' }, '這些是依訂閱週期推算的預估續費（站內提醒），實際扣款後請按「記錄扣款」。'),
        button(
          '前往訂閱',
          () => {
            state().tab = 'subs';
            location.hash = '#finance';
          },
          { variant: 'ghost', size: 'small', focusKey: 'today-go-subs' },
        ),
      );
    },
  });

  // 設定頁：主要幣別
  registerSettingsExtension({
    order: 55,
    render: () =>
      h(
        'div',
        {},
        selectField({
          id: 'settings-currency',
          label: '主要幣別（新增收支與訂閱時的預設值）',
          value: app.data.settings.baseCurrency,
          options: currencyOptions(),
          onChange: (event) =>
            commit(
              { ...app.data, settings: { ...app.data.settings, baseCurrency: event.target.value, updatedAt: new Date().toISOString() } },
              '已更新主要幣別。',
            ),
        }),
        h('p', { class: 'small muted' }, '變更主要幣別不會換算既有紀錄；不同幣別一律分開統計。'),
      ),
  });
}
