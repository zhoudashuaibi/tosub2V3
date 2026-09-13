/**
 * 废弃号池「废弃时的代理 IP」快照测试。
 *
 * 要守住的两件事：
 *  1. 值来自**废弃那一刻**的出口，而不是事后现查 —— 远端绑定会被改绑、也会随号消失
 *     （一键更换代理 IP 会删掉旧代理），错过那一刻就再也拿不到真正的出口；
 *  2. 拿不到就是空，绝不猜。登录类废弃的号往往根本不在远端，也不能硬套一条代理上去。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { listMigrations } from '../lib/db.js';
import { createCrypto } from '../lib/crypto.js';
import { createPools } from '../modules/accounts/pools.js';
import { createDiscardUsage } from '../modules/accounts/discard-usage.js';

const silentLogger = { debug() {}, warn() {}, info() {}, error() {} };

function setup() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const migration of listMigrations()) db.exec(migration.sql);
  const crypto = createCrypto({ secretKeyEnv: 'discard-proxy-test' });

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO accounts(id, email, pool, status, created_at, updated_at)
     VALUES(1, 'main-a@test.local', 'main', 'active', ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO accounts(id, email, pool, status, created_at, updated_at)
     VALUES(2, 'reserve-b@test.local', 'reserve', 'mail_ok', ?, ?)`,
  ).run(now, now);

  // 本机代理：display_url 是脱敏串（用户名为认证账号，密码已打码）
  db.prepare(
    `INSERT INTO proxies(id, url_enc, url_hash, display_url, protocol, label, status, created_at, updated_at)
     VALUES(1, 'enc', 'hash1', 'http://acct-7:***@10.0.0.1:8080', 'http', '家宽A', 'alive', ?, ?)`,
  ).run(now, now);

  return { db, crypto };
}

/** 装出与 accounts 模块一样的废弃钩子：快照队列是异步的，测试要能等它。 */
function buildHarness({ db, crypto, remoteSync = null, client = null } = {}) {
  const discardUsage = createDiscardUsage({
    db,
    getClient: () => client,
    getRemoteSync: () => remoteSync,
    logger: silentLogger,
  });
  const pools = createPools(db, crypto, {
    onDiscarded: (accountId, snapshot) => discardUsage.snapshotAfterDiscard(accountId, snapshot),
  });
  return { pools, discardUsage };
}

const proxyRow = (db, id) =>
  db
    .prepare('SELECT pool, discard_proxy_name, discard_proxy_user, discard_proxy_id, discard_proxy_at FROM accounts WHERE id=?')
    .get(id);

/** 远端单账号接口 + 代理列表：真实形状（账号只给 proxy_id，代理本身另查） */
function fakeRemoteSync({ remoteById = {}, proxies = [], failGetAccount = false } = {}) {
  return {
    resolveDiscardProxy: async ({ accountId, email }) => {
      const remote = remoteById[String(accountId)] ?? (email ? remoteById[email] : null);
      if (!remote) return null;
      const proxyId = Number(remote.proxy_id);
      if (!Number.isSafeInteger(proxyId) || proxyId <= 0) return null;
      if (failGetAccount) throw new Error('sub2api 连不上');
      const proxy = proxies.find((item) => Number(item.id) === proxyId) || {};
      return { id: proxyId, name: proxy.name ?? null, username: proxy.username ?? null };
    },
  };
}

test('巡检废弃：用废弃当下同步过来的远端绑定代理落库（代理名 + 认证账号）', async (t) => {
  const ctx = setup();
  t.after(() => ctx.db.close());
  const { pools } = buildHarness({ ...ctx, remoteSync: fakeRemoteSync() });

  // 巡检手里本来就有远端账号对象，原样传给 pools —— 不查远端也不查本机任务
  const remote = { id: 701, proxy_id: 3, proxy: { id: 3, name: '23', username: 'u123' } };
  const result = pools.moveToDiscard(1, 'rate_limited_429', '限流至下个月', { proxy: remote });
  // 快照是 best-effort 异步的，pools 把 Promise 挂回结果上供等待（正常调用点不需要 await）
  await result.snapshot;

  const row = proxyRow(ctx.db, 1);
  assert.equal(row.pool, 'discard');
  assert.equal(row.discard_proxy_name, '23');
  assert.equal(row.discard_proxy_user, 'u123');
  assert.equal(row.discard_proxy_id, 3);
  assert.ok(row.discard_proxy_at, '快照要带时间戳');

  const events = ctx.db.prepare(`SELECT type, detail FROM account_events WHERE account_id=1 ORDER BY id`).all();
  assert.deepEqual(events.map((event) => event.type), ['moved_to_discard', 'discard_proxy_snapshot']);
  assert.deepEqual(JSON.parse(events[1].detail), { proxy_id: 3, name: '23', username: 'u123' });
});

