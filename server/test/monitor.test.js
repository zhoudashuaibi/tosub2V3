import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../lib/db.js';
import { createCrypto } from '../lib/crypto.js';
import { createLogger } from '../lib/logger.js';
import { createMonitor } from '../modules/sub2api/monitor.js';
import { createPools } from '../modules/accounts/pools.js';

const logger = createLogger('silent');

let ctx;

function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tosub2-monitor-'));
  const db = openDatabase(dataDir, { logger });
  const crypto = createCrypto({ dataDir, secretKeyEnv: 'test-secret', logger });
  const pools = createPools(db, crypto);
  return { dataDir, db, crypto, pools, submitted: [], uploads: [], schedulable: [], banChecks: [], banResults: [] };
}

function insertAccount(db, crypto, { email, pool = 'main', status = 'active', tokens = null, credentials = null, balance = null, initialBalance = null }) {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO accounts(email, pool, status, mail_status, tokens_enc, credentials_enc, balance, initial_balance, imported_at, created_at, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      email,
      pool,
      status,
      'ok',
      tokens ? crypto.encryptJson(tokens, 'accounts.tokens_enc') : null,
      credentials ? crypto.encryptJson(credentials, 'accounts.credentials_enc') : null,
      balance,
      initialBalance,
      now,
      now,
      now,
    );
  return Number(result.lastInsertRowid);
}

function insertRunningJob(db, accountId) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO jobs(id, account_id, type, status, log_path, created_at, updated_at) VALUES(?,?,?,?,?,?,?)`).run(
    `job-${accountId}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    accountId,
    'login',
    'running',
    'logs/mock.log',
    now,
    now,
  );
}

function remoteAccount({ id, email, status = 'active', rateLimitedAt = null, resetAt = null, name = null, errorMessage = '401 unauthorized', concurrency = null }) {
  return {
    id,
    type: 'oauth',
    status,
    name: name || `oauth---${email}`,
    credentials: { email },
    rate_limited_at: rateLimitedAt,
    rate_limit_reset_at: resetAt,
    ...(concurrency != null ? { concurrency } : {}),
    error_message: status === 'error' ? errorMessage : null,
  };
}

function buildMonitor({
  threshold = 10,
  remoteAccounts = [],
  autoRepair = false,
  bannedPatterns = ['401'],
  banMailCheck = null,
  monitorConfig: monitorOverrides = {},
  uploadDefaults = {},
  failDiscard = false,
} = {}) {
  const client = {
    listAllOpenAiAccounts: async () => remoteAccounts,
    accountEmail: (account) => account?.credentials?.email || null,
    accountRateLimit: (account) => {
      let limitedNow = Boolean(account?.rate_limited_at);
      if (limitedNow && account?.rate_limit_reset_at) {
        const resetMs = Date.parse(account.rate_limit_reset_at);
        if (Number.isFinite(resetMs) && resetMs <= Date.now()) limitedNow = false;
      }
      return { rate_limited_at: account?.rate_limited_at ?? null, rate_limit_reset_at: account?.rate_limit_reset_at ?? null, limited_now: limitedNow };
    },
    accountErrorMessage: (account) => account?.error_message || '',
    setSchedulable: async (id, enabled) => {
      ctx.schedulable.push({ id, enabled });
    },
  };
  const getConfig = () => ({
    base_url: 'http://sub2api.test',
    admin_key: 'sk-test',
    group_ids: [],
    upload_defaults: uploadDefaults,
    monitor: {
      enabled: true,
      auto_repair: autoRepair,
      auto_replenish: true,
      // 巡检余额刷新走独立测试覆盖；默认关避免影响既有 submitJob 精确断言
      refresh_balance: false,
      reserve_threshold: threshold,
      banned_patterns: bannedPatterns,
      rate_limit_patterns: ['429', 'rate limit'],
      ...monitorOverrides,
    },
  });
  return createMonitor({
    db: ctx.db,
    crypto: ctx.crypto,
    client,
    getConfig,
    pools: failDiscard
      ? {
          ...ctx.pools,
          moveToDiscard: () => {
            throw new Error('账号不在可废弃的状态');
          },
        }
      : ctx.pools,
    engine: { submitJob: (job) => ctx.submitted.push(job) },
    uploader: {
      uploadAccounts: async (ids, options) => {
        ctx.uploads.push({ ids: [...ids], options });
        return { created: ids.length, updated: 0, failed: [], updated_account_ids: [] };
      },
    },
    banMailCheck,
    logger,
  });
}

beforeEach(() => {
  ctx = setup();
});

test('补号计数：远端正常的主池号计入，达到阈值不补', async () => {
  const emails = ['a@test.local', 'b@test.local', 'c@test.local'];
  for (const email of emails) insertAccount(ctx.db, ctx.crypto, { email });
  const monitor = buildMonitor({
    threshold: 3,
    remoteAccounts: emails.map((email, i) => remoteAccount({ id: i + 1, email })),
  });

  const view = await monitor.runCheck();

  assert.equal(view.last_result.available_count, 3);
  assert.equal(view.last_result.replenished, 0);
  assert.equal(ctx.submitted.length, 0);
});

test('巡检余额刷新：已上传主池号排队，限流/备用池/已有任务跳过', async () => {
  const okId = insertAccount(ctx.db, ctx.crypto, { email: 'ok@test.local', tokens: { refresh_token: 'rt' } });
  insertAccount(ctx.db, ctx.crypto, { email: 'no-tokens@test.local' });
  insertAccount(ctx.db, ctx.crypto, { email: 'limited@test.local', tokens: { refresh_token: 'rt' } });
  insertAccount(ctx.db, ctx.crypto, { email: 'busy@test.local', tokens: { refresh_token: 'rt' } });
  insertAccount(ctx.db, ctx.crypto, { email: 'reserve@test.local', pool: 'reserve', status: 'mail_ok', tokens: { refresh_token: 'rt' } });
  const busyId = ctx.db.prepare(`SELECT id FROM accounts WHERE email='busy@test.local'`).get().id;
  insertRunningJob(ctx.db, busyId);
  const monitor = buildMonitor({
    threshold: 10,
    monitorConfig: { refresh_balance: true },
    remoteAccounts: [
      remoteAccount({ id: 1, email: 'ok@test.local' }),
      remoteAccount({ id: 2, email: 'no-tokens@test.local' }),
      remoteAccount({
        id: 3,
        email: 'limited@test.local',
        rateLimitedAt: new Date().toISOString(),
        resetAt: new Date(Date.now() + 3600_000).toISOString(),
      }),
      remoteAccount({ id: 4, email: 'busy@test.local' }),
      remoteAccount({ id: 5, email: 'reserve@test.local' }),
    ],
  });

  const view = await monitor.runCheck();

  assert.equal(view.last_result.balance_queued, 1);
  const balanceJobs = ctx.submitted.filter((job) => job.type === 'balance');
  assert.equal(balanceJobs.length, 1);
  assert.equal(balanceJobs[0].accountId, okId);
});

