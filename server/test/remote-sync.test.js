import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../lib/db.js';
import { createCrypto } from '../lib/crypto.js';
import { createLogger } from '../lib/logger.js';
import { createRemoteSync, buildProxyUrl } from '../modules/sub2api/remote-sync.js';

const logger = createLogger('silent');

let ctx;

function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tosub2-remote-sync-'));
  const db = openDatabase(dataDir, { logger });
  const crypto = createCrypto({ dataDir, secretKeyEnv: 'test-secret', logger });
  return { dataDir, db, crypto };
}

beforeEach(() => {
  ctx = setup();
});

function insertMain(db, { email, sub2apiAccountId = null, sub2apiStatus = null }) {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO accounts(email, pool, status, mail_status, sub2api_account_id, sub2api_status, created_at, updated_at)
       VALUES(?, 'main', 'active', 'ok', ?, ?, ?, ?)`,
    )
    .run(email, sub2apiAccountId, sub2apiStatus, now, now);
  return Number(result.lastInsertRowid);
}

function buildSync({ remoteAccounts = [], proxies = [], configured = true } = {}) {
  const client = {
    listAllOpenAiAccounts: async () => remoteAccounts,
    listProxies: async () => proxies,
    accountEmail: (account) => account?.credentials?.email || null,
  };
  return createRemoteSync({
    db: ctx.db,
    client,
    getConfig: () => (configured ? { base_url: 'http://sub2api.test', admin_key: 'sk-test' } : {}),
    logger,
  });
}

test('buildProxyUrl：拼接协议/认证/端口，非法输入返回 null', () => {
  assert.equal(buildProxyUrl({ protocol: 'http', host: '1.2.3.4', port: 8080 }), 'http://1.2.3.4:8080');
  assert.equal(
    buildProxyUrl({ protocol: 'socks5', host: 'p.example', port: 1080, username: 'u', password: 'p@ss' }),
    'socks5://u:p%40ss@p.example:1080',
  );
  assert.equal(buildProxyUrl({ protocol: 'ssh', host: '1.2.3.4', port: 22 }), null);
  assert.equal(buildProxyUrl({ protocol: 'http', host: '', port: 80 }), null);
  assert.equal(buildProxyUrl({ protocol: 'http', host: '1.2.3.4', port: 0 }), null);
});

test('syncRemoteStatus：按 email 回填远端 ID 并镜像 status', async () => {
  const id = insertMain(ctx.db, { email: 'a@test.local' });
  const sync = buildSync({
    remoteAccounts: [{ id: 7, credentials: { email: 'a@test.local' }, status: 'active' }],
  });

  const stats = await sync.syncRemoteStatus();

  assert.equal(stats.scanned, 1);
  assert.equal(stats.linked, 1);
  const row = ctx.db.prepare('SELECT * FROM accounts WHERE id=?').get(id);
  assert.equal(row.sub2api_account_id, 7);
  assert.equal(row.sub2api_status, 'active');
  assert.ok(row.sub2api_uploaded_at);
  const events = ctx.db.prepare(`SELECT type FROM account_events WHERE account_id=?`).all(id);
  assert.deepEqual(events.map((e) => e.type), ['sub2api_linked']);
});

test('syncRemoteStatus：ID 已正确时仅镜像 status，无变化不写库', async () => {
  const id = insertMain(ctx.db, { email: 'a@test.local', sub2apiAccountId: 7 });
  const sync = buildSync({
    remoteAccounts: [{ id: 7, credentials: { email: 'a@test.local' }, status: 'error' }],
  });

  const first = await sync.syncRemoteStatus();
  assert.equal(first.status_updated, 1);
  assert.equal(ctx.db.prepare('SELECT sub2api_status FROM accounts WHERE id=?').get(id).sub2api_status, 'error');

  const second = await sync.syncRemoteStatus();
  assert.equal(second.status_updated, 0);
  assert.equal(second.linked, 0);
});

test('syncRemoteStatus：远端已不存在 → 清除本地关联并记事件', async () => {
  const id = insertMain(ctx.db, { email: 'gone@test.local', sub2apiAccountId: 9, sub2apiStatus: 'active' });
  const sync = buildSync({ remoteAccounts: [] });

  const stats = await sync.syncRemoteStatus();

  assert.equal(stats.unlinked, 1);
  const row = ctx.db.prepare('SELECT sub2api_account_id, sub2api_status FROM accounts WHERE id=?').get(id);
  assert.equal(row.sub2api_account_id, null);
  assert.equal(row.sub2api_status, null);
});

test('syncRemoteStatus：优先按本地 ID 匹配（email 变更仍能关联）', async () => {
  const id = insertMain(ctx.db, { email: 'renamed@test.local', sub2apiAccountId: 5 });
  const sync = buildSync({
    remoteAccounts: [{ id: 5, credentials: { email: 'old@test.local' }, status: 'active' }],
  });

  await sync.syncRemoteStatus();

  const row = ctx.db.prepare('SELECT sub2api_account_id, sub2api_status FROM accounts WHERE id=?').get(id);
  assert.equal(row.sub2api_account_id, 5);
  assert.equal(row.sub2api_status, 'active');
});

test('syncRemoteStatus：同邮箱多远端账号 → 记一次 sub2api_duplicate 事件并统计', async () => {
  const id = insertMain(ctx.db, { email: 'dup@test.local', sub2apiAccountId: 20 });
  const sync = buildSync({
    remoteAccounts: [
      { id: 20, credentials: { email: 'dup@test.local' }, status: 'active' },
      { id: 30, credentials: { email: 'dup@test.local' }, status: 'error' },
    ],
  });

  const first = await sync.syncRemoteStatus();
  assert.equal(first.duplicates, 1);
  assert.equal(first.duplicate_new, 1);
  assert.deepEqual(first.duplicate_items, [
    { email: 'dup@test.local', remote_ids: [20, 30], extras: [30] },
  ]);
  const events = ctx.db.prepare(`SELECT type FROM account_events WHERE account_id=? ORDER BY id`).all(id);
  assert.deepEqual(events.map((e) => e.type), ['sub2api_duplicate']);
  // 关联仍指向最早的那份，不会被重复账号带偏
  assert.equal(ctx.db.prepare('SELECT sub2api_account_id FROM accounts WHERE id=?').get(id).sub2api_account_id, 20);

  // 重复集合未变 → 不重复记事件，但每轮仍然统计到，方便巡检日志持续提醒
  const second = await sync.syncRemoteStatus();
  assert.equal(second.duplicates, 1);
  assert.equal(second.duplicate_new, 0);
  assert.equal(second.duplicate_items.length, 0);
  assert.equal(
    ctx.db.prepare(`SELECT COUNT(*) n FROM account_events WHERE account_id=? AND type='sub2api_duplicate'`).get(id).n,
    1,
  );
});

test('syncRemoteStatus：未关联时按 email 命中最早的一份（与远端返回顺序无关）', async () => {
  const id = insertMain(ctx.db, { email: 'dup2@test.local' });
  const sync = buildSync({
    remoteAccounts: [
      { id: 30, credentials: { email: 'dup2@test.local' }, status: 'error' },
      { id: 20, credentials: { email: 'dup2@test.local' }, status: 'active' },
    ],
  });

  await sync.syncRemoteStatus();

  assert.equal(ctx.db.prepare('SELECT sub2api_account_id FROM accounts WHERE id=?').get(id).sub2api_account_id, 20);
});

test('resolveSub2apiProxy：已上传且绑代理 → 返回 URL；未配置/未上传/未绑代理 → null', async () => {
  const proxies = [{ id: 3, protocol: 'http', host: '10.0.0.1', port: 8080, username: 'u', password: 'p', name: 'p3' }];
  const remoteAccounts = [
    { id: 7, credentials: { email: 'bound@test.local' }, status: 'active', proxy_id: 3 },
    { id: 8, credentials: { email: 'noproxy@test.local' }, status: 'active', proxy_id: 0 },
  ];
  const boundId = insertMain(ctx.db, { email: 'bound@test.local' });
  insertMain(ctx.db, { email: 'noproxy@test.local' });
  const localOnlyId = insertMain(ctx.db, { email: 'local-only@test.local' });
  const configured = buildSync({ remoteAccounts, proxies });
  const unconfigured = buildSync({ remoteAccounts, proxies, configured: false });

  const bound = await configured.resolveSub2apiProxy(boundId);
  assert.equal(bound.url, 'http://u:p@10.0.0.1:8080');
  assert.equal(bound.remote_id, 7);
  assert.equal(bound.proxy_name, 'p3');

  assert.equal(await configured.resolveSub2apiProxy(localOnlyId), null);
  assert.equal(await unconfigured.resolveSub2apiProxy(boundId), null);

  // 未绑代理的远端号：listProxies 只在解析到 proxy_id 后才请求，noproxy 号不会触发也不返回路由
  const noProxyId = ctx.db.prepare(`SELECT id FROM accounts WHERE email='noproxy@test.local'`).get().id;
  assert.equal(await configured.resolveSub2apiProxy(noProxyId), null);
});
