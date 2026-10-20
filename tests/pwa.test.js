import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

function shellList() {
  const source = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  const block = source.match(/const APP_SHELL = \[([\s\S]*?)\];/)[1];
  return [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

function walk(dir, filter) {
  return fs
    .readdirSync(path.join(root, dir), { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name), filter) : [path.join(dir, entry.name).replaceAll('\\', '/')]))
    .filter(filter);
}

test('離線快取清單包含所有網站檔案（新增檔案時不會漏掉）', () => {
  const shell = new Set(shellList());
  const required = [
    'index.html',
    'manifest.webmanifest',
    ...walk('js', (f) => f.endsWith('.js')),
    ...walk('css', (f) => f.endsWith('.css')),
    ...walk('icons', (f) => /\.(png|svg)$/.test(f)),
  ];
  const missing = required.filter((f) => !shell.has(f));
  assert.deepEqual(missing, [], `sw.js 的 APP_SHELL 缺少：${missing.join(', ')}`);
  for (const file of shell) {
    if (file === './') continue;
    assert.ok(fs.existsSync(path.join(root, file)), `APP_SHELL 列出不存在的檔案：${file}`);
  }
});

test('所有路徑都是相對路徑（可部署在 /daily-habit/ 子路徑）', () => {
  for (const file of shellList()) assert.ok(!file.startsWith('/'), file);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.webmanifest'), 'utf8'));
  assert.ok(!manifest.start_url.startsWith('/') && !manifest.scope.startsWith('/'));
  for (const icon of manifest.icons) {
    assert.ok(!icon.src.startsWith('/'));
    assert.ok(fs.existsSync(path.join(root, icon.src)), icon.src);
  }
  assert.ok(manifest.icons.some((i) => i.sizes === '192x192') && manifest.icons.some((i) => i.sizes === '512x512'));
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.equal(/(src|href)="\//.test(html), false, 'index.html 不可有 / 開頭的路徑');
});