test('补号计数：限流中（429）的号不计入，缺口触发补号', async () => {
  insertAccount(ctx.db, ctx.crypto, { email: 'ok@test.local' });
  insertAccount(ctx.db, ctx.crypto, { email: 'limited@test.local' });
  insertAccount(ctx.db, ctx.crypto, { email: 'cand@test.local', pool: 'reserve', status: 'mail_ok' });
  const monitor = buildMonitor({
    threshold: 2,
    remoteAccounts: [
      remoteAccount({ id: 1, email: 'ok@test.local' }),
      // 短期限流（1 小时后重置）：保留主池观察，但补号计数必须剔除
      remoteAccount({ id: 2, email: 'limited@test.local', rateLimitedAt: new Date().toISOString(), resetAt: new Date(Date.now() + 3600_000).toISOString() }),
    ],
  });

  const view = await monitor.runCheck();

  assert.equal(view.last_result.available_count, 1);
  assert.equal(view.last_result.replenished, 1);
  assert.equal(ctx.submitted.length, 1);
  assert.equal(ctx.submitted[0].type, 'login');
  const candidate = ctx.db.prepare(`SELECT pool, status FROM accounts WHERE email='cand@test.local'`).get();
  assert.equal(candidate.pool, 'reserve');
  assert.equal(candidate.status, 'joining');
});

test('401 只代表会话过期：不废弃，修复关闭时保留主池观察', async () => {
  insertAccount(ctx.db, ctx.crypto, { email: 'ok@test.local' });
  insertAccount(ctx.db, ctx.crypto, { email: 'expired@test.local' });
  insertAccount(ctx.db, ctx.crypto, { email: 'cand@test.local', pool: 'reserve', status: 'mail_ok' });
  const monitor = buildMonitor({
    threshold: 2,
    remoteAccounts: [
      remoteAccount({ id: 1, email: 'ok@test.local' }),
      remoteAccount({ id: 2, email: 'expired@test.local', status: 'error' }),
    ],
  });

  const view = await monitor.runCheck();

  // 即使 banned_patterns 里残留 '401' 也会被剥离：不废弃、不判封
  assert.equal(view.last_result.discarded, 0);
  assert.equal(view.last_result.ban_unconfirmed, 0);
  assert.equal(view.last_result.available_count, 1);
  assert.equal(view.last_result.replenished, 1);
  const account = ctx.db.prepare(`SELECT pool, status, banned FROM accounts WHERE email='expired@test.local'`).get();
  assert.equal(account.pool, 'main');
  assert.equal(account.banned, 0);
});

test('401 error + 自动修复：有 refresh_token 发刷新任务（失败由引擎转完整登录）', async () => {
  insertAccount(ctx.db, ctx.crypto, { email: 'expired@test.local', tokens: { refresh_token: 'rt' } });
  const monitor = buildMonitor({
    autoRepair: true,
    remoteAccounts: [remoteAccount({ id: 1, email: 'expired@test.local', status: 'error' })],
  });

  const view = await monitor.runCheck();

  assert.equal(view.last_result.repairing, 1);
  assert.equal(ctx.submitted.length, 1);
  assert.equal(ctx.submitted[0].type, 'refresh');
  const account = ctx.db.prepare(`SELECT status FROM accounts WHERE email='expired@test.local'`).get();
  assert.equal(account.status, 'authorizing');
});

test('401 error + 自动修复：无 refresh_token 但有密码 → 直接发完整登录', async () => {
  insertAccount(ctx.db, ctx.crypto, { email: 'expired@test.local', credentials: { password: 'pw' } });
  const monitor = buildMonitor({
    autoRepair: true,
    remoteAccounts: [remoteAccount({ id: 1, email: 'expired@test.local', status: 'error' })],
  });

  const view = await monitor.runCheck();

  assert.equal(view.last_result.repairing, 1);
  assert.equal(ctx.submitted[0].type, 'login');
});

test('封禁关键词未获邮件辅证 → 不废弃，暂停远端保留观察', async () => {
  insertAccount(ctx.db, ctx.crypto, { email: 'suspect@test.local' });
  const monitor = buildMonitor({
    bannedPatterns: ['banned'],
    banMailCheck: {
      check: async (id, { source }) => {
        ctx.banChecks.push({ id, source });
        return { confirmed: false, result: 'not_found' };
      },
    },
    remoteAccounts: [remoteAccount({ id: 7, email: 'suspect@test.local', status: 'error', errorMessage: 'account is banned' })],
  });

  const view = await monitor.runCheck();

  assert.equal(view.last_result.discarded, 0);
  assert.equal(view.last_result.ban_unconfirmed, 1);
  assert.equal(ctx.banChecks.length, 1);
  assert.deepEqual(ctx.schedulable, [{ id: 7, enabled: false }]);
  const account = ctx.db.prepare(`SELECT pool, banned, auto_repair_blocked FROM accounts WHERE email='suspect@test.local'`).get();
  assert.equal(account.pool, 'main');
  assert.equal(account.banned, 0);
  assert.equal(account.auto_repair_blocked, 0);
});

test('封禁关键词 + 邮件辅证证实 → 移废弃池并阻断自动修复', async () => {
  insertAccount(ctx.db, ctx.crypto, { email: 'banned@test.local' });
  const monitor = buildMonitor({
    bannedPatterns: ['deactivated'],
    banMailCheck: {
      check: async () => ({ confirmed: true, result: 'confirmed', reason: '邮件命中封禁关键词' }),
    },
    remoteAccounts: [remoteAccount({ id: 8, email: 'banned@test.local', status: 'error', errorMessage: 'account_deactivated' })],
  });

  const view = await monitor.runCheck();

  assert.equal(view.last_result.discarded, 1);
  assert.equal(view.last_result.ban_unconfirmed, 0);
  const account = ctx.db.prepare(`SELECT pool, discard_reason, auto_repair_blocked FROM accounts WHERE email='banned@test.local'`).get();
  assert.equal(account.pool, 'discard');
  assert.equal(account.discard_reason, 'banned_401');
  assert.equal(account.auto_repair_blocked, 1);
});

