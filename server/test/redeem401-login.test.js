import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';

const SERVER_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const SCRIPT = path.join(SERVER_ROOT, 'core', 'redeem401-login.mjs');

const EMAIL = 'gawk-frozen-volley@duck.com';

/** 与 export 归档同构的最小 ZIP 构造（deflate、无加密、无数据描述符）。 */
function buildZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, content } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const compressed = zlib.deflateRawSync(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += 30 + nameBuf.length + compressed.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

function sub2apiAccount(email, overrides = {}) {
  return {
    name: email,
    platform: 'openai',
    type: 'oauth',
    expires_at: 1790419038,
    concurrency: 10,
    priority: 1,
    credentials: {
      access_token: `at-${email}`,
      refresh_token: `rt-${email}`,
      client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
      email,
      chatgpt_account_id: '29ec7371-5719-439c-bca0-ecf599919ce7',
      expires_at: '2026-09-26T10:37:18Z',
      plan_type: 'free',
      ...overrides.credentials,
    },
    extra: { email, email_key: email.replaceAll(/[-.@]/g, '_'), auth_provider: 'openai', source: 'chatgpt_web_session' },
    ...overrides.account,
  };
}

/** redeem /401processing 三端点 mock：status 按剧本序列逐次返回，export 返回真 ZIP。 */
function createRedeemMock({ email, statusScript, exportAccounts, exportResponse = null, statusFlapTimes = 0 }) {
  const calls = { run: [], export: [] };
  let statusIndex = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/401processing/api/run') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        calls.run.push(JSON.parse(body || '{}'));
        // 与真实服务一致：run 响应自带 state，本邮箱以 pending track 确认入队
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          state: { running: true, phase: 'running', accounts: [{ email, status: '待处理', error: '', plan: '', kind: 'mail' }], tracks: [{ email, phase: 'pending', otp: '', detail: '排队中' }], totals: { queue: 1 } },
        }));
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/401processing/api/status') {
      // 闪断模拟：前 statusFlapTimes 次 502（Envoy upstream 断连文案）
      if (statusFlapTimes > 0) {
        statusFlapTimes -= 1;
        res.writeHead(502, { 'content-type': 'text/plain' });
        res.end('upstream connect error or disconnect/reset before headers. retried 5 times');
        return;
      }
      const state = statusScript[Math.min(statusIndex, statusScript.length - 1)];
      statusIndex += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(state));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/401processing/api/export') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        calls.export.push(JSON.parse(body || '{}'));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(exportResponse || defaultExportResponse(exportAccounts)));
      });
      return;
    }
    res.writeHead(404);
    res.end('{}');
  });
  const ready = new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
  return { server, ready, calls, email };
}

function defaultExportResponse(exportAccounts) {
  const zip = buildZip([
    { name: 'sub2api_accounts_2026-09-16.json', content: JSON.stringify({ type: 'sub2api-data', version: 1, exported_at: '2026-09-16T10:37:18Z', proxies: [], accounts: exportAccounts }) },
  ]);
  return { ok: true, format: 'sub2api', archive: { filename: 'sub2api.zip', contentBase64: zip.toString('base64'), fileCount: 1 }, state: {} };
}

function runScript(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      cwd: SERVER_ROOT,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const events = [];
    let stderr = '';
    let stdoutBuffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk;
      let newline;
      while ((newline = stdoutBuffer.indexOf('\n')) >= 0) {
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (!line) continue;
        try {
          events.push(JSON.parse(line));
        } catch {}
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => resolve({ code, events, stderr }));
  });
}

