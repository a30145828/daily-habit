// 設定區域：偏好設定、資料保存說明、儲存空間用量、完整備份匯出與還原、範例資料、清除資料；
// 以及資料損壞時的救援畫面。帳號與同步的設定由 account-view.js 登記到這裡。

import { BACKUP_MAX_BYTES, backupFileName, createBackup, validateBackupText } from '../backup.js';
import { formatTimestamp } from '../dates.js';
import { downloadText } from '../dom.js';
import { buildSampleData, mergeSample } from '../sample.js';
import { COLLECTIONS, CURRENT_VERSION, countData, describeCounts, emptyData, hasUserData } from '../schema.js';
import { STORAGE_LIMIT_CHARS, measureStorage, preserveCorruptData, saveData } from '../storage.js';
import {
  addNotice,
  app,
  button,
  card,
  commit,
  confirmAction,
  focusHeading,
  h,
  heading,
  render,
  replaceChildren,
  segmented,
  showToast,
} from './core.js';

const META_KEY = 'daily-habit:meta';

/** 其他模組（帳號與同步、財務匯出）可登記設定頁的卡片：{ order, render: () => 元素 } */
const extensions = [];

export function registerSettingsExtension(extension) {
  extensions.push(extension);
  extensions.sort((a, b) => a.order - b.order);
}

function readMeta() {
  try {
    const meta = JSON.parse(app.storage?.getItem(META_KEY) ?? '{}');
    return meta && typeof meta === 'object' ? meta : {};
  } catch {
    return {};
  }
}

function writeMeta(meta) {
  try {
    app.storage?.setItem(META_KEY, JSON.stringify({ ...readMeta(), ...meta }));
  } catch {
    // 只是提示用的資訊，寫不進去不影響主要資料。
  }
}

/** 匯入預覽的狀態（設定頁與救援頁共用）。 */
const importState = { preview: null };

export function exportBackup() {
  const filename = backupFileName();
  downloadText(filename, JSON.stringify(createBackup(app.data), null, 2));
  writeMeta({ lastExportAt: new Date().toISOString() });
  if (app.view === 'settings' && app.mode !== 'recovery') render();
  showToast(`已下載備份檔 ${filename}`);
}

export async function loadSampleData() {
  if (hasUserData(app.data)) {
    const ok = await confirmAction({
      title: '加入範例資料？',
      message: '範例資料會「加入」到目前的資料中，不會刪除你原有的內容。\n範例項目名稱前會標示「（範例）」，之後可以自行刪除或封存。',
      confirmText: '加入範例',
    });
    if (!ok) return;
  }
  commit(mergeSample(app.data, buildSampleData(app.todayKey)), '已載入範例資料。');
}

async function clearAllData() {
  const ok = await confirmAction({
    title: '清除所有資料？',
    message:
      '這裡的所有任務、習慣、打卡、收支、訂閱與獎勵紀錄都會被刪除，無法復原。\n' +
      (app.session ? '你已登入：刪除會同步到雲端與你的其他裝置。\n' : '') +
      '如果還沒備份，請先按「取消」，再下載備份檔。',
    confirmText: '全部清除',
    danger: true,
  });
  if (!ok) return;
  commit(emptyData(), '已清除所有資料。');
}

function setSetting(field, value, message) {
  const settings = { ...app.data.settings, [field]: value, updatedAt: new Date().toISOString() };
  commit({ ...app.data, settings }, message);
}

// ---------- 匯入 ----------