test('修复失败熔断：连续失败 max_repair_attempts 次暂停保留待重授（不废弃），转登录链路不重复计数', async () => {
  const id = insertAccount(ctx.db, ctx.crypto, { email: 'flaky@test.local' });
  const monitor = buildMonitor({}); // max_repair_attempts 默认 2
  ctx.db.prepare(`UPDATE accounts SET last_auto_repair_at=? WHERE id=?`).run(new Date().toISOString(), id);

  // refresh 失败但已转完整登录（followUpJobId）→ 本链路未结束，不计数
  monitor.noteRepairOutcome({ id: 'job-1', account_id: id, type: 'refresh' }, { ok: false, followUpJobId: 'job-2' });
  assert.equal(ctx.db.prepare(`SELECT repair_fail_count FROM accounts WHERE id=?`).get(id).repair_fail_count, 0);

  // 派生登录也失败 → 计 1 次，仍在主池
  monitor.noteRepairOutcome({ id: 'job-2', account_id: id, type: 'login' }, { ok: false });
  assert.equal(ctx.db.prepare(`SELECT repair_fail_count, pool FROM accounts WHERE id=?`).get(id).repair_fail_count, 1);

  // 第二轮修复失败 → 达到上限：暂停保留（needs_reauth + 停自动修复），不废弃、不暂停远端（未关联远端）
  monitor.noteRepairOutcome({ id: 'job-3', account_id: id, type: 'login' }, { ok: false });
  const account = ctx.db.prepare(`SELECT pool, status, discard_reason, repair_fail_count, auto_repair_blocked FROM accounts WHERE id=?`).get(id);
  assert.equal(account.pool, 'main');
  assert.equal(account.status, 'needs_reauth');
  assert.equal(account.discard_reason, null);
  assert.equal(account.repair_fail_count, 2);
  assert.equal(account.auto_repair_blocked, 1);
  assert.deepEqual(ctx.schedulable, []);

  // 成功路径：清零
  const id2 = insertAccount(ctx.db, ctx.crypto, { email: 'healed@test.local' });
  ctx.db.prepare(`UPDATE accounts SET last_auto_repair_at=?, repair_fail_count=1 WHERE id=?`).run(new Date().toISOString(), id2);
  monitor.noteRepairOutcome({ id: 'job-4', account_id: id2, type: 'login' }, { ok: true });
  assert.equal(ctx.db.prepare(`SELECT repair_fail_count FROM accounts WHERE id=?`).get(id2).repair_fail_count, 0);
});

test('修复连败达上限：巡检不再发修复任务，暂停保留并暂停远端调度', async () => {
  const id = insertAccount(ctx.db, ctx.crypto, { email: 'parked@test.local', tokens: { refresh_token: 'rt' } });
  ctx.db.prepare(`UPDATE accounts SET repair_fail_count=2, sub2api_account_id=55 WHERE id=?`).run(id);
  const monitor = buildMonitor({
    autoRepair: true,
    remoteAccounts: [remoteAccount({ id: 55, email: 'parked@test.local', status: 'error' })],
  });

  const view = await monitor.runCheck();

  assert.equal(view.last_result.repairing, 0);
  assert.equal(ctx.submitted.filter((job) => job.type !== 'balance').length, 0);
  assert.deepEqual(ctx.schedulable, [{ id: 55, enabled: false }]);
  const account = ctx.db.prepare(`SELECT pool, status, auto_repair_blocked FROM accounts WHERE id=?`).get(id);
  assert.equal(account.pool, 'main');
  assert.equal(account.status, 'needs_reauth');
  assert.equal(account.auto_repair_blocked, 1);
});

test('主池重授成功：状态回 active 并解锁自动修复（清连败计数与封锁）', async () => {
  const id = insertAccount(ctx.db, ctx.crypto, { email: 'reauth@test.local' });
  ctx.db.prepare(`UPDATE accounts SET status='needs_reauth', auto_repair_blocked=1, repair_fail_count=2 WHERE id=?`).run(id);

  ctx.pools.joinSucceeded(id, { tokensEnc: ctx.crypto.encryptJson({ access_token: 'at' }, 'accounts.tokens_enc') });

  const account = ctx.db.prepare(`SELECT pool, status, auto_repair_blocked, repair_fail_count FROM accounts WHERE id=?`).get(id);
  assert.equal(account.pool, 'main');
  assert.equal(account.status, 'active');
  assert.equal(account.auto_repair_blocked, 0);
  assert.equal(account.repair_fail_count, 0);
});

test('补号计数：他人上传的号（本地无记录）不计入', async () => {
  insertAccount(ctx.db, ctx.crypto, { email: 'mine@test.local' });
  insertAccount(ctx.db, ctx.crypto, { email: 'cand@test.local', pool: 'reserve', status: 'mail_ok' });
  const monitor = buildMonitor({
    threshold: 2,
    remoteAccounts: [
      remoteAccount({ id: 1, email: 'mine@test.local' }),
      remoteAccount({ id: 2, email: 'stranger@test.local' }),
    ],
  });

  const view = await monitor.runCheck();

  assert.equal(view.last_result.available_count, 1);
  assert.equal(view.last_result.replenished, 1);
});

test('补号计数：已废弃号远端未删不计入', async () => {
  insertAccount(ctx.db, ctx.crypto, { email: 'ok@test.local' });
  const discardedId = insertAccount(ctx.db, ctx.crypto, { email: 'gone@test.local' });
  ctx.pools.moveToDiscard(discardedId, 'rate_limited_429', '限流至下个月');
  insertAccount(ctx.db, ctx.crypto, { email: 'cand@test.local', pool: 'reserve', status: 'mail_ok' });
  const monitor = buildMonitor({
    threshold: 2,
    remoteAccounts: [
      remoteAccount({ id: 1, email: 'ok@test.local' }),
      // 远端还挂着、status 还是 active，但本地已废弃 → 不计入
      remoteAccount({ id: 2, email: 'gone@test.local' }),
    ],
  });

  const view = await monitor.runCheck();

  assert.equal(view.last_result.available_count, 1);
  assert.equal(view.last_result.replenished, 1);
});

test('补号计数：reserve 池在途 joining（有活跃任务）计入可用与库存，按缺口补足不超发', async () => {
  insertAccount(ctx.db, ctx.crypto, { email: 'ok@test.local' });
  const joiningId = insertAccount(ctx.db, ctx.crypto, { email: 'inflight@test.local', pool: 'reserve', status: 'joining' });
  insertRunningJob(ctx.db, joiningId);
  insertAccount(ctx.db, ctx.crypto, { email: 'c1@test.local', pool: 'reserve', status: 'mail_ok' });
  insertAccount(ctx.db, ctx.crypto, { email: 'c2@test.local', pool: 'reserve', status: 'mail_ok' });
  const monitor = buildMonitor({
    threshold: 2,
    remoteAccounts: [remoteAccount({ id: 1, email: 'ok@test.local' })],
  });

  const view = await monitor.runCheck();

  assert.equal(view.last_result.available_count, 2);
  // 在途 joining 计入库存（库存 1）→ 只补 1 个到保底 2，而不是把 2 个候选全发出去
  assert.equal(view.last_result.replenished, 1);
  assert.equal(ctx.submitted.length, 1);
});

