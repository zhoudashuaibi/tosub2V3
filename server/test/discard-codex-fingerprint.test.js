/**
 * 废弃池「Codex 指纹收敛」列（封号时的档位快照）测试。
 *
 * 要守住的三件事：
 *  1. 值来自**废弃那一刻**的远端 extra.codex_fingerprint_mode，而不是事后现查 ——
 *     远端档位随时能在 sub2api 账号编辑页改，号废弃后还可能被清理，错过那一刻就再也拿不到；
 *  2. **键缺失 ≠ 读不到**：sub2api 契约里 off（透传）就是不写这个键，所以「拿到 extra 但没有这个键」
 *     是确定的 off，只有连 extra 都拿不到才算未知 —— 两者混淆会让「没开收敛」看起来像「没抓到」；
 *  3. 与出口代理**共用一次远端解析**：两个字段都只存在同一个远端账号对象上，
 *     分两次查等于把同一个号查两遍（批量废弃时被放大千倍）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { listMigrations } from '../lib/db.js';
import { createCrypto } from '../lib/crypto.js';
import { registerErrorHandler } from '../lib/http-errors.js';
import { createPools } from '../modules/accounts/pools.js';
import { createDiscardUsage } from '../modules/accounts/discard-usage.js';
import { createAccountsModule } from '../modules/accounts/index.js';
import { extractCodexFingerprintMode } from '../modules/sub2api/remote-sync.js';

const silentLogger = { debug() {}, warn() {}, info() {}, error() {} };
const NOW = '2026-09-13T10:00:00.000Z';

function setup() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const migration of listMigrations()) db.exec(migration.sql);
  const crypto = createCrypto({ secretKeyEnv: 'discard-fingerprint-test' });

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO accounts(id, email, pool, status, created_at, updated_at)
     VALUES(1, 'main-a@test.local', 'main', 'active', ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO accounts(id, email, pool, status, created_at, updated_at)
     VALUES(2, 'reserve-b@test.local', 'reserve', 'mail_ok', ?, ?)`,
  ).run(now, now);

  return { db, crypto };
}

/**
 * 装出与 accounts 模块一样的废弃钩子。
 * remoteSync 计数：证明「一次废弃只解析一次远端」（代理 + 档位共用）。
 */
function buildHarness({ db, crypto, remoteSync = null } = {}) {
  const discardUsage = createDiscardUsage({
    db,
    getClient: () => null,
    getRemoteSync: () => remoteSync,
    logger: silentLogger,
  });
  const pools = createPools(db, crypto, {
    onDiscarded: (accountId, snapshot) => discardUsage.snapshotAfterDiscard(accountId, snapshot),
  });
  return { pools };
}

const fingerprintRow = (db, id) =>
  db
    .prepare('SELECT pool, discard_codex_fingerprint_mode AS mode, discard_codex_fingerprint_at AS at FROM accounts WHERE id=?')
    .get(id);

const fingerprintEvents = (db, id) =>
  db
    .prepare(`SELECT detail FROM account_events WHERE account_id=? AND type='discard_codex_fingerprint_snapshot' ORDER BY id`)
    .all(id)
    .map((row) => JSON.parse(row.detail));

// ---------------------------------------------------------------- 纯函数：远端对象 → 档位

