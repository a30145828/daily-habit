// 金額：一律以「最小貨幣單位的整數」儲存（amountMinor），避免浮點數誤差。
// 例：新台幣 120 元 → 120；美金 9.99 → 999。
// 不同幣別不可直接相加；沒有匯率資料時一律分開統計。

/** 支援的幣別與小數位數。新台幣在本工具以「元」為最小單位。 */
export const CURRENCIES = {
  TWD: { label: '新台幣', symbol: 'NT$', digits: 0 },
  USD: { label: '美元', symbol: 'US$', digits: 2 },
  JPY: { label: '日圓', symbol: '¥', digits: 0 },
  EUR: { label: '歐元', symbol: '€', digits: 2 },
  CNY: { label: '人民幣', symbol: 'CN¥', digits: 2 },
  HKD: { label: '港幣', symbol: 'HK$', digits: 2 },
  GBP: { label: '英鎊', symbol: '£', digits: 2 },
  KRW: { label: '韓元', symbol: '₩', digits: 0 },
  SGD: { label: '新加坡幣', symbol: 'S$', digits: 2 },
  AUD: { label: '澳幣', symbol: 'A$', digits: 2 },
  CAD: { label: '加幣', symbol: 'C$', digits: 2 },
};

export const DEFAULT_CURRENCY = 'TWD';
export const MAX_AMOUNT_MINOR = 1e13; // 遠大於個人使用範圍，避免超出精確整數

export function isCurrency(code) {
  return Object.hasOwn(CURRENCIES, code);
}

export function currencyDigits(code) {
  return CURRENCIES[code]?.digits ?? 2;
}

/**
 * 解析使用者輸入的金額字串（可含千分位逗號），回傳最小單位整數。
 * 回傳 { ok: true, value } 或 { ok: false, error }。不接受負數與 0（收入／支出由類型決定）。
 */
export function parseAmount(input, currency, { allowZero = false } = {}) {
  const digits = currencyDigits(currency);
  const text = String(input ?? '').trim().replace(/[,，\s]/g, '').replace(/^(NT\$|\$|＄)/, '');
  if (!text) return { ok: false, error: '請輸入金額。' };
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return { ok: false, error: '金額只能包含數字與小數點。' };
  const fraction = match[2] ?? '';
  if (fraction.length > digits) {
    return {
      ok: false,
      error: digits === 0 ? `${CURRENCIES[currency]?.label ?? currency}不可有小數。` : `最多 ${digits} 位小數。`,
    };
  }
  const value = Number(match[1]) * 10 ** digits + Number(fraction.padEnd(digits, '0') || 0);
  if (!Number.isSafeInteger(value) || value > MAX_AMOUNT_MINOR) return { ok: false, error: '金額過大。' };
  if (value === 0 && !allowZero) return { ok: false, error: '金額必須大於 0。' };
  return { ok: true, value };
}

/** 最小單位整數 → 不含符號的數字字串，例如 123450, USD → "1,234.50"。 */
export function formatAmountNumber(amountMinor, currency, { grouping = true } = {}) {
  const digits = currencyDigits(currency);
  const negative = amountMinor < 0;
  const abs = Math.abs(amountMinor);
  const whole = Math.floor(abs / 10 ** digits);
  const fraction = digits ? String(abs % 10 ** digits).padStart(digits, '0') : '';
  const wholeText = grouping ? whole.toLocaleString('en-US') : String(whole);
  return `${negative ? '-' : ''}${wholeText}${digits ? `.${fraction}` : ''}`;
}

/** 顯示用：NT$1,200、US$9.99。 */
export function formatMoney(amountMinor, currency) {
  const symbol = CURRENCIES[currency]?.symbol ?? `${currency} `;
  const negative = amountMinor < 0;
  return `${negative ? '-' : ''}${symbol}${formatAmountNumber(Math.abs(amountMinor), currency)}`;
}

/** 輸入框用（不含千分位）。 */
export function amountToInput(amountMinor, currency) {
  return formatAmountNumber(amountMinor, currency, { grouping: false });
}

/** 依幣別加總：items 為 [{ currency, amountMinor }]，回傳 { TWD: 1200, USD: 999 }。 */
export function sumByCurrency(items) {
  const totals = {};
  for (const item of items) totals[item.currency] = (totals[item.currency] ?? 0) + item.amountMinor;
  return totals;
}

/** 整數除法並四捨五入（估算用），例如年費換算月費。 */
export function divideRounded(amountMinor, divisor) {
  return Math.round(amountMinor / divisor);
}