test('手动废弃：调用方没给代理 → 按 sub2api_account_id 单查远端补齐', async (t) => {
  const ctx = setup();
  t.after(() => ctx.db.close());
  ctx.db.prepare('UPDATE accounts SET sub2api_account_id=701 WHERE id=1').run();
  const remoteSync = fakeRemoteSync({
    remoteById: { 701: { id: 701, proxy_id: 9 } },
    proxies: [{ id: 9, name: '12', username: 'acct-9' }],
  });
  const { pools } = buildHarness({ ...ctx, remoteSync });

  await pools.moveToDiscard(1, 'manual', '手动废弃').snapshot;

  const row = proxyRow(ctx.db, 1);
  assert.equal(row.discard_proxy_name, '12');
  assert.equal(row.discard_proxy_user, 'acct-9');
  assert.equal(row.discard_proxy_id, 9);
});

test('登录终局失败：号不在远端时退回本机任务出口，仍记得到是哪个 IP', async (t) => {
  const ctx = setup();
  t.after(() => ctx.db.close());
  // 2 号从未上传远端：resolveDiscardProxy 返回 null
  const { pools } = buildHarness({ ...ctx, remoteSync: fakeRemoteSync() });

  const now = new Date().toISOString();
  ctx.db
    .prepare(
      `INSERT INTO jobs(id, account_id, type, status, attempt, proxy_id, log_path, created_at, updated_at)
       VALUES('job-1', 2, 'login', 'failed', 1, 1, 'logs/job-1.log', ?, ?)`,
    )
    .run(now, now);

  const job = await pools.joinFailed(2, { error: '登录被拒', permanent: true });
  await job.snapshot;

  const row = proxyRow(ctx.db, 2);
  assert.equal(row.pool, 'discard');
  assert.equal(row.discard_proxy_name, '家宽A', '本机代理标签');
  assert.equal(row.discard_proxy_user, 'acct-7', '本机代理 URL 里的认证账号');
  assert.equal(row.discard_proxy_id, 1);
});

test('没有远端绑定也没有本机任务：列保持为空，不硬套代理', async (t) => {
  const ctx = setup();
  t.after(() => ctx.db.close());
  const { pools } = buildHarness({ ...ctx, remoteSync: fakeRemoteSync() });

  await pools.moveToDiscard(1, 'manual', '手动废弃').snapshot;

  const row = proxyRow(ctx.db, 1);
  assert.equal(row.discard_proxy_name, null);
  assert.equal(row.discard_proxy_user, null);
  assert.equal(row.discard_proxy_id, null);
  // 没值就不写事件，避免「事件说有代理、列却是空的」
  const n = ctx.db.prepare(`SELECT COUNT(*) n FROM account_events WHERE account_id=1 AND type='discard_proxy_snapshot'`).get().n;
  assert.equal(n, 0);
});

test('远端查询失败：不阻断废弃，代理列留空而不是写错值', async (t) => {
  const ctx = setup();
  t.after(() => ctx.db.close());
  ctx.db.prepare('UPDATE accounts SET sub2api_account_id=701 WHERE id=1').run();
  const remoteSync = fakeRemoteSync({ remoteById: { 701: { id: 701, proxy_id: 9 } }, failGetAccount: true });
  const { pools } = buildHarness({ ...ctx, remoteSync });

  await pools.moveToDiscard(1, 'banned_401', '账号被封禁').snapshot;

  const row = proxyRow(ctx.db, 1);
  assert.equal(row.pool, 'discard', '代理快照失败不影响废弃本身');
  assert.equal(row.discard_proxy_name, null);
});

test('废弃后又被移回主池：快照不覆盖，也不会写进主池的号', async (t) => {
  const ctx = setup();
  t.after(() => ctx.db.close());
  const { pools } = buildHarness({
    ...ctx,
    remoteSync: fakeRemoteSync({ remoteById: { 701: { id: 701, proxy_id: 9 } }, proxies: [{ id: 9, name: '12' }] }),
  });
  ctx.db.prepare('UPDATE accounts SET sub2api_account_id=701 WHERE id=1').run();

  await pools.moveToDiscard(1, 'manual', '手动废弃').snapshot;
  assert.equal(proxyRow(ctx.db, 1).discard_proxy_name, '12');

  pools.restore(1);
  // 移回主池后 discard_* 列被清空（restore 的同一条 UPDATE 覆盖），这是既有口径
  const row = proxyRow(ctx.db, 1);
  assert.equal(row.pool, 'main');
  assert.equal(row.discard_proxy_name, null);
});
