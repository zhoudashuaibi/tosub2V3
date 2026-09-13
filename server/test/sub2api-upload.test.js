import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../lib/db.js';
import { createCrypto } from '../lib/crypto.js';
import { createLogger } from '../lib/logger.js';
import { createUploader, balanceTierPriority, mergeUploadOptions, uploadIdempotencyKey } from '../modules/sub2api/upload.js';
import { buildMainBalanceEstimate } from '../modules/accounts/index.js';
import { createSub2apiClient } from '../modules/sub2api/client.js';

const logger = createLogger('silent');

let ctx;

function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tosub2-upload-'));
  const db = openDatabase(dataDir, { logger });
  const crypto = createCrypto({ dataDir, secretKeyEnv: 'test-secret', logger });
  const created = [];
  const createBatches = [];
  const updated = [];
  const remote = new Map(); // email → 远端账号（mock 的远端状态，创建后即可被索引到）
  let nextRemoteId = 100;
  const client = {
    listAllOpenAiAccounts: async () => [...remote.values()],
    accountEmail: (account) => account?.credentials?.email || null,
    createAccountsBatch: async (payloads, idempotencyKey) => {
      createBatches.push({ payloads, idempotencyKey });
      for (const payload of payloads) {
        const email = String(payload.credentials?.email || '').toLowerCase();
        remote.set(email, { id: nextRemoteId, credentials: payload.credentials, name: payload.name, status: 'active' });
        nextRemoteId += 1;
        created.push(payload);
      }
      return { data: [] };
    },
    updateAccount: async (id, payload) => {
      updated.push({ id, payload });
    },
    clearError: async () => {},
    setSchedulable: async () => {},
    listProxies: async () => [],
  };
  const uploader = createUploader({
    db,
    crypto,
    client,
    getConfig: () => ({ base_url: 'http://sub2api.test', admin_key: 'sk-test', group_ids: [], upload_defaults: {} }),
    settingsGet: () => null,
    dataDir,
    proxySelector: null,
    logger,
  });
  return { dataDir, db, crypto, uploader, client, created, createBatches, updated, remote };
}

// 不带 access_token：余额为空时跳过实时补查，保持「未查过」口径
function insertAccount(db, crypto, { email, balance = null }) {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO accounts(email, pool, status, mail_status, tokens_enc, credentials_enc, balance, imported_at, created_at, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      email,
      'main',
      'active',
      'ok',
      crypto.encryptJson({ refresh_token: 'rt', email }, 'accounts.tokens_enc'),
      null,
      balance,
      now,
      now,
      now,
    );
  return Number(result.lastInsertRowid);
}

function priorityByEmail() {
  const map = new Map();
  for (const payload of ctx.created) map.set(payload.credentials.email, payload);
  return map;
}

function estimateOptions() {
  return {
    accountEmail: (account) => account?.credentials?.email || null,
    accountUsedAmount: (account) => {
      const value = account.used_amount ?? account.usage?.total_cost;
      return Number.isFinite(Number(value)) ? { amount: Number(value), source: 'test' } : null;
    },
  };
}

beforeEach(() => {
  ctx = setup();
});

test('balanceTierPriority：四档边界与未知余额默认档', () => {
  assert.equal(balanceTierPriority(0), 40);
  assert.equal(balanceTierPriority(9.4), 40);
  assert.equal(balanceTierPriority(9.6), 40); // 四舍五入到 10，与 ---N 名称后缀同口径
  assert.equal(balanceTierPriority(10), 40);
  assert.equal(balanceTierPriority(10.6), 20);
  assert.equal(balanceTierPriority(15), 20);
  assert.equal(balanceTierPriority(19.6), 30);
  assert.equal(balanceTierPriority(25), 30);
  assert.equal(balanceTierPriority(39.4), 30);
  assert.equal(balanceTierPriority(39.6), 10);
  assert.equal(balanceTierPriority(40), 10);
  assert.equal(balanceTierPriority(null), 20); // 未查过按默认 10 刀档
  assert.equal(balanceTierPriority(undefined), 20);
});

