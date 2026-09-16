#!/usr/bin/env node
// ---------------------------------------------------------------------------
// redeem401 远程登录子进程：把本地协议登录（网页登录 + Codex OAuth）替换为调用
// redeem 服务 /401processing 三个端点（run → 轮询 status → export）。
//
// CLI 与事件契约对齐 protocol-login.mjs 的 login 子集（--json-events 模式）：
//   stdout NDJSON 事件 starting / stage / log / result_saved / error / exit
//   成功时 --sub2api-out 写出标准 sub2api-data JSON（export 返回的 ZIP 在内存解包，
//   ZIP 本身不落盘），引擎 handleSaveTokens / 上传链路零改动。
//
// 环境变量（由 launcher 按设置注入，不进 argv、不写日志）：
//   REDEEM401_BASE_URL          服务地址，默认 https://redeem.lazmeow.com
//   REDEEM401_TIMEOUT_MINUTES   轮询总超时（分钟），默认 15
//   REDEEM401_POLL_INTERVAL_MS  轮询间隔（毫秒），默认 5000
//   TOSUB2_JOB_ATTEMPT          事件携带的 attempt 序号
// ---------------------------------------------------------------------------
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { spawn, spawnSync } from "node:child_process";

const DEFAULT_BASE = "https://redeem.lazmeow.com";
const DEFAULT_TIMEOUT_MINUTES = 15;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const REQUEST_TIMEOUT_MS = 30_000;

const EVENT_ERROR_CODES = [
  "REDEEM401_UNAVAILABLE",
  "REDEEM401_TIMEOUT",
  "REDEEM401_FAILED",
  "REDEEM401_EXPORT_INVALID",
];

// 引擎 PERMANENT_FAILURE_PATTERN 只认英文标记；远程返回中文失败文案时补英文 marker，
// 让 isPermanentAccountFailure 命中并自动移废弃，而不是反复重试死号
const BANNED_MARKER_PATTERN =
  /封禁|封号|停用|注销|已禁|deactivated|deleted|suspended|banned|permanently\s+deleted/i;

// ---------------------------------------------------------------------------
// json-events（与 protocol-login 相同的事件格式：type/ts/attempt + 字段）
// ---------------------------------------------------------------------------
const JSON_EVENTS = { enabled: false, attempt: 1 };

function emitEvent(type, fields = {}) {
  if (!JSON_EVENTS.enabled) return;
  const event = { type, ts: new Date().toISOString(), attempt: JSON_EVENTS.attempt, ...fields };
  try {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  } catch {}
}

function emitErrorEvent(error) {
  if (!JSON_EVENTS.enabled) return;
  const message = String(error?.message || "unknown error");
  let code = typeof error?.code === "string" && EVENT_ERROR_CODES.includes(error.code)
    ? error.code
    : "INTERNAL";
  if (code === "INTERNAL") {
    for (const candidate of EVENT_ERROR_CODES) {
      if (message.includes(candidate)) {
        code = candidate;
        break;
      }
    }
  }
  emitEvent("error", { code, message: message.slice(0, 800), fatal: true, retry_proxy: false });
}

function emitStageEvent(stage) {
  emitEvent("stage", { stage });
}

function emitLogEvent(message) {
  emitEvent("log", { message: String(message).slice(0, 500) });
}

function enableJsonEvents() {
  JSON_EVENTS.enabled = true;
  JSON_EVENTS.attempt = Math.max(1, Number.parseInt(process.env.TOSUB2_JOB_ATTEMPT || "1", 10) || 1);
  console.log = (...args) => process.stderr.write(`${args.join(" ")}\n`);
  // 兼容引擎的 quit 指令（人工输入在 redeem 流程不存在，但取消路径会发 quit）。
  // stdin 必须 unref：引擎持有 stdin 管道不关闭，resume 状态的 stdin 会挂住事件循环，
  // 子进程在流程结束后永不退出（Windows 实测），任务就会卡到超时
  process.stdin.setEncoding("utf8");
  process.stdin.resume();
  process.stdin.unref?.();
  process.stdin.on("data", (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const command = JSON.parse(line);
        if (command?.action === "quit") {
          emitEvent("error", { code: "USER_QUIT", message: "Stopped before redeem401 login finished", fatal: true, retry_proxy: false });
          process.exit(1);
        }
      } catch {}
    }
  });
}

