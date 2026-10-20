process.env.TZ = 'Asia/Taipei';

import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloud, parseAuthRedirect, toSession } from '../js/cloud/api.js';
import {
  applyLocalImport,
  applyPullRows,
  applyPushResults,
  buildChanges,
  diffKeys,
  emptyMeta,
  keyOf,
  markPending,
  pendingCount,
  planLocalImport,
  resolveConflict,
  stableStringify,
} from '../js/cloud/sync.js';
import { reconcileRewards, redeemReward, createReward, totals } from '../js/game.js';
import { emptyData } from '../js/schema.js';
import { createTask, setTaskDone, updateTask, deleteTask } from '../js/tasks.js';

const now = new Date('2026-10-20T02:00:00Z');
const today = '2026-10-20';

/** 與 supabase/migrations 的 sync_push 規則相同的記憶體伺服器（單一帳號）。 */
class FakeServer {
  constructor() {
    this.rows = new Map();
    this.seq = 0;
  }
  push(changes) {
    return changes.map((c) => {
      const key = keyOf(c.collection, c.id);
      const cur = this.rows.get(key);
      const write = (data, deleted) => {
        const row = { collection: c.collection, id: c.id, data, deleted, rev: (cur?.rev ?? 0) + 1, seq: ++this.seq };
        this.rows.set(key, row);
        return { collection: c.collection, id: c.id, status: 'applied', rev: row.rev, seq: row.seq };
      };
      if (!cur) {
        if (c.deleted) return { status: 'applied', rev: null };
        if (c.collection === 'ledger' && c.data.kind === 'redeem') {
          const balance = [...this.rows.values()].filter((r) => r.collection === 'ledger' && !r.deleted).reduce((s, r) => s + r.data.coins, 0);
          if (balance + c.data.coins < 0) return { status: 'rejected', reason: 'insufficient_coins' };
        }
        return write(c.data, false);
      }
      if (cur.deleted === c.deleted && (c.deleted || stableStringify(cur.data) === stableStringify(c.data))) {
        return { status: 'applied', rev: cur.rev, seq: cur.seq };
      }
      const isLedgerEdit = c.collection === 'ledger' && !c.deleted;
      if ((c.base_rev !== null && cur.rev === c.base_rev && !isLedgerEdit) || (c.base_rev === null && cur.deleted && !c.deleted && c.collection !== 'ledger')) {
        return write(c.deleted ? null : c.data, c.deleted);
      }
      return { status: 'conflict', server: { data: cur.data, deleted: cur.deleted, rev: cur.rev, seq: cur.seq } };
    });
  }
  pull(cursor) {
    return [...this.rows.values()].filter((r) => r.seq > cursor).sort((a, b) => a.seq - b.seq).map((r) => JSON.parse(JSON.stringify(r)));
  }
}

/** 一台裝置：本機資料 + 同步狀態。 */
class Device {
  constructor(server, data = emptyData()) {
    this.server = server;
    this.data = data;
    this.meta = emptyMeta();
    this.rejected = [];
  }
  /** 模擬一次儲存（含遊戲化結算），並記錄待同步的變更。 */
  commit(next) {
    const settled = reconcileRewards(next, today, now);
    this.meta = markPending(this.meta, diffKeys(this.data, settled));
    this.data = settled;
  }
  push() {
    const sent = buildChanges(this.meta, this.data);
    if (!sent.length) return;
    const results = this.server.push(JSON.parse(JSON.stringify(sent)));
    const r = applyPushResults(this.meta, this.data, sent, results, now);
    this.meta = r.meta;
    this.data = r.data;
    this.rejected.push(...r.rejected);
  }
  pull() {
    const r = applyPullRows(this.meta, this.data, this.server.pull(this.meta.cursor), now);
    this.meta = r.meta;
    this.data = r.data;
    return r;
  }
  sync() {
    this.push();
    this.pull();
    // 下載後重新結算獎勵（與畫面相同）
    this.commit(this.data);
    this.push();
  }
}

function task(title, priority = 'medium') {
  return createTask({ title, note: '', dueDate: today, priority, tags: [], subtasks: [] }, now);
}

test('diffKeys 找出新增、修改、刪除的紀錄', () => {
  const a = task('A');
  const b = task('B');
  const prev = { ...emptyData(), tasks: [a, b] };
  const next = { ...prev, tasks: [{ ...a, title: 'A2' }, task('C')], settings: { ...prev.settings, weekStart: 0 } };
  const keys = diffKeys(prev, next).sort();
  assert.equal(keys.length, 4);
  assert.ok(keys.includes(keyOf('tasks', a.id)) && keys.includes(keyOf('tasks', b.id)) && keys.includes('settings/settings'));
  assert.deepEqual(diffKeys(prev, { ...prev }), [], '沒有變化');
});