test('上传默认按余额分档设置优先级，并追加余额后缀', async () => {
  const cases = [
    { email: 'small@test.local', balance: 5.4, priority: 40, suffix: '---5' },
    { email: 'mid@test.local', balance: 15, priority: 20, suffix: '---15' },
    { email: 'mid-high@test.local', balance: 25, priority: 30, suffix: '---25' },
    { email: 'big@test.local', balance: 40, priority: 10, suffix: '---40' },
    { email: 'unknown@test.local', balance: null, priority: 20, suffix: null },
  ];
  const ids = cases.map((c) => insertAccount(ctx.db, ctx.crypto, c));
  const result = await ctx.uploader.uploadAccounts(ids, {});
  assert.equal(result.created, 5);
  assert.equal(result.failed.length, 0);
  const byEmail = priorityByEmail();
  for (const c of cases) {
    const payload = byEmail.get(c.email);
    assert.ok(payload, `missing payload for ${c.email}`);
    assert.equal(payload.priority, c.priority, `${c.email} priority`);
    if (c.suffix) assert.ok(String(payload.name).endsWith(c.suffix), `${c.email} name suffix`);
    else assert.equal(String(payload.name), `oauth---${c.email}`);
  }
});

test('显式指定优先级时不做余额分档', async () => {
  const ids = [
    insertAccount(ctx.db, ctx.crypto, { email: 'a@test.local', balance: 5 }),
    insertAccount(ctx.db, ctx.crypto, { email: 'b@test.local', balance: 30 }),
  ];
  await ctx.uploader.uploadAccounts(ids, { priority: 99 });
  const byEmail = priorityByEmail();
  assert.equal(byEmail.get('a@test.local').priority, 99);
  assert.equal(byEmail.get('b@test.local').priority, 99);
});

test('并发上传串行执行：同一个号只创建一次，后到的那次走替换', async () => {
  const id = insertAccount(ctx.db, ctx.crypto, { email: 'race@test.local', balance: 20 });

  const [first, second] = await Promise.all([
    ctx.uploader.uploadAccounts([id], {}),
    ctx.uploader.uploadAccounts([id], {}),
  ]);

  assert.equal(ctx.createBatches.length, 1, '并发进入也只应有一次批量创建');
  assert.equal(ctx.createBatches[0].payloads.length, 1);
  assert.equal(first.created, 1);
  assert.equal(first.updated, 0);
  assert.equal(second.created, 0);
  assert.equal(second.updated, 1);
  const remoteId = ctx.remote.get('race@test.local').id;
  assert.equal(ctx.updated.length, 1);
  assert.equal(ctx.updated[0].id, remoteId);
  assert.equal(
    ctx.db.prepare('SELECT sub2api_account_id FROM accounts WHERE id=?').get(id).sub2api_account_id,
    remoteId,
  );
  const events = ctx.db.prepare('SELECT type FROM account_events WHERE account_id=? ORDER BY id').all(id);
  assert.deepEqual(events.map((e) => e.type), ['uploaded_sub2api', 'sub2api_replaced']);
});

test('创建前二次校验：快照之后远端已出现的号降级为替换，不再重复创建', async () => {
  const id = insertAccount(ctx.db, ctx.crypto, { email: 'stale@test.local', balance: 20 });
  // 第一次拉取是空的（=陈旧快照），之后远端已经有这个号（=别处并发建好了）
  let calls = 0;
  ctx.client.listAllOpenAiAccounts = async () => {
    calls += 1;
    return calls === 1 ? [] : [{ id: 777, status: 'active', credentials: { email: 'stale@test.local' } }];
  };

  const result = await ctx.uploader.uploadAccounts([id], {});

  assert.equal(ctx.createBatches.length, 0, '创建前已存在于远端 → 不应再创建');
  assert.equal(result.created, 0);
  assert.equal(result.updated, 1);
  assert.equal(ctx.updated[0].id, 777);
  assert.equal(
    ctx.db.prepare('SELECT sub2api_account_id FROM accounts WHERE id=?').get(id).sub2api_account_id,
    777,
  );
});

