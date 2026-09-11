/**
 * 废弃号池信息补全测试：
 *  - 时间线派生列（加入备用池时间 / 加入主号池时间）
 *  - 已用额度快照：同步端点的分类结果、stale 跳过、ids 上限
 *  - 筛选感知的用量统计
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { listMigrations } from '../lib/db.js';
import { createCrypto } from '../lib/crypto.js';
import { registerErrorHandler } from '../lib/http-errors.js';
import { createAccountsModule } from '../modules/accounts/index.js';

const RESERVE_IMPORTED_AT = '2026-08-01T02:00:00.000Z';
const CREATED_AT = '2026-08-01T00:00:00.000Z';
const JOINED_MAIN_AT = '2026-08-15T06:30:00.000Z';
const DISCARDED_AT = '2026-09-05T10:00:00.000Z';
const OLD_SYNC_AT = '2026-09-01T00:00:00.000Z';
const FRESH_SYNC_AT = new Date(Date.now() - 60_000).toISOString();
// 3 号也进过主池（更早），与 1 号形成可比的时间差
const JOINED_MAIN_EARLY = '2026-08-10T00:00:00.000Z';

function seed(db) {
  const insert = db.prepare(
    `INSERT INTO accounts(id, email, pool, status, imported_at, discarded_at, discard_reason,
                          sub2api_account_id, discard_used_amount, discard_used_amount_at,
                          created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  // 1：进过备用池 → 主池 → 废弃，有旧快照
  insert.run(1, 'joined@test.local', 'discard', 'discarded', RESERVE_IMPORTED_AT, DISCARDED_AT, 'banned_401', 101, 3.5, OLD_SYNC_AT, CREATED_AT, DISCARDED_AT);
  // 2：从未进过主池（导入即封），无快照、无序
  insert.run(2, 'never-main@test.local', 'discard', 'discarded', RESERVE_IMPORTED_AT, DISCARDED_AT, 'login_failed', null, null, null, CREATED_AT, DISCARDED_AT);
  // 3：主池加入更早、远端会失踪、快照新鲜（默认应被跳过）；imported_at 为空，用于验证回退
  insert.run(3, 'fresh@test.local', 'discard', 'discarded', null, DISCARDED_AT, 'manual', 103, 1.25, FRESH_SYNC_AT, CREATED_AT, DISCARDED_AT);

  const event = db.prepare('INSERT INTO account_events(account_id, type, detail, created_at) VALUES(?,?,?,?)');
  event.run(1, 'join_succeeded', JSON.stringify({ balance: 20 }), JOINED_MAIN_AT);
  event.run(3, 'join_succeeded', JSON.stringify({ balance: 5 }), JOINED_MAIN_EARLY);
}

const remoteAccounts = [
  { id: 101, credentials: { email: 'joined@test.local' }, used_amount: 12.5 },
  // 103 故意不存在：模拟远端账号已被删除
  // 2 号从未上传，也没有远端账号
];

/**
 * 假客户端：只实现「按需解析」所需的两个方法。
 *
 * **刻意让 listAllOpenAiAccounts 抛错** —— 早期实现依赖它建全量 email 索引，
 * 在账号量大的实例上会翻几十页后撞上 120s 超时，表现为「所有账号都失败」。
 * 任何回退到全量列表的代码都会在这里立刻暴露。
 */
function fakeSub2apiClient(overrides = {}) {
  const byId = new Map(remoteAccounts.map((account) => [String(account.id), account]));
  const byEmail = new Map(remoteAccounts.map((account) => [account.credentials.email.toLowerCase(), account]));
  return {
    listAllOpenAiAccounts: async () => {
      throw new Error('不应调用全量列表接口（会在大号池实例上超时）');
    },
    getAccount: async (id) => {
      const hit = byId.get(String(id));
      // 远端已删除 → sub2api 返回 404，客户端据此抛错
      if (!hit) throw new Error('sub2api 返回 HTTP 404：账号不存在');
      return { data: hit };
    },
    findAccountByEmail: async (email) => byEmail.get(String(email).toLowerCase()) ?? null,
    accountEmail: (account) => account?.credentials?.email || null,
    accountUsedAmount: (account) => {
      const amount = Number(account?.used_amount);
      return Number.isFinite(amount) && amount >= 0 ? { amount, source: 'used_amount' } : null;
    },
    ...overrides,
  };
}

/** 账号模块会往 engine.hooks 上挂登录终态回调，测试里给个等价的最小替身。 */
const fakeEngine = () => ({ hooks: {} });

const silentLogger = { debug() {}, warn() {}, info() {}, error() {} };

