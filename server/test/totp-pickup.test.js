import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseTwofaLines, parsePasswordFileText, credentialsForImport } from '../modules/accounts/import.js';
import {
  resolveTotpPickupUrl,
  extractTotpCodeFromText,
  msUntilNextTotpWindow,
  fetchTotpCodeFromPickupUrl,
} from '../lib/totp-pickup.js';
import { openDatabase } from '../lib/db.js';
import { createCrypto } from '../lib/crypto.js';
import { createSettingsService } from '../lib/settings.js';
import { createLogger } from '../lib/logger.js';
import { createJobsEngine } from '../modules/jobs/engine.js';
import { createPools } from '../modules/accounts/pools.js';

const UUID = '9e5f94bc-e8a4-4e73-b8be-63364c29d753';
const RT = 'M.C509_BL2.' + 'x'.repeat(120);
const CODE = 'CBCLDAV22HRBZUDELLKNRPK4L3YJ25IQ';

test('2FA 行解析：合法行带取件码', () => {
  const [entry] = parseTwofaLines(`a@b.com----${CODE}`);
  assert.equal(entry.ok, true);
  assert.equal(entry.email, 'a@b.com');
  assert.equal(entry.pickupCode, CODE);
});

test('2FA 行解析：邮箱大写归一、非法行逐条报错', () => {
  const results = parseTwofaLines(
    ['A@B.com----' + CODE, 'bad-email----' + CODE, 'c@d.com----short', 'e@f.com----a----b', '# 注释', ''].join('\n'),
  );
  assert.equal(results.length, 4);
  assert.equal(results[0].ok, true);
  assert.equal(results[0].email, 'a@b.com');
  assert.equal(results[1].ok, false);
  assert.match(results[1].reason, /邮箱/);
  assert.equal(results[2].ok, false);
  assert.match(results[2].reason, /取件码/);
  assert.equal(results[3].ok, false);
  assert.match(results[3].reason, /格式/);
});

test('2FA 行解析：批内重复只保留首行', () => {
  const results = parseTwofaLines(`a@b.com----${CODE}\na@b.com----OTHERCODE1234`);
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, false);
  assert.equal(results[1].duplicateInBatch, true);
});

test('credentialsForImport 携带/省略 totp_pickup_code', () => {
  const withCode = credentialsForImport({ password: 'p', clientId: UUID, refreshToken: RT, pickupCode: CODE });
  assert.equal(withCode.totp_pickup_code, CODE);
  assert.equal(withCode.outlook.refresh_token, RT);
  const without = credentialsForImport({ password: 'p', clientId: UUID, refreshToken: RT });
  assert.equal('totp_pickup_code' in without, false);
});

test('密码文件解析：ChatGPT 导出 JSON 取 meta.label 第 3 段', () => {
  const json = JSON.stringify([
    { meta: { label: 'a@b.com----9-gFQ_xxxx----P@ss1!' } },
    { meta: { label: 'only@email.com' } }, // 无密码条目跳过
    { meta: { label: 'c@d.com----tok----#OP1Iy$kP#!W' } },
  ]);
  const result = parsePasswordFileText(json);
  assert.equal(result.ok, true);
  assert.equal(result.passwords.size, 2);
  assert.equal(result.passwords.get('a@b.com'), 'P@ss1!');
  assert.equal(result.passwords.get('c@d.com'), '#OP1Iy$kP#!W');
});

test('密码文件解析：行格式 / 非法 JSON / 空输入', () => {
  const lines = parsePasswordFileText('a@b.com----tok----Pw123\n# 注释\nc@d.com（无密码）');
  assert.equal(lines.ok, true);
  assert.equal(lines.passwords.size, 1);
  assert.equal(lines.passwords.get('a@b.com'), 'Pw123');

  const bad = parsePasswordFileText('[{"meta":');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /JSON/);

  const empty = parsePasswordFileText('   ');
  assert.equal(empty.ok, true);
  assert.equal(empty.passwords.size, 0);
});