test('extractCodexFingerprintMode：四档照读，缺 extra 才是未知', () => {
  // 标准位置：extra.codex_fingerprint_mode
  for (const mode of ['device', 'session', 'full']) {
    assert.equal(extractCodexFingerprintMode({ id: 1, extra: { codex_fingerprint_mode: mode } }), mode);
  }
  // **键缺失 = 确定的 off**（sub2api 契约：off 就是不写这个键），不能当成「读不到」
  assert.equal(extractCodexFingerprintMode({ id: 1, extra: {} }), 'off');
  assert.equal(extractCodexFingerprintMode({ id: 1, extra: { email: 'a@test.local' } }), 'off');
  assert.equal(extractCodexFingerprintMode({ id: 1, extra: { codex_fingerprint_mode: null } }), 'off');
  assert.equal(extractCodexFingerprintMode({ id: 1, extra: { codex_fingerprint_mode: '  ' } }), 'off');
  assert.equal(extractCodexFingerprintMode({ id: 1, extra: { codex_fingerprint_mode: 'off' } }), 'off');
  // 非法值按 sub2api 读取侧口径归为 off（绝不放行未知值）
  assert.equal(extractCodexFingerprintMode({ id: 1, extra: { codex_fingerprint_mode: 'bogus' } }), 'off');

  // 平铺形状（少数接口把 extra 键摊在账号上）
  assert.equal(extractCodexFingerprintMode({ id: 1, codex_fingerprint_mode: 'full' }), 'full');
  assert.equal(extractCodexFingerprintMode({ id: 1, codex_fingerprint_mode: null }), 'off');

  // 读不到：没有 extra 字段 / extra 不是对象 / 空对象 → 一律未知，绝不代填 off
  assert.equal(extractCodexFingerprintMode({ id: 1, proxy_id: 3 }), null);
  assert.equal(extractCodexFingerprintMode({ id: 1, extra: null }), null);
  assert.equal(extractCodexFingerprintMode({ id: 1, extra: 'x' }), null);
  assert.equal(extractCodexFingerprintMode(null), null);
  assert.equal(extractCodexFingerprintMode(undefined), null);
  // 已提好的代理对象（没有 extra）也要是未知，别把代理对象误判成 off
  assert.equal(extractCodexFingerprintMode({ id: 3, name: '23', username: 'u123' }), null);
});

// ---------------------------------------------------------------- 落库语义

test('巡检废弃：用废弃当下同步过来的远端账号对象落库（含 extra 档位），零额外远端请求', async (t) => {
  const ctx = setup();
  t.after(() => ctx.db.close());
  let remoteCalls = 0;
  const { pools } = buildHarness({
    ...ctx,
    remoteSync: {
      resolveDiscardRemote: async () => {
        remoteCalls += 1;
        return { proxy: null, codex_fingerprint_mode: null };
      },
    },
  });

  // 巡检手里本来就有远端账号对象（401/429 封禁路径），原样传给 pools
  const remote = {
    id: 701,
    proxy_id: 3,
    proxy: { id: 3, name: '23', username: 'u123' },
    extra: { codex_fingerprint_mode: 'full' },
  };
  await pools.moveToDiscard(1, 'banned_401', '账号被封禁', { proxy: remote }).snapshot;

  const row = fingerprintRow(ctx.db, 1);
  assert.equal(row.pool, 'discard');
  assert.equal(row.mode, 'full');
  assert.ok(row.at, '快照要带时间戳');
  assert.deepEqual(fingerprintEvents(ctx.db, 1), [{ mode: 'full' }]);
  // 对象里两个字段都能就地提取 → 一次远端都不该打（巡检是热路径，每轮都跑）
  assert.equal(remoteCalls, 0, '调用方给了完整远端对象时不应再查远端');
});

test('远端对象缺 extra（读不到档位）→ 才回落查一次远端补齐，代理不重复查', async (t) => {
  const ctx = setup();
  t.after(() => ctx.db.close());
  ctx.db.prepare('UPDATE accounts SET sub2api_account_id=701 WHERE id=1').run();
  let remoteCalls = 0;
  const { pools } = buildHarness({
    ...ctx,
    remoteSync: {
      resolveDiscardRemote: async () => {
        remoteCalls += 1;
        // 单账号接口带 extra：补齐档位，代理也顺手带上（但调用方那半边优先）
        return { proxy: { id: 9, name: '12' }, codex_fingerprint_mode: 'device' };
      },
    },
  });

  const remote = { id: 701, proxy_id: 3, proxy: { id: 3, name: '23', username: 'u123' } };
  await pools.moveToDiscard(1, 'rate_limited_429', '限流', { proxy: remote }).snapshot;

  assert.equal(remoteCalls, 1, '缺档位时补查一次，且代理/档位共用这一次');
  const row = fingerprintRow(ctx.db, 1);
  assert.equal(row.mode, 'device');
  // 调用方给的是废弃当下那一瞬，比补查结果更可信：代理不能被补查覆盖
  assert.equal(ctx.db.prepare('SELECT discard_proxy_name FROM accounts WHERE id=1').get().discard_proxy_name, '23');
});