test('补号计数：僵尸 joining（无活跃任务）不计入可用', async () => {
  insertAccount(ctx.db, ctx.crypto, { email: 'ok@test.local' });
  insertAccount(ctx.db, ctx.crypto, { email: 'zombie@test.local', pool: 'reserve', status: 'joining' });
  insertAccount(ctx.db, ctx.crypto, { email: 'cand@test.local', pool: 'reserve', status: 'mail_ok' });
  const monitor = buildMonitor({
    threshold: 2,
    remoteAccounts: [remoteAccount({ id: 1, email: 'ok@test.local' })],
  });

  const view = await monitor.runCheck();

  assert.equal(view.last_result.available_count, 1);
  assert.equal(view.last_result.replenished, 1);
  // 僵尸 joining 不符合候选资格，补的是 mail_ok 号
  const candidate = ctx.db.prepare(`SELECT email FROM accounts WHERE status='joining' AND email='cand@test.local'`).get();
  assert.ok(candidate);
});

test('补号并发：单轮最多补 3 个', async () => {
  for (const email of ['c1@test.local', 'c2@test.local', 'c3@test.local', 'c4@test.local', 'c5@test.local']) {
    insertAccount(ctx.db, ctx.crypto, { email, pool: 'reserve', status: 'mail_ok' });
  }
  const monitor = buildMonitor({ threshold: 6, remoteAccounts: [] });

  const view = await monitor.runCheck();

  assert.equal(view.last_result.available_count, 0);
  assert.equal(view.last_result.replenished, 3);
  assert.equal(ctx.submitted.length, 3);
});

test('级联补号：库存充足（补完缺口仍不低于保底）时备用池不动；余额小/未知余额的先上', async () => {
  insertAccount(ctx.db, ctx.crypto, { email: 'ok@test.local' });
  const unknownId = insertAccount(ctx.db, ctx.crypto, { email: 'unknown@test.local', tokens: { refresh_token: "rt" } });
  const smallId = insertAccount(ctx.db, ctx.crypto, { email: 'small@test.local', tokens: { refresh_token: "rt" }, balance: 3 });
  for (const email of ['big@test.local', 's4@test.local', 's5@test.local']) {
    insertAccount(ctx.db, ctx.crypto, { email, tokens: { refresh_token: "rt" }, balance: 20 });
  }
  insertAccount(ctx.db, ctx.crypto, { email: 'cand@test.local', pool: 'reserve', status: 'mail_ok' });
  const monitor = buildMonitor({
    threshold: 3,
    remoteAccounts: [remoteAccount({ id: 1, email: 'ok@test.local' })],
  });

  const view = await monitor.runCheck();

  // 可用 1、缺口 2：库存 5 个，上传 2 后剩余 3 仍等于保底 → 备用池不动
  assert.equal(view.last_result.available_count, 1);
  assert.equal(view.last_result.uploaded, 2);
  assert.equal(ctx.uploads.length, 1);
  // 未知余额（NULL 视为 0）与余额小的先上传
  assert.deepEqual(ctx.uploads[0].ids, [unknownId, smallId]);
  assert.equal(view.last_result.replenished, 0);
  assert.equal(ctx.submitted.length, 0);
  assert.equal(view.last_result.stock_count, 3);
});

test('级联补号：库存补不满缺口时，上传全部库存并从备用池登录补库存', async () => {
  insertAccount(ctx.db, ctx.crypto, { email: 'ok@test.local' });
  insertAccount(ctx.db, ctx.crypto, { email: 's1@test.local', tokens: { refresh_token: "rt" } });
  insertAccount(ctx.db, ctx.crypto, { email: 'cand@test.local', pool: 'reserve', status: 'mail_ok' });
  insertAccount(ctx.db, ctx.crypto, { email: 'cand2@test.local', pool: 'reserve', status: 'mail_ok' });
  const monitor = buildMonitor({
    threshold: 4,
    remoteAccounts: [remoteAccount({ id: 1, email: 'ok@test.local' })],
  });

  const view = await monitor.runCheck();

  // 可用 1、缺口 3：库存 1 个全部上传，剩余库存 0 低于保底 4 → 备用池登录补入 min(3, 4) 个，候选只有 2
  assert.equal(view.last_result.uploaded, 1);
  assert.equal(ctx.uploads[0].ids.length, 1);
  assert.equal(view.last_result.replenished, 2);
  assert.equal(ctx.submitted.length, 2);
  assert.equal(ctx.submitted[0].type, 'login');
  assert.equal(view.last_result.stock_count, 0);
});

test('级联补号：sub2api 可用够（无缺口），主池库存低于保底仍从备用池登录补库存', async () => {
  const emails = ['a@test.local', 'b@test.local', 'c@test.local'];
  for (const email of emails) insertAccount(ctx.db, ctx.crypto, { email });
  insertAccount(ctx.db, ctx.crypto, { email: 'cand@test.local', pool: 'reserve', status: 'mail_ok' });
  const monitor = buildMonitor({
    threshold: 3,
    remoteAccounts: emails.map((email, i) => remoteAccount({ id: i + 1, email })),
  });

  const view = await monitor.runCheck();

  // 无缺口不上传，但库存 0 低于保底 3 → 备用池登录补入 min(3, 3) 个，候选只有 1
  assert.equal(view.last_result.available_count, 3);
  assert.equal(view.last_result.uploaded, 0);
  assert.equal(ctx.uploads.length, 0);
  assert.equal(view.last_result.replenished, 1);
  assert.equal(ctx.submitted.length, 1);
  assert.equal(view.last_result.stock_count, 0);
});

test('级联补号：远端已存在的主池号不重复上传', async () => {
  insertAccount(ctx.db, ctx.crypto, { email: 'ok@test.local' });
  // 远端已存在（短期限流中，保留主池）：不进上传候选
  insertAccount(ctx.db, ctx.crypto, { email: 'dupe@test.local', tokens: { refresh_token: "rt" } });
  const freshId = insertAccount(ctx.db, ctx.crypto, { email: 'fresh@test.local', tokens: { refresh_token: "rt" } });
  const monitor = buildMonitor({
    threshold: 2,
    remoteAccounts: [
      remoteAccount({ id: 1, email: 'ok@test.local' }),
      remoteAccount({
        id: 2,
        email: 'dupe@test.local',
        rateLimitedAt: new Date().toISOString(),
        resetAt: new Date(Date.now() + 3600_000).toISOString(),
      }),
    ],
  });

  const view = await monitor.runCheck();

  // 可用 1、缺口 1：只上传 fresh，dupe 在远端已存在被跳过；缺口补满后备用池不动
  assert.equal(view.last_result.uploaded, 1);
  assert.deepEqual(ctx.uploads[0].ids, [freshId]);
  assert.equal(view.last_result.replenished, 0);
});

