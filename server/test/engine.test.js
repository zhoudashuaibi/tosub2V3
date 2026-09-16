import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../lib/db.js';
import { createCrypto } from '../lib/crypto.js';
import { createSettingsService } from '../lib/settings.js';
import { createLogger } from '../lib/logger.js';
import { createJobsEngine } from '../modules/jobs/engine.js';
import { createPools } from '../modules/accounts/pools.js';

const logger = createLogger('silent');

function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tosub2-engine-'));
  for (const sub of ['logs', 'results', 'checkpoints']) fs.mkdirSync(path.join(dataDir, sub), { recursive: true });
  const db = openDatabase(dataDir, { logger });
  const crypto = createCrypto({ dataDir, secretKeyEnv: 'test-secret', logger });
  const settings = createSettingsService(db, crypto, { logger });
  settings.ensureDefaults();
  // 引擎流程测试沿用无代理直连；strict_proxy 拦截行为由专门用例覆盖
  settings.set('engine.config', { ...settings.get('engine.config'), strict_proxy: false });
  // 本文件测本地协议登录流程；redeem401 远程登录路径由 redeem401-engine.test.js 覆盖
  settings.set('login.provider', { ...settings.get('login.provider'), mode: 'protocol' });
  const config = {
    dataDir,
    serverRoot: path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..'),
    settingsGet: (k) => settings.get(k),
    cryptoTryDecryptJson: (e, f) => crypto.tryDecryptJson(e, f),
    cryptoEncryptJson: (v, f) => crypto.encryptJson(v, f),
    pickProxy: () => ({ id: null, url: null }),
    recordProxyFailure: () => {},
  };
  const pools = createPools(db, crypto);
  return { dataDir, db, crypto, settings, config, pools };
}

function writeScript(dataDir, events) {
  const scriptPath = path.join(dataDir, `script-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(scriptPath, JSON.stringify({ events }));
  return scriptPath;
}

function createAccount(db, { email = 'mock@test.local', credentials = null } = {}) {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO accounts(email, pool, status, mail_status, imported_at, created_at, updated_at)
       VALUES(?, 'reserve', 'joining', 'ok', ?, ?, ?)`,
    )
    .run(email, now, now, now);
  return Number(result.lastInsertRowid);
}

async function waitFor(db, jobId, status, timeoutMs = 20000) {
  const started = Date.now();
  for (;;) {
    const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
    if (row?.status === status) return row;
    if (Date.now() - started > timeoutMs) throw new Error(`job ${jobId} 未在 ${timeoutMs}ms 内进入 ${status}，当前 ${row?.status} / ${row?.error}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

test('引擎全链路：login 任务 → 人工输入（错→对）→ completed → 移入主号池 + tokens 入库', async () => {
  const { dataDir, db, crypto, config, pools } = setup();
  process.env.TOSUB2_PROTOCOL_SCRIPT = path.resolve('test/mock-protocol-login.mjs');
  process.env.TOSUB2_MOCK_RESULT_PATH = '1';
  try {
    const resultPath = path.join(dataDir, 'results', 'will-be-set-by-event.json');
    const scriptPath = writeScript(dataDir, [
      { type: 'stage', stage: 'web_login' },
      { type: 'stage', stage: 'email_otp' },
      { type: 'input_required', kind: 'email_otp', detail: '请输入验证码', can_resend: true, expect: '123456', path: resultPath },
      { type: 'stage', stage: 'oauth' },
      { type: 'result_saved', path: resultPath, account: { email: 'mock@test.local' } },
    ]);
    process.env.TOSUB2_MOCK_SCRIPT = scriptPath;

    const engine = createJobsEngine({ config, db, logger });
    // accounts 模块的引擎回调（与生产装配一致）
    engine.hooks.onTokensSaved = (job, runtime, tokens) => {
      pools.joinSucceeded(job.account_id, {
        tokensEnc: config.cryptoEncryptJson(tokens, 'accounts.tokens_enc'),
        balance: null,
        balanceCheckedAt: null,
      });
    };
    engine.hooks.onLoginFinished = (job, account, { ok, canceled }) => {
      if (!ok && canceled) return;
      if (!ok) pools.joinFailed(job.account_id, { error: '登录失败' });
    };

    const accountId = createAccount(db);
    engine.start();
    const job = engine.submitJob({ accountId, type: 'login' });

    // 无自动输入源 → awaiting_input
    await waitFor(db, job.id, 'awaiting_input');
    let row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id);
    assert.equal(row.prompt_kind, 'email_otp');

    // 输错一次 → mock 重新要求输入（仍 awaiting_input）
    await engine.submitInput(job.id, 'input', '999999');
    await new Promise((r) => setTimeout(r, 600));
    row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id);
    assert.equal(row.status, 'awaiting_input', '输错后应回到待输入');

    // 输对 → completed
    await engine.submitInput(job.id, 'input', '123456');
    await waitFor(db, job.id, 'completed');

    // 账号移入主号池 + tokens 密文入库
    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
    assert.equal(account.pool, 'main');
    assert.equal(account.status, 'active');
    const tokens = crypto.tryDecryptJson(account.tokens_enc, 'accounts.tokens_enc');
    assert.equal(tokens.access_token, 'mock-access-token');
    assert.equal(tokens.refresh_token, 'mock-refresh-token');

    // 日志文件已落盘
    assert.ok(fs.existsSync(path.resolve(dataDir, row.log_path)));

    await engine.shutdown();
  } finally {
    delete process.env.TOSUB2_PROTOCOL_SCRIPT;
    delete process.env.TOSUB2_MOCK_SCRIPT;
    delete process.env.TOSUB2_MOCK_RESULT_PATH;
    db.close();
    cleanupDir(dataDir);
  }
});

test('取消进行中任务 → canceled', async () => {
  const { dataDir, db, config } = setup();
  process.env.TOSUB2_PROTOCOL_SCRIPT = path.resolve('test/mock-protocol-login.mjs');
  try {
    const scriptPath = writeScript(dataDir, [{ type: '__sleep', ms: 15000 }]);
    process.env.TOSUB2_MOCK_SCRIPT = scriptPath;
    const engine = createJobsEngine({ config, db, logger });
    const accountId = createAccount(db);
    engine.start();
    const job = engine.submitJob({ accountId, type: 'login' });
    await waitFor(db, job.id, 'running', 8000);
    const canceled = await engine.cancel(job.id);
    assert.equal(canceled.status, 'canceled');
    await engine.shutdown();
  } finally {
    delete process.env.TOSUB2_PROTOCOL_SCRIPT;
    delete process.env.TOSUB2_MOCK_SCRIPT;
    db.close();
    cleanupDir(dataDir);
  }
});

test('重启恢复：running 任务回 queued（attempt 保留）', async () => {
  const { dataDir, db, config } = setup();
  try {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO jobs(id, account_id, type, status, attempt, proxy_attempts, log_path, created_at, updated_at, started_at)
       VALUES('job-x', NULL, 'login', 'running', 3, 2, 'logs/job-x.log', ?, ?, ?)`,
    ).run(now, now, now);
    const engine = createJobsEngine({ config, db, logger });
    engine.recoverInterrupted();
    const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get('job-x');
    assert.equal(row.status, 'queued');
    assert.equal(row.attempt, 3);
    assert.match(row.error, /重新排队/);
  } finally {
    db.close();
    cleanupDir(dataDir);
  }
});