function log(...args) {
  console.log(`[redeem401] ${args.join(" ")}`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === "--help" || item === "-h") args.help = true;
    else if (item === "--verbose" || item === "-v") args.verbose = true;
    else if (item === "--json-events") args.jsonEvents = true;
    else if (item.startsWith("--email=")) args.email = item.slice("--email=".length);
    else if (item === "--email") args.email = argv[++i];
    else if (item.startsWith("--sub2api-out=")) args.sub2apiOut = item.slice("--sub2api-out=".length);
    else if (item === "--sub2api-out") args.sub2apiOut = argv[++i];
    else if (item.startsWith("--redeem-base=")) args.redeemBase = item.slice("--redeem-base=".length);
    else if (item === "--redeem-base") args.redeemBase = argv[++i];
    else throw new Error(`Unknown argument: ${item}`);
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  node core/redeem401-login.mjs [options]

Options:
  --email <email>             Email address to re-login on the redeem service.
  --sub2api-out <file>        sub2api import JSON path (unzipped from export).
  --redeem-base <url>         Redeem service base URL. Default: ${DEFAULT_BASE} (or REDEEM401_BASE_URL)
  --json-events               v2 console mode: emit NDJSON events on stdout.
  --verbose                   Print HTTP request status lines.
  --help                      Show this help.
`);
}

// ---------------------------------------------------------------------------
// 极简 ZIP 读取（export 归档为单成员标准 deflate、无加密、无数据描述符、无 ZIP64；
// 引入解压依赖不值得，这里只覆盖归档生成端实际会产出的形态）
// ---------------------------------------------------------------------------
function readZipEntries(buffer) {
  // EOCD：签名 PK\x05\x06（22 字节固定尾 + 至多 64K 注释），从尾部向前扫
  const eocdMin = 22;
  const scanStart = Math.max(0, buffer.length - (eocdMin + 0xffff));
  let eocd = -1;
  for (let i = buffer.length - eocdMin; i >= scanStart; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("REDEEM401_EXPORT_INVALID: export archive has no ZIP end record");
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const cdOffset = buffer.readUInt32LE(eocd + 16);

  const entries = [];
  let cursor = cdOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error("REDEEM401_EXPORT_INVALID: export archive central directory is corrupt");
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    if (flags & 0x0001) throw new Error(`REDEEM401_EXPORT_INVALID: export archive entry "${name}" is encrypted`);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error("REDEEM401_EXPORT_INVALID: export archive uses unsupported ZIP64 layout");
    }
    // 本地文件头：30 字节固定 + 名称 + extra（长度可能与中央目录里的不同，必须重读）
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`REDEEM401_EXPORT_INVALID: export archive entry "${name}" local header is corrupt`);
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`REDEEM401_EXPORT_INVALID: export archive entry "${name}" uses unsupported compression ${method}`);
    if (data.length !== uncompressedSize) {
      throw new Error(`REDEEM401_EXPORT_INVALID: export archive entry "${name}" size mismatch`);
    }
    entries.push({ name, data });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

// ---------------------------------------------------------------------------
// HTTP：必须经 curl_cffi（Chrome TLS 指纹）+ 常驻 Session 访问
//
// 2026-09-16 实测，redeem 服务有两个绕不开的访问约束：
// 1. TLS 指纹分流：Node fetch / curl 的握手特征被路由到「照单全收但从不
//    执行」的后端（run 返回 200 且确认入队，任务随后静默消失）；
//    curl_cffi impersonate=chrome 的指纹进真实后端正常处理。
// 2. 连接粘滞：负载均衡按 TCP 连接固定后端，任务队列在各后端进程内存里。
//    逐请求新建连接会让 run 与 status 落到不同后端（同样表现为任务凭空
//    消失）。因此这里保持一个常驻 python worker + curl_cffi Session，
//    整个登录周期复用同一条连接（与 tls-transport 同一套环境约定）。
// ---------------------------------------------------------------------------
const HTTP_WORKER_SCRIPT = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "redeem401-http.py");

let cachedPython = undefined; // undefined=未探测，null=不可用，{command,args}=可用

function findPythonCommand() {
  if (cachedPython !== undefined) return cachedPython;
  const configured = String(process.env.TOSUB2_PYTHON || "").trim();
  const candidates = configured
    ? [{ command: configured, args: [] }]
    : process.platform === "win32"
      ? [{ command: "python", args: [] }, { command: "py", args: ["-3"] }]
      : [{ command: "python3", args: [] }, { command: "python", args: [] }];
  for (const candidate of candidates) {
    try {
      const check = spawnSync(candidate.command, [...candidate.args, "-c", "import curl_cffi"], {
        stdio: "ignore",
        timeout: 15_000,
        windowsHide: true,
      });
      if (check.status === 0) {
        cachedPython = candidate;
        return cachedPython;
      }
    } catch {}
  }
  cachedPython = null;
  return cachedPython;
}

/** 常驻 curl_cffi worker：行协议 {id,method,url,body,timeoutMs} → {id,ok,...}。 */
function createHttpWorker({ verbose, log }) {
  const python = findPythonCommand();
  if (!python) {
    throw new Error(
      "未找到可用的 Python curl_cffi 环境（redeem 服务要求浏览器 TLS 指纹）。请先运行 python -m pip install -r requirements.txt；也可以设置 TOSUB2_PYTHON 指定 Python 路径",
    );
  }
  const child = spawn(python.command, [...python.args, HTTP_WORKER_SCRIPT], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const pending = new Map(); // id -> {resolve, reject, timer}
  let nextId = 1;
  let stdoutBuffer = "";
  let closed = false;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    let newline;
    while ((newline = stdoutBuffer.indexOf("\n")) >= 0) {
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.ok) waiter.resolve({ status: Number(message.status), text: String(message.body ?? "") });
      else waiter.reject(new Error(String(message.error || "worker 请求失败")));
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    if (verbose) log(`[http-worker] ${chunk.trimEnd()}`);
  });
  const failAll = (error) => {
    closed = true;
    for (const [, waiter] of pending) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
  };
  child.on("error", (error) => failAll(new Error(`curl_cffi worker 启动失败：${error.message}`)));
  child.on("close", (code) => failAll(new Error(`curl_cffi worker 退出（code=${code}）`)));

  return {
    request({ method, url, body, timeoutMs }) {
      if (closed) return Promise.reject(new Error("curl_cffi worker 已关闭"));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`请求超时（${Math.round(timeoutMs / 1000)}s）`));
        }, timeoutMs + 10_000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ id, method, url, body, timeoutMs })}\n`, (error) => {
          if (error) {
            pending.delete(id);
            clearTimeout(timer);
            reject(new Error(`curl_cffi worker 写入失败：${error.message}`));
          }
        });
      });
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        child.stdin.end();
      } catch {}
      const killer = setTimeout(() => {
        try {
          child.kill();
        } catch {}
      }, 3_000);
      killer.unref?.();
      child.once("close", () => clearTimeout(killer));
    },
  };
}