async function setup(t) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const migration of listMigrations()) db.exec(migration.sql);
  seed(db);

  const app = Fastify();
  app.decorate('db', db);
  app.decorate('crypto', createCrypto({ secretKeyEnv: 'discard-usage-test' }));
  app.decorate('settings', { get: () => ({ base_url: 'http://sub2api.test', admin_key: 'k' }) });
  app.decorate('config', { dataDir: process.cwd() });
  app.decorate('sub2apiClient', fakeSub2apiClient());
  registerErrorHandler(app);
  await createAccountsModule({ engine: fakeEngine(), logger: silentLogger })(app);
  await app.ready();
  t.after(async () => {
    await app.close();
    db.close();
  });
  return { app, db };
}

async function listDiscard(app, query = '') {
  const response = await app.inject(`/api/v1/accounts?pool=discard&${query}`);
  assert.equal(response.statusCode, 200);
  return response.json();
}

test('时间线：加入备用池时间取 imported_at，缺失回退 created_at', async (t) => {
  const { app } = await setup(t);
  const body = await listDiscard(app, 'sort=id:asc');
  const byId = new Map(body.items.map((item) => [item.id, item]));

  assert.equal(byId.get(1).reserve_joined_at, RESERVE_IMPORTED_AT);
  // 账号 3 的 imported_at 为 NULL（历史数据），回退 created_at
  assert.equal(byId.get(3).reserve_joined_at, CREATED_AT);
});

test('时间线：加入主号池时间取 join_succeeded 事件；无事件的号回退 created_at', async (t) => {
  const { app } = await setup(t);
  const body = await listDiscard(app, 'sort=id:asc');
  const byId = new Map(body.items.map((item) => [item.id, item]));

  assert.equal(byId.get(1).joined_main_at, JOINED_MAIN_AT);
  assert.equal(byId.get(3).joined_main_at, JOINED_MAIN_EARLY);
  // 2 号没有 join_succeeded 事件 → 回退 created_at。
  // 这刻意与 lib/upload-order.js 的 joinedMainPoolAtExpr 保持同一口径
  // （「按加入号池时间排序」用的就是它），不是缺陷。
  assert.equal(byId.get(2).joined_main_at, CREATED_AT);
});

test('时间线：可按加入主号池时间排序（派生列参与 ORDER BY）', async (t) => {
  const { app } = await setup(t);
  const asc = await listDiscard(app, 'sort=joined_main_at:asc');
  // 2 号回退到 created_at（2026-08-01）→ 最早；3 号 08-10；1 号 08-15
  assert.deepEqual(asc.items.map((item) => item.id), [2, 3, 1]);

  const desc = await listDiscard(app, 'sort=joined_main_at:desc');
  assert.deepEqual(desc.items.map((item) => item.id), [1, 3, 2]);
});

test('已用额度：返回快照值、来源与同步时间，并标记是否待同步', async (t) => {
  const { app } = await setup(t);
  const body = await listDiscard(app, 'sort=id:asc');
  const byId = new Map(body.items.map((item) => [item.id, item]));

  const old = byId.get(1);
  assert.equal(old.used_amount, 3.5);
  assert.equal(old.used_amount_at, OLD_SYNC_AT);
  assert.equal(old.used_amount_stale, true, '一天前的快照应视为待同步');

  const fresh = byId.get(3);
  assert.equal(fresh.used_amount, 1.25);
  assert.equal(fresh.used_amount_stale, false);

  const never = byId.get(2);
  assert.equal(never.used_amount, null);
  assert.equal(never.used_amount_at, null);
  assert.equal(never.used_amount_stale, true);
});

test('已用额度：可按用量排序，未知沉底（两个方向都是）', async (t) => {
  const { app } = await setup(t);
  const desc = await listDiscard(app, 'sort=discard_used_amount:desc');
  assert.deepEqual(desc.items.map((item) => item.id), [1, 3, 2]);

  // 未知用 COALESCE(..., -1) 兜底，ASC 下也排在已知值之后
  const asc = await listDiscard(app, 'sort=discard_used_amount:asc');
  assert.deepEqual(asc.items.map((item) => item.id), [3, 1, 2]);
});

test('同步端点：分类统计（更新 / 远端无此号 / 未关联）并落库', async (t) => {
  const { app, db } = await setup(t);
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/accounts/discard-usage-sync',
    payload: { force: true },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json();

  assert.equal(body.summary.scanned, 3);
  assert.equal(body.summary.updated, 1, '只有 1 号能取到用量');
  assert.equal(body.summary.remote_account_not_found, 1, '103 远端已删除');
  assert.equal(body.summary.not_linked, 1, '2 号从未上传');

  const updated = db
    .prepare('SELECT discard_used_amount, discard_used_amount_at, discard_used_amount_source FROM accounts WHERE id=1')
    .get();
  assert.equal(updated.discard_used_amount, 12.5);
  assert.equal(updated.discard_used_amount_source, 'used_amount');
  assert.ok(Date.parse(updated.discard_used_amount_at) > Date.parse(OLD_SYNC_AT));

  // 未取到用量的号不应被写成 0
  const untouched = db.prepare('SELECT discard_used_amount FROM accounts WHERE id=2').get();
  assert.equal(untouched.discard_used_amount, null);
});