// ---- 自动补号挑号顺序（replenish_upload_order / replenish_join_order） ----

test('补号上传顺序：默认余额小优先，可改为金额从大到小', async () => {
  for (const [email, balance] of [
    ['s5@test.local', 5],
    ['s60@test.local', 60],
    ['s12@test.local', 12],
  ]) {
    insertAccount(ctx.db, ctx.crypto, { email, balance, tokens: { refresh_token: 't' } });
  }
  const emailOf = (id) => ctx.db.prepare('SELECT email FROM accounts WHERE id=?').get(id).email;

  const asc = buildMonitor({ threshold: 3, remoteAccounts: [] });
  await asc.runCheck();
  assert.equal(ctx.uploads.length, 1);
  assert.deepEqual(ctx.uploads[0].ids.map(emailOf), ['s5@test.local', 's12@test.local', 's60@test.local']);

  ctx.uploads.length = 0;
  const desc = buildMonitor({ threshold: 3, remoteAccounts: [], monitorConfig: { replenish_upload_order: 'balance_desc' } });
  await desc.runCheck();
  assert.deepEqual(ctx.uploads[0].ids.map(emailOf), ['s60@test.local', 's12@test.local', 's5@test.local']);
});

test('补号登录顺序：replenish_join_order=time_desc 按加入时间新优先', async () => {
  const rows = [
    ['old@test.local', '2026-08-01T00:00:00.000Z'],
    ['mid@test.local', '2026-08-10T00:00:00.000Z'],
    ['new@test.local', '2026-08-19T00:00:00.000Z'],
  ];
  for (const [email] of rows) insertAccount(ctx.db, ctx.crypto, { email, pool: 'reserve', status: 'mail_ok' });
  const update = ctx.db.prepare('UPDATE accounts SET imported_at=? WHERE email=?');
  for (const [email, importedAt] of rows) update.run(importedAt, email);

  const monitor = buildMonitor({ threshold: 3, remoteAccounts: [], monitorConfig: { replenish_join_order: 'time_desc' } });
  await monitor.runCheck();

  assert.equal(ctx.submitted.length, 3);
  const emailOf = (id) => ctx.db.prepare('SELECT email FROM accounts WHERE id=?').get(id).email;
  assert.deepEqual(ctx.submitted.map((job) => emailOf(job.accountId)), [
    'new@test.local',
    'mid@test.local',
    'old@test.local',
  ]);
});

test('补号登录顺序：time_asc 按加入时间早优先', async () => {
  const rows = [
    ['old@test.local', '2026-08-01T00:00:00.000Z'],
    ['mid@test.local', '2026-08-10T00:00:00.000Z'],
    ['new@test.local', '2026-08-19T00:00:00.000Z'],
  ];
  for (const [email] of rows) insertAccount(ctx.db, ctx.crypto, { email, pool: 'reserve', status: 'mail_ok' });
  const update = ctx.db.prepare('UPDATE accounts SET imported_at=? WHERE email=?');
  for (const [email, importedAt] of rows) update.run(importedAt, email);

  const monitor = buildMonitor({ threshold: 3, remoteAccounts: [], monitorConfig: { replenish_join_order: 'time_asc' } });
  await monitor.runCheck();

  const emailOf = (id) => ctx.db.prepare('SELECT email FROM accounts WHERE id=?').get(id).email;
  assert.deepEqual(ctx.submitted.map((job) => emailOf(job.accountId)), [
    'old@test.local',
    'mid@test.local',
    'new@test.local',
  ]);
});

// ---- 主池库存保底拆分（main_stock_threshold） ----

test('主池库存保底未设置时沿用 sub2api 保底（旧行为兼容）', async () => {
  for (const email of ['r1@test.local', 'r2@test.local', 'r3@test.local']) {
    insertAccount(ctx.db, ctx.crypto, { email, pool: 'reserve', status: 'mail_ok' });
  }
  const monitor = buildMonitor({ threshold: 2, remoteAccounts: [] });

  const view = await monitor.runCheck();

  // 可用 0、库存 0：缺口 2 但无库存可上传 → 库存 0 < 保底 2（回退），只发起 2 个登录
  assert.equal(view.last_result.uploaded, 0);
  assert.equal(view.last_result.replenished, 2);
  assert.equal(ctx.submitted.length, 2);
});

test('主池库存保底 = 0：不从备用池自动补入', async () => {
  for (const email of ['r1@test.local', 'r2@test.local']) {
    insertAccount(ctx.db, ctx.crypto, { email, pool: 'reserve', status: 'mail_ok' });
  }
  const monitor = buildMonitor({ threshold: 5, remoteAccounts: [], monitorConfig: { main_stock_threshold: 0 } });

  const view = await monitor.runCheck();

  assert.equal(view.last_result.uploaded, 0);
  assert.equal(view.last_result.replenished, 0);
  assert.equal(ctx.submitted.length, 0);
});

test('主池库存保底低于 sub2api 保底：库存补完缺口后只按库存保底补', async () => {
  insertAccount(ctx.db, ctx.crypto, { email: 'ok@test.local' });
  for (const email of ['s1@test.local', 's2@test.local', 's3@test.local', 's4@test.local']) {
    insertAccount(ctx.db, ctx.crypto, { email, tokens: { refresh_token: 'rt' } });
  }
  for (const email of ['r1@test.local', 'r2@test.local', 'r3@test.local']) {
    insertAccount(ctx.db, ctx.crypto, { email, pool: 'reserve', status: 'mail_ok' });
  }
  const monitor = buildMonitor({
    threshold: 10,
    remoteAccounts: [remoteAccount({ id: 1, email: 'ok@test.local' })],
    monitorConfig: { main_stock_threshold: 2 },
  });

  const view = await monitor.runCheck();

  // 可用 1、缺口 9 → 库存 4 全部上传；剩余库存 0 < 保底 2 → 只补 2 个（共用阈值时会按缺口一直囤库存）
  assert.equal(view.last_result.uploaded, 4);
  assert.equal(view.last_result.replenished, 2);
  assert.equal(view.last_result.stock_count, 0);
  assert.equal(ctx.submitted.length, 2);
});