test('取件 URL 模板解析：{code} 占位 / xxx 结尾 / 路径拼接 / 空取件码', () => {
  assert.equal(resolveTotpPickupUrl('https://2fa.show/2fa/{code}', CODE), `https://2fa.show/2fa/${CODE}`);
  assert.equal(resolveTotpPickupUrl('https://2fa.show/2fa/xxx', CODE), `https://2fa.show/2fa/${CODE}`);
  assert.equal(resolveTotpPickupUrl('https://2fa.show', CODE), `https://2fa.show/${CODE}`);
  assert.equal(resolveTotpPickupUrl('https://2fa.show/', CODE), `https://2fa.show/${CODE}`);
  assert.equal(resolveTotpPickupUrl(undefined, CODE), `https://2fa.show/2fa/${CODE}`);
  assert.equal(resolveTotpPickupUrl('https://2fa.show/2fa/{code}', ''), '');
  assert.equal(resolveTotpPickupUrl('https://2fa.show/2fa/{code}', '  '), '');
});

test('取件响应解析：纯文本 / HTML / 带噪声文本 / 无码', () => {
  assert.equal(extractTotpCodeFromText('735623'), '735623');
  assert.equal(extractTotpCodeFromText('  735623\n'), '735623');
  const html = `<!DOCTYPE html><html><body><h2 id="code" onclick="copyfun()" style="color: red">735623</h2></body></html>`;
  assert.equal(extractTotpCodeFromText(html), '735623');
  assert.equal(extractTotpCodeFromText('code: 482910 done'), '482910');
  assert.equal(extractTotpCodeFromText('no digits here'), null);
  assert.equal(extractTotpCodeFromText(''), null);
});

test('取件响应解析：HTML 中首个 6 位数字不误取（id=code 优先）', () => {
  // 页面示例链接或其他内容出现 6 位数字时，优先取 id="code" 元素
  const html = `<p>example 123456</p><h2 id="code">654321</h2>`;
  assert.equal(extractTotpCodeFromText(html), '654321');
});

test('窗口等待毫秒数落在 (0.5s, 30.5s]', () => {
  const atWindowStart = msUntilNextTotpWindow(30_000 * 1000);
  assert.equal(atWindowStart, 30_500);
  const atWindowEnd = msUntilNextTotpWindow(30_000 * 1000 + 29_900);
  assert.equal(atWindowEnd, 600);
});

test('fetchTotpCodeFromPickupUrl：走注入的 fetch 实现并解析', async () => {
  const calls = [];
  const code = await fetchTotpCodeFromPickupUrl('https://2fa.show/x', {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, text: async () => '<h2 id="code">314159</h2>' };
    },
  });
  assert.equal(code, '314159');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://2fa.show/x');
});

test('fetchTotpCodeFromPickupUrl：HTTP 错误与无码响应抛错', async () => {
  await assert.rejects(
    () => fetchTotpCodeFromPickupUrl('https://x/y', { fetchImpl: async () => ({ ok: false, status: 503, text: async () => '' }) }),
    /HTTP 503/,
  );
  await assert.rejects(
    () => fetchTotpCodeFromPickupUrl('https://x/y', { fetchImpl: async () => ({ ok: true, status: 200, text: async () => 'nothing' }) }),
    /no 6-digit/,
  );
  await assert.rejects(() => fetchTotpCodeFromPickupUrl('not-a-url'), /invalid/i);
});

// ---------------------------------------------------------------------------
// 引擎级集成：launcher 注入取件 URL 环境变量 + auto-input 兜底在线取码
// ---------------------------------------------------------------------------
const PICKUP_CODE = 'PICKUPCODE0000000000000000AA';
const OTP = '246810';