export function renderImporter({ allowExportFirst, onConfirm }) {
  const preview = importState.preview;
  const fileInput = h('input', {
    type: 'file',
    id: 'import-file',
    class: 'file-input',
    accept: '.json,application/json',
    dataset: { focusKey: 'import-file' },
    onChange: (event) => handleImportFile(event.target.files?.[0], allowExportFirst),
  });
  const parts = [h('div', { class: 'field' }, h('label', { for: 'import-file', class: 'field-label' }, '選擇備份檔（.json）'), fileInput)];

  if (preview && !preview.result.ok) {
    parts.push(
      h(
        'div',
        { class: 'import-preview notice notice--error' },
        h('h4', { id: 'import-result', tabindex: '-1' }, '✕ 無法使用這個備份檔'),
        h('p', {}, `檔案「${preview.fileName}」沒有通過檢查，`, h('strong', {}, '目前的資料沒有任何變更'), '。'),
        h('ul', { class: 'bullets' }, preview.result.errors.map((error) => h('li', {}, error))),
        button('關閉', cancelImport, { size: 'small', focusKey: 'import-cancel' }),
      ),
    );
  } else if (preview) {
    const { result } = preview;
    parts.push(
      h(
        'div',
        { class: 'import-preview notice notice--info' },
        h('h4', { id: 'import-result', tabindex: '-1' }, '✓ 備份檔檢查通過'),
        h(
          'dl',
          { class: 'details' },
          h('dt', {}, '檔案'),
          h('dd', {}, preview.fileName),
          h('dt', {}, '資料版本'),
          h('dd', {}, `${result.version}${result.version < CURRENT_VERSION ? `（還原時會自動轉換為版本 ${CURRENT_VERSION}）` : ''}`),
          h('dt', {}, '匯出時間'),
          h('dd', {}, result.exportedAt ? formatTimestamp(result.exportedAt) : '未記錄'),
          h('dt', {}, '內容'),
          h('dd', {}, describeCounts(result.counts)),
        ),
        result.warnings.length ? h('ul', { class: 'bullets' }, result.warnings.map((w) => h('li', {}, w))) : null,
        app.mode === 'recovery'
          ? h('p', {}, '還原後會使用備份內容；無法讀取的原始資料會另外保留在瀏覽器中。')
          : h('p', {}, h('strong', {}, '注意：'), `目前的資料（${describeCounts(countData(app.data))}）將被完整取代。`),
        app.session && app.mode !== 'recovery'
          ? h('p', { class: 'small' }, '你已登入：還原後的內容會同步到雲端；備份中沒有的資料會在雲端標記刪除。')
          : null,
        allowExportFirst && app.mode !== 'recovery'
          ? h(
              'label',
              { class: 'checkbox-label' },
              h('input', {
                type: 'checkbox',
                checked: preview.exportFirst,
                dataset: { focusKey: 'import-export-first' },
                onChange: (event) => {
                  preview.exportFirst = event.target.checked;
                },
              }),
              h('span', {}, '還原前，先下載目前資料的備份（建議）'),
            )
          : null,
        h(
          'div',
          { class: 'button-row' },
          button('以此備份還原…', () => confirmImport(onConfirm), { variant: 'danger', focusKey: 'import-confirm' }),
          button('取消', cancelImport, { focusKey: 'import-cancel' }),
        ),
      ),
    );
  }
  return h('div', { class: 'importer' }, parts);
}

async function handleImportFile(file, allowExportFirst) {
  if (!file) return;
  let result;
  if (file.size > BACKUP_MAX_BYTES) {
    result = { ok: false, errors: ['檔案太大，不像是本工具的備份檔。'], warnings: [] };
  } else {
    try {
      result = validateBackupText(await file.text());
    } catch {
      result = { ok: false, errors: ['無法讀取這個檔案。'], warnings: [] };
    }
  }
  importState.preview = { fileName: file.name, result, exportFirst: allowExportFirst && hasUserData(app.data) };
  render();
  document.getElementById('import-result')?.focus();
}

function cancelImport() {
  importState.preview = null;
  app.pendingFocusKey = 'import-file';
  render();
}

