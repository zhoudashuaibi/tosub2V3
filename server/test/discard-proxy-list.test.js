/**
 * 废弃池「代理 IP」列端到端校验（API 层）：
 * 建库 → 跑全部迁移（含 0011）→ 往废弃池塞带/不带代理快照的号 →
 * 命中真实路由 GET /api/v1/accounts?pool=discard，检查返回字段、排序、搜索。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { listMigrations } from '../lib/db.js';
import { createCrypto } from '../lib/crypto.js';
import { registerErrorHandler } from '../lib/http-errors.js';
import { createAccountsModule } from '../modules/accounts/index.js';

const silentLogger = { debug() {}, warn() {}, info() {}, error() {} };
const NOW = '2026-09-13T10:00:00.000Z';

function seedDiscardPool(db) {
  const insert = db.prepare(
    `INSERT INTO accounts(id, email, pool, status, discard_reason, discarded_at,
       discard_proxy_name, discard_proxy_user, discard_proxy_id, discard_proxy_at, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  insert.run(1, 'a@test.local', 'discard', 'discarded', 'banned_401', NOW, '23', 'u123', 23, NOW, NOW, NOW);
  insert.run(2, 'b@test.local', 'discard', 'discarded', 'rate_limited_429', NOW, '23', 'u999', 23, NOW, NOW, NOW);
  insert.run(3, 'c@test.local', 'discard', 'discarded', 'login_failed', NOW, null, null, null, null, NOW, NOW);
}

test('废弃池列表：代理 IP 字段、空值沉底排序、按代理名/认证账号搜索', async (t) => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const migration of listMigrations()) db.exec(migration.sql);
  seedDiscardPool(db);

  const app = Fastify();
  app.decorate('db', db);
  app.decorate('crypto', createCrypto({ secretKeyEnv: 'discard-proxy-e2e' }));
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

  // 排序白名单不含 id，同 discarded_at 时按 id DESC 兜底 → 这里固定用 email:asc 让顺序可预期
  const byEmail = (body) => body.items.map((item) => item.email);
  const emails = (body) => byEmail(body).slice().sort();

  // 字段透出（界面那一列直接用这四个）
  const all = await list('sort=email:asc');
  const byEmailMap = new Map(all.items.map((item) => [item.email, item]));
  assert.deepEqual(
    ['a@test.local', 'b@test.local', 'c@test.local'].map((email) => {
      const item = byEmailMap.get(email);
      return [item.proxy_name, item.proxy_user, item.proxy_id];
    }),
    [
      ['23', 'u123', 23],
      ['23', 'u999', 23],
      [null, null, null],
    ],
  );

  // 按代理反查：同一个 IP 上死了哪批号，是这个列的主用途
  assert.deepEqual(emails(await list('q=23')), ['a@test.local', 'b@test.local']);
  assert.deepEqual(byEmail(await list('q=u999')), ['b@test.local']);

  // 排序：没有代理记录的号两个方向都沉底
  assert.deepEqual(emails(await list('sort=proxy_name:asc')), ['a@test.local', 'b@test.local', 'c@test.local']);
  assert.deepEqual(emails(await list('sort=proxy_name:desc')), ['a@test.local', 'b@test.local', 'c@test.local']);

  // 邮箱搜索仍然可用（回归）
  assert.deepEqual(byEmail(await list('q=b@test')), ['b@test.local']);
});