test('兩台裝置：A 新增、修改、刪除，B 同步後一致', () => {
  const server = new FakeServer();
  const A = new Device(server);
  const B = new Device(server);
  const t = task('買菜');
  A.commit({ ...A.data, tasks: [t] });
  A.sync();
  assert.equal(pendingCount(A.meta), 0);
  B.sync();
  assert.equal(B.data.tasks[0].title, '買菜');
  A.commit({ ...A.data, tasks: updateTask(A.data.tasks, t.id, { ...t, title: '買菜和水果' }, now) });
  A.sync();
  B.sync();
  assert.equal(B.data.tasks[0].title, '買菜和水果');
  A.commit({ ...A.data, tasks: deleteTask(A.data.tasks, t.id) });
  A.sync();
  B.sync();
  assert.equal(B.data.tasks.length, 0, '刪除同步到另一台');
  // B 再次同步不會讓刪除的資料重新出現
  B.sync();
  A.sync();
  assert.equal(A.data.tasks.length + B.data.tasks.length, 0);
});

test('兩台裝置同時修改同一筆：第二台出現衝突，不會無聲覆蓋', () => {
  const server = new FakeServer();
  const A = new Device(server);
  const B = new Device(server);
  const t = task('原本');
  A.commit({ ...A.data, tasks: [t] });
  A.sync();
  B.sync();
  A.commit({ ...A.data, tasks: updateTask(A.data.tasks, t.id, { ...t, title: 'A 的修改' }, now) });
  B.commit({ ...B.data, tasks: updateTask(B.data.tasks, t.id, { ...t, title: 'B 的修改' }, now) });
  A.sync();
  B.sync();
  const key = keyOf('tasks', t.id);
  assert.ok(B.meta.conflicts[key], 'B 出現衝突');
  assert.equal(B.data.tasks[0].title, 'B 的修改', 'B 本機保留自己的版本直到選擇');
  assert.equal(server.rows.get(key).data.title, 'A 的修改', '雲端保留 A 的版本');
  // 選擇保留 B 的版本
  const r = resolveConflict(B.meta, B.data, key, 'local');
  B.meta = r.meta;
  B.data = r.data;
  B.sync();
  assert.equal(server.rows.get(key).data.title, 'B 的修改');
  A.sync();
  assert.equal(A.data.tasks[0].title, 'B 的修改');
});

test('衝突時選擇雲端版本', () => {
  const server = new FakeServer();
  const A = new Device(server);
  const B = new Device(server);
  const t = task('原本');
  A.commit({ ...A.data, tasks: [t] });
  A.sync();
  B.sync();
  A.commit({ ...A.data, tasks: deleteTask(A.data.tasks, t.id) }); // A 刪除
  B.commit({ ...B.data, tasks: updateTask(B.data.tasks, t.id, { ...t, title: 'B 修改' }, now) }); // B 修改
  A.sync();
  B.sync();
  const key = keyOf('tasks', t.id);
  assert.equal(B.meta.conflicts[key].server.deleted, true, '刪除與修改衝突');
  const r = resolveConflict(B.meta, B.data, key, 'server');
  assert.equal(r.data.tasks.length, 0, '採用雲端（已刪除）');
  assert.equal(pendingCount(r.meta), 0);
});

test('上傳回應遺失後重試：不會重複建立或衝突', () => {
  const server = new FakeServer();
  const A = new Device(server);
  A.commit({ ...A.data, tasks: [task('A')] });
  const sent = buildChanges(A.meta, A.data);
  server.push(JSON.parse(JSON.stringify(sent))); // 伺服器已套用，但回應遺失
  A.sync(); // 重試
  assert.equal(server.rows.size, A.data.tasks.length + A.data.ledger.length);
  assert.equal(Object.keys(A.meta.conflicts).length, 0);
  assert.equal(pendingCount(A.meta), 0);
});