test('手动废弃：调用方没给远端对象 → 与出口代理共用一次远端解析（只查一次）', async (t) => {
  const ctx = setup();
  t.after(() => ctx.db.close());
  ctx.db.prepare('UPDATE accounts SET sub2api_account_id=701 WHERE id=1').run();
  let calls = 0;
  const { pools } = buildHarness({
    ...ctx,
    remoteSync: {
      resolveDiscardRemote: async () => {
        calls += 1;
        return {
          proxy: { id: 9, name: '12', username: 'acct-9' },
          codex_fingerprint_mode: 'session',
        };
      },
    },
  });

  await pools.moveToDiscard(1, 'manual', '手动废弃').snapshot;

  assert.equal(calls, 1, '代理与档位必须共用同一次远端解析，不能各查一遍');
  const row = fingerprintRow(ctx.db, 1);
  assert.equal(row.mode, 'session');
  assert.equal(ctx.db.prepare('SELECT discard_proxy_name FROM accounts WHERE id=1').get().discard_proxy_name, '12');
});

test('远端 extra 里没有这个键 → 记 off（透传是确定结论，不是「没抓到」）', async (t) => {
  const ctx = setup();
  t.after(() => ctx.db.close());
  const { pools } = buildHarness({ ...ctx, remoteSync: null });

  const remote = { id: 701, proxy_id: 3, proxy: { id: 3, name: '23' }, extra: { email: 'a@test.local' } };
  await pools.moveToDiscard(1, 'banned_401', '账号被封禁', { proxy: remote }).snapshot;

  assert.equal(fingerprintRow(ctx.db, 1).mode, 'off');
  assert.deepEqual(fingerprintEvents(ctx.db, 1), [{ mode: 'off' }]);
});

test('远端对象不带 extra（读不到档位）→ 列留空且不写事件，不反推成 off', async (t) => {
  const ctx = setup();
  t.after(() => ctx.db.close());
  // 号从未上传过远端：既没有远端对象，回退解析也拿不到
  const { pools } = buildHarness({
    ...ctx,
    remoteSync: { resolveDiscardRemote: async () => ({ proxy: null, codex_fingerprint_mode: null }) },
  });

  const job = await pools.joinFailed(2, { error: '登录被拒', permanent: true });
  await job.snapshot;

  const row = fingerprintRow(ctx.db, 2);
  assert.equal(row.pool, 'discard');
  assert.equal(row.mode, null);
  assert.equal(row.at, null);
  // 没值就不写事件，避免「事件说有档位、列却是空的」
  assert.deepEqual(fingerprintEvents(ctx.db, 2), []);
});

test('远端解析整体失败：不阻断废弃，档位列留空而不是写错值', async (t) => {
  const ctx = setup();
  t.after(() => ctx.db.close());
  ctx.db.prepare('UPDATE accounts SET sub2api_account_id=701 WHERE id=1').run();
  const { pools } = buildHarness({
    ...ctx,
    remoteSync: {
      resolveDiscardRemote: async () => {
        throw new Error('sub2api 连不上');
      },
    },
  });

  const result = pools.moveToDiscard(1, 'banned_401', '账号被封禁');
  await result.snapshot;

  const row = fingerprintRow(ctx.db, 1);
  assert.equal(row.pool, 'discard', '档位快照失败不影响废弃本身');
  assert.equal(row.mode, null);
});