async function waitForJob(db, jobId, status, timeoutMs = 20000) {
  const started = Date.now();
  for (;;) {
    const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
    if (row?.status === status) return row;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`job ${jobId} 未在 ${timeoutMs}ms 内进入 ${status}，当前 ${row?.status} / ${row?.error}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

test('引擎集成：2FA 取件码账号 → mfa_otp 自动取码作答 + launcher 注入取件 URL', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tosub2-pickup-'));
  for (const sub of ['logs', 'results', 'checkpoints']) fs.mkdirSync(path.join(dataDir, sub), { recursive: true });
  const logger = createLogger('silent');
  const db = openDatabase(dataDir, { logger });
  const crypto = createCrypto({ dataDir, secretKeyEnv: 'test-secret', logger });
  const settings = createSettingsService(db, crypto, { logger });
  settings.ensureDefaults();
  // 集成测试沿用无代理直连跑 mock 流程，不受 strict_proxy 拦截影响
  settings.set('engine.config', { ...settings.get('engine.config'), strict_proxy: false });
  // mock 流程为本地协议登录；redeem401 路径由 redeem401-engine.test.js 覆盖
  settings.set('login.provider', { ...settings.get('login.provider'), mode: 'protocol' });
  const serverRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

  // 本地 mock 2fa.show：/{code} 返回纯文本 6 位码
  const mockServer = http.createServer((req, res) => {
    if (req.url === `/${PICKUP_CODE}`) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(OTP);
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  const port = mockServer.address().port;
  settings.set('twofa.fetch', { template: `http://127.0.0.1:${port}/{code}` });

  const config = {
    dataDir,
    serverRoot,
    settingsGet: (k) => settings.get(k),
    cryptoTryDecryptJson: (e, f) => crypto.tryDecryptJson(e, f),
    cryptoEncryptJson: (v, f) => crypto.encryptJson(v, f),
    pickProxy: () => ({ id: null, url: null }),
    recordProxyFailure: () => {},
  };
  const pools = createPools(db, crypto);

  const scriptPath = path.join(dataDir, 'script.json');
  const resultPath = path.join(dataDir, 'results', 'out.json');
  const envDumpPath = path.join(dataDir, 'env-dump.txt');
  fs.writeFileSync(scriptPath, JSON.stringify({
    events: [
      { type: 'stage', stage: 'web_login' },
      { type: 'stage', stage: 'mfa_otp' },
      { type: 'input_required', kind: 'mfa_otp', detail: '请输入两步验证码', expect: OTP, path: resultPath },
      { type: 'stage', stage: 'oauth' },
      { type: 'result_saved', path: resultPath, account: { email: 'mfa@test.local' } },
    ],
  }));

  // 账号凭据只带 totp_pickup_code（无本地 totp_secret），强制走在线取件
  const now = new Date().toISOString();
  const accountResult = db
    .prepare(
      `INSERT INTO accounts(email, pool, status, mail_status, imported_at, created_at, updated_at)
       VALUES(?, 'reserve', 'joining', 'ok', ?, ?, ?)`,
    )
    .run('mfa@test.local', now, now, now);
  const accountId = Number(accountResult.lastInsertRowid);
  db.prepare('UPDATE accounts SET credentials_enc = ? WHERE id = ?').run(
    crypto.encryptJson({ totp_pickup_code: PICKUP_CODE }, 'accounts.credentials_enc'),
    accountId,
  );

  process.env.TOSUB2_PROTOCOL_SCRIPT = path.resolve(serverRoot, 'test/mock-protocol-login.mjs');
  process.env.TOSUB2_MOCK_SCRIPT = scriptPath;
  process.env.TOSUB2_MOCK_RESULT_PATH = '1';
  process.env.TOSUB2_MOCK_ENV_DUMP = envDumpPath;
  const engine = createJobsEngine({ config, db, logger });
  engine.hooks.onTokensSaved = (job, runtime, tokens) => {
    pools.joinSucceeded(job.account_id, {
      tokensEnc: config.cryptoEncryptJson(tokens, 'accounts.tokens_enc'),
      balance: null,
      balanceCheckedAt: null,
    });
  };

  try {
    engine.start();
    const job = engine.submitJob({ accountId, type: 'login' });

    // auto-input 在线取码自动作答 → 任务完成（无需人工输入）
    await waitForJob(db, job.id, 'completed');
    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
    assert.equal(account.pool, 'main');

    // launcher 注入的取件 URL = 设置模板 + 账号取件码
    const dumped = fs.readFileSync(envDumpPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(dumped.at(-1).totpPickupUrl, `http://127.0.0.1:${port}/${PICKUP_CODE}`);
    assert.equal(dumped.at(-1).totpSecret, '');

    await engine.shutdown();
  } finally {
    delete process.env.TOSUB2_PROTOCOL_SCRIPT;
    delete process.env.TOSUB2_MOCK_SCRIPT;
    delete process.env.TOSUB2_MOCK_RESULT_PATH;
    delete process.env.TOSUB2_MOCK_ENV_DUMP;
    mockServer.close();
    db.close();
    // Windows 下日志流句柄延迟释放，清理失败不影响断言结果
    for (let i = 0; i < 10; i += 1) {
      try {
        fs.rmSync(dataDir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  }
});
