import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { openDatabase } from '../lib/db.js';
import { createCrypto } from '../lib/crypto.js';
import { createSettingsService } from '../lib/settings.js';
import { createLogger } from '../lib/logger.js';
import { createJobsEngine } from '../modules/jobs/engine.js';
import { createPools } from '../modules/accounts/pools.js';

const logger = createLogger('silent');
const EMAIL = 'engine-redeem@test.local';

function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tosub2-redeem-engine-'));
  for (const sub of ['logs', 'results', 'checkpoints']) fs.mkdirSync(path.join(dataDir, sub), { recursive: true });
  const db = openDatabase(dataDir, { logger });
  const crypto = createCrypto({ dataDir, secretKeyEnv: 'test-secret', logger });
  const settings = createSettingsService(db, crypto, { logger });
  settings.ensureDefaults();
  // 特意开启 strict_proxy：redeem401 远程登录不占本机出口，必须不受该拦截影响
  settings.set('engine.config', { ...settings.get('engine.config'), strict_proxy: true });
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

function createAccount(db, email = EMAIL) {
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

function sub2apiExport(email) {
  return {
    type: 'sub2api-data',
    version: 1,
    exported_at: new Date().toISOString(),
    proxies: [],
    accounts: [
      {
        name: email,
        platform: 'openai',
        type: 'oauth',
        credentials: {
          access_token: 'redeem-access-token',
          refresh_token: 'redeem-refresh-token',
          client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
          email,
          chatgpt_account_id: '29ec7371-5719-439c-bca0-ecf599919ce7',
          chatgpt_user_id: 'user-test',
        },
        extra: { email, name: email, chatgpt_user_id: 'user-test', client_id: 'app_EMoamEEZ73f0CkXaXp7hrann', source: 'chatgpt_web_session' },
      },
    ],
  };
}

/** 内存打一个单成员 deflate ZIP（与真实 export 归档同构）。 */
function buildZip(name, content) {
  const nameBuf = Buffer.from(name, 'utf8');
  const data = Buffer.from(JSON.stringify(content), 'utf8');
  const compressed = zlib.deflateRawSync(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  const localBytes = 30 + nameBuf.length + compressed.length;
  central.writeUInt32LE(0, 42); // 本地头偏移 0
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(localBytes, 16);
  return Buffer.concat([local, nameBuf, compressed, central, nameBuf, eocd]);
}

function createRedeemMock({ email }) {
  let polls = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const json = (payload) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (req.method === 'POST' && url.pathname === '/401processing/api/run') {
      req.resume();
      req.on('end', () => json({ ok: true, state: { running: true } }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/401processing/api/status') {
      polls += 1;
      if (polls === 1) json({ running: true, tracks: [{ email, phase: 'login', detail: '正在网页登录' }], totals: { queue: 1 } });
      else json({
        running: false,
        tracks: [{ email, phase: 'ok', detail: '可导出 CPA / sub2' }],
        history: [{ email, state: 'ok', detail: '可导出 CPA / sub2' }],
        exportable: { count: 1, emails: [email] },
        totals: { queue: 0 },
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/401processing/api/export') {
      req.resume();
      req.on('end', () => json({
        ok: true,
        format: 'sub2api',
        archive: { filename: 'sub2api.zip', contentBase64: buildZip('sub2api_accounts_2026-09-16.json', sub2apiExport(email)).toString('base64'), fileCount: 1 },
      }));
      return;
    }
    res.writeHead(404);
    res.end('{}');
  });
  const ready = new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
  return { server, ready };
}

function cleanupDir(dataDir) {
  try {
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {}
}

test('redeem401 引擎全链路：strict_proxy 开启仍可登录 → completed → tokens 入库 + 移入主号池', async () => {
  const { dataDir, db, crypto, settings, config, pools } = setup();
  // 子进程轮询间隔经 process.env 继承注入（launcher 展开整个 process.env）
  process.env.REDEEM401_POLL_INTERVAL_MS = '50';
  const mock = createRedeemMock({ email: EMAIL });
  const baseUrl = await mock.ready;
  settings.set('login.provider', { ...settings.get('login.provider'), redeem401_base_url: baseUrl });
  try {
    const engine = createJobsEngine({ config, db, logger });
    engine.hooks.onTokensSaved = (job, runtime, tokens) => {
      pools.joinSucceeded(job.account_id, {
        tokensEnc: config.cryptoEncryptJson(tokens, 'accounts.tokens_enc'),
        balance: null,
        balanceCheckedAt: null,
      });
    };
    engine.hooks.onLoginFinished = (job, account, { ok, canceled }) => {
      if (!ok && !canceled) pools.joinFailed(job.account_id, { error: '登录失败' });
    };

    const accountId = createAccount(db);
    engine.start();
    const job = engine.submitJob({ accountId, type: 'login' });
    const row = await waitFor(db, job.id, 'completed');

    // 产物落盘 + 账号级导出文件 + tokens 密文入库
    const resultData = JSON.parse(fs.readFileSync(path.resolve(dataDir, row.result_path), 'utf8'));
    assert.equal(resultData.accounts[0].credentials.access_token, 'redeem-access-token');
    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
    assert.equal(account.pool, 'main');
    assert.equal(account.status, 'active');
    const tokens = crypto.tryDecryptJson(account.tokens_enc, 'accounts.tokens_enc');
    assert.equal(tokens.access_token, 'redeem-access-token');
    assert.equal(tokens.refresh_token, 'redeem-refresh-token');
    assert.ok(fs.existsSync(path.resolve(dataDir, 'results', `account-${accountId}.json`)), '账号级导出文件应维护');

    // 任务日志标注远程登录来源
    const logText = fs.readFileSync(path.resolve(dataDir, row.log_path), 'utf8');
    assert.match(logText, /provider=redeem401/);
    assert.match(logText, /redeem401 remote login/);

    await engine.shutdown();
  } finally {
    delete process.env.REDEEM401_POLL_INTERVAL_MS;
    mock.server.close();
    db.close();
    cleanupDir(dataDir);
  }
});

test('mode=protocol 时登录任务不受 redeem 开关影响：无代理 + strict_proxy → NO_ALIVE_PROXY', async () => {
  const { dataDir, db, settings, config } = setup();
  settings.set('login.provider', { ...settings.get('login.provider'), mode: 'protocol' });
  try {
    const engine = createJobsEngine({ config, db, logger });
    const accountId = createAccount(db);
    engine.start();
    const job = engine.submitJob({ accountId, type: 'login' });
    const row = await waitFor(db, job.id, 'failed', 5000);
    assert.match(row.error, /无可用代理/);
    await engine.shutdown();
  } finally {
    db.close();
    cleanupDir(dataDir);
  }
});
