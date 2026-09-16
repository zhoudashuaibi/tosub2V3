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
  for (const sub of ['logs', 'results']) fs.mkdirSync(path.join(dataDir, sub), { recursive: true });
  const db = openDatabase(dataDir, { logger });
  const crypto = createCrypto({ dataDir, secretKeyEnv: 'test-secret', logger });
  const settings = createSettingsService(db, crypto, { logger });
  settings.ensureDefaults();
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

function useMockLogin(dataDir, events) {
  process.env.TOSUB2_REDEEM_SCRIPT = path.resolve('test/mock-login-child.mjs');
  process.env.TOSUB2_MOCK_RESULT_PATH = '1';
  process.env.TOSUB2_MOCK_SCRIPT = writeScript(dataDir, events);
}

function clearMockLogin() {
  delete process.env.TOSUB2_REDEEM_SCRIPT;
  delete process.env.TOSUB2_MOCK_SCRIPT;
  delete process.env.TOSUB2_MOCK_RESULT_PATH;
  delete process.env.TOSUB2_MOCK_EMAIL;
}

function createAccount(db, { email = 'mock@test.local' } = {}) {
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

test('引擎全链路：login 任务（redeem401）→ completed → 移入主号池 + tokens 入库', async () => {
  const { dataDir, db, crypto, config, pools } = setup();
  useMockLogin(dataDir, [
    { type: 'stage', stage: 'web_login' },
    { type: 'log', message: '正在网页登录' },
    { type: 'stage', stage: 'email_otp' },
    { type: 'stage', stage: 'finalizing' },
  ]);
  try {
    const resultPath = path.join(dataDir, 'results', 'will-be-set-by-event.json');
    // mock 按 result_saved 事件携带的 path 写产物
    const scriptPath = process.env.TOSUB2_MOCK_SCRIPT;
    const script = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
    script.events.push({ type: 'result_saved', path: resultPath, account: { email: 'mock@test.local' } });
    fs.writeFileSync(scriptPath, JSON.stringify(script));

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

    await waitFor(db, job.id, 'completed');
    const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id);
    assert.equal(row.stage, 'finalizing');

    // 账号移入主号池 + tokens 密文入库
    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
    assert.equal(account.pool, 'main');
    assert.equal(account.status, 'active');
    const tokens = crypto.tryDecryptJson(account.tokens_enc, 'accounts.tokens_enc');
    assert.equal(tokens.access_token, 'mock-access-token');
    assert.equal(tokens.refresh_token, 'mock-refresh-token');

    // 日志文件已落盘且标注 redeem401
    const logText = fs.readFileSync(path.resolve(dataDir, row.log_path), 'utf8');
    assert.match(logText, /provider=redeem401/);

    await engine.shutdown();
  } finally {
    clearMockLogin();
    db.close();
    cleanupDir(dataDir);
  }
});

test('失败路径：error 事件 → failed + 账号回滚 joining', async () => {
  const { dataDir, db, config, pools } = setup();
  useMockLogin(dataDir, [
    { type: 'stage', stage: 'web_login' },
    { type: 'error', code: 'REDEEM401_FAILED', message: '账号已停用或删除 (account_deactivated)', fatal: true },
  ]);
  try {
    const engine = createJobsEngine({ config, db, logger });
    engine.hooks.onLoginFinished = (job, account, { ok, canceled }) => {
      if (!ok && canceled) return;
      if (!ok) pools.joinFailed(job.account_id, { error: '登录失败' });
    };

    const accountId = createAccount(db, { email: 'fail@test.local' });
    process.env.TOSUB2_MOCK_EMAIL = 'fail@test.local';
    engine.start();
    const job = engine.submitJob({ accountId, type: 'login' });
    const row = await waitFor(db, job.id, 'failed');

    // 封禁类失败被识别为永久失败：错误带前缀，账号标记 auto_repair_blocked
    assert.match(row.error, /【账号已停用\/封禁】/);
    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
    assert.equal(account.auto_repair_blocked, 1);

    await engine.shutdown();
  } finally {
    clearMockLogin();
    db.close();
    cleanupDir(dataDir);
  }
});

test('取消进行中任务 → canceled', async () => {
  const { dataDir, db, config } = setup();
  useMockLogin(dataDir, [{ type: '__sleep', ms: 15000 }]);
  try {
    const engine = createJobsEngine({ config, db, logger });
    const accountId = createAccount(db);
    engine.start();
    const job = engine.submitJob({ accountId, type: 'login' });
    await waitFor(db, job.id, 'running', 8000);
    const canceled = await engine.cancel(job.id);
    assert.equal(canceled.status, 'canceled');
    await engine.shutdown();
  } finally {
    clearMockLogin();
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

test('strict_proxy 开启：无可用代理时余额任务失败并记录 balance_error（login 不受影响）', async () => {
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