function cleanupDir(dataDir) {
  try {
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {}
}

test('成功路径：run → 轮询 → export 解包 ZIP → 写出标准 sub2api JSON + 事件序列', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tosub2-redeem401-'));
  const mock = createRedeemMock({
    email: EMAIL,
    statusScript: [
      { running: true, tracks: [{ email: EMAIL, phase: 'login', detail: '正在网页登录' }], totals: { queue: 1 } },
      { running: true, tracks: [{ email: EMAIL, phase: 'otp_wait', detail: '正在等待接收验证码' }], totals: { queue: 0 } },
      { running: true, tracks: [{ email: EMAIL, phase: 'otp_got', detail: '成功获取验证码：726895' }], totals: { queue: 0 } },
      {
        running: false,
        tracks: [{ email: EMAIL, phase: 'ok', detail: '可导出 CPA / sub2' }],
        history: [{ email: EMAIL, state: 'ok', detail: '可导出 CPA / sub2' }],
        exportable: { count: 1, emails: [EMAIL] },
        totals: { queue: 0 },
      },
    ],
    // export 故意带回同批导出的另一个邮箱：脚本必须按 --email 挑出目标账号并收窄成单账号文件
    exportAccounts: [sub2apiAccount('other@duck.com'), sub2apiAccount(EMAIL)],
  });
  const baseUrl = await mock.ready;
  try {
    const outPath = path.join(dataDir, 'results', 'job-1.json');
    const { code, events } = await runScript(
      ['--email', EMAIL, '--sub2api-out', outPath, '--json-events', '--redeem-base', baseUrl],
      { REDEEM401_POLL_INTERVAL_MS: '50', REDEEM401_TIMEOUT_MINUTES: '2', TOSUB2_JOB_ATTEMPT: '3' },
    );

    assert.equal(code, 0, `stderr 应为空流程正常，events=${JSON.stringify(events)}`);

    // run / export 请求体契约
    assert.equal(mock.calls.run.length, 1);
    assert.deepEqual(mock.calls.run[0], { source: 'emails', emails: [EMAIL], text: EMAIL, limit: 0, dry_run: false });
    assert.deepEqual(mock.calls.export[0], { format: 'sub2', emails: [EMAIL] });

    // 事件序列：starting → stage(web_login/email_otp/finalizing) → result_saved → exit ok
    const types = events.map((e) => e.type);
    assert.equal(types[0], 'starting');
    assert.equal(events[0].mode, 'redeem401');
    assert.equal(events[0].attempt, 3);
    assert.ok(types.includes('stage') && events.filter((e) => e.type === 'stage').some((e) => e.stage === 'web_login'));
    assert.ok(events.filter((e) => e.type === 'stage').some((e) => e.stage === 'email_otp'));
    assert.ok(events.filter((e) => e.type === 'stage').some((e) => e.stage === 'finalizing'));
    assert.ok(types.includes('log'));
    const saved = events.find((e) => e.type === 'result_saved');
    assert.equal(saved.account.email, EMAIL);
    const exit = events.find((e) => e.type === 'exit');
    assert.equal(exit.ok, true);

    // 产物：正常形式 sub2api-data JSON（ZIP 未落盘），且已收窄为目标账号
    const data = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    assert.equal(data.type, 'sub2api-data');
    assert.equal(data.accounts.length, 1);
    assert.equal(data.accounts[0].credentials.email, EMAIL);
    assert.equal(data.accounts[0].credentials.access_token, `at-${EMAIL}`);
    assert.equal(data.accounts[0].credentials.refresh_token, `rt-${EMAIL}`);
    assert.equal(fs.readdirSync(path.join(dataDir, 'results')).filter((f) => f.endsWith('.zip')).length, 0, 'ZIP 不应落盘');
  } finally {
    mock.server.close();
    cleanupDir(dataDir);
  }
});

test('失败路径：账号停用（phase=delete，真实响应形态）→ error 事件带 account_deactivated marker，退出码 1', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tosub2-redeem401-'));
  const mock = createRedeemMock({
    email: EMAIL,
    statusScript: [
      { running: true, tracks: [{ email: EMAIL, phase: 'login', detail: '正在网页登录' }], totals: { queue: 1 } },
      {
        running: true,
        tracks: [{ email: EMAIL, phase: 'delete', detail: '账号已停用或删除（已检测到 OpenAI 停用状态）' }],
        history: [],
        exportable: { count: 0, emails: [] },
        totals: { queue: 0 },
      },
    ],
    exportAccounts: [],
  });
  const baseUrl = await mock.ready;
  try {
    const outPath = path.join(dataDir, 'results', 'job-2.json');
    const { code, events } = await runScript(
      ['--email', EMAIL, '--sub2api-out', outPath, '--json-events', '--redeem-base', baseUrl],
      { REDEEM401_POLL_INTERVAL_MS: '50', REDEEM401_TIMEOUT_MINUTES: '2' },
    );

    assert.equal(code, 1);
    const error = events.find((e) => e.type === 'error');
    assert.ok(error, '应有 error 事件');
    assert.equal(error.code, 'REDEEM401_FAILED');
    assert.match(error.message, /账号已停用或删除/);
    assert.match(error.message, /account_deactivated/);
    assert.equal(error.retry_proxy, false);
    assert.ok(!events.some((e) => e.type === 'exit' && e.ok), '失败时不应有 exit ok');
    assert.ok(!fs.existsSync(outPath), '失败时不应写出产物');
  } finally {
    mock.server.close();
    cleanupDir(dataDir);
  }
});

test('export 归档无 JSON 成员 → REDEEM401_EXPORT_INVALID', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tosub2-redeem401-'));
  const mock = createRedeemMock({
    email: EMAIL,
    statusScript: [
      {
        running: false,
        tracks: [{ email: EMAIL, phase: 'ok', detail: '可导出 CPA / sub2' }],
        history: [{ email: EMAIL, state: 'ok', detail: 'ok' }],
        exportable: { count: 1, emails: [EMAIL] },
        totals: { queue: 0 },
      },
    ],
    exportAccounts: [],
    // 返回一个不含 .json 成员的 ZIP
    exportResponse: {
      ok: true,
      archive: { filename: 'x.zip', contentBase64: buildZip([{ name: 'readme.txt', content: 'no json here' }]).toString('base64'), fileCount: 1 },
    },
  });
  const baseUrl = await mock.ready;
  try {
    const { code, events } = await runScript(
      ['--email', EMAIL, '--sub2api-out', path.join(dataDir, 'out.json'), '--json-events', '--redeem-base', baseUrl],
      { REDEEM401_POLL_INTERVAL_MS: '50', REDEEM401_TIMEOUT_MINUTES: '2' },
    );
    assert.equal(code, 1);
    const error = events.find((e) => e.type === 'error');
    assert.equal(error.code, 'REDEEM401_EXPORT_INVALID');
    assert.match(error.message, /没有 JSON 成员/);
  } finally {
    mock.server.close();
    cleanupDir(dataDir);
  }
});