test('主池库存保底满足后不再囤库存（共用阈值时会继续补）', async () => {
  insertAccount(ctx.db, ctx.crypto, { email: 'ok@test.local' });
  for (const email of ['s1@test.local', 's2@test.local', 's3@test.local', 's4@test.local', 's5@test.local', 's6@test.local']) {
    insertAccount(ctx.db, ctx.crypto, { email, tokens: { refresh_token: 'rt' } });
  }
  for (const email of ['r1@test.local', 'r2@test.local']) {
    insertAccount(ctx.db, ctx.crypto, { email, pool: 'reserve', status: 'mail_ok' });
  }
  const monitor = buildMonitor({
    threshold: 5,
    remoteAccounts: [remoteAccount({ id: 1, email: 'ok@test.local' })],
    monitorConfig: { main_stock_threshold: 2 },
  });

  const view = await monitor.runCheck();

  // 可用 1、缺口 4 → 上传 4，剩余库存 2 ≥ 保底 2 → 不从备用池补（共用阈值时 2 < 5 会补 3 个）
  assert.equal(view.last_result.uploaded, 4);
  assert.equal(view.last_result.replenished, 0);
  assert.equal(ctx.submitted.length, 0);
});

// ---- resource 补号口径（总并发 + 初始总余额） ----

test('resource 口径：并发缺口触发库存上传，补齐即停', async () => {
  insertAccount(ctx.db, ctx.crypto, { email: 'ok@test.local' });
  const s1 = insertAccount(ctx.db, ctx.crypto, { email: 's1@test.local', tokens: { refresh_token: 'rt' } });
  const s2 = insertAccount(ctx.db, ctx.crypto, { email: 's2@test.local', tokens: { refresh_token: 'rt' } });
  insertAccount(ctx.db, ctx.crypto, { email: 's3@test.local', tokens: { refresh_token: 'rt' } });
  const monitor = buildMonitor({
    remoteAccounts: [remoteAccount({ id: 1, email: 'ok@test.local', concurrency: 4 })],
    monitorConfig: { replenish_mode: 'resource', concurrency_target: 10 },
    uploadDefaults: { concurrency: 3 },
  });

  const view = await monitor.runCheck();

  // 在架并发 4（远端记录优先），缺口 6，每号贡献 3（上传默认并发）→ 2 个补齐，第 3 个库存不动
  assert.equal(view.last_result.fleet_concurrency, 4);
  assert.equal(view.last_result.uploaded, 2);
  assert.deepEqual(ctx.uploads[0].ids, [s1, s2]);
  assert.equal(view.last_result.replenished, 0);
});

test('resource 口径：初始余额缺口触发（OR 语义），按初始余额贪心补齐', async () => {
  insertAccount(ctx.db, ctx.crypto, { email: 'ok@test.local', initialBalance: 10 });
  const s1 = insertAccount(ctx.db, ctx.crypto, { email: 's1@test.local', tokens: { refresh_token: 'rt' }, initialBalance: 8 });
  const s2 = insertAccount(ctx.db, ctx.crypto, { email: 's2@test.local', tokens: { refresh_token: 'rt' }, initialBalance: 8 });
  const s3 = insertAccount(ctx.db, ctx.crypto, { email: 's3@test.local', tokens: { refresh_token: 'rt' }, initialBalance: 8 });
  const monitor = buildMonitor({
    remoteAccounts: [remoteAccount({ id: 1, email: 'ok@test.local' })],
    monitorConfig: { replenish_mode: 'resource', initial_balance_target: 30 },
  });

  const view = await monitor.runCheck();

  // fleet 余额 10，缺 20：8×3=24 ≥ 20 → 恰好 3 个
  assert.equal(view.last_result.fleet_initial_balance, 10);
  assert.equal(view.last_result.uploaded, 3);
  assert.deepEqual(ctx.uploads[0].ids, [s1, s2, s3]);
});

test('resource 口径：达标不补；error 号不计入，初始余额缺失回退当前余额', async () => {
  // fleet 达标：在架 1 个（初始余额 40）→ 目标 30 无缺口，库存 0 也不上传（resource 口径不再看库存数量保底以外的数量）
  insertAccount(ctx.db, ctx.crypto, { email: 'rich@test.local', initialBalance: 40 });
  // error 号不计入统计；初始余额缺失回退 balance；均无记 0
  insertAccount(ctx.db, ctx.crypto, { email: 'err@test.local', initialBalance: 50 });
  insertAccount(ctx.db, ctx.crypto, { email: 'noinit@test.local', balance: 5 });
  insertAccount(ctx.db, ctx.crypto, { email: 'blank@test.local' });
  const monitor = buildMonitor({
    remoteAccounts: [
      remoteAccount({ id: 1, email: 'rich@test.local' }),
      remoteAccount({ id: 2, email: 'err@test.local', status: 'error' }),
      remoteAccount({ id: 3, email: 'noinit@test.local' }),
      remoteAccount({ id: 4, email: 'blank@test.local' }),
    ],
    monitorConfig: { replenish_mode: 'resource', initial_balance_target: 30 },
  });

  const view = await monitor.runCheck();

  // 计入 rich(40) + noinit(5→回退 balance) + blank(0) = 45 ≥ 30；err 的 50 不计入
  assert.equal(view.last_result.fleet_initial_balance, 45);
  assert.equal(view.last_result.available_count, 3);
  assert.equal(ctx.uploads.length, 0);
  assert.equal(view.last_result.uploaded, 0);
});

test('resource 口径：限流中的号计入统计（限流按现有逻辑恢复或废弃）', async () => {
  insertAccount(ctx.db, ctx.crypto, { email: 'limited@test.local', initialBalance: 20 });
  const monitor = buildMonitor({
    remoteAccounts: [
      remoteAccount({
        id: 1,
        email: 'limited@test.local',
        rateLimitedAt: new Date().toISOString(),
        resetAt: new Date(Date.now() + 3600_000).toISOString(),
      }),
    ],
    monitorConfig: { replenish_mode: 'resource', initial_balance_target: 10 },
  });

  const view = await monitor.runCheck();

  assert.equal(view.last_result.fleet_initial_balance, 20);
  assert.equal(view.last_result.uploaded, 0);
});

test('resource 口径：第二段只看主池库存数量保底，不要求库存资源镜像在架目标', async () => {
  insertAccount(ctx.db, ctx.crypto, { email: 'ok@test.local' });
  insertAccount(ctx.db, ctx.crypto, { email: 's1@test.local', tokens: { refresh_token: 'rt' } });
  insertAccount(ctx.db, ctx.crypto, { email: 's2@test.local', tokens: { refresh_token: 'rt' } });
  insertAccount(ctx.db, ctx.crypto, { email: 'r1@test.local', pool: 'reserve', status: 'mail_ok' });
  const monitor = buildMonitor({
    remoteAccounts: [remoteAccount({ id: 1, email: 'ok@test.local', concurrency: 4 })],
    monitorConfig: { replenish_mode: 'resource', concurrency_target: 10, main_stock_threshold: 1 },
    uploadDefaults: { concurrency: 3 },
  });

  const view = await monitor.runCheck();

  // 在架并发 4、缺口 6 → 库存 2 个各贡献 3 恰好补齐；剩余库存 0 < 保底 1 → 只补 1 个
  // （旧口径会比较库存资源与整套在架目标，0 < 10 固定补 3 个）
  assert.equal(view.last_result.uploaded, 2);
  assert.equal(view.last_result.replenished, 1);
  assert.equal(ctx.submitted.length, 1);
});