test('同一批次内重复的账号 id 去重：不会在远端建出两份', async () => {
  const id = insertAccount(ctx.db, ctx.crypto, { email: 'twice@test.local', balance: 20 });

  const result = await ctx.uploader.uploadAccounts([id, id], {});

  assert.equal(ctx.createBatches.length, 1);
  assert.equal(ctx.createBatches[0].payloads.length, 1);
  assert.equal(result.created, 1);
});

test('uploadIdempotencyKey：同内容同时间桶一致且与顺序无关，跨桶或内容变化则不同', () => {
  const a = [{ payload: { name: 'x', credentials: { email: 'a@test.local' } } }];
  const b = [{ payload: { name: 'y', credentials: { email: 'b@test.local' } } }];
  const now = Date.parse('2026-09-13T08:00:00Z');

  assert.match(uploadIdempotencyKey(a, now), /^tosub2-upload-[0-9a-f]{32}$/);
  assert.equal(uploadIdempotencyKey([...a, ...b], now), uploadIdempotencyKey([...b, ...a], now));
  assert.notEqual(uploadIdempotencyKey(a, now), uploadIdempotencyKey(b, now));
  // 跨时间桶 → 视为新批次，避免远端号被删后重新上传命中旧缓存响应被静默跳过
  assert.notEqual(uploadIdempotencyKey(a, now), uploadIdempotencyKey(a, now + 11 * 60_000));
});