async function confirmImport(onConfirm) {
  const preview = importState.preview;
  if (!preview?.result.ok) return;
  const ok = await confirmAction({
    title: '以備份完整取代目前資料？',
    message:
      app.mode === 'recovery'
        ? `將以備份內容（${describeCounts(preview.result.counts)}）開始使用。`
        : `目前所有資料都會被取代為備份檔中的內容（${describeCounts(preview.result.counts)}）。\n此動作無法復原。`,
    confirmText: '確定還原',
    danger: true,
  });
  if (!ok) return;
  if (onConfirm) {
    if (onConfirm(preview.result.data)) {
      importState.preview = null;
      render();
      showToast('已從備份還原資料。');
    }
    return;
  }
  if (preview.exportFirst) exportBackup();
  importState.preview = null;
  if (!commit(preview.result.data, '已從備份還原資料。')) {
    importState.preview = preview;
    render();
  }
}

// ---------- 儲存空間用量 ----------

const STORAGE_KIND_LABELS = {
  current: '目前的資料',
  local: '未登入時的本機資料',
  account: '帳號快取與待同步',
  preserved: '升級前或損壞時另存',
  app: '其他設定',
  other: '同網址的其他網站',
};

const STORAGE_LEVEL_TEXT = {
  ok: '✓ 空間充足。',
  warn: '⚠ 已使用超過七成。建議先匯出備份，並清除同網址下不需要的其他網站資料。',
  danger: '⛔ 空間快滿了：滿了之後新的變更將無法保存。請立即匯出備份。',
};

/** 以字元數概略換算成 KB／MB（只用於顯示）。 */
function formatStorageSize(chars) {
  if (chars < 1000) return '不到 1 KB';
  if (chars < 1_000_000) return `約 ${Math.round(chars / 1000)} KB`;
  return `約 ${(chars / 1_000_000).toFixed(1)} MB`;
}

function storagePercent(usage) {
  return Math.min(100, Math.round(usage.ratio * 100));
}

/** 啟動時檢查用量；超過七成在畫面上方提醒（由 app.js 呼叫）。 */
export function checkStorageUsage() {
  if (app.mode === 'memory') return;
  const usage = measureStorage(app.storage, app.storageKey);
  if (!usage || usage.level === 'ok') return;
  addNotice(
    `瀏覽器儲存空間已使用約 ${storagePercent(usage)}%。${usage.level === 'danger' ? '空間快滿了，滿了之後新的變更將無法保存，' : ''}請先匯出備份，詳情見「設定 → 儲存空間」。`,
    usage.level === 'danger' ? 'error' : 'warning',
    { key: 'storage-usage', action: { label: '前往設定', onClick: () => (location.hash = '#settings') } },
  );
}

function renderStorageUsage() {
  const usage = app.mode === 'memory' ? null : measureStorage(app.storage, app.storageKey);
  if (!usage) {
    return card('settings-storage', '儲存空間', h('p', {}, '瀏覽器目前不允許讀取儲存空間，無法計算用量。'));
  }
  const percent = storagePercent(usage);
  const percentText = usage.used > 0 && percent === 0 ? '不到 1%' : `${percent}%`;
  return card(
    'settings-storage',
    '儲存空間',
    h(
      'dl',
      { class: 'details storage-summary' },
      h('dt', {}, '已使用'),
      h('dd', {}, `${formatStorageSize(usage.used)}（${percentText}）`),
      h('dt', {}, '剩餘'),
      h('dd', {}, formatStorageSize(Math.max(0, usage.limit - usage.used))),
      h('dt', {}, '估計上限'),
      h('dd', {}, `約 ${usage.limit / 1_000_000} MB`),
    ),
    h('progress', {
      class: `storage-meter is-${usage.level}`,
      max: '100',
      value: String(percent),
      'aria-label': `儲存空間已使用 ${percentText}`,
    }),
    h(
      'p',
      { class: usage.level === 'ok' ? 'small' : `small notice notice--${usage.level === 'danger' ? 'error' : 'warning'}`, 'data-storage-level': usage.level },
      STORAGE_LEVEL_TEXT[usage.level],
    ),
    h('h4', { class: 'field-label' }, '各類資料佔用'),
    h(
      'dl',
      { class: 'details storage-breakdown' },
      Object.entries(usage.kinds)
        .filter(([, size]) => size > 0)
        .map(([kind, size]) => [h('dt', {}, STORAGE_KIND_LABELS[kind]), h('dd', {}, formatStorageSize(size))]),
    ),
    h(
      'ul',
      { class: 'bullets small' },
      h('li', {}, `上限依瀏覽器不同，這裡以約 ${STORAGE_LIMIT_CHARS / 1_000_000} MB 估算，剩餘空間也是估計值。同一個網址（${location.host || '本機'}）下的所有網站共用這個空間。`),
      h('li', {}, '空間不足時，新的變更不會保存，但已經保存的資料不會被刪除。'),
      app.session ? h('li', {}, '你已登入：資料也存在雲端，但這台裝置的空間滿了之後，新的變更無法保存也無法上傳。') : null,
    ),
  );
}

