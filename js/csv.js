// CSV 解析與產生，以及收支 CSV 匯入（欄位對應、預覽、驗證、重複提示）與匯出。

import { isValidDateKey, makeDateKey } from './dates.js';
import { createAccount, createCategory } from './finance.js';
import { createId } from './ids.js';
import { amountToInput, isCurrency, parseAmount } from './money.js';
import { estimateCost } from './subscriptions.js';

// ---------- 解析與產生 ----------

/** 解析 CSV 文字（支援 UTF-8 BOM、引號、引號內的逗號與換行、CRLF）。回傳二維陣列。 */
export function parseCsv(text) {
  const input = String(text ?? '').replace(/^﻿/, '');
  const delimiter = detectDelimiter(input);
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (const ch of firstLine) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch in counts) counts[ch] += 1;
  }
  const [best, count] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return count > 0 ? best : ',';
}

function escapeCell(value) {
  const text = String(value ?? '');
  // 以 = + - @ 開頭的內容在試算表中可能被當成公式，前面加上單引號避免執行
  const safe = /^[=+\-@\t\r]/.test(text) && !/^-?\d/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** 產生 CSV 文字（含 UTF-8 BOM，讓 Excel 正確顯示中文）。 */
export function toCsv(rows) {
  return `﻿${rows.map((row) => row.map(escapeCell).join(',')).join('\r\n')}\r\n`;
}

// ---------- 欄位對應 ----------

export const IMPORT_FIELDS = ['date', 'amount', 'type', 'category', 'account', 'note', 'currency'];
export const IMPORT_FIELD_LABELS = {
  date: '日期',
  amount: '金額',
  type: '類型（收入／支出）',
  category: '分類',
  account: '帳戶',
  note: '備註',
  currency: '幣別',
};

const HEADER_ALIASES = {
  date: ['日期', '交易日期', '記帳日期', 'date', 'transaction date'],
  amount: ['金額', '金額（元）', 'amount', 'value'],
  type: ['類型', '收支', '收入/支出', '收入／支出', 'type'],
  category: ['分類', '類別', '項目', 'category'],
  account: ['帳戶', '付款方式', '支付方式', 'account'],
  note: ['備註', '說明', '描述', '摘要', '內容', 'note', 'description', 'memo'],
  currency: ['幣別', '貨幣', 'currency'],
};

/** 依標題列猜測欄位對應：{ date: 欄位索引 | -1, … } */
export function guessMapping(header) {
  const normalized = header.map((h) => String(h).trim().toLowerCase());
  const mapping = {};
  for (const field of IMPORT_FIELDS) {
    mapping[field] = normalized.findIndex((h) => HEADER_ALIASES[field].includes(h));
  }
  return mapping;
}

// ---------- 值的解析 ----------

/** 支援 2026-10-20、2026/10/20、2026/1/5、2026.1.5。 */
export function parseDateCell(text) {
  const match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(String(text ?? '').trim());
  if (!match) return null;
  const key = makeDateKey(Number(match[1]), Number(match[2]), Number(match[3]));
  return isValidDateKey(key) ? key : null;
}

export function parseTypeCell(text) {
  const value = String(text ?? '').trim().toLowerCase();
  if (['支出', 'expense', '支', 'out', '-'].includes(value)) return 'expense';
  if (['收入', 'income', '收', 'in', '+'].includes(value)) return 'income';
  return null;
}

/** 金額欄位可能帶負號或括號（會計格式）。回傳 { ok, value(正數), negative } 或錯誤。 */
export function parseAmountCell(text, currency) {
  let value = String(text ?? '').trim().replace(/[\s,，]/g, '');
  let negative = false;
  if (/^\(.*\)$/.test(value)) {
    negative = true;
    value = value.slice(1, -1);
  }
  if (value.startsWith('-')) {
    negative = true;
    value = value.slice(1);
  } else if (value.startsWith('+')) value = value.slice(1);
  value = value.replace(/^(NT\$|US\$|\$|¥|€|£)/, '');
  const parsed = parseAmount(value, currency);
  return parsed.ok ? { ok: true, value: parsed.value, negative } : parsed;
}

/** 重複判斷用的鍵：日期、類型、金額、幣別、備註（忽略空白與大小寫）。 */
export function importKeyOf(txn) {
  return [txn.date, txn.type, txn.amountMinor, txn.currency, String(txn.note ?? '').trim().toLowerCase()].join('|');
}

// ---------- 匯入預覽 ----------

/**
 * 依欄位對應與選項驗證每一列。
 * options：{ hasHeader, defaultCurrency, signMode: 'type' | 'negative' | 'expense' | 'income', defaultAccountId, defaultType }
 * - type：使用「類型」欄位
 * - negative：負數為支出、正數為收入
 * - expense / income：全部視為支出或收入
 * 回傳 { rows: [{ line, status: 'ok' | 'error' | 'duplicate', errors, txn, categoryName, accountName }], newCategories, newAccounts, counts }
 */
export function previewImport(rows, mapping, options, data) {
  const body = options.hasHeader ? rows.slice(1) : rows;
  const firstLine = options.hasHeader ? 2 : 1;
  const existingKeys = new Map(data.transactions.map((t) => [importKeyOf(t), t]));
  const seenInFile = new Set();
  const newCategories = new Map();
  const newAccounts = new Map();
  const cell = (row, field) => (mapping[field] >= 0 ? String(row[mapping[field]] ?? '').trim() : '');

  const result = body.map((row, index) => {
    const errors = [];
    const line = firstLine + index;
    const date = parseDateCell(cell(row, 'date'));
    if (!date) errors.push(`日期「${cell(row, 'date')}」無法辨識（請用 2026-10-20 或 2026/10/20）`);
    let currency = cell(row, 'currency').toUpperCase() || options.defaultCurrency;
    if (currency === 'NTD') currency = 'TWD';
    if (!isCurrency(currency)) errors.push(`不支援的幣別「${currency}」`);
    const amount = isCurrency(currency) ? parseAmountCell(cell(row, 'amount'), currency) : { ok: false, error: '' };
    if (!amount.ok && amount.error) errors.push(`金額「${cell(row, 'amount')}」：${amount.error}`);

    let type = null;
    if (options.signMode === 'type') {
      type = parseTypeCell(cell(row, 'type'));
      if (!type) errors.push(`類型「${cell(row, 'type')}」需為「收入」或「支出」`);
    } else if (options.signMode === 'negative') type = amount.ok && amount.negative ? 'expense' : 'income';
    else type = options.signMode === 'income' ? 'income' : 'expense';
    if (options.signMode !== 'negative' && amount.ok && amount.negative) {
      errors.push('金額為負數；若負數代表支出，請把「收支判斷」改為「負數為支出」');
    }

    const categoryName = cell(row, 'category');
    let categoryId = null;
    if (categoryName && type) {
      const found = data.categories.find((c) => c.type === type && c.name.trim().toLowerCase() === categoryName.toLowerCase());
      if (found) categoryId = found.id;
      else {
        const key = `${type}|${categoryName.toLowerCase()}`;
        if (!newCategories.has(key)) newCategories.set(key, createCategory(categoryName.slice(0, 50), type));
        categoryId = newCategories.get(key).id;
      }
    }
    const accountName = cell(row, 'account');
    let accountId = options.defaultAccountId || null;
    if (accountName) {
      const found = data.accounts.find((a) => a.name.trim().toLowerCase() === accountName.toLowerCase());
      if (found) accountId = found.id;
      else {
        const key = accountName.toLowerCase();
        if (!newAccounts.has(key)) newAccounts.set(key, createAccount(accountName.slice(0, 50)));
        accountId = newAccounts.get(key).id;
      }
    }
    const note = cell(row, 'note').slice(0, 500);

    if (errors.length) return { line, status: 'error', errors, txn: null, categoryName, accountName };
    const txn = { type, date, amountMinor: amount.value, currency, categoryId, accountId, note };
    const key = importKeyOf(txn);
    let status = 'ok';
    let duplicateReason = '';
    if (existingKeys.has(key)) {
      status = 'duplicate';
      duplicateReason = '與現有紀錄相同（日期、類型、金額、幣別、備註）';
    } else if (seenInFile.has(key)) {
      status = 'duplicate';
      duplicateReason = '與檔案中前面的某一列相同';
    }
    seenInFile.add(key);
    return { line, status, errors: duplicateReason ? [duplicateReason] : [], txn: { ...txn, importKey: key }, categoryName, accountName };
  });

  const counts = { ok: 0, duplicate: 0, error: 0 };
  for (const row of result) counts[row.status] += 1;
  return { rows: result, newCategories: [...newCategories.values()], newAccounts: [...newAccounts.values()], counts };
}

/**
 * 把預覽結果套用到資料。includeDuplicates 為 true 時連重複列也匯入。
 * 只建立實際用到的新分類與帳戶。回傳新的 data 與匯入筆數。
 */
export function applyImport(data, preview, { includeDuplicates = false } = {}, now = new Date()) {
  const timestamp = now.toISOString();
  const rows = preview.rows.filter((row) => row.status === 'ok' || (includeDuplicates && row.status === 'duplicate'));
  const transactions = rows.map((row) => ({
    id: createId('x'),
    ...row.txn,
    subscriptionId: null,
    chargeDate: null,
    source: 'csv',
    createdAt: timestamp,
    updatedAt: timestamp,
  }));
  const usedCategories = new Set(transactions.map((t) => t.categoryId));
  const usedAccounts = new Set(transactions.map((t) => t.accountId));
  const categories = preview.newCategories.filter((c) => usedCategories.has(c.id));
  const accounts = preview.newAccounts.filter((a) => usedAccounts.has(a.id));
  return {
    data: {
      ...data,
      transactions: [...data.transactions, ...transactions],
      categories: [...data.categories, ...categories],
      accounts: [...data.accounts, ...accounts],
    },
    imported: transactions.length,
    createdCategories: categories.length,
    createdAccounts: accounts.length,
  };
}

// ---------- 匯出 ----------

const TYPE_TEXT = { expense: '支出', income: '收入' };

export function transactionsCsv(data, txns = data.transactions) {
  const name = (list, id) => list.find((x) => x.id === id)?.name ?? '';
  const subName = (id) => data.subscriptions.find((s) => s.id === id)?.name ?? '';
  const rows = [['日期', '類型', '金額', '幣別', '分類', '帳戶', '備註', '訂閱', '訂閱續費日']];
  for (const t of txns.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))) {
    rows.push([
      t.date,
      TYPE_TEXT[t.type],
      amountToInput(t.amountMinor, t.currency),
      t.currency,
      name(data.categories, t.categoryId),
      name(data.accounts, t.accountId),
      t.note,
      subName(t.subscriptionId),
      t.chargeDate ?? '',
    ]);
  }
  return toCsv(rows);
}

export function subscriptionsCsv(data) {
  const STATUS = { active: '使用中', paused: '暫停', cancelled: '已取消' };
  const UNIT = { day: '天', week: '週', month: '月', year: '年' };
  const name = (list, id) => list.find((x) => x.id === id)?.name ?? '';
  const rows = [['名稱', '金額', '幣別', '週期', '下次續費日', '付款方式', '帳戶', '分類', '狀態', '已封存', '每月估算', '全年估算', '備註']];
  for (const s of data.subscriptions) {
    const e = estimateCost(s);
    rows.push([
      s.name,
      amountToInput(s.amountMinor, s.currency),
      s.currency,
      `每 ${s.cycleEvery} ${UNIT[s.cycleUnit]}`,
      s.nextRenewal,
      s.paymentMethod,
      name(data.accounts, s.accountId),
      name(data.categories, s.categoryId),
      STATUS[s.status],
      s.archived ? '是' : '否',
      amountToInput(e.monthly, s.currency),
      amountToInput(e.annual, s.currency),
      s.note,
    ]);
  }
  return toCsv(rows);
}