// ---------------------------------------------------------------------------
// API 客户端
// ---------------------------------------------------------------------------
class Redeem401Error extends Error {
  constructor(message, code = "REDEEM401_UNAVAILABLE") {
    super(message);
    this.code = code;
  }
}

function createClient({ baseUrl, verbose }) {
  const base = String(baseUrl || DEFAULT_BASE).replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) {
    throw new Redeem401Error(`redeem 服务地址不合法：${base}`, "REDEEM401_UNAVAILABLE");
  }
  const apiRoot = `${base}/401processing/api`;
  const worker = createHttpWorker({ verbose, log });

  async function request(pathname, { method = "GET", body = null } = {}) {
    try {
      const { status, text } = await worker.request({
        method,
        url: `${apiRoot}${pathname}`,
        body,
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
      if (verbose) log(`HTTP ${method} ${pathname} -> ${status}`);
      let payload = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = null;
      }
      if (status < 200 || status >= 300) {
        const detail = String(payload?.error || payload?.message || text || "").trim().slice(0, 300);
        throw new Redeem401Error(`redeem 服务 ${pathname} 返回 HTTP ${status}${detail ? `：${detail}` : ""}`);
      }
      if (payload && typeof payload === "object" && payload.ok === false) {
        const detail = String(payload?.error || payload?.message || "未知错误").trim().slice(0, 300);
        throw new Redeem401Error(`redeem 服务 ${pathname} 返回错误：${detail}`);
      }
      return payload;
    } catch (error) {
      if (error instanceof Redeem401Error) throw error;
      throw new Redeem401Error(`无法连接 redeem 服务：${String(error?.message || error)}`);
    }
  }

  return {
    run: (email) => request("/run", {
      method: "POST",
      body: { source: "emails", emails: [email], text: email, limit: 0, dry_run: false },
    }),
    status: () => request("/status"),
    export: (email) => request("/export", {
      method: "POST",
      body: { format: "sub2", emails: [email] },
    }),
    close: () => worker.close(),
  };
}