test('兩台裝置各自完成同一個任務：獎勵只入帳一次', () => {
  const server = new FakeServer();
  const A = new Device(server);
  const B = new Device(server);
  const t = task('報告', 'high');
  A.commit({ ...A.data, tasks: [t] });
  A.sync();
  B.sync();
  A.commit({ ...A.data, tasks: setTaskDone(A.data.tasks, t.id, true, now) });
  B.commit({ ...B.data, tasks: setTaskDone(B.data.tasks, t.id, true, new Date(now.getTime() + 1000)) });
  A.sync();
  B.sync();
  A.sync();
  const serverLedger = [...server.rows.values()].filter((r) => r.collection === 'ledger' && !r.deleted).map((r) => r.data);
  const taskReward = serverLedger.filter((e) => e.source === `task:${t.id}`).reduce((s, e) => s + e.xp, 0);
  assert.equal(taskReward, 30, '雲端帳本中這個任務只有一份獎勵');
  assert.equal(totals(A.data.ledger).xp, totals(B.data.ledger).xp, '兩台裝置的經驗值一致');
});

test('兩台裝置離線各自兌換：雲端拒絕超出餘額的那一筆', () => {
  const server = new FakeServer();
  const A = new Device(server);
  const B = new Device(server);
  const reward = createReward({ name: '獎勵', cost: 10, icon: '🎁' }, now);
  const t = task('任務', 'high'); // 6 金幣 + 首次完成成就 10 = 16
  A.commit({ ...A.data, tasks: setTaskDone([t], t.id, true, now), rewards: [reward] });
  A.sync();
  B.sync();
  assert.equal(totals(B.data.ledger).coins, 16);
  A.commit(redeemReward(A.data, reward.id, today, now).data);
  B.commit(redeemReward(B.data, reward.id, today, now).data);
  A.sync();
  B.sync();
  assert.equal(B.rejected.length, 1, 'B 的兌換被拒絕');
  assert.equal(totals(B.data.ledger).coins, 6, 'B 取消本機兌換後與雲端一致');
  A.sync();
  assert.equal(totals(A.data.ledger).coins, 6);
});

test('本機資料匯入帳號：預覽筆數、相同 id 不重複、可安全重試', () => {
  const local = { ...emptyData(), tasks: [task('本機任務')] };
  const account = { ...emptyData(), tasks: [task('帳號任務')] };
  const plan = planLocalImport(account, local);
  assert.equal(plan.addCount, 1, '只新增本機任務（預設分類、帳戶相同 id 略過）');
  assert.ok(plan.skipCount >= 1);
  const merged = applyLocalImport(account, plan);
  assert.equal(merged.tasks.length, 2);
  const again = planLocalImport(merged, local);
  assert.equal(again.addCount, 0, '重試不會重複');
});

test('網址中的登入回傳與錯誤', () => {
  const token = `x.${Buffer.from(JSON.stringify({ sub: 'u-1', email: 'a@example.test', exp: 2000000000 })).toString('base64url')}.y`;
  const ok = parseAuthRedirect(`#access_token=${token}&refresh_token=r&expires_in=3600&token_type=bearer&type=recovery`);
  assert.equal(ok.type, 'recovery');
  assert.equal(ok.session.user.id, 'u-1');
  assert.equal(ok.session.expires_at, 2000000000);
  assert.match(parseAuthRedirect('#error=access_denied&error_code=otp_expired').error, /過期/);
  assert.equal(parseAuthRedirect('#tasks'), null, '一般的區域網址不受影響');
  assert.equal(toSession({}), null);
});

test('API 錯誤轉成中文訊息，並區分可重試與需重新登入', async () => {
  const respond = (status, body) => async () => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
  const make = (fetchImpl) => createCloud({ url: 'https://x.test', anonKey: 'k', fetchImpl });
  await assert.rejects(make(respond(400, { error_code: 'invalid_credentials', msg: 'Invalid login credentials' })).signIn('a', 'b'), /電子郵件或密碼不正確/);
  await assert.rejects(make(respond(401, { code: 'PGRST301', message: 'JWT expired' })).pull('t', 0), (e) => e.authExpired === true);
  await assert.rejects(make(respond(503, {})).pull('t', 0), (e) => e.retryable === true);
  await assert.rejects(make(async () => { throw new TypeError('Failed to fetch'); }).pull('t', 0), (e) => e.offline === true && e.retryable === true);
  let seen;
  await make(async (url, init) => {
    seen = { url, init };
    return { ok: true, status: 200, text: async () => '[]' };
  }).pull('tok', 42);
  assert.match(seen.url, /\/rest\/v1\/records\?select=.*seq=gt\.42&order=seq\.asc/);
  assert.equal(seen.init.headers.authorization, 'Bearer tok');
  assert.equal(seen.init.headers.apikey, 'k');
});