test('strict_proxy 开启：无可用代理时登录任务不 spawn 直接失败', async () => {
  const { dataDir, db, config, settings, pools } = setup();
  settings.set('engine.config', { ...settings.get('engine.config'), strict_proxy: true });
  try {
    const engine = createJobsEngine({ config, db, logger });
    const finished = [];
    engine.hooks.onLoginFinished = (job, account, payload) => {
      finished.push(payload);
      if (!payload.ok) pools.joinFailed(job.account_id, { error: payload.message });
    };

    const accountId = createAccount(db);
    engine.start();
    const job = engine.submitJob({ accountId, type: 'login' });
    const row = await waitFor(db, job.id, 'failed', 5000);

    assert.match(row.error, /无可用代理/);
    assert.ok(row.finished_at, '任务应有完成时间');
    assert.equal(finished.length, 1);
    assert.equal(finished[0].ok, false);
    assert.equal(finished[0].code, 'NO_ALIVE_PROXY');
    // 账号状态机按登录失败流转（reserve joining → mail_failed）
    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
    assert.equal(account.status, 'mail_failed');

    await engine.shutdown();
  } finally {
    db.close();
    cleanupDir(dataDir);
  }
});

test('strict_proxy 开启：无可用代理时余额任务失败并记录 balance_error', async () => {
  const { dataDir, db, crypto, config, settings } = setup();
  settings.set('engine.config', { ...settings.get('engine.config'), strict_proxy: true });
  try {
    const accountId = createAccount(db, { email: 'balance@test.local' });
    db.prepare('UPDATE accounts SET tokens_enc = ? WHERE id = ?').run(
      crypto.encryptJson(
        { access_token: 'at', refresh_token: 'rt', client_id: 'cid' },
        'accounts.tokens_enc',
      ),
      accountId,
    );
    const engine = createJobsEngine({ config, db, logger });
    engine.start();
    const job = engine.submitJob({ accountId, type: 'balance' });
    const row = await waitFor(db, job.id, 'failed', 5000);

    assert.match(row.error, /无可用代理/);
    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
    assert.match(account.balance_error, /无可用代理/);

    await engine.shutdown();
  } finally {
    db.close();
    cleanupDir(dataDir);
  }
});

// Windows 下日志流句柄延迟释放，清理失败不影响断言结果
function cleanupDir(dataDir) {
  for (let i = 0; i < 10; i += 1) {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
      return;
    } catch {
      try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); return; } catch {}
    }
  }
}