// ---------------------------------------------------------------------------
// 状态机：tracks[].phase → 引擎 stage / 进度文案
// ---------------------------------------------------------------------------
function findTrack(state, email) {
  const tracks = Array.isArray(state?.tracks) ? state.tracks : [];
  return tracks.find((t) => String(t?.email || "").toLowerCase() === email.toLowerCase()) || null;
}

function findHistoryEntry(state, email) {
  const history = Array.isArray(state?.history) ? state.history : [];
  // 同一邮箱可能跨批次留下多条 history（先 ok 后 delete 等），取时间最新的一条
  const matches = history.filter((h) => String(h?.email || "").toLowerCase() === email.toLowerCase());
  if (!matches.length) return null;
  return matches.reduce((latest, h) => {
    const ts = Date.parse(h?.ts || "");
    const latestTs = Date.parse(latest?.ts || "");
    return Number.isFinite(ts) && ts >= latestTs ? h : latest;
  }, matches[0]);
}

function trackStage(phase) {
  if (phase === "otp_wait" || phase === "otp" || phase === "otp_got") return "email_otp";
  return "web_login"; // pending / login / 其他中间态
}

// 终态 phase：ok=成功；delete=账号已停用/删除（真实响应实测）；failed/error/done=其他失败；
// forbidden 由 totals.forbidden 字段推断存在，一并视为终态
const TERMINAL_PHASES = new Set(["ok", "failed", "error", "done", "delete", "forbidden"]);

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  if (args.jsonEvents) enableJsonEvents();

  const email = String(args.email || "").trim();
  if (!email) throw new Error("Email is required (--email)");
  if (!args.sub2apiOut) throw new Error("--sub2api-out is required");

  const baseUrl = args.redeemBase || process.env.REDEEM401_BASE_URL || DEFAULT_BASE;
  const timeoutMinutes = Math.max(
    1,
    Number.parseInt(process.env.REDEEM401_TIMEOUT_MINUTES || String(DEFAULT_TIMEOUT_MINUTES), 10) || DEFAULT_TIMEOUT_MINUTES,
  );
  const pollIntervalMs = Math.max(
    50,
    Number.parseInt(process.env.REDEEM401_POLL_INTERVAL_MS || String(DEFAULT_POLL_INTERVAL_MS), 10) || DEFAULT_POLL_INTERVAL_MS,
  );
  const sub2apiOutPath = path.resolve(args.sub2apiOut);
  const deadline = Date.now() + timeoutMinutes * 60_000;
  const client = createClient({ baseUrl, verbose: args.verbose });
  try {
  emitEvent("starting", { mode: "redeem401", email });
  log(`remote login via ${baseUrl}/401processing (timeout ${timeoutMinutes}m)`);

  // 1. 入队。服务端是全局单队列：若正有任务在跑导致 run 被拒，退化为纯轮询，
  //    等本邮箱出现在 tracks / history（并发提交多个账号时必然走到这条路径）。
  //    run 响应自带全量 state：若本邮箱出现在其中，说明服务已确认入队，
  //    之后凭空消失即可归因为服务闪断重启清空了队列（而非提交未达）
  emitStageEvent("web_login");
  let enqueueConfirmed = false;
  try {
    const runState = await client.run(email);
    const track = findTrack(runState?.state, email);
    enqueueConfirmed = Boolean(track);
    log(`run accepted: ${email}`);
  } catch (error) {
    emitLogEvent(`run 提交未确认（${String(error.message).slice(0, 160)}），转入轮询等待`);
  }

  // 2. 轮询直到本邮箱终态或超时；服务空闲却始终没见到本账号时补提交 run。
  //    实测（2026-09-16）：服务端 worker 故障时会接收任务后静默丢弃（队列 1 秒内清空、
  //    tracks/history 无痕），且故障呈小时级间歇——补提交次数与间隔递增（5s→60s，
  //    共约 3 分钟），专门捕捉不稳定时段里的健康窗口
  let lastSignature = "";
  let resubmissions = 0;
  const MAX_RESUBMISSIONS = 6;
  const startedAt = Date.now();
  const state = await pollUntilTerminal(client, email, { deadline, startedAt, pollIntervalMs, isEnqueueConfirmed: () => enqueueConfirmed, onProgress: (snapshot) => {
    const signature = `${snapshot.phase}|${snapshot.detail}`;
    if (signature !== lastSignature) {
      lastSignature = signature;
      const stage = trackStage(snapshot.phase);
      emitStageEvent(stage);
      emitLogEvent(snapshot.detail || `阶段：${snapshot.phase || "unknown"}`);
    }
  }, onMissing: async () => {
    if (resubmissions >= MAX_RESUBMISSIONS) return false;
    resubmissions += 1;
    const backoffMs = Math.min(60_000, pollIntervalMs * 2 ** (resubmissions - 1));
    emitLogEvent(`服务空闲且未见本账号，${Math.round(backoffMs / 1000)}s 后补提交 run（第 ${resubmissions}/${MAX_RESUBMISSIONS} 次）`);
    await sleep(backoffMs);
    try {
      const runState = await client.run(email);
      if (findTrack(runState?.state, email)) enqueueConfirmed = true;
    } catch {}
    return true;
  } });

  if (!state.ok) {
    throw new Redeem401Error(describeFailure(state), "REDEEM401_FAILED");
  }

  // 3. 导出并解包 ZIP → 标准 sub2api-data JSON
  emitStageEvent("finalizing");
  log(`exporting credentials: ${email}`);
  const exportPayload = await client.export(email);
  const archive = exportPayload?.archive;
  if (!archive?.contentBase64) {
    throw new Redeem401Error("export 响应缺少 archive.contentBase64", "REDEEM401_EXPORT_INVALID");
  }
  let archiveBuffer;
  try {
    archiveBuffer = Buffer.from(String(archive.contentBase64), "base64");
  } catch (error) {
    throw new Redeem401Error(`export 归档 base64 解码失败：${error.message}`, "REDEEM401_EXPORT_INVALID");
  }
  const entries = readZipEntries(archiveBuffer);
  const jsonEntry = entries.find((e) => e.name.toLowerCase().endsWith(".json"));
  if (!jsonEntry) {
    throw new Redeem401Error(`export 归档中没有 JSON 成员（${archive.filename || "unnamed"}）`, "REDEEM401_EXPORT_INVALID");
  }
  let exportData;
  try {
    exportData = JSON.parse(jsonEntry.data.toString("utf8"));
  } catch (error) {
    throw new Redeem401Error(`export JSON 解析失败：${error.message}`, "REDEEM401_EXPORT_INVALID");
  }
  if (!Array.isArray(exportData?.accounts) || !exportData.accounts.length) {
    throw new Redeem401Error("export JSON 缺少 accounts 数组", "REDEEM401_EXPORT_INVALID");
  }

  // 4. 校验目标账号并落盘（文件里可能带同批导出的其他邮箱，按邮箱挑出目标）
  const target = exportData.accounts.find(
    (a) => String(a?.credentials?.email || a?.name || "").toLowerCase() === email.toLowerCase(),
  );
  if (!target) {
    throw new Redeem401Error(`export 产物中没有 ${email} 的账号`, "REDEEM401_EXPORT_INVALID");
  }
  if (!target.credentials?.access_token || !target.credentials?.refresh_token) {
    throw new Redeem401Error(`export 产物缺少 access_token/refresh_token（${email}）`, "REDEEM401_EXPORT_INVALID");
  }
  // 引擎按 accounts[0] 取 tokens：单账号文件是既有约定，多账号时收窄成目标账号
  const single = { ...exportData, accounts: [target] };
  await writeJsonAtomic(sub2apiOutPath, single, { mode: 0o600 });

  log(`saved sub2api import: ${sub2apiOutPath}`);
  log(`account: ${target.name} chatgpt_account_id: ${mask(target.credentials.chatgpt_account_id)}`);
  emitEvent("result_saved", {
    path: sub2apiOutPath,
    account: {
      email: target.credentials.email || email,
      name: target.name,
      chatgpt_account_id: target.credentials.chatgpt_account_id || "",
    },
  });
  } finally {
    client.close();
  }
}

