/**
 * 取消任务与账号状态的联动：
 *
 * 背景（线上事故）：用户在备用池「加入主号池」批量提交了 36 个号，随后点「取消全部」。
 * 引擎并发上限只放行了 10 个，剩下 26 个还停在 queued。取消时
 *  - 跑起来的号：cancelInternal 有 runtime → 回调触发 → joining 回滚 mail_failed ✅
 *  - 纯排队的号：running.get() 是 undefined → 回调压根没触发 → 永远停在 joining ❌
 * 表现就是「任务全取消了，备用池还全是加入中」，且「加入主号池」按钮被永久禁用。
 *
 * 另一个连带坑：对失败任务点「重试」时，casAccountStatus 无条件写主池语义的 authorizing，
 * 把备用号写成备用池不存在的状态，取消回滚（只匹配 joining）再也救不回来。
 */
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tosub2-cancel-'));
  for (const sub of ['logs', 'results', 'checkpoints']) fs.mkdirSync(path.join(dataDir, sub), { recursive: true });
  const db = openDatabase(dataDir, { logger });
  const crypto = createCrypto({ dataDir, secretKeyEnv: 'test-secret', logger });
  const settings = createSettingsService(db, crypto, { logger });
  settings.ensureDefaults();
  // 本文件测本地协议登录的取消回滚；redeem401 路径由 redeem401-engine.test.js 覆盖
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
  return { dataDir, db, settings, config, pools };
}

/** 与 server/modules/accounts/index.js 的 engine.hooks.onLoginFinished 保持同一口径。 */
function attachAccountHooks(engine, { db, pools }) {
  engine.hooks.onLoginFinished = (job, account, { ok, code, message, canceled }) => {
    if (!job?.account_id) return;
    if (canceled) {
      const current = account || db.prepare('SELECT * FROM accounts WHERE id = ?').get(job.account_id);
      if (!current) return;
      const now = new Date().toISOString();
      if (current.pool === 'reserve') {
        db.prepare(
          `UPDATE accounts SET status='mail_failed', mail_error='任务已取消', updated_at=?
           WHERE id=? AND pool='reserve' AND status IN ('joining','authorizing')`,
        ).run(now, job.account_id);
      } else if (current.pool === 'main') {
        db.prepare(
          `UPDATE accounts SET status='needs_reauth', updated_at=? WHERE id=? AND pool='main' AND status='authorizing'`,
        ).run(now, job.account_id);
      }
      pools.recordEvent(job.account_id, 'join_canceled', { job_id: job.id, reason: String(message || '') });
      return;
    }
    if (ok) return;
    pools.joinFailed(job.account_id, {
      error: message || code || '登录失败',
      jobId: job.id,
      permanent: /login_failed_permanent/.test(code || ''),
    });
  };
}

function createReserveAccount(db, email, status = 'joining') {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO accounts(email, pool, status, mail_status, imported_at, created_at, updated_at)
       VALUES(?, 'reserve', ?, 'ok', ?, ?, ?)`,
    )
    .run(email, status, now, now, now);
  return Number(result.lastInsertRowid);
}

function mockSleepingJob(dataDir, ms = 30000) {
  process.env.TOSUB2_REDEEM_SCRIPT = path.resolve('test/mock-login-child.mjs');
  const scriptPath = path.join(dataDir, `script-sleep-${Date.now()}.json`);
  fs.writeFileSync(scriptPath, JSON.stringify({ events: [{ type: '__sleep', ms }] }));
  process.env.TOSUB2_MOCK_SCRIPT = scriptPath;
  return scriptPath;
}

function cleanup({ db, dataDir }) {
  delete process.env.TOSUB2_REDEEM_SCRIPT;
  delete process.env.TOSUB2_MOCK_SCRIPT;
  db.close();
  for (let i = 0; i < 10; i += 1) {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
      return;
    } catch {
      try {
        fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        return;
      } catch {}
    }
  }
}

test('取消全部：排队中未启动的 login 任务也要把账号 joining 回滚为 mail_failed', async () => {
  const ctx = setup();
  const { db, config, pools } = ctx;
  mockSleepingJob(ctx.dataDir);
  try {
    // 并发上限 1：保证只有 1 个任务真正起进程，其余留在 queued
    ctx.settings.set('engine.config', {
      ...ctx.settings.get('engine.config'),
      strict_proxy: false,
      max_concurrent_jobs: 1,
    });
    const engine = createJobsEngine({ config, db, logger });
    attachAccountHooks(engine, { db, pools });

    const ids = ['a', 'b', 'c', 'd', 'e'].map((n) => createReserveAccount(db, `cancel-${n}@test.local`));
    engine.start();
    for (const accountId of ids) engine.submitJob({ accountId, type: 'login', note: 'join-main' });

    // 等第一个真正跑起来
    for (let i = 0; i < 60; i += 1) {
      if (db.prepare(`SELECT COUNT(*) n FROM jobs WHERE status='running'`).get().n >= 1) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const queuedBefore = db.prepare(`SELECT COUNT(*) n FROM jobs WHERE status='queued'`).get().n;
    assert.equal(queuedBefore, 4, '并发上限 1 时应剩 4 个任务在排队');

    const canceled = await engine.cancelAll();
    assert.equal(canceled, ids.length);

    const rows = db.prepare(`SELECT id, status, mail_error FROM accounts ORDER BY id`).all();
    const stuck = rows.filter((row) => row.status === 'joining');
    assert.deepEqual(
      stuck,
      [],
      `任务已取消但账号仍停在 joining：${JSON.stringify(stuck)}（排队中的任务没有 runtime，必须回查账号）`,
    );
    for (const row of rows) {
      assert.equal(row.status, 'mail_failed');
      assert.equal(row.mail_error, '任务已取消');
    }
    // 取消事件落库，便于事后审计
    const events = db
      .prepare(`SELECT COUNT(*) n FROM account_events WHERE type='join_canceled'`)
      .get().n;
    assert.equal(events, ids.length);

    await engine.shutdown();
  } finally {
    cleanup(ctx);
  }
});

test('登录任务不会把备用池账号写成主池的 authorizing', async () => {
  const ctx = setup();
  const { db, config, pools } = ctx;
  try {
    const engine = createJobsEngine({ config, db, logger });
    attachAccountHooks(engine, { db, pools });

    const accountId = createReserveAccount(db, 'reserve-authorizing@test.local');
    // 提交任务本身不应改账号状态（加入流程由调用方 CAS 成 joining）
    engine.submitJob({ accountId, type: 'login' });
    assert.equal(
      db.prepare('SELECT status FROM accounts WHERE id = ?').get(accountId).status,
      'joining',
      'submitJob 不该把备用号写成 authorizing',
    );

    const canceledJob = db.prepare(`SELECT * FROM jobs WHERE account_id = ?`).get(accountId);
    await engine.cancel(canceledJob.id, '用户取消');
    // 重试前账号先按加入流程 CAS 回 joining（生产由 join-main / 自动补号负责）
    db.prepare(`UPDATE accounts SET status='joining', updated_at=? WHERE id=?`).run(
      new Date().toISOString(),
      accountId,
    );
    const retried = engine.retry(canceledJob.id);
    assert.equal(
      db.prepare('SELECT status FROM accounts WHERE id = ?').get(accountId).status,
      'joining',
      'retry 不该把备用号写成 authorizing',
    );

    await engine.cancel(retried.id, '用户取消');
    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
    assert.equal(account.status, 'mail_failed', '取消后备用号必须回到 mail_failed');
    assert.equal(account.mail_error, '任务已取消');

    await engine.shutdown();
  } finally {
    cleanup(ctx);
  }
});