// ---------- 設定頁 ----------

export function renderSettings(panel) {
  const counts = countData(app.data);
  const meta = readMeta();
  const settings = app.data.settings;
  replaceChildren(
    panel,
    heading('settings', '設定'),
    extensions.filter((ext) => ext.order < 50).map((ext) => ext.render()),
    card(
      'settings-prefs',
      '偏好設定',
      h('p', { class: 'field-label' }, '每週從哪一天開始'),
      segmented({
        name: 'week-start',
        legend: '每週從哪一天開始',
        value: String(settings.weekStart),
        options: [
          { value: '1', label: '星期一' },
          { value: '0', label: '星期日' },
        ],
        onChange: (value) => setSetting('weekStart', Number(value), '已更新每週起始日。'),
      }),
      extensions.filter((ext) => ext.order >= 50 && ext.order < 60).map((ext) => ext.render()),
    ),
    h(
      'section',
      { class: 'card notice notice--info', 'aria-labelledby': 'settings-where' },
      h('h3', { id: 'settings-where' }, '你的資料存在哪裡？'),
      h(
        'ul',
        { class: 'bullets' },
        app.session
          ? h('li', {}, '你已登入：資料會存在這個瀏覽器，並同步到你的雲端帳號。其他裝置登入同一帳號即可看到。')
          : h('li', {}, '未登入時，資料只儲存在「目前這個瀏覽器」中，', h('strong', {}, '不會跨裝置同步'), '。'),
        h('li', {}, '清除瀏覽器資料、使用無痕視窗或更換瀏覽器時，本機資料可能消失。'),
        h('li', {}, h('strong', {}, '請定期匯出備份'), '（建議每週一次），並把檔案存放在安全的地方；備份含有財務資料，請勿上傳到公開位置。'),
      ),
      h('p', { class: 'small' }, meta.lastExportAt ? `上次在這個瀏覽器匯出備份：${formatTimestamp(meta.lastExportAt)}` : '你還沒有在這個瀏覽器匯出過備份。'),
    ),
    renderStorageUsage(),
    card(
      'settings-export',
      '匯出完整備份（JSON）',
      h('p', {}, `下載包含全部資料的 JSON 檔：${describeCounts(counts)}。`),
      button('下載備份檔', exportBackup, { variant: 'primary', focusKey: 'export' }),
    ),
    card(
      'settings-import',
      '從備份還原',
      h('p', {}, '選擇之前匯出的備份檔（新、舊版本皆可），系統會先檢查內容與筆數。還原會以備份內容「完整取代」目前所有資料；無效的備份不會覆蓋任何資料。'),
      renderImporter({ allowExportFirst: true }),
    ),
    extensions.filter((ext) => ext.order >= 60).map((ext) => ext.render()),
    card(
      'settings-sample',
      '範例資料',
      h('p', {}, '加入幾筆範例資料，名稱前會標示「（範例）」。不會刪除你原有的資料。'),
      button('載入範例資料', loadSampleData, { focusKey: 'settings-sample' }),
    ),
    h(
      'section',
      { class: 'card danger-zone', 'aria-labelledby': 'settings-clear' },
      h('h3', { id: 'settings-clear' }, '清除所有資料'),
      h('p', {}, '刪除所有任務、習慣、收支、訂閱與獎勵紀錄。建議先匯出備份。'),
      button('清除所有資料…', clearAllData, { variant: 'danger', focusKey: 'settings-clear' }),
    ),
    card(
      'settings-about',
      '技術資訊',
      h(
        'dl',
        { class: 'details' },
        h('dt', {}, '儲存狀態'),
        h('dd', {}, app.mode === 'memory' ? '⚠ 無法儲存（僅暫存在目前頁面）' : '✓ 已儲存在這個瀏覽器'),
        h('dt', {}, '資料版本'),
        h('dd', {}, String(CURRENT_VERSION)),
        h('dt', {}, '資料集合'),
        h('dd', {}, String(COLLECTIONS.length)),
      ),
    ),
  );
}