test('Sub2API 管理端账号统计：使用 /stats?days=90 并携带管理员密钥', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify({ data: { summary: { total_cost: 3.25 } } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const client = createSub2apiClient(() => ({ base_url: 'https://sub2api.example/', admin_key: 'admin-secret' }));
    const result = await client.getAccountStats(42, 90);
    assert.equal(result.data.summary.total_cost, 3.25);
    assert.equal(calls[0].url, 'https://sub2api.example/api/v1/admin/accounts/42/stats?days=90');
    assert.equal(calls[0].options.headers['x-api-key'], 'admin-secret');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('主号池预估余额：名称后缀回退、邮箱匹配和负数归零', () => {
  const result = buildMainBalanceEstimate(
    [
      { id: 1, email: 'a@test.local', initial_balance: 20, sub2api_account_id: null },
      { id: 2, email: 'b@test.local', initial_balance: 5, sub2api_account_id: 22 },
      { id: 3, email: 'c@test.local', initial_balance: null, sub2api_account_id: 33 },
    ],
    [
      { id: 11, credentials: { email: 'a@test.local' }, used_amount: 6.4 },
      { id: 22, credentials: { email: 'b@test.local' }, usage: { total_cost: 8 } },
      { id: 33, name: 'oauth---c@test.local---20', credentials: { email: 'c@test.local' }, used_amount: 1 },
    ],
    estimateOptions(),
  );
  assert.equal(result.total_estimated_remaining, 32.6);
  assert.equal(result.calculable_count, 3);
  assert.equal(result.unknown_count, 0);
  assert.equal(result.items[1].estimated_remaining, 0);
  assert.equal(result.items[2].initial_balance, 20);
  assert.equal(result.items[2].initial_balance_source, 'sub2api_name_suffix');
  assert.equal(result.items[2].estimated_remaining, 19);
});

test('主号池预估余额：本地初始化余额优先于远端名称后缀', () => {
  const result = buildMainBalanceEstimate(
    [{ id: 1, email: 'a@test.local', initial_balance: 5, sub2api_account_id: 7 }],
    [{ id: 7, name: 'oauth---a@test.local---20', credentials: { email: 'a@test.local' }, used_amount: 1 }],
    estimateOptions(),
  );
  assert.equal(result.items[0].initial_balance, 5);
  assert.equal(result.items[0].initial_balance_source, 'local');
  assert.equal(result.items[0].estimated_remaining, 4);
});

test('主号池预估余额：非末尾整数后缀不作为初始化余额', () => {
  const result = buildMainBalanceEstimate(
    [{ id: 1, email: 'a@test.local', initial_balance: null, sub2api_account_id: 7 }],
    [{ id: 7, name: 'oauth---a@test.local---20-extra', credentials: { email: 'a@test.local' }, used_amount: 1 }],
    estimateOptions(),
  );
  assert.equal(result.unknown_count, 1);
  assert.equal(result.items[0].initial_balance, null);
  assert.equal(result.items[0].initial_balance_source, null);
  assert.equal(result.items[0].reason, 'initial_balance_unknown');
});

test('主号池预估余额：缺少远端用量时保持未知，不写入余额', () => {
  const result = buildMainBalanceEstimate(
    [{ id: 1, email: 'a@test.local', initial_balance: 20, sub2api_account_id: 7 }],
    [{ id: 7, credentials: { email: 'a@test.local' } }],
    { accountEmail: () => 'a@test.local', accountUsedAmount: () => null },
  );
  assert.equal(result.total_estimated_remaining, 0);
  assert.equal(result.unknown_count, 1);
  assert.equal(result.items[0].reason, 'remote_used_amount_unknown');
});

test('mergeUploadOptions：未显式覆盖时 priority 保持空，交给分档逻辑', () => {
  const merged = mergeUploadOptions({ priority: null }, { priority: null });
  assert.equal(merged.priority, null);
  const overridden = mergeUploadOptions({ priority: 5 }, { priority: null });
  assert.equal(overridden.priority, null); // 弹窗清空即显式取消默认值，与既有语义一致
});

test('mergeUploadOptions：Codex 指纹收敛只放行四档，缺省/非法值一律回落到 off', () => {
  // 未配置 = off（透传），不是「未设置就随便收敛」
  assert.equal(mergeUploadOptions({}, {}).codex_fingerprint_mode, 'off');
  assert.equal(mergeUploadOptions({ codex_fingerprint_mode: 'session' }, {}).codex_fingerprint_mode, 'session');
  // 脏值（空格/大小写/未知档位）不得进入 payload：收敛在上游是显式 opt-in，放行未知值等于静默开启
  for (const dirty of ['', ' ', 'SESSION', 'on', 'true', null, undefined, 3, {}]) {
    assert.equal(
      mergeUploadOptions({ codex_fingerprint_mode: dirty }, {}).codex_fingerprint_mode,
      'off',
      `defaults=${JSON.stringify(dirty)}`,
    );
  }
  // 请求级覆盖同样过白名单
  assert.equal(mergeUploadOptions({}, { codex_fingerprint_mode: 'full' }).codex_fingerprint_mode, 'full');
  assert.equal(mergeUploadOptions({ codex_fingerprint_mode: 'full' }, { codex_fingerprint_mode: 'bogus' }).codex_fingerprint_mode, 'off');
});

test('上传 payload：收敛模式写入 extra.codex_fingerprint_mode，off 不写键', async () => {
  const ids = [insertAccount(ctx.db, ctx.crypto, { email: 'fp@test.local', balance: 20 })];
  await ctx.uploader.uploadAccounts(ids, { codex_fingerprint_mode: 'session' });
  assert.equal(ctx.created[0].extra.codex_fingerprint_mode, 'session');
  // 账号导出文件里的 extra 原样保留，其余 extra 键不受影响
  assert.equal(ctx.created[0].extra.openai_long_context_billing_enabled, true);

  // off / 非法值：不写该键（远端缺省即透传，与 sub2api 账号编辑页「关闭」语义一致）
  for (const mode of ['off', 'bogus', undefined]) {
    ctx = setup();
    const target = insertAccount(ctx.db, ctx.crypto, { email: 'fp2@test.local', balance: 20 });
    await ctx.uploader.uploadAccounts([target], { codex_fingerprint_mode: mode });
    assert.equal('codex_fingerprint_mode' in ctx.created[0].extra, false, `mode=${mode}`);
  }
});