async function pollUntilTerminal(client, email, { deadline, startedAt, pollIntervalMs, isEnqueueConfirmed = () => false, onProgress, onMissing }) {
  let sawTrack = false;
  // 服务闪断容忍：轮询中途的网络/5xx 错误连续 MAX_STATUS_FAILURES 次才放弃，
  // 单次失败按原间隔重试（服务端 Envoy 网关瞬时 502 是常态）
  const MAX_STATUS_FAILURES = 3;
  let statusFailures = 0;
  while (true) {
    if (Date.now() > deadline) {
      const elapsedMinutes = Math.max(1, Math.round((Date.now() - startedAt) / 60000));
      throw new Redeem401Error(`redeem 登录 ${elapsedMinutes} 分钟未完成`, "REDEEM401_TIMEOUT");
    }
    let state;
    try {
      state = await client.status();
      statusFailures = 0;
    } catch (error) {
      statusFailures += 1;
      if (statusFailures >= MAX_STATUS_FAILURES) throw error;
      emitLogEvent(`status 轮询失败（${statusFailures}/${MAX_STATUS_FAILURES}）：${String(error.message).slice(0, 120)}，重试`);
      await sleep(pollIntervalMs);
      continue;
    }
    const track = findTrack(state, email);
    if (track) {
      sawTrack = true;
      onProgress({
        phase: String(track.phase || ""),
        detail: String(track.detail || track.error || ""),
      });
      if (String(track.phase) === "ok") return { ok: true, state };
      if (TERMINAL_PHASES.has(String(track.phase)) && String(track.phase) !== "ok") {
        return { ok: false, state, detail: String(track.detail || track.error || track.phase) };
      }
    }
    // 全局停止后以 history 为准：ok → 成功；否则若本邮箱从未出现/无成功记录 → 失败
    if (!state?.running) {
      const history = findHistoryEntry(state, email);
      if (history?.state === "ok") return { ok: true, state };
      const exportable = Array.isArray(state?.exportable?.emails)
        ? state.exportable.emails.map((e) => String(e).toLowerCase())
        : [];
      if (exportable.includes(email.toLowerCase())) return { ok: true, state };
      const queueEmpty = !state?.totals || Number(state.totals.queue) === 0;
      if (sawTrack || queueEmpty) {
        // 队列已空且无成功痕迹：要么提交被清（服务重启/被替换），要么中途轮询连接
        // 被负载均衡切到了别的后端（见过 track 后也凭空消失）——都先走补提交
        if (queueEmpty && onMissing && (await onMissing())) {
          await sleep(pollIntervalMs);
          continue;
        }
        // 补提交预算耗尽仍无成功痕迹：入队曾被确认 → 归因服务端丢弃/连接漂移
        if (queueEmpty && isEnqueueConfirmed()) {
          return {
            ok: false,
            state,
            detail: "服务接受了请求但任务未被执行（队列被清空或轮询连接漂移到无状态后端），补提交预算耗尽",
          };
        }
        return {
          ok: false,
          state,
          detail: String(history?.detail || track?.detail || track?.error || history?.state || "服务端未产出该账号的可用凭据"),
        };
      }
    }
    await sleep(pollIntervalMs);
  }
}

function describeFailure({ detail }) {
  const text = String(detail || "redeem 远程登录失败");
  return BANNED_MARKER_PATTERN.test(text) ? `${text} (account_deactivated)` : text;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeJsonAtomic(filePath, data, options = {}) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(
      tempPath,
      `${JSON.stringify(data, null, 2)}\n`,
      options.mode ? { mode: options.mode } : undefined,
    );
    JSON.parse(await fs.readFile(tempPath, "utf8"));
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

function mask(value) {
  if (!value) return "<none>";
  if (value.length <= 12) return "<redacted>";
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

run()
  .then(() => {
    emitEvent("exit", { ok: true });
  })
  .catch((error) => {
    emitErrorEvent(error);
    console.error(`[error] ${error.message}`);
    process.exitCode = 1;
  });