test('同步端点：默认跳过新鲜快照，force 才重算', async (t) => {
  const { app } = await setup(t);
  const incremental = await app.inject({ method: 'POST', url: '/api/v1/accounts/discard-usage-sync', payload: {} });
  assert.equal(incremental.statusCode, 200);
  assert.equal(incremental.json().summary.scanned, 2, '3 号快照新鲜，默认跳过');

  const forced = await app.inject({ method: 'POST', url: '/api/v1/accounts/discard-usage-sync', payload: { force: true } });
  assert.equal(forced.json().summary.scanned, 3);
});

test('同步端点：只同步指定 ids', async (t) => {
  const { app } = await setup(t);
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/accounts/discard-usage-sync',
    payload: { ids: [2] },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().summary.scanned, 1);
  assert.equal(response.json().summary.not_linked, 1);
});

test('同步端点：写入审计事件（便于追溯数字来源）', async (t) => {
  const { app, db } = await setup(t);
  await app.inject({ method: 'POST', url: '/api/v1/accounts/discard-usage-sync', payload: { ids: [1], force: true } });
  const events = db.prepare(`SELECT detail FROM account_events WHERE account_id=1 AND type='discard_usage_synced'`).all();
  assert.equal(events.length, 1);
  assert.equal(JSON.parse(events[0].detail).used_amount, 12.5);
});

test('同步端点：不调用全量账号列表，只按目标账号解析（回归：大号池超时）', async (t) => {
  const calls = { getAccount: 0, byEmail: 0 };
  const { app } = await setup(t);
  // 换成一个会记账的客户端：fakeSub2apiClient 的 listAllOpenAiAccounts 本来就会抛错
  const counting = fakeSub2apiClient({
    getAccount: async (id) => {
      calls.getAccount += 1;
      const hit = remoteAccounts.find((account) => String(account.id) === String(id));
      if (!hit) throw new Error('sub2api 返回 HTTP 404：账号不存在');
      return { data: hit };
    },
    findAccountByEmail: async (email) => {
      calls.byEmail += 1;
      return remoteAccounts.find((account) => account.credentials.email.toLowerCase() === String(email).toLowerCase()) ?? null;
    },
  });
  app.sub2apiClient = counting;

  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/accounts/discard-usage-sync',
    payload: { force: true },
  });
  assert.equal(response.statusCode, 200, '整批不应因为一条记录失败而 5xx');

  // 1 号有 sub2api_account_id → 走单账号接口，不需要邮箱查找
  // 3 号关联 id 已失效 → 单账号接口 404 后回退邮箱查找
  // 2 号没有关联 → 直接邮箱查找
  assert.equal(calls.getAccount, 2, `getAccount 调用次数应等于「有远端 id 的账号数」，实际 ${calls.getAccount}`);
  assert.equal(calls.byEmail, 2, `邮箱查找只用于没有命中 id 的账号，实际 ${calls.byEmail}`);
});

test('同步端点：查询异常归为查询失败并带上具体原因', async (t) => {
  const { app } = await setup(t);
  app.sub2apiClient = fakeSub2apiClient({
    getAccount: async () => {
      throw new Error('sub2api 请求超时（120s）');
    },
    findAccountByEmail: async () => {
      throw new Error('sub2api 请求超时（120s）');
    },
  });

  const response = await app.inject({ method: 'POST', url: '/api/v1/accounts/discard-usage-sync', payload: { force: true } });
  assert.equal(response.statusCode, 200);
  const body = response.json();

  // 2 号从未上传 → not_linked（确定事实，与「查询失败」区分开）
  assert.equal(body.summary.not_linked, 1);
  // 1、3 号查询异常 → fetch_failed
  assert.equal(body.summary.fetch_failed, 2);
  assert.equal(body.summary.updated, 0);

  const failedItem = body.items.find((item) => item.id === 1);
  assert.equal(failedItem.reason, 'fetch_failed');
  assert.match(failedItem.detail, /超时/, '失败明细要带上服务端原因，便于区分连接问题与账号不存在');
  assert.equal(failedItem.ok, false);
});