// ---------- 資料救援（儲存的資料無法讀取時） ----------

/** 離開救援模式：先另存損壞的原始內容，再寫入新資料。 */
function leaveRecovery(data) {
  const preserved = preserveCorruptData(app.storage, app.corrupt.raw);
  if (!preserved.ok) {
    addNotice(preserved.message, 'error');
    return false;
  }
  const saved = saveData(app.storage, data, new Date(), app.storageKey);
  if (!saved.ok) {
    addNotice(saved.message, 'error');
    return false;
  }
  app.mode = 'normal';
  app.corrupt = null;
  app.data = data;
  app.view = 'today';
  if (location.hash !== '#today') history.replaceState(null, '', '#today');
  addNotice(`無法讀取的原始資料已另存在瀏覽器的「${preserved.key}」。`, 'info');
  return true;
}

async function startFresh() {
  const ok = await confirmAction({
    title: '改用空白資料開始？',
    message: '無法讀取的原始內容會另外保留，不會被刪除。建議先按「下載原始資料」存一份檔案。',
    confirmText: '以空白資料開始',
    danger: true,
  });
  if (!ok) return;
  if (leaveRecovery(emptyData())) {
    render();
    focusHeading();
    showToast('已改用空白資料開始。');
  }
}

export function renderRecovery(panel) {
  const { raw, errors } = app.corrupt;
  replaceChildren(
    panel,
    h('h2', { id: 'heading-recovery', class: 'view-title', tabindex: '-1' }, '無法讀取已儲存的資料'),
    h(
      'div',
      { class: 'notice notice--error' },
      h(
        'p',
        {},
        '這個瀏覽器裡有本工具的資料，但內容無法正確讀取（可能已損壞，或是由較新版本的網頁建立）。',
        h('strong', {}, '為了保護你的資料，程式沒有修改或刪除它。'),
      ),
      h('details', {}, h('summary', {}, '查看錯誤細節'), h('ul', { class: 'bullets' }, errors.map((error) => h('li', {}, error)))),
    ),
    card(
      'recovery-1',
      '1. 先下載原始資料',
      h('p', {}, '把目前無法讀取的內容存成檔案，之後可以請人協助修復。'),
      button('下載原始資料', () => downloadText(`daily-habit-raw-${app.todayKey}.txt`, raw, 'text/plain'), {
        variant: 'primary',
        focusKey: 'recovery-download',
      }),
    ),
    card(
      'recovery-2',
      '2. 重新整理',
      h('p', {}, '如果你剛在其他分頁或較新版本的網頁使用過，重新整理可能就能解決。'),
      button('重新整理頁面', () => location.reload(), { focusKey: 'recovery-reload' }),
    ),
    card('recovery-3', '3. 從備份還原', renderImporter({ allowExportFirst: false, onConfirm: leaveRecovery })),
    h(
      'section',
      { class: 'card danger-zone', 'aria-labelledby': 'recovery-4' },
      h('h3', { id: 'recovery-4' }, '4. 改用空白資料重新開始'),
      h('p', {}, '無法讀取的原始內容會另外保留在瀏覽器中（不會被刪除），然後以空白資料開始使用。'),
      button('改用空白資料開始…', startFresh, { variant: 'danger', focusKey: 'recovery-fresh' }),
    ),
  );
}
