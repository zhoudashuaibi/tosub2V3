import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { openDatabase } from '../lib/db.js';
import { createCrypto } from '../lib/crypto.js';
import { createLogger } from '../lib/logger.js';
import { createAccountsModule } from '../modules/accounts/index.js';

const logger = createLogger('silent');

// 四段格式（邮箱----密码----clientId----refreshToken），clientId/refreshToken 满足格式校验
const LINE_A = `a@test.com----pw1----11111111-1111-1111-1111-111111111111----${'r'.repeat(120)}`;
const LINE_B = `b@test.com----pw2----22222222-2222-2222-2222-222222222222----${'s'.repeat(120)}`;

/** 远端 sub2api 账号（client.accountEmail 读 credentials.email） */
function remoteAccount(id, email, status = 'active') {
  return { id, status, platform: 'openai', type: 'oauth', credentials: { email } };
}

let ctx;
let originalFetch;

function setup({ remoteAccounts = [] } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tosub2-adopt-'));
  const db = openDatabase(dataDir, { logger });
  const crypto = createCrypto({ dataDir, secretKeyEnv: 'test-secret', logger });
  const app = Fastify();
  app.decorate('db', db);
  app.decorate('crypto', crypto);
  app.decorate('config', { dataDir });
  app.decorate('settings', {
    get: (key) => (key === 'sub2api.config' ? { base_url: 'https://sub2api.test', admin_key: 'key' } : {}),
  });
  app.decorate('sub2apiClient', {
    listAllOpenAiAccounts: async () => remoteAccounts,
    accountEmail: (account) => account?.credentials?.email || null,
  });
  return { dataDir, db, crypto, app, remoteAccounts };
}

async function start(remoteAccounts = []) {
  ctx = setup({ remoteAccounts });
  await createAccountsModule({ engine: { hooks: {} }, logger })(ctx.app);
  await ctx.app.ready();
  return ctx;
}

function importCall(payload) {
  return ctx.app.inject({ method: 'POST', url: '/api/v1/accounts/import', payload });
}

function accountRow(email) {
  return ctx.db.prepare('SELECT * FROM accounts WHERE email = ?').get(email);
}

beforeEach(() => {
  // 备用池导入会异步拉 Outlook 邮件：stub 掉网络，快速失败不挂测试
  originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('network disabled in test');
  };
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (ctx) {
    await ctx.app.close();
    ctx.db.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
    ctx = null;
  }
});

test('远端重复默认只提示不入库（维持原查重语义）', async () => {
  await start([remoteAccount(101, 'a@test.com')]);
  const res = await importCall({ text: LINE_A });
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.equal(body.created, 0);
  assert.deepEqual(body.duplicates_remote, ['a@test.com']);
  assert.equal(body.adopted_remote.length, 0);
  assert.equal(accountRow('a@test.com'), undefined);
});

test('adopt_remote：本地无记录的远端账号收编进主号池，不登录、关联远端、禁自动修复', async () => {
  await start([remoteAccount(101, 'a@test.com', 'active')]);
  const res = await importCall({ text: `${LINE_A}\n${LINE_B}`, adopt_remote: true });
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.equal(body.created, 2);
  assert.equal(body.main_created, 1);
  assert.deepEqual(body.adopted_remote, ['a@test.com']);
  assert.deepEqual(body.duplicates_remote, []);

  const adopted = accountRow('a@test.com');
  assert.equal(adopted.pool, 'main');
  assert.equal(adopted.status, 'active');
  assert.equal(adopted.sub2api_account_id, 101);
  assert.equal(adopted.sub2api_status, 'active');
  assert.equal(adopted.auto_repair_blocked, 1);
  assert.equal(adopted.tokens_enc, null);

  // 不在远端的账号照旧进备用池
  assert.equal(accountRow('b@test.com').pool, 'reserve');

  // 事件：imported + sub2api_linked
  const events = ctx.db
    .prepare(`SELECT type FROM account_events WHERE account_id=? ORDER BY id`)
    .all(adopted.id)
    .map((row) => row.type);
  assert.ok(events.includes('imported'));
  assert.ok(events.includes('sub2api_linked'));
});

test('adopt_remote：备用池已有且远端也存在 → 升级进主号池，保留初始余额', async () => {
  const remote = [];
  await start(remote);
  // 第一次导入：远端还没有 a，进备用池
  await importCall({ text: `${LINE_A}\n${LINE_B}` });
  ctx.db.prepare('UPDATE accounts SET initial_balance=5, has_balance=1 WHERE email=?').run('a@test.com');
  // 另一台机器把 a 传上了 sub2api
  remote.push(remoteAccount(101, 'a@test.com'));

  const res = await importCall({ text: LINE_A, adopt_remote: true });
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.deepEqual(body.adopted_remote, ['a@test.com']);
  assert.deepEqual(body.duplicates_in_reserve, []);

  const upgraded = accountRow('a@test.com');
  assert.equal(upgraded.pool, 'main');
  assert.equal(upgraded.status, 'active');
  assert.equal(upgraded.sub2api_account_id, 101);
  assert.equal(upgraded.auto_repair_blocked, 1);
  assert.equal(upgraded.initial_balance, 5);
  assert.equal(upgraded.has_balance, 1);
});

test('adopt_remote：备用池加入中的号不收编，退化为刷新凭据', async () => {
  const remote = [];
  await start(remote);
  await importCall({ text: LINE_A });
  ctx.db.prepare(`UPDATE accounts SET status='joining' WHERE email='a@test.com'`).run();
  remote.push(remoteAccount(101, 'a@test.com'));

  const res = await importCall({ text: LINE_A, adopt_remote: true });
  const body = res.json();
  assert.deepEqual(body.adopted_remote, []);
  assert.deepEqual(body.duplicates_in_reserve, ['a@test.com']);
  assert.equal(accountRow('a@test.com').pool, 'reserve');
  assert.equal(accountRow('a@test.com').status, 'joining');
});

test('force_remote 优先于 adopt_remote：强制进备用池', async () => {
  await start([remoteAccount(101, 'a@test.com')]);
  const res = await importCall({ text: LINE_A, adopt_remote: true, force_remote: true });
  const body = res.json();
  assert.deepEqual(body.adopted_remote, []);
  assert.equal(accountRow('a@test.com').pool, 'reserve');
});

test('adopt_remote：远端状态镜像（error 一并写入 sub2api_status）', async () => {
  await start([remoteAccount(202, 'a@test.com', 'error')]);
  await importCall({ text: LINE_A, adopt_remote: true });
  const adopted = accountRow('a@test.com');
  assert.equal(adopted.sub2api_status, 'error');
  assert.equal(adopted.sub2api_account_id, 202);
});