test('废弃后又被移回主池：档位快照随废弃字段一起清空，不污染下一次废弃', async (t) => {
  const ctx = setup();
  t.after(() => ctx.db.close());
  const { pools } = buildHarness({ ...ctx, remoteSync: null });

  await pools.moveToDiscard(1, 'manual', '手动废弃', {
    proxy: { id: 3, proxy: { id: 3, name: '23' }, extra: { codex_fingerprint_mode: 'device' } },
  }).snapshot;
  assert.equal(fingerprintRow(ctx.db, 1).mode, 'device');

  pools.restore(1);
  const cleared = fingerprintRow(ctx.db, 1);
  assert.equal(cleared.pool, 'main');
  assert.equal(cleared.mode, null);
  assert.equal(cleared.at, null);
});

// ---------------------------------------------------------------- 列表接口（API 层）

function seedDiscardPool(db) {
  const insert = db.prepare(
    `INSERT INTO accounts(id, email, pool, status, discard_reason, discarded_at,
       discard_codex_fingerprint_mode, discard_codex_fingerprint_at, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
  );
  insert.run(1, 'a@test.local', 'discard', 'discarded', 'banned_401', NOW, 'full', NOW, NOW, NOW);
  insert.run(2, 'b@test.local', 'discard', 'discarded', 'banned_401', NOW, 'session', NOW, NOW, NOW);
  insert.run(3, 'c@test.local', 'discard', 'discarded', 'banned_401', NOW, 'off', NOW, NOW, NOW);
  insert.run(4, 'd@test.local', 'discard', 'discarded', 'login_failed', NOW, null, null, NOW, NOW);
}

test('废弃池列表：档位字段透出、按收敛强度排序、读不到档位的号排在一边', async (t) => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const migration of listMigrations()) db.exec(migration.sql);
  seedDiscardPool(db);

  const app = Fastify();
  app.decorate('db', db);
  app.decorate('crypto', createCrypto({ secretKeyEnv: 'discard-fingerprint-e2e' }));
  app.decorate('settings', { get: () => ({}) });
  app.decorate('config', { dataDir: process.cwd() });
  registerErrorHandler(app);
  await createAccountsModule({ engine: { hooks: {} }, logger: silentLogger })(app);
  await app.ready();
  t.after(async () => {
    await app.close();
    db.close();
  });

  const list = async (query) => {
    const response = await app.inject(`/api/v1/accounts?pool=discard&${query}`);
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };

  // 界面那一列直接用这两个字段
  const all = await list('sort=email:asc');
  const byEmail = new Map(all.items.map((item) => [item.email, item]));
  assert.deepEqual(
    ['a@test.local', 'c@test.local', 'd@test.local'].map((email) => {
      const item = byEmail.get(email);
      return [item.codex_fingerprint_mode, item.codex_fingerprint_at];
    }),
    [
      ['full', NOW],
      ['off', NOW],
      [null, null],
    ],
  );

  // 排序按收敛强度，不按字典序：顺排 = 透传 → 仅设备 → 设备+会话 → 完全收敛
  // （字典序会给出 full < off < session，off 夹在中间，读不出「越来越收敛」）
  const emails = (body) => body.items.map((item) => item.email);
  assert.deepEqual(emails(await list('sort=codex_fingerprint_mode:asc')), [
    'c@test.local', // off
    'b@test.local', // session
    'a@test.local', // full
    'd@test.local', // 读不到 → 沉底
  ]);
  // 倒排 = 最可疑的「完全收敛」放最前，正是排障时要看的顺序；
  // 读不到档位的号在倒排里同样沉底（分组键固定 ASC，与 used_amount / proxy_name 同款）
  assert.deepEqual(emails(await list('sort=codex_fingerprint_mode:desc')), [
    'a@test.local',
    'b@test.local',
    'c@test.local',
    'd@test.local',
  ]);

  // 排序白名单之外的键（含原始列名）回落到默认排序，不会 500（防注入回归）
  const fallback = await list('sort=discard_codex_fingerprint_mode:asc');
  assert.equal(fallback.items.length, 4);
});