const IDLE_EMPTY = () => ({
  running: false,
  current: '',
  phase: 'idle',
  error: '',
  tracks: [],
  history: [],
  exportable: { count: 0, emails: [] },
  totals: { oauth: 0, queue: 0, forbidden: 0 },
});

const DONE_OK = () => ({
  running: false,
  tracks: [{ email: EMAIL, phase: 'ok', otp: '535003', detail: '可导出 CPA / sub2' }],
  history: [{ email: EMAIL, state: 'ok', detail: '可导出 CPA / sub2', ts: '2026-09-16T15:51:50+00:00' }],
  exportable: { count: 1, emails: [EMAIL] },
  totals: { queue: 0 },
});

test('服务闪断清空队列（实测形态）：run 确认入队后 status 全空 → 补提交 3 次后成功', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tosub2-redeem401-'));
  const mock = createRedeemMock({
    email: EMAIL,
    // 前三次轮询：服务重启后队列被清空、tracks 无痕；第四次：补提交的任务跑完
    statusScript: [IDLE_EMPTY(), IDLE_EMPTY(), IDLE_EMPTY(), DONE_OK()],
    exportAccounts: [sub2apiAccount(EMAIL)],
  });
  const baseUrl = await mock.ready;
  try {
    const outPath = path.join(dataDir, 'results', 'flap-ok.json');
    const { code, events } = await runScript(
      ['--email', EMAIL, '--sub2api-out', outPath, '--json-events', '--redeem-base', baseUrl],
      { REDEEM401_POLL_INTERVAL_MS: '50', REDEEM401_TIMEOUT_MINUTES: '2' },
    );

    assert.equal(code, 0, `events=${JSON.stringify(events)}`);
    // 初始 run + 3 次补提交
    assert.equal(mock.calls.run.length, 4);
    const resubmitLogs = events.filter((e) => e.type === 'log' && /第 3\/6 次/.test(e.message));
    assert.equal(resubmitLogs.length, 1, '应有第 3/3 次补提交日志');
    const data = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    assert.equal(data.accounts[0].credentials.email, EMAIL);
  } finally {
    mock.server.close();
    cleanupDir(dataDir);
  }
});

test('服务持续闪断：补提交耗尽 → 错误明确指出队列被清空（而非笼统的未产出凭据）', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tosub2-redeem401-'));
  const mock = createRedeemMock({
    email: EMAIL,
    statusScript: [IDLE_EMPTY()],
    exportAccounts: [],
  });
  const baseUrl = await mock.ready;
  try {
    const { code, events } = await runScript(
      ['--email', EMAIL, '--sub2api-out', path.join(dataDir, 'out.json'), '--json-events', '--redeem-base', baseUrl],
      { REDEEM401_POLL_INTERVAL_MS: '50', REDEEM401_TIMEOUT_MINUTES: '2' },
    );
    assert.equal(code, 1);
    assert.equal(mock.calls.run.length, 7, '初始 + 6 次补提交后放弃');
    const error = events.find((e) => e.type === 'error');
    assert.equal(error.code, 'REDEEM401_FAILED');
    assert.match(error.message, /队列被清空/);
    assert.match(error.message, /补提交预算耗尽/);
  } finally {
    mock.server.close();
    cleanupDir(dataDir);
  }
});

test('status 轮询闪断容忍：连续 2 次 502 不放弃，恢复后正常完成', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tosub2-redeem401-'));
  const mock = createRedeemMock({
    email: EMAIL,
    statusFlapTimes: 2,
    statusScript: [{ running: true, tracks: [{ email: EMAIL, phase: 'login', detail: '正在网页登录' }], totals: { queue: 1 } }, DONE_OK()],
    exportAccounts: [sub2apiAccount(EMAIL)],
  });
  const baseUrl = await mock.ready;
  try {
    const outPath = path.join(dataDir, 'results', 'flap502.json');
    const { code, events } = await runScript(
      ['--email', EMAIL, '--sub2api-out', outPath, '--json-events', '--redeem-base', baseUrl],
      { REDEEM401_POLL_INTERVAL_MS: '50', REDEEM401_TIMEOUT_MINUTES: '2' },
    );
    assert.equal(code, 0, `events=${JSON.stringify(events)}`);
    const flapLogs = events.filter((e) => e.type === 'log' && /status 轮询失败（[12]\/3）/.test(e.message));
    assert.equal(flapLogs.length, 2, '应有两次 502 容忍日志');
    assert.ok(fs.existsSync(outPath));
  } finally {
    mock.server.close();
    cleanupDir(dataDir);
  }
});