test('resource 口径：主池库存保底 = 0 → 缺口仍在也不从备用池补入', async () => {
  insertAccount(ctx.db, ctx.crypto, { email: 'ok@test.local' });
  insertAccount(ctx.db, ctx.crypto, { email: 's1@test.local', tokens: { refresh_token: 'rt' } });
  insertAccount(ctx.db, ctx.crypto, { email: 'r1@test.local', pool: 'reserve', status: 'mail_ok' });
  const monitor = buildMonitor({
    remoteAccounts: [remoteAccount({ id: 1, email: 'ok@test.local', concurrency: 4 })],
    monitorConfig: { replenish_mode: 'resource', concurrency_target: 10, main_stock_threshold: 0 },
    uploadDefaults: { concurrency: 3 },
  });

  const view = await monitor.runCheck();

  // 缺口 6 > 库存贡献 3：上传后缺口仍在，但库存保底 0 → 不再烧备用池
  assert.equal(view.last_result.uploaded, 1);
  assert.equal(view.last_result.replenished, 0);
  assert.equal(ctx.submitted.length, 0);
});

// ---- 巡检余额刷新节流 ----

test('巡检余额刷新：距上次查询不足间隔的号跳过，0=每轮都查', async () => {
  const freshId = insertAccount(ctx.db, ctx.crypto, { email: 'fresh@test.local', tokens: { refresh_token: 'rt' } });
  const staleId = insertAccount(ctx.db, ctx.crypto, { email: 'stale@test.local', tokens: { refresh_token: 'rt' } });
  ctx.db.prepare('UPDATE accounts SET balance_checked_at=? WHERE id=?').run(new Date().toISOString(), freshId);
  ctx.db.prepare('UPDATE accounts SET balance_checked_at=? WHERE id=?').run(
    new Date(Date.now() - 2 * 3600_000).toISOString(),
    staleId,
  );
  const monitor = buildMonitor({
    monitorConfig: { refresh_balance: true, balance_refresh_interval_minutes: 60 },
    remoteAccounts: [remoteAccount({ id: 1, email: 'fresh@test.local' }), remoteAccount({ id: 2, email: 'stale@test.local' })],
  });

  const view = await monitor.runCheck();

  assert.equal(view.last_result.balance_queued, 1);
  assert.equal(view.last_result.balance_skipped_fresh, 1);
  assert.deepEqual(ctx.submitted.map((job) => job.accountId), [staleId]);

  // 间隔 0 = 每轮都查（旧行为）
  ctx.submitted.length = 0;
  const everyRound = buildMonitor({
    monitorConfig: { refresh_balance: true, balance_refresh_interval_minutes: 0 },
    remoteAccounts: [remoteAccount({ id: 1, email: 'fresh@test.local' })],
  });
  const view2 = await everyRound.runCheck();
  assert.equal(view2.last_result.balance_queued, 1);
  assert.equal(view2.last_result.balance_skipped_fresh, 0);
});

test('收编号：远端 error 触发完整登录修复，远端健康零动作', async () => {
  const adoptedOk = insertAccount(ctx.db, ctx.crypto, { email: 'adopt-ok@test.local' });
  const adoptedErr = insertAccount(ctx.db, ctx.crypto, { email: 'adopt-err@test.local', credentials: { outlook: { refresh_token: 'rt' } } });
  ctx.db.prepare(`UPDATE accounts SET sub2api_account_id=901, adopted_remote=1 WHERE id=?`).run(adoptedOk);
  ctx.db.prepare(`UPDATE accounts SET sub2api_account_id=902, adopted_remote=1 WHERE id=?`).run(adoptedErr);
  const monitor = buildMonitor({
    autoRepair: true,
    remoteAccounts: [
      remoteAccount({ id: 901, email: 'adopt-ok@test.local' }),
      remoteAccount({ id: 902, email: 'adopt-err@test.local', status: 'error', errorMessage: 'Token revoked: invalidated oauth token' }),
    ],
  });

  const view = await monitor.runCheck();

  assert.equal(view.last_result.error_accounts, 1);
  assert.equal(view.last_result.repairing, 1);
  assert.equal(ctx.submitted.length, 1);
  assert.equal(ctx.submitted[0].type, 'login');
  assert.equal(ctx.submitted[0].accountId, adoptedErr);
});

test('远端同邮箱重复条目只跟踪一条（优先本地关联 ID），error 计数不虚高', async () => {
  const id = insertAccount(ctx.db, ctx.crypto, { email: 'dup@test.local', tokens: { refresh_token: 'rt' } });
  ctx.db.prepare(`UPDATE accounts SET sub2api_account_id=5 WHERE id=?`).run(id);
  const monitor = buildMonitor({
    remoteAccounts: [
      remoteAccount({ id: 9, email: 'dup@test.local' }),
      remoteAccount({ id: 5, email: 'dup@test.local' }),
    ],
  });

  const view = await monitor.runCheck();

  assert.equal(view.last_result.scanned, 1);
});

// ---- 修复结果回执（日志必须能回答「修好了还是修废了」）----

test('修复回执：401 发起修复，任务成功 → 同一行明细回执 ok', async () => {
  const id = insertAccount(ctx.db, ctx.crypto, { email: 'expired@test.local', tokens: { refresh_token: 'rt' } });
  const monitor = buildMonitor({
    autoRepair: true,
    remoteAccounts: [remoteAccount({ id: 1, email: 'expired@test.local', status: 'error' })],
  });

  await monitor.runCheck();
  const [item] = monitor.recentLogs(1)[0].items;
  assert.equal(item.action, 'repairing');
  assert.equal(item.outcome, null);

  monitor.noteRepairOutcome({ id: 'job-1', account_id: id, type: 'refresh' }, { ok: true });

  const [done] = monitor.recentLogs(1)[0].items;
  assert.equal(done.outcome, 'ok');
  assert.ok(done.outcome_at);
  assert.match(done.outcome_detail, /修复成功/);
});

