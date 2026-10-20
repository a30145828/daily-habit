// 建立 DOM 的小工具。所有使用者輸入都以文字節點加入，不使用 innerHTML，避免被當成 HTML 執行。

/**
 * h('button', { class: 'btn', onClick: fn }, '文字', 子元素...)
 * - class：CSS 類別
 * - text：設定 textContent
 * - onXxx：事件處理
 * - dataset：data-* 屬性
 * - 其他：一般屬性；值為 true 時設為空屬性，false / null / undefined 則略過
 */
export function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') element.className = value;
    else if (key === 'text') element.textContent = value;
    else if (key === 'dataset') Object.assign(element.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      element.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) element.setAttribute(key, '');
    else element.setAttribute(key, String(value));
  }
  appendChildren(element, children);
  return element;
}

function appendChildren(element, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/** 清空元素並放入新的子元素。 */
export function replaceChildren(element, ...children) {
  element.textContent = '';
  appendChildren(element, children);
}

/** 讓瀏覽器下載文字檔。 */
export function downloadText(filename, text, type = 'application/json') {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = h('a', { href: url, download: filename, hidden: true });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