test('同步端点：远端存在但没用用量字段 → remote_used_amount_unknown', async (t) => {
  const { app } = await setup(t);
  app.sub2apiClient = fakeSub2apiClient({
    // 有账号记录，但没有任何用量字段
    getAccount: async (id) => ({ data: { id: Number(id), credentials: { email: 'joined@test.local' } } }),
    findAccountByEmail: async () => null,
  });

  const response = await app.inject({ method: 'POST', url: '/api/v1/accounts/discard-usage-sync', payload: { ids: [1] } });
  const body = response.json();
  assert.equal(body.summary.remote_used_amount_unknown, 1);
  assert.equal(body.items[0].reason, 'remote_used_amount_unknown');
  assert.equal(body.items[0].remote_account_id, 101, '仍要带回远端 id 便于排查');
  assert.equal(body.items[0].used_amount, null, '取不到用量时不能写成 0');
});

test('同步端点：未配置 sub2api 返回 422 VALIDATION 而不是 500', async (t) => {  const db = new Database(':memory:');
  for (const migration of listMigrations()) db.exec(migration.sql);

  const bare = Fastify();
  bare.decorate('db', db);
  bare.decorate('crypto', createCrypto({ secretKeyEnv: 'discard-usage-bare' }));
  // 未配置：base_url / admin_key 都为空
  bare.decorate('settings', { get: () => ({}) });
  bare.decorate('config', { dataDir: process.cwd() });
  bare.decorate('sub2apiClient', fakeSub2apiClient());
  registerErrorHandler(bare);
  await createAccountsModule({ engine: fakeEngine(), logger: silentLogger })(bare);
  await bare.ready();
  t.after(async () => {
    await bare.close();
    db.close();
  });

  const response = await bare.inject({ method: 'POST', url: '/api/v1/accounts/discard-usage-sync', payload: {} });
  assert.equal(response.statusCode, 422);
  assert.equal(response.json().error.code, 'VALIDATION');
  assert.match(response.json().error.message, /sub2api/);
});

test('同步端点：ids 超过 500 条被 schema 拒绝', async (t) => {
  const { app } = await setup(t);
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/accounts/discard-usage-sync',
    payload: { ids: Array.from({ length: 501 }, (_, i) => i + 1) },
  });
  assert.equal(response.statusCode, 422);
  assert.equal(response.json().error.code, 'VALIDATION');
});

test('统计：已用额度合计 / 已知数 / 待同步数', async (t) => {
  const { app } = await setup(t);
  const body = await listDiscard(app);
  assert.equal(body.stats.used_amount_total, 4.75);
  assert.equal(body.stats.used_amount_known, 2);
  assert.equal(body.stats.used_amount_stale, 2, '1 号旧快照 + 2 号无快照');
});

test('批量移回主号池：一次请求处理多条，跳过不在废弃池的 id', async (t) => {
  const { app, db } = await setup(t);
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/accounts/batch-restore',
    payload: { ids: [1, 2, 999] },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { restored: 2, skipped: 1 });

  const restored = db
    .prepare(`SELECT id, pool, status, discard_reason, discarded_at FROM accounts WHERE pool='main' ORDER BY id`)
    .all();
  assert.deepEqual(restored.map((row) => row.id), [1, 2]);
  assert.ok(restored.every((row) => row.status === 'needs_reauth'));
  assert.ok(restored.every((row) => row.discard_reason === null && row.discarded_at === null));
});

test('按筛选导出：与列表同口径，不依赖 ids 列表', async (t) => {
  const { app } = await setup(t);
  const response = await app.inject('/api/v1/accounts/export-by-filter?pool=discard&reason=banned_401&format=tosub2');
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['content-disposition']?.includes('tosub2'), true);
  const payload = response.json();
  const emails = payload.accounts.map((account) => account.email);
  assert.deepEqual(emails, ['joined@test.local']);
});

test('按筛选取全部 id：供「选中全部 N 条」使用，支持 limit 截断', async (t) => {
  const { app } = await setup(t);

  const all = await app.inject('/api/v1/accounts/ids?pool=discard');
  assert.equal(all.statusCode, 200);
  assert.equal(all.json().total, 3);
  assert.equal(all.json().truncated, false);
  // 默认排序 discarded_at:desc，同值时 id DESC 兜底
  assert.deepEqual(all.json().ids, [3, 2, 1]);

  const filtered = await app.inject('/api/v1/accounts/ids?pool=discard&reason=banned_401');
  assert.deepEqual(filtered.json().ids, [1]);
  assert.equal(filtered.json().total, 1);

  const truncated = await app.inject('/api/v1/accounts/ids?pool=discard&limit=2');
  assert.equal(truncated.json().ids.length, 2);
  assert.equal(truncated.json().total, 3, 'total 始终是筛选后的真实总数');
  assert.equal(truncated.json().truncated, true);
});

test('按筛选取全部 id：非法 pool 返回 422 而不是 500', async (t) => {
  const { app } = await setup(t);
  const response = await app.inject('/api/v1/accounts/ids?pool=nope');
  assert.equal(response.statusCode, 422);
  assert.equal(response.json().error.code, 'VALIDATION');
});