test('修复回执：refresh 失败转登录 → followup（仍算在途），派生登录失败 → failed', async () => {
  const id = insertAccount(ctx.db, ctx.crypto, { email: 'expired@test.local', tokens: { refresh_token: 'rt' } });
  const monitor = buildMonitor({
    autoRepair: true,
    remoteAccounts: [remoteAccount({ id: 1, email: 'expired@test.local', status: 'error' })],
  });

  await monitor.runCheck();
  monitor.noteRepairOutcome(
    { id: 'job-1', account_id: id, type: 'refresh' },
    { ok: false, followUpJobId: 'job-2', message: 'REFRESH_TOKEN_INVALID' },
  );
  assert.equal(monitor.recentLogs(1)[0].items[0].outcome, 'followup');
  assert.match(monitor.recentLogs(1)[0].items[0].outcome_detail, /已自动转完整登录/);

  monitor.noteRepairOutcome({ id: 'job-2', account_id: id, type: 'login' }, { ok: false, message: 'MFA 403' });
  const [item] = monitor.recentLogs(1)[0].items;
  assert.equal(item.outcome, 'failed');
  assert.match(item.outcome_detail, /第 1\/2 次/);
  assert.match(item.outcome_detail, /MFA 403/);
});

test('修复回执：连败达上限 → parked（暂停保留待重授）', async () => {
  const id = insertAccount(ctx.db, ctx.crypto, { email: 'flaky@test.local', tokens: { refresh_token: 'rt' } });
  const monitor = buildMonitor({
    autoRepair: true,
    remoteAccounts: [remoteAccount({ id: 1, email: 'flaky@test.local', status: 'error' })],
  });

  await monitor.runCheck();
  ctx.db.prepare(`UPDATE accounts SET repair_fail_count=1 WHERE id=?`).run(id);
  monitor.noteRepairOutcome({ id: 'job-1', account_id: id, type: 'login' }, { ok: false });

  const [item] = monitor.recentLogs(1)[0].items;
  assert.equal(item.outcome, 'parked');
  assert.equal(ctx.db.prepare(`SELECT status FROM accounts WHERE id=?`).get(id).status, 'needs_reauth');
});

test('修复在途：同账号已有活跃任务 → 动作标为「修复任务在途」，不发新任务且计入状态量', async () => {
  const id = insertAccount(ctx.db, ctx.crypto, { email: 'busy@test.local', tokens: { refresh_token: 'rt' } });
  ctx.db.prepare(`UPDATE accounts SET status='authorizing', last_auto_repair_at=? WHERE id=?`).run(new Date().toISOString(), id);
  insertRunningJob(ctx.db, id);

  const monitor = buildMonitor({
    autoRepair: true,
    monitorConfig: { cooldown_minutes: 0 },
    remoteAccounts: [remoteAccount({ id: 1, email: 'busy@test.local', status: 'error' })],
  });

  const view = await monitor.runCheck();

  assert.equal(view.last_result.repairing, 0);
  assert.equal(view.last_result.repair_pending, 1);
  assert.equal(ctx.submitted.filter((job) => job.type !== 'balance').length, 0);
  const [item] = monitor.recentLogs(1)[0].items;
  assert.equal(item.action, 'repair_pending');
  assert.equal(item.reason, 'repair_in_flight');
  assert.match(item.detail, /修复任务在途（login/);
});

test('修复未发起的原因分类：冷却中 / 缺凭据 / 自动修复关闭', async () => {
  insertAccount(ctx.db, ctx.crypto, { email: 'cooling@test.local', tokens: { refresh_token: 'rt' } });
  const coolingId = ctx.db.prepare(`SELECT id FROM accounts WHERE email='cooling@test.local'`).get().id;
  ctx.db.prepare(`UPDATE accounts SET last_auto_repair_at=? WHERE id=?`).run(new Date().toISOString(), coolingId);
  insertAccount(ctx.db, ctx.crypto, { email: 'bare@test.local' });
  const monitor = buildMonitor({
    autoRepair: true,
    remoteAccounts: [
      remoteAccount({ id: 1, email: 'cooling@test.local', status: 'error' }),
      remoteAccount({ id: 2, email: 'bare@test.local', status: 'error' }),
    ],
  });

  await monitor.runCheck();
  const byEmail = new Map(monitor.recentLogs(1)[0].items.map((item) => [item.email, item]));
  assert.equal(byEmail.get('cooling@test.local').action, 'repair_cooldown');
  assert.equal(byEmail.get('bare@test.local').action, 'repair_no_credentials');

  const off = buildMonitor({
    autoRepair: false,
    remoteAccounts: [remoteAccount({ id: 1, email: 'cooling@test.local', status: 'error' })],
  });
  await off.runCheck();
  const [item] = off.recentLogs(1)[0].items;
  assert.equal(item.action, 'ignored');
  assert.equal(item.reason, 'auto_repair_off');
});

test('修复回执计数：上一轮之后落地的成败进入本轮动作量', async () => {
  const healed = insertAccount(ctx.db, ctx.crypto, { email: 'healed@test.local', tokens: { refresh_token: 'rt' } });
  const broken = insertAccount(ctx.db, ctx.crypto, { email: 'broken@test.local', tokens: { refresh_token: 'rt' } });
  const monitor = buildMonitor({
    autoRepair: true,
    monitorConfig: { cooldown_minutes: 0 },
    remoteAccounts: [
      remoteAccount({ id: 1, email: 'healed@test.local', status: 'error' }),
      remoteAccount({ id: 2, email: 'broken@test.local', status: 'error' }),
    ],
  });

  await monitor.runCheck();
  monitor.noteRepairOutcome({ id: 'job-1', account_id: healed, type: 'refresh' }, { ok: true });
  monitor.noteRepairOutcome({ id: 'job-2', account_id: broken, type: 'login' }, { ok: false, message: 'boom' });

  const view = await monitor.runCheck();

  assert.equal(view.last_result.repair_ok, 1);
  assert.equal(view.last_result.repair_failed, 1);
  assert.equal(view.last_result.repair_parked, 0);
});

// ---- 废弃计数求真 ----

test('废弃失败不再谎报「已废弃」：状态冲突单独记 discard_failed', async () => {
  insertAccount(ctx.db, ctx.crypto, {
    email: 'limited@test.local',
    tokens: { refresh_token: 'rt' },
  });
  const monitor = buildMonitor({
    failDiscard: true,
    remoteAccounts: [
      remoteAccount({
        id: 1,
        email: 'limited@test.local',
        rateLimitedAt: new Date().toISOString(),
        resetAt: new Date(Date.now() + 30 * 24 * 3600_000).toISOString(),
      }),
    ],
  });

  const view = await monitor.runCheck();

  assert.equal(view.last_result.rate_limited, 1);
  assert.equal(view.last_result.discarded, 0);
  assert.equal(view.last_result.discard_failed, 1);
  const [item] = monitor.recentLogs(1)[0].items;
  assert.equal(item.action, 'discard_failed');
  assert.match(item.detail, /废弃失败/);
  const account = ctx.db.prepare(`SELECT pool FROM accounts WHERE email='limited@test.local'`).get();
  assert.equal(account.pool, 'main');
});

