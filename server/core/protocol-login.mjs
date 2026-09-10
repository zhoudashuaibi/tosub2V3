#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fetchSentinelToken } from "./sentinel.mjs";
import { fetchTotpCodeFromPickupUrl, msUntilNextTotpWindow } from "../lib/totp-pickup.js";
import {
  browserIdentityForTlsProfile,
  shouldUseTlsTransport,
  TlsFingerprintTransport,
} from "./tls-transport.mjs";

const DEFAULT_CHATGPT_BASE = "https://chatgpt.com";
const DEFAULT_AUTH_BASE = "https://auth.openai.com";
const DEFAULT_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEFAULT_CODEX_REDIRECT_URI = "http://localhost:1455/auth/callback";
const DEFAULT_OUT = "tmp/chatgpt-protocol-session.json";
const DEFAULT_SUB2API_OUT = "tmp/sub2api-import-oauth.json";
const DEFAULT_TOTP_RESULT = "tmp/chatgpt-totp-setup.json";
const DEFAULT_TIMEOUT_MS = 30_000;
// OAuth authorization code 生命周期仅数分钟：超过此时效的 callback_ready 恢复兑换注定 400
const OAUTH_CODE_MAX_AGE_MS = 10 * 60_000;

// ---------------------------------------------------------------------------
// v2 --json-events 模式（docs/v2/03-核心协议复用.md §8）
// 开启后：stdout 只输出 NDJSON 事件流；人类可读日志全部转 stderr；
// 人工输入点改为 stdin JSON 指令行（{"action":"input","value":...} 等）。
// 不带 --json-events 时本区块全部短路，保持 v1 交互 CLI 行为不变。
// ---------------------------------------------------------------------------
const JSON_EVENTS = {
  enabled: false,
  attempt: 1,
  stdinBuffer: "",
  stdinPending: [],
  stdinWaiters: [],
};

const EVENT_ERROR_CODES = [
  "PROXY_RISK_CONTROL",
  "PROXY_CONNECTION_RETRY",
  "REFRESH_TOKEN_INVALID",
  "UNEXPECTED_LOGIN_PAGE",
  "SESSION_SELECTION_INVALID",
  "CODEX_AUTH_LOGIN_REQUIRED",
  "PROFILE_SECURITY_CHECK_REQUIRED",
  "ACCOUNT_PROFILE_REQUIRED",
  "CHECKPOINT_INVALID",
  "SESSION_EXPIRED",
  "TOTP_ACCESS_TOKEN_MISSING",
  "TOTP_ENROLL_INVALID",
];

const RETRY_PROXY_CODES = new Set(["PROXY_RISK_CONTROL", "PROXY_CONNECTION_RETRY"]);
const RETRY_PROXY_ONCE_CODES = new Set(["UNEXPECTED_LOGIN_PAGE", "CHECKPOINT_INVALID", "SESSION_EXPIRED"]);

function emitEvent(type, fields = {}) {
  if (!JSON_EVENTS.enabled) return;
  const event = { type, ts: new Date().toISOString(), attempt: JSON_EVENTS.attempt, ...fields };
  try {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  } catch {}
}

function extractErrorCode(message) {
  const text = String(message || "");
  for (const code of EVENT_ERROR_CODES) {
    if (text.includes(code)) return code;
  }
  if (/Stopped before password/i.test(text)) return "PASSWORD_INVALID";
  if (/Stopped before email OTP/i.test(text)) return "EMAIL_OTP_INVALID";
  if (/Stopped before 2FA/i.test(text)) return "MFA_OTP_INVALID";
  if (/Stopped before phone/i.test(text)) return "ADD_PHONE_FAILED";
  if (/Too many email OTP resend/i.test(text)) return "OTP_RESEND_LIMITED";
  if (/add-phone\/send|phone_number/i.test(text) && /HTTP 4\d\d/.test(text)) return "ADD_PHONE_FAILED";
  return "INTERNAL";
}

function emitErrorEvent(error) {
  if (!JSON_EVENTS.enabled) return;
  const message = String(error?.message || "unknown error");
  const code = extractErrorCode(message);
  emitEvent("error", {
    code,
    message: message.slice(0, 800),
    fatal: true,
    retry_proxy: RETRY_PROXY_CODES.has(code) || RETRY_PROXY_ONCE_CODES.has(code),
  });
}

function emitStageEvent(stage) {
  emitEvent("stage", { stage });
}

function enableJsonEvents() {
  JSON_EVENTS.enabled = true;
  JSON_EVENTS.attempt = Math.max(1, Number.parseInt(process.env.TOSUB2_JOB_ATTEMPT || "1", 10) || 1);
  let sessionCounter = 0;
  console.log = (...args) => {
    const line = args.join(" ");
    const sessionMatch = /^\[proxy-session-attempt\]\s*(\S+)/.exec(line);
    if (sessionMatch) {
      sessionCounter += 1;
      emitEvent("proxy_session_attempt", { n: sessionCounter, session_id: sessionMatch[1] });
      return;
    }
    if (/^\[proxy-risk-retry\]/.test(line)) {
      emitEvent("risk_retry", { reason: "PROXY_RISK_CONTROL", retry_in_ms: 1000 });
    }
    process.stderr.write(`${line}\n`);
  };
  process.stdin.setEncoding("utf8");
  process.stdin.resume();
  process.stdin.on("data", (chunk) => {
    JSON_EVENTS.stdinBuffer += chunk;
    let newline;
    while ((newline = JSON_EVENTS.stdinBuffer.indexOf("\n")) >= 0) {
      const line = JSON_EVENTS.stdinBuffer.slice(0, newline).trim();
      JSON_EVENTS.stdinBuffer = JSON_EVENTS.stdinBuffer.slice(newline + 1);
      if (!line) continue;
      const waiter = JSON_EVENTS.stdinWaiters.shift();
      if (waiter) waiter(line);
      else JSON_EVENTS.stdinPending.push(line);
    }
  });
}

function readStdinLine() {
  const pending = JSON_EVENTS.stdinPending.shift();
  if (pending !== undefined) return Promise.resolve(pending);
  return new Promise((resolve) => {
    JSON_EVENTS.stdinWaiters.push(resolve);
  });
}

let pendingPhoneOverride = null;

/**
 * json-events 输入点：emit input_required → 等待 stdin JSON 指令 → emit input_accepted。
 * 返回值与 CLI 输入同构（验证码/密码/"r"/"p"/"q"），上层流程逻辑零改动。
 */
async function askJsonEvents(kind, { detail = "", canResend = false } = {}) {
  for (;;) {
    if (kind === "phone" && pendingPhoneOverride) {
      const value = pendingPhoneOverride;
      pendingPhoneOverride = null;
      return value;
    }
    emitEvent("input_required", { kind, detail, can_resend: canResend });
    const raw = await readStdinLine();
    let command;
    try {
      command = JSON.parse(raw);
    } catch {
      process.stderr.write(`[json-events] 忽略非法 stdin 输入：${String(raw).slice(0, 120)}\n`);
      continue;
    }
    const action = String(command?.action || "");
    if (action === "input") {
      const value = String(command?.value ?? "");
      emitEvent("input_accepted", { kind });
      return value;
    }
    if (action === "resend" && canResend) {
      emitEvent("input_accepted", { kind });
      return "r";
    }
    if (action === "change_phone" && (kind === "phone_otp" || kind === "phone")) {
      if (command?.value) pendingPhoneOverride = String(command.value);
      emitEvent("input_accepted", { kind });
      return kind === "phone_otp" ? "p" : String(command?.value ?? "");
    }
    if (action === "quit") {
      return "q";
    }
    process.stderr.write(`[json-events] 忽略未知指令：${action}\n`);
  }
}

/** 统一输入点：CLI 模式走 readline；json-events 模式走 stdin JSON 指令。 */
async function askInput(rl, prompt, kind, options = {}) {
  if (JSON_EVENTS.enabled) return askJsonEvents(kind, { detail: prompt.trim(), ...options });
  return (await rl.question(prompt)).trim();
}
const PROFILE_MIN_AGE = 20;
const PROFILE_MAX_AGE = 50;
const PROFILE_FIRST_NAMES = [
  "Alex", "Avery", "Blake", "Cameron", "Casey", "Drew", "Emerson", "Hayden",
  "Jamie", "Jordan", "Logan", "Morgan", "Parker", "Quinn", "Reese", "Taylor",
];
const PROFILE_LAST_NAMES = [
  "Adams", "Baker", "Brooks", "Carter", "Clark", "Collins", "Cooper", "Evans",
  "Foster", "Gray", "Hall", "Hayes", "Morgan", "Perry", "Reed", "Walker",
];
const HAR_ADD_PHONE_COOKIE_NAMES = new Set([
  "oai-login-csrf_dev_3772291445",
  "oai-did",
  "rg_context",
  "iss_context",
  "oaicom-stable-id",
  "_cfuvid",
  "cf_clearance",
  "__cf_bm",
  "auth_provider",
  "login_session",
  "hydra_redirect",
  "oai-client-auth-session",
  "oai-client-auth-info",
  "usc_o1a21GmV3HrblEv81QfM5Rd2",
  "unified_session_manifest",
  "auth-session-minimized",
  "auth-session-minimized-client-checksum",
  "__cflb",
  "oai-sc",
  "_dd_s",
]);
function userAgentForTransport(transport) {
  return browserIdentityForTransport(transport).userAgent;
}

function browserIdentityForTransport(transport) {
  return browserIdentityForTlsProfile(transport?.profile || "chrome146");
}

function browserHeadersForTransport(transport) {
  const identity = browserIdentityForTransport(transport);
  const headers = {
    "user-agent": identity.userAgent,
    "accept-language": identity.acceptLanguage,
  };
  if (!transport?.enabled) {
    headers["sec-ch-ua"] = identity.secChUa;
    headers["sec-ch-ua-mobile"] = identity.secChUaMobile;
    headers["sec-ch-ua-platform"] = identity.secChUaPlatform;
  }
  return headers;
}

class CookieJar {
  constructor(cookies = []) {
    this.cookies = Array.isArray(cookies)
      ? cookies.filter(isStoredCookie).map((cookie) => ({ ...cookie }))
      : [];
  }

  setFromResponse(url, headers) {
    for (const line of getSetCookie(headers)) {
      const cookie = parseSetCookie(line, url);
      if (!cookie) continue;
      const idx = this.cookies.findIndex(
        (item) =>
          item.name === cookie.name &&
          item.domain === cookie.domain &&
          item.path === cookie.path,
      );
      if (cookie.expires && cookie.expires <= Date.now()) {
        if (idx >= 0) this.cookies.splice(idx, 1);
        continue;
      }
      if (idx >= 0) this.cookies[idx] = cookie;
      else this.cookies.push(cookie);
    }
  }

  headerFor(url) {
    const target = new URL(url);
    const now = Date.now();
    this.cookies = this.cookies.filter((item) => !item.expires || item.expires > now);
    return this.cookies
      .filter((item) => cookieMatches(item, target))
      .map((item) => `${item.name}=${item.value}`)
      .join("; ");
  }

  namesFor(url) {
    const target = new URL(url);
    const now = Date.now();
    this.cookies = this.cookies.filter((item) => !item.expires || item.expires > now);
    return this.cookies
      .filter((item) => cookieMatches(item, target))
      .map((item) => item.name);
  }

  has(name) {
    return this.cookies.some((item) => item.name === name);
  }

  value(name, url = null) {
    const target = url ? new URL(url) : null;
    const found = this.cookies.find((item) => item.name === name && (!target || cookieMatches(item, target)));
    return found?.value || null;
  }

  merge(cookies) {
    for (const rawCookie of Array.isArray(cookies) ? cookies : []) {
      if (!isStoredCookie(rawCookie)) continue;
      const cookie = { ...rawCookie, domain: rawCookie.domain.replace(/^\./, "").toLowerCase() };
      const idx = this.cookies.findIndex(
        (item) => item.name === cookie.name && item.domain === cookie.domain && item.path === cookie.path,
      );
      if (cookie.expires && cookie.expires <= Date.now()) {
        if (idx >= 0) this.cookies.splice(idx, 1);
      } else if (idx >= 0) this.cookies[idx] = cookie;
      else this.cookies.push(cookie);
    }
  }

  toJSON() {
    return this.cookies;
  }

  static fromJSON(cookies) {
    return new CookieJar(cookies);
  }
}

class ProtocolClient {
  constructor(options = {}) {
    this.jar = options.jar || new CookieJar();
    this.verbose = Boolean(options.verbose);
    this.debugAuth = Boolean(options.debugAuth);
    this.transport = options.transport || null;
  }

  async rawFetch(url, options = {}) {
    if (this.transport) return this.transport.fetch(url, { ...options, retryRiskControl: true });
    return fetch(url, options);
  }

  async request(method, url, options = {}) {
    const targetUrl = new URL(url);
    const headers = new Headers(options.headers || {});
    for (const [name, value] of Object.entries(browserHeadersForTransport(this.transport))) {
      headers.set(name, value);
    }
    if (options.userAgent) headers.set("user-agent", options.userAgent);

    if (!headers.has("accept")) {
      headers.set("accept", options.accept || "application/json, text/plain, */*");
    }
    if (options.referer) headers.set("referer", options.referer);
    if (options.origin) headers.set("origin", options.origin);

    const cookie = this.jar.headerFor(url);
    if (cookie) headers.set("cookie", cookie);

    if (
      method !== "GET" &&
      (targetUrl.hostname === "auth.openai.com" || targetUrl.pathname.startsWith("/api/accounts/"))
    ) {
      headers.set("x-access-flow-invocation-id", crypto.randomUUID());
      headers.set("sec-fetch-site", "same-origin");
      headers.set("sec-fetch-mode", "cors");
      headers.set("sec-fetch-dest", "empty");
      headers.set("priority", "u=1, i");
      if (options.json) headers.set("accept", "application/json");
    }

    let body = options.body;
    if (options.json) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(options.json);
    } else if (options.form) {
      headers.set("content-type", "application/x-www-form-urlencoded");
      body = new URLSearchParams(options.form).toString();
    }

    if (this.verbose) {
      console.error(`> ${method} ${safeUrl(url)}`);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs || DEFAULT_TIMEOUT_MS);
    let res;
    let text;
    try {
      res = await this.rawFetch(url, {
        method,
        headers,
        body,
        redirect: "manual",
        signal: controller.signal,
        timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
      });
      this.jar.setFromResponse(url, res.headers);
      this.jar.merge(res.headers.transportCookies);
      text = await res.text();
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error(`${method} ${safeUrl(url)} timed out after ${options.timeoutMs || DEFAULT_TIMEOUT_MS}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    const location = res.headers.get("location");
    if (this.verbose) {
      const suffix = location ? ` -> ${safeUrl(new URL(location, url).toString())}` : "";
      console.error(`< ${method} ${safeUrl(url)} ${res.status}${suffix}`);
    }

    if (isRiskControlResponse(res, text)) {
      throw new Error(
        `PROXY_RISK_CONTROL: ${method} ${safeUrl(url)} returned HTTP ${res.status} with a security-check page`,
      );
    }

    return { res, text, location: location ? new URL(location, url).toString() : null, url };
  }

  async follow(url, options = {}) {
    let current = url;
    let last = null;
    for (let i = 0; i < (options.maxRedirects || 12); i += 1) {
      if (isLocalCallback(current)) return { finalUrl: current, last };
      last = await this.request("GET", current, {
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        referer: options.referer,
      });
      if (last.res.status >= 400) assertOk(last, `GET ${current}`);
      if (![301, 302, 303, 307, 308].includes(last.res.status) || !last.location) {
        return { finalUrl: current, last };
      }
      current = last.location;
    }
    throw new Error(`Too many redirects from ${url}`);
  }

  async getJson(method, url, options = {}) {
    const result = await this.request(method, url, options);
    assertOk(result, `${method} ${url}`);
    try {
      return { data: JSON.parse(result.text), result };
    } catch {
      throw new Error(`Expected JSON from ${url}, got: ${result.text.slice(0, 160)}`);
    }
  }
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  if (args.jsonEvents) enableJsonEvents();

  const chatgptBase = trimSlash(args.chatgptBase || process.env.CHATGPT_BASE || DEFAULT_CHATGPT_BASE);
  const authBase = trimSlash(args.authBase || process.env.AUTH_BASE || DEFAULT_AUTH_BASE);
  const outputMode = args.outputMode || "both";
  if (!["both", "session", "sub2api"].includes(outputMode)) {
    throw new Error("--output-mode must be one of: both, session, sub2api");
  }
  const outPath = path.resolve(args.out || DEFAULT_OUT);
  const sub2apiOutPath = path.resolve(args.sub2apiOut || DEFAULT_SUB2API_OUT);
  const proxyTemplate = normalizeProxyUrl(args.proxy || process.env.CHATGPT_PROXY_URL);
  const transport = new TlsFingerprintTransport({
    enabled: shouldUseTlsTransport({ chatgptBase, authBase, nativeHttp: args.nativeHttp }),
    profile:
      args.tlsProfile
      || process.env.TOSUB2_TLS_PROFILE
      || (proxyTemplate || args.refreshSub2api ? "chrome146" : "auto"),
    verbose: Boolean(args.verbose),
    maxProxySessionAttempts: process.env.CHATGPT_PROXY_MAX_ATTEMPTS || 10,
    sameProxyRiskRetryDelayMs: process.env.CHATGPT_SAME_PROXY_RISK_RETRY_DELAY_MS,
  });
  try {
    if (args.refreshSub2api) {
      emitEvent("starting", {
        mode: "refresh",
        email: await guessRefreshEmail(args.refreshSub2api),
      });
      emitStageEvent("refreshing");
      if (proxyTemplate) await transport.prepareProxy(proxyTemplate, `${authBase}/`);
      else await transport.configure(null, { force: true });
      const sourcePath = path.resolve(args.refreshSub2api);
      const targetPath = path.resolve(args.sub2apiOut || sourcePath);
      const refreshed = await refreshSub2apiOauthExport({
        authBase,
        sourcePath,
        targetPath,
        fallbackClientId: args.codexClientId || DEFAULT_CODEX_CLIENT_ID,
        transport,
      });
      console.log(`[ok] Saved sub2api import: ${targetPath}`);
      console.log(`[ok] Refreshed OAuth account: ${refreshed.email || "<unknown>"}`);
      emitEvent("result_saved", {
        path: targetPath,
        account: { email: refreshed.email || "" },
      });
      return;
    }
    if (!args.setupTotp) emitEvent("starting", { mode: "full", email: args.email || "" });
    // 2FA 在线取件 URL 由启动方（引擎 launcher）按 设置模板+账号取件码 解析后注入
    const totpPickupUrl = process.env.CHATGPT_TOTP_PICKUP_URL || "";
    await transport.prepareProxy(proxyTemplate, `${chatgptBase}/`);
    if (args.setupTotp) {
      const resultPath = path.resolve(args.totpResult || DEFAULT_TOTP_RESULT);
      emitEvent("starting", { mode: "totp_setup", email: args.email || "" });
      const rl = args.jsonEvents ? null : readline.createInterface({ input, output });
      try {
        const client = new ProtocolClient({ verbose: args.verbose, transport });
        const email = args.email || (await askInput(rl, "Email: ", "email"));
        if (!email) throw new Error("Email is required");
        console.log("[1/3] Sign in to verify the account before setting 2FA");
        emitStageEvent("web_login");
        const web = await loginChatgptWeb(client, {
          chatgptBase,
          authBase,
          email,
          rl,
          password: process.env.CHATGPT_LOGIN_PASSWORD || "",
          totpSecret: process.env.CHATGPT_TOTP_SECRET || "",
          totpPickupUrl,
        });
        console.log(
          client.jar.has("__Secure-next-auth.session-token")
            ? "[ok] ChatGPT web session cookie received"
            : "[warn] ChatGPT session cookie not found; continue with auth cookies",
        );
        await setupChatgptTotp(client, {
          chatgptBase,
          email,
          rl,
          deviceId: web.deviceId,
          resultPath,
        });
      } finally {
        if (rl) rl.close();
      }
      return;
    }
    const rl = args.jsonEvents ? null : readline.createInterface({ input, output });
    const checkpointPath = path.resolve(args.checkpoint || args.resumeCheckpoint || `${sub2apiOutPath}.checkpoint.json`);
    try {
    let client = null;
    let email = args.email || "";
    let web = null;
    let codex = null;
    const codexOptions = {
      authBase,
      rl,
      phone: args.phone,
      codexClientId: args.codexClientId || DEFAULT_CODEX_CLIENT_ID,
      codexRedirectUri: args.codexRedirectUri || DEFAULT_CODEX_REDIRECT_URI,
      debugAuth: Boolean(args.debugAuth),
    };
    let checkpoint = null;

    if (args.resumeCheckpoint) {
      try {
        checkpoint = await readProtocolCheckpoint(path.resolve(args.resumeCheckpoint));
      } catch (error) {
        if (error?.code !== "ENOENT") {
          console.log("[resume] Saved login checkpoint is unreadable; restarting email login.");
          await removeProtocolCheckpoint(checkpointPath);
        }
      }
    }
    if (checkpoint && args.webOnly) checkpoint = null;

    let freshLoginRestartCount = 0;
    let finalizeRestartCount = 0;
    flowLoop: while (true) {
      if (checkpoint && !args.webOnly) {
        email = checkpoint.email || email;
        client = new ProtocolClient({ verbose: args.verbose, jar: CookieJar.fromJSON(checkpoint.cookies), transport });
        const saveCheckpoint = createCheckpointWriter(checkpointPath, {
          client,
          email,
          chatgptBase,
          authBase,
        });
        console.log(`[resume] Continue saved login flow from ${checkpoint.stage}.`);
        try {
          codex = await resumeCodexOauth(client, { ...codexOptions, saveCheckpoint }, checkpoint);
          emitEvent("resume_used", { stage: checkpoint.stage });
          web = checkpoint.web || null;
        } catch (error) {
          if (isSecurityCheckRequiredError(error)) throw error;
          if (!isExpiredCheckpointError(error)) throw error;
          console.log("[auth-expired] Saved login state expired; restarting email login.");
          await removeProtocolCheckpoint(checkpointPath);
          checkpoint = null;
          client = null;
          codex = null;
          await transport.prepareProxy(proxyTemplate, `${chatgptBase}/`);
        }
      }

      while (!checkpoint && !codex) {
        client = new ProtocolClient({ verbose: args.verbose, transport });
        email = email || (await askInput(rl, "Email: ", "email"));
        if (!email) throw new Error("Email is required");

        console.log("[1/5] Start ChatGPT web login");
        emitStageEvent("web_login");
        web = await loginChatgptWeb(client, {
          chatgptBase,
          authBase,
          email,
          rl,
          password: process.env.CHATGPT_LOGIN_PASSWORD || "",
          totpSecret: process.env.CHATGPT_TOTP_SECRET || "",
          totpPickupUrl,
        });
        console.log(
          client.jar.has("__Secure-next-auth.session-token")
            ? "[ok] ChatGPT web session cookie received"
            : "[warn] ChatGPT session cookie not found; continue with auth cookies",
        );

        const saveCheckpoint = createCheckpointWriter(checkpointPath, {
          client,
          email,
          chatgptBase,
          authBase,
          web,
        });
        await saveCheckpoint("email_verified", {});
        console.log("[checkpoint] Saved verified email login state.");

        if (!args.webOnly) {
          console.log("[2/5] Start Codex OAuth flow");
          emitStageEvent("oauth");
          try {
            codex = await runCodexOauth(client, { ...codexOptions, saveCheckpoint });
          } catch (error) {
            if (isSecurityCheckRequiredError(error)) throw error;
            if (!isExpiredCheckpointError(error)) throw error;
            await removeProtocolCheckpoint(checkpointPath);
            if (freshLoginRestartCount >= 1) throw error;
            freshLoginRestartCount += 1;
            console.log("[auth-expired] Newly verified login state was rejected; restarting email login once.");
            client = null;
            web = null;
            codex = null;
            await transport.prepareProxy(proxyTemplate, `${chatgptBase}/`);
            continue;
          }
        }
        break;
      }

      if (outputMode !== "sub2api") {
        await writeJsonAtomic(outPath, {
          generated_at: new Date().toISOString(),
          chatgpt_base: chatgptBase,
          auth_base: authBase,
          warning: "This file contains login cookies and OAuth data. Do not share it.",
          cookies: client.jar.toJSON(),
          web,
          codex,
        });
        console.log(`[ok] Saved session data: ${outPath}`);
      }

      if (codex?.callbackUrl) {
        console.log("[ok] Codex callback URL:");
        console.log(codex.callbackUrl);
      }
      if (codex?.callbackUrl && codex?.codeVerifier && !args.noSub2apiExport && outputMode !== "session") {
        console.log("[6/6] Convert OAuth callback to sub2api import");
        emitStageEvent("finalizing");
        let sub2apiExport;
        try {
          sub2apiExport = await buildSub2apiOauthExport({
            authBase,
            callbackUrl: codex.callbackUrl,
            codeVerifier: codex.codeVerifier,
            clientId: args.codexClientId || DEFAULT_CODEX_CLIENT_ID,
            redirectUri: args.codexRedirectUri || DEFAULT_CODEX_REDIRECT_URI,
            accountName: args.sub2apiName,
            concurrency: args.concurrency,
            priority: args.priority,
            rateMultiplier: args.rateMultiplier,
            transport,
            cookie: client.jar.headerFor(authBase),
          });
        } catch (error) {
          if (isExpiredCheckpointError(error)) {
            await removeProtocolCheckpoint(checkpointPath);
            if (finalizeRestartCount < 1) {
              finalizeRestartCount += 1;
              console.log("[auth-expired] Saved OAuth code is no longer exchangeable; restarting a fresh email login.");
              checkpoint = null;
              client = null;
              web = null;
              codex = null;
              await transport.prepareProxy(proxyTemplate, `${chatgptBase}/`);
              continue flowLoop;
            }
          }
          throw error;
        }
        await writeJsonAtomic(sub2apiOutPath, sub2apiExport.data);
        await removeProtocolCheckpoint(checkpointPath);
        console.log(`[ok] Saved sub2api import: ${sub2apiOutPath}`);
        console.log(`[ok] Account: ${sub2apiExport.account.name}`);
        console.log(`[ok] Email: ${sub2apiExport.account.credentials.email || "<unknown>"}`);
        console.log(`[ok] chatgpt_account_id: ${mask(sub2apiExport.account.credentials.chatgpt_account_id)}`);
        console.log(`[ok] chatgpt_user_id: ${mask(sub2apiExport.account.extra.chatgpt_user_id)}`);
        console.log("[note] sub2api import JSON contains access_token, refresh_token and id_token. Do not share it.");
        emitEvent("result_saved", {
          path: sub2apiOutPath,
          account: {
            email: sub2apiExport.account.credentials.email || "",
            name: sub2apiExport.account.name,
            chatgpt_account_id: sub2apiExport.account.credentials.chatgpt_account_id || "",
          },
        });
      } else if (outputMode === "sub2api") {
        throw new Error("Cannot output only sub2api import without Codex OAuth. Remove --web-only and --no-sub2api-export.");
      } else if (args.webOnly) {
        await removeProtocolCheckpoint(checkpointPath);
      }
      break flowLoop;
    }
    } finally {
      if (rl) rl.close();
    }
  } finally {
    await transport.close();
  }
}

async function setupChatgptTotp(client, { chatgptBase, email, rl, deviceId, resultPath }) {
  console.log("[2/3] Check current 2FA status");
  const enablePage = await client.follow(`${chatgptBase}/?action=enable&factor=totp`, {
    referer: `${chatgptBase}/`,
  });
  const accessToken = extractChatgptAccessToken(enablePage.last?.text || "");
  if (!accessToken) {
    throw new Error("TOTP_ACCESS_TOKEN_MISSING: Could not read the current ChatGPT access token");
  }

  const infoUrl = `${chatgptBase}/backend-api/accounts/mfa_info`;
  const { data: currentInfo } = await client.getJson("GET", infoUrl, {
    headers: chatgptMfaHeaders({ chatgptBase, accessToken, deviceId }, "/backend-api/accounts/mfa_info"),
    referer: `${chatgptBase}/`,
  });
  if (hasEnabledTotp(currentInfo)) {
    await writePrivateJson(resultPath, { version: 1, already_enabled: true, email });
    console.log("[2fa-already-enabled] This account already has TOTP 2FA enabled.");
    emitEvent("totp_secret", { secret: null, already_enabled: true });
    return;
  }

  const { data: enrollment } = await client.getJson(
    "POST",
    `${chatgptBase}/backend-api/accounts/mfa/enroll`,
    {
      headers: chatgptMfaHeaders({ chatgptBase, accessToken, deviceId }, "/backend-api/accounts/mfa/enroll"),
      origin: chatgptBase,
      referer: `${chatgptBase}/`,
      json: { factor_type: "totp" },
    },
  );
  const secret = normalizeEnrolledTotpSecret(enrollment?.secret);
  const sessionId = typeof enrollment?.session_id === "string" ? enrollment.session_id : "";
  if (!secret || !sessionId) {
    throw new Error("TOTP_ENROLL_INVALID: The 2FA enrollment response did not include a valid key and session ID");
  }
  const otpauthUri = buildTotpUri(email, secret);
  await writePrivateJson(resultPath, {
    version: 1,
    already_enabled: false,
    activation_mode: "automatic",
    activation_succeeded: false,
    email,
    secret,
    otpauth_uri: otpauthUri,
  });
  console.log("[2fa-setup-ready] 2FA key created; activating it automatically.");
  emitEvent("totp_secret", { secret });

  console.log("[3/3] Activate TOTP 2FA");
  let code = generateTotp(secret);
  let generatedFromSecret = true;
  console.log("[2fa] Generated a current 6-digit activation code from the new 2FA key.");
  for (;;) {
    try {
      const { data: activation } = await client.getJson(
        "POST",
        `${chatgptBase}/backend-api/accounts/mfa/user/activate_enrollment`,
        {
          headers: chatgptMfaHeaders({
            chatgptBase,
            accessToken,
            deviceId,
          }, "/backend-api/accounts/mfa/user/activate_enrollment"),
          origin: chatgptBase,
          referer: `${chatgptBase}/`,
          json: { code, factor_type: "totp", session_id: sessionId },
        },
      );
      if (activation?.success === true) {
        await writePrivateJson(resultPath, {
          version: 1,
          already_enabled: false,
          activation_mode: "automatic",
          activation_succeeded: true,
          activated_at: new Date().toISOString(),
          email,
          secret,
          otpauth_uri: otpauthUri,
        });
        break;
      }
      console.log(
        generatedFromSecret
          ? "[warn] The automatically generated 2FA setup code was rejected; enter a current code manually."
          : "[warn] 2FA setup code was rejected; enter a new code or type q to quit.",
      );
    } catch (error) {
      if (!/activate_enrollment failed with HTTP 400/i.test(String(error?.message || ""))) throw error;
      console.log(
        generatedFromSecret
          ? "[warn] The automatically generated 2FA setup code was rejected; enter a current code manually."
          : "[warn] 2FA setup code was rejected; enter a new code or type q to quit.",
      );
    }
    generatedFromSecret = false;
    code = await askSetupTotpOtp(rl);
  }
  try {
    const { data: confirmedInfo } = await client.getJson("GET", infoUrl, {
      headers: chatgptMfaHeaders({ chatgptBase, accessToken, deviceId }, "/backend-api/accounts/mfa_info"),
      referer: `${chatgptBase}/`,
    });
    if (!hasEnabledTotp(confirmedInfo)) {
      console.log("[warn] 2FA activation succeeded, but the follow-up status response did not confirm it.");
    }
  } catch (error) {
    console.log(`[warn] 2FA activation succeeded, but the follow-up status check failed: ${error.message}`);
  }
  console.log("[ok] 2FA setup activated");
  emitEvent("result_saved", { path: resultPath, account: { email } });
}

function chatgptMfaHeaders({ chatgptBase, accessToken, deviceId }, targetPath) {
  return {
    authorization: `Bearer ${accessToken}`,
    "oai-device-id": deviceId,
    "oai-session-id": crypto.randomUUID(),
    "oai-language": "zh-CN",
    "x-openai-target-path": targetPath,
    "x-openai-target-route": targetPath,
    origin: chatgptBase,
  };
}

function extractChatgptAccessToken(html) {
  const sources = [String(html || ""), decodeHtml(String(html || ""))];
  for (const source of sources) {
    const match = /["']accessToken["']\s*:\s*"((?:\\.|[^"\\])+)"/.exec(source);
    if (!match) continue;
    try {
      const value = JSON.parse(`"${match[1]}"`);
      if (typeof value === "string" && value.length >= 20) return value;
    } catch {}
  }
  return null;
}

function normalizeEnrolledTotpSecret(value) {
  const normalized = String(value || "").toUpperCase().replace(/[\s=]/g, "");
  return /^[A-Z2-7]{16,128}$/.test(normalized) ? normalized : "";
}

function buildTotpUri(email, secret) {
  const label = encodeURIComponent(`OpenAI:${email}`);
  const query = new URLSearchParams({ secret, issuer: "OpenAI", algorithm: "SHA1", digits: "6", period: "30" });
  return `otpauth://totp/${label}?${query.toString()}`;
}

function hasEnabledTotp(info) {
  return Boolean(
    info?.mfa_enabled_v2
    && Array.isArray(info?.factors?.totp)
    && info.factors.totp.some((factor) => factor?.factor_type === "totp" || factor?.id),
  );
}

async function askSetupTotpOtp(rl) {
  for (;;) {
    const value = await askInput(rl, "2FA setup OTP (6 digits, q=quit): ", "totp_setup_otp");
    if (value.toLowerCase() === "q") throw new Error("Stopped before 2FA setup activation");
    if (/^\d{6}$/.test(value)) return value;
    console.log("[warn] 2FA setup OTP should be exactly 6 digits.");
  }
}

async function loginChatgptWeb(client, { chatgptBase, authBase, email, rl, password, totpSecret, totpPickupUrl }) {
  await client.follow(`${chatgptBase}/`, { referer: `${chatgptBase}/` });
  await client.getJson("GET", `${chatgptBase}/api/auth/providers`, {
    referer: `${chatgptBase}/`,
  });

  const { data: csrf } = await client.getJson("GET", `${chatgptBase}/api/auth/csrf`, {
    referer: `${chatgptBase}/`,
  });
  if (!csrf.csrfToken) throw new Error("Missing csrfToken");
  if (!client.jar.has("__Host-next-auth.csrf-token")) {
    throw new Error("Missing __Host-next-auth.csrf-token cookie; open the ChatGPT home page first or retry.");
  }

  const deviceId = client.jar.value("oai-did", `${chatgptBase}/`) || crypto.randomUUID();
  const authSessionLoggingId = crypto.randomUUID();
  const signinUrl =
    `${chatgptBase}/api/auth/signin/openai?` +
    new URLSearchParams({
      prompt: "login",
      "ext-oai-did": deviceId,
      auth_session_logging_id: authSessionLoggingId,
      screen_hint: "login_or_signup",
      login_hint: email,
    }).toString();

  const { data: signin } = await client.getJson("POST", signinUrl, {
    origin: chatgptBase,
    referer: `${chatgptBase}/`,
    form: {
      callbackUrl: `${chatgptBase}/`,
      csrfToken: csrf.csrfToken,
      json: "true",
    },
  });
  if (!signin.url) throw new Error("signin/openai did not return url");

  const authPage = await client.follow(signin.url, { referer: `${chatgptBase}/` });
  console.log(`[info] Auth page: ${safeUrl(authPage.finalUrl)}`);
  if (authPage.last?.text) {
    console.log(`[info] Page text: ${summarizeHtml(authPage.last.text)}`);
    // 诊断钩子：TOSUB2_DEBUG_AUTH_HTML=<path> 时把认证页原始 HTML 落盘
    const htmlDumpPath = process.env.TOSUB2_DEBUG_AUTH_HTML;
    if (htmlDumpPath) {
      fs.writeFile(path.resolve(htmlDumpPath), authPage.last.text).catch(() => {});
    }
  }

  let authenticated;
  let loginMethod;
  if (isPasswordLoginPage(authPage.finalUrl)) {
    if (!password) {
      // 未配置 ChatGPT 密码（如仅凭 Outlook 收件凭据导入的备用池账号）：
      // 先尝试把会话切换为邮箱一次性验证码登录；失败再回退人工输入密码
      const otpReferer = await switchPasswordPageToEmailOtp(client, { authBase, referer: authPage.finalUrl });
      if (otpReferer) {
        loginMethod = "email_otp";
        console.log("[3/5] No password configured; switched to email one-time-code login.");
        emitStageEvent("email_otp");
        authenticated = await verifyEmailOtp(client, {
          authBase,
          rl,
          referer: otpReferer,
        });
      } else {
        loginMethod = "password";
        console.log("[3/5] Password login page reached.");
        emitStageEvent("password");
        authenticated = await verifyPassword(client, {
          authBase,
          rl,
          password,
          referer: authPage.finalUrl,
        });
      }
    } else {
      loginMethod = "password";
      console.log("[3/5] Password login page reached.");
      emitStageEvent("password");
      authenticated = await verifyPassword(client, {
        authBase,
        rl,
        password,
        referer: authPage.finalUrl,
      });
    }
  } else if (isEmailVerificationPage(authPage.finalUrl)) {
    loginMethod = "email_otp";
    console.log("[3/5] Email OTP page reached. Enter code, or type r to resend.");
    emitStageEvent("email_otp");
    authenticated = await verifyEmailOtp(client, {
      authBase,
      rl,
      referer: authPage.finalUrl,
    });
  } else if (isCompletedChatgptLoginPage(authPage.finalUrl, chatgptBase, client)) {
    loginMethod = "existing_session";
    authenticated = { continue_url: authPage.finalUrl };
    console.log("[3/5] Existing ChatGPT web session accepted.");
  } else {
    let pathname = authPage.finalUrl;
    try {
      pathname = new URL(authPage.finalUrl).pathname;
    } catch {}
    throw new Error(`UNEXPECTED_LOGIN_PAGE: Expected password or email verification, received ${pathname}`);
  }

  const mfaRequired = isMfaChallengePayload(authenticated);
  authenticated = await completeTotpMfaIfNeeded(client, {
    authBase,
    rl,
    payload: authenticated,
    totpSecret,
    totpPickupUrl,
    referer: authPage.finalUrl,
  });
  authenticated = await completeAccountProfileIfNeeded(client, {
    authBase,
    deviceId,
    payload: authenticated,
  });
  authenticated = await selectChatgptLoginWorkspaceIfNeeded(client, {
    authBase,
    payload: authenticated,
  });
  const callback = await continueFlow(client, authenticated);
  return {
    deviceId,
    authSessionLoggingId,
    callbackUrl: callback?.finalUrl || null,
    emailVerified: true,
    loginMethod,
    mfaVerified: mfaRequired,
  };
}

async function selectChatgptLoginWorkspaceIfNeeded(client, { authBase, payload }) {
  if (!isWorkspaceSelectionPayload(payload)) return payload;
  const workspaceId = pickWorkspaceId(payload);
  if (!workspaceId) {
    console.log("[web] Workspace page did not include a selectable workspace; skipping selection.");
    return payload;
  }
  emitStageEvent("workspace");
  const workspaceUrl = getContinueUrl(payload) || `${authBase}/workspace`;
  console.log("[web] Select ChatGPT login workspace");
  const { data } = await authJsonStep(client, authBase, "POST", "/api/accounts/workspace/select", {
    workspace_id: workspaceId,
  }, { referer: workspaceUrl });
  return data;
}

/**
 * 密码页 → 邮箱一次性验证码登录：提交密码页隐藏表单 intent=passwordless_login_send_otp
 * （对应网页上「使用一次性代码登录」按钮），服务端会向账号邮箱发送 6 位验证码。
 * 切换成功返回验证码页 URL（作为后续 validate 的 referer），失败返回 null（回退密码流程）。
 */
async function switchPasswordPageToEmailOtp(client, { authBase, referer }) {
  try {
    const result = await client.request("POST", `${authBase}/log-in/password`, {
      origin: authBase,
      referer,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      headers: {
        // 表单导航式提交（等价浏览器点击「使用一次性代码登录」按钮提交隐藏表单）
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "same-origin",
        "sec-fetch-user": "?1",
        "upgrade-insecure-requests": "1",
      },
      form: { intent: "passwordless_login_send_otp" },
    });
    if (result.res.status >= 400) {
      console.log(
        `[warn] Email one-time-code switch rejected (HTTP ${result.res.status}: ${String(result.text || "").slice(0, 160)}); falling back to password input.`,
      );
      return null;
    }
    let finalUrl = result.location || `${authBase}/log-in/password`;
    let pageText = result.text || "";
    if (result.location) {
      const page = await client.follow(result.location, { referer });
      finalUrl = page.finalUrl;
      pageText = page.last?.text || "";
    }
    const looksLikeOtpPage =
      isEmailVerificationPage(finalUrl) || /验证码|one-time code|verification code|enter.{0,20}code/i.test(summarizeHtml(pageText));
    if (!looksLikeOtpPage) {
      console.log(`[warn] Email one-time-code switch landed on ${safeUrl(finalUrl)}; falling back to password input.`);
      return null;
    }
    console.log("[ok] Email one-time-code login requested; a 6-digit code has been sent to the mailbox.");
    return finalUrl;
  } catch (error) {
    console.log(`[warn] Email one-time-code switch failed (${error.message}); falling back to password input.`);
    return null;
  }
}

async function verifyPassword(client, { authBase, rl, password, referer }) {  let nextPassword = password;
  for (;;) {
    const value = nextPassword || (await askInput(rl, "Password (q=quit): ", "password"));
    nextPassword = "";
    if (!value || value.toLowerCase() === "q") throw new Error("Stopped before password validation");
    try {
      const { data } = await authJsonStep(client, authBase, "POST", "/api/accounts/password/verify", {
        password: value,
      }, { referer });
      console.log("[ok] Password accepted");
      return data;
    } catch (error) {
      if (!/HTTP 401|invalid.*password|incorrect.*password/i.test(String(error?.message || ""))) throw error;
      console.log("[warn] Password was rejected. Enter it again, or q to quit.");
    }
  }
}

async function completeTotpMfaIfNeeded(client, { authBase, rl, payload, totpSecret, totpPickupUrl, referer }) {
  if (!isMfaChallengePayload(payload)) return payload;
  const factor = pickTotpFactor(payload);
  if (!factor?.id) throw new Error("2FA is required, but the response does not contain a TOTP factor ID");

  console.log("[mfa] TOTP 2FA challenge reached.");
  emitStageEvent("mfa_otp");
  await authJsonStep(client, authBase, "POST", "/api/accounts/mfa/issue_challenge", {
    type: "totp",
    id: factor.id,
    force_fresh_challenge: false,
  }, { referer });

  // 验证码来源优先级：本地 2FA 密钥 > 在线取件 URL（2fa.show 等）> 人工输入
  let code;
  let codeSource; // "secret" | "pickup" | "manual"
  if (totpSecret) {
    code = generateTotp(totpSecret);
    codeSource = "secret";
    console.log("[mfa] Generated a 6-digit code from the configured 2FA key.");
  } else if (totpPickupUrl) {
    codeSource = "pickup";
    try {
      code = await fetchTotpCodeFromPickupUrl(totpPickupUrl);
      console.log("[mfa] Fetched a 6-digit code from the 2FA pickup URL.");
    } catch (error) {
      console.log(`[warn] 2FA pickup fetch failed (${error.message}); falling back to manual input.`);
      code = await askTotpOtp(rl);
      codeSource = "manual";
    }
  } else {
    code = await askTotpOtp(rl);
    codeSource = "manual";
  }

  const challengeUrl = getContinueUrl(payload) || `${authBase}/mfa-challenge/${factor.id}`;
  let pickupRetries = 0;
  for (;;) {
    try {
      const { data } = await authJsonStep(client, authBase, "POST", "/api/accounts/mfa/verify", {
        type: "totp",
        id: factor.id,
        code,
      }, { referer: challengeUrl });
      console.log("[ok] 2FA verification accepted");
      return data;
    } catch (error) {
      const message = String(error?.message || "");
      // 429 限流：把限流当"错码"继续重试只会加剧限流，直接失败（任务层稍后可重试）
      if (/HTTP 429/.test(message)) throw error;
      if (!/HTTP (400|401)|invalid.*(?:totp|code)|incorrect.*code/i.test(message)) throw error;
      if (codeSource === "pickup" && pickupRetries < 3) {
        // 被拒通常意味着取到的码已过窗口：等下一个 30s 窗口换新码重试
        pickupRetries += 1;
        const waitMs = msUntilNextTotpWindow();
        console.log(
          `[warn] The fetched 2FA code was rejected; waiting ${Math.round(waitMs / 1000)}s for the next code window (retry ${pickupRetries}/3).`,
        );
        await sleep(waitMs);
        try {
          code = await fetchTotpCodeFromPickupUrl(totpPickupUrl);
          continue;
        } catch (fetchError) {
          console.log(`[warn] 2FA pickup refetch failed (${fetchError.message}); falling back to manual input.`);
        }
      } else if (codeSource === "secret") {
        console.log("[warn] The code generated from the configured 2FA key was rejected; enter a current code manually.");
      } else {
        console.log("[warn] The 2FA code was rejected; enter a new code.");
      }
      codeSource = "manual";
      code = await askTotpOtp(rl);
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPasswordLoginPage(url) {
  try {
    return new URL(url).pathname === "/log-in/password";
  } catch {
    return false;
  }
}

function isEmailVerificationPage(url) {
  try {
    return new URL(url).pathname === "/email-verification";
  } catch {
    return false;
  }
}

function isCompletedChatgptLoginPage(url, chatgptBase, client) {
  try {
    const current = new URL(url);
    const expected = new URL(chatgptBase);
    return current.origin === expected.origin
      && current.pathname === "/"
      && client.jar.has("__Secure-next-auth.session-token");
  } catch {
    return false;
  }
}

function isMfaChallengePayload(payload) {
  if (payload?.page?.type === "mfa_challenge") return true;
  try {
    return new URL(getContinueUrl(payload)).pathname.startsWith("/mfa-challenge/");
  } catch {
    return false;
  }
}

function isWorkspaceSelectionPayload(payload) {
  if (payload?.page?.type === "workspace") return true;
  try {
    return new URL(getContinueUrl(payload)).pathname === "/workspace";
  } catch {
    return false;
  }
}

function isAccountProfileRequired(payload) {
  if (payload?.page?.type === "about_you") return true;
  try {
    return new URL(getContinueUrl(payload)).pathname === "/about-you";
  } catch {
    return false;
  }
}

async function completeAccountProfileIfNeeded(client, { authBase, deviceId, payload }) {
  if (!isAccountProfileRequired(payload)) return payload;

  const profile = generateAccountProfile();
  const profileUrl = getContinueUrl(payload) || `${authBase}/about-you`;
  emitStageEvent("about_you");
  console.log(
    `[profile] Account profile is incomplete; generating a name and an age between ${PROFILE_MIN_AGE} and ${PROFILE_MAX_AGE}.`,
  );
  console.log("[sentinel] Requesting a fresh security token for account profile creation.");
  let sentinelToken;
  try {
    sentinelToken = await fetchSentinelToken({
      flow: "oauth_create_account",
      deviceID: deviceId,
      fetch: (url, options) => client.rawFetch(url, {
        ...options,
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
        timeoutMs: DEFAULT_TIMEOUT_MS,
      }),
      reqEndpoint: sentinelRequirementsEndpoint(authBase),
      deviceProfile: browserIdentityForTransport(client.transport),
      sendClientHints: !client.transport?.enabled,
    });
  } catch (error) {
    throw new Error(
      `[profile-security-check-required] Could not generate the Sentinel security token: ${error.message}`,
    );
  }

  let data;
  try {
    ({ data } = await authJsonStep(
      client,
      authBase,
      "POST",
      "/api/accounts/create_account",
      profile,
      {
        referer: profileUrl,
        headers: { "openai-sentinel-token": sentinelToken },
      },
    ));
  } catch (error) {
    if (/registration_disallowed/i.test(String(error?.message || ""))) {
      throw new Error(
        "[profile-security-check-required] Account profile creation was rejected after Sentinel verification.",
      );
    }
    throw error;
  }
  if (isAccountProfileRequired(data)) {
    throw new Error("ACCOUNT_PROFILE_REQUIRED: Account profile submission did not advance the login flow.");
  }
  console.log("[ok] Account profile completed");
  return data;
}

function sentinelRequirementsEndpoint(authBase) {
  const target = new URL(authBase);
  if (target.hostname === "auth.openai.com") {
    return "https://sentinel.openai.com/backend-api/sentinel/req";
  }
  return new URL("/backend-api/sentinel/req", target).toString();
}

function generateAccountProfile(now = new Date()) {
  const firstName = PROFILE_FIRST_NAMES[crypto.randomInt(PROFILE_FIRST_NAMES.length)];
  const lastName = PROFILE_LAST_NAMES[crypto.randomInt(PROFILE_LAST_NAMES.length)];
  return {
    name: `${firstName} ${lastName}`,
    birthdate: generateBirthdate(PROFILE_MIN_AGE, PROFILE_MAX_AGE, now),
  };
}

function generateBirthdate(minAge, maxAge, now) {
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const latest = new Date(todayUtc);
  latest.setUTCFullYear(latest.getUTCFullYear() - minAge);

  const earliest = new Date(todayUtc);
  earliest.setUTCFullYear(earliest.getUTCFullYear() - maxAge - 1);
  earliest.setUTCDate(earliest.getUTCDate() + 1);

  const dayMs = 24 * 60 * 60 * 1000;
  const dayCount = Math.floor((latest.getTime() - earliest.getTime()) / dayMs);
  const selected = new Date(earliest.getTime() + crypto.randomInt(dayCount + 1) * dayMs);
  return selected.toISOString().slice(0, 10);
}

function pickTotpFactor(payload) {
  const session = payload?.["oai-client-auth-session"] || {};
  const factors = [
    ...(Array.isArray(session.mfa_challenge_factors) ? session.mfa_challenge_factors : []),
    ...(Array.isArray(session.mfa_factors) ? session.mfa_factors : []),
  ];
  return factors.find((factor) => factor?.factor_type === "totp" && typeof factor.id === "string") || null;
}

async function askTotpOtp(rl) {
  for (;;) {
    const value = await askInput(rl, "2FA OTP (6 digits, q=quit): ", "mfa_otp");
    if (value.toLowerCase() === "q") throw new Error("Stopped before 2FA validation");
    if (/^\d{6}$/.test(value)) return value;
    console.log("[warn] 2FA OTP should be exactly 6 digits.");
  }
}

function generateTotp(secret, timestamp = Date.now()) {
  const key = decodeBase32Secret(secret);
  const counter = BigInt(Math.floor(timestamp / 30_000));
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(counter);
  const digest = crypto.createHmac("sha1", key).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(6, "0");
}

function decodeBase32Secret(value) {
  const normalized = String(value || "").toUpperCase().replace(/[\s=]/g, "");
  if (!/^[A-Z2-7]{16,128}$/.test(normalized)) {
    throw new Error("2FA key must be a Base32 string containing only A-Z and 2-7");
  }
  let bits = "";
  for (const char of normalized) {
    const index = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(char);
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  }
  return Buffer.from(bytes);
}

async function runCodexOauth(client, options) {
  const codeVerifier = base64Url(crypto.randomBytes(48));
  const codeChallenge = base64Url(crypto.createHash("sha256").update(codeVerifier).digest());
  const state = base64Url(crypto.randomBytes(24));
  const authUrl =
    `${options.authBase}/oauth/authorize?` +
    new URLSearchParams({
      client_id: options.codexClientId,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      codex_cli_simplified_flow: "true",
      id_token_add_organizations: "true",
      redirect_uri: options.codexRedirectUri,
      response_type: "code",
      scope: "openid profile email offline_access",
      state,
    }).toString();

  const authorized = await client.follow(authUrl);
  if (isLocalCallback(authorized.finalUrl)) {
    ensureCallbackHasOAuthCode(authorized.finalUrl);
    const result = { callbackUrl: authorized.finalUrl, codeVerifier, state };
    await options.saveCheckpoint?.("callback_ready", { oauth: result });
    return result;
  }

  const html = authorized.last?.text || "";
  const sessionId = extractFirstSessionId(html);
  if (!sessionId) {
    if (isAuthLoginPage(authorized.finalUrl)) {
      throw new Error(
        "CODEX_AUTH_LOGIN_REQUIRED: Codex authorization returned to the login page because the ChatGPT web session is missing or expired.",
      );
    }
    throw new Error(
      "SESSION_SELECTION_INVALID: Could not find a us_ account session on choose-account page. " +
        "The authorization page may require a browser security check.",
    );
  }
  if (options.debugAuth || client.verbose) {
    console.log(`[debug] selected account session_id: ${maskSessionId(sessionId)}`);
  }

  const { data: selected } = await authJsonStep(client, options.authBase, "POST", "/api/accounts/session/select", {
    session_id: sessionId,
  }, { referer: `${options.authBase}/choose-an-account` });
  let current = selected;
  const addPhoneUrl = getContinueUrl(selected);
  const oauth = { codeVerifier, state, sessionId, addPhoneUrl };
  if (options.debugAuth) {
    logAuthSnapshot(client, "session/select", `${options.authBase}/api/accounts/session/select`, HAR_ADD_PHONE_COOKIE_NAMES);
    console.log(`[debug] session/select continue_url: ${addPhoneUrl || "<none>"}`);
  }

  if (isPhoneBindingRequired(current)) {
    await options.saveCheckpoint?.("phone_required", { oauth });
    current = await bindPhoneIfNeeded(client, { ...options, checkpointOauth: oauth }, current, addPhoneUrl);
  } else if (hasWorkspace(current)) {
    console.log("[4/5] Existing workspace/session selected; phone binding was not requested");
  } else if (isLocalCallback(getContinueUrl(current))) {
    console.log("[4/5] Account selected; phone binding and workspace selection were not requested");
  } else {
    throw unexpectedSessionSelectionError(current);
  }

  await options.saveCheckpoint?.("oauth_continue", { oauth: { ...oauth, current } });
  return finishCodexOauth(client, options, current, oauth);
}

async function resumeCodexOauth(client, options, checkpoint) {
  if (checkpoint.stage === "email_verified") {
    console.log("[resume] Email login is still available; starting Codex OAuth without a new email code.");
    return runCodexOauth(client, options);
  }

  const oauth = checkpoint.oauth || {};
  if (!oauth.codeVerifier || !oauth.state) throw new Error("CHECKPOINT_INVALID: missing OAuth PKCE state");
  if (checkpoint.stage === "callback_ready" && oauth.callbackUrl) {
    ensureCallbackHasOAuthCode(oauth.callbackUrl);
    // OAuth code 生命周期只有几分钟：过旧的 checkpoint 恢复兑换注定失败，直接弃档重登
    const savedAtMs = Date.parse(checkpoint.updated_at || "");
    if (Number.isFinite(savedAtMs) && Date.now() - savedAtMs > OAUTH_CODE_MAX_AGE_MS) {
      const ageMin = Math.round((Date.now() - savedAtMs) / 60_000);
      throw new Error(
        `CHECKPOINT_INVALID: saved OAuth code is ${ageMin} minutes old and has expired; restarting fresh login.`,
      );
    }
    return {
      callbackUrl: oauth.callbackUrl,
      codeVerifier: oauth.codeVerifier,
      state: oauth.state,
      workspaceId: oauth.workspaceId || null,
    };
  }

  if (checkpoint.stage === "oauth_continue" && oauth.current) {
    return finishCodexOauth(client, options, oauth.current, oauth);
  }

  if (["phone_required", "phone_otp"].includes(checkpoint.stage)) {
    if (!isPhoneBindingUrl(oauth.addPhoneUrl)) {
      throw new Error("SESSION_SELECTION_INVALID: saved phone checkpoint does not point to an add-phone page");
    }
    console.log("[resume] Email verification already completed; continuing phone binding.");
    const current = await bindPhoneIfNeeded(
      client,
      {
        ...options,
        checkpointOauth: oauth,
        resumePhone: checkpoint.stage === "phone_otp"
          ? { phone: oauth.phone, phoneReferer: oauth.phoneReferer }
          : null,
      },
      null,
      oauth.addPhoneUrl,
    );
    await options.saveCheckpoint?.("oauth_continue", { oauth: { ...oauth, current, phone: null, phoneReferer: null } });
    return finishCodexOauth(client, options, current, oauth);
  }

  throw new Error(`CHECKPOINT_INVALID: unsupported stage ${checkpoint.stage || "unknown"}`);
}

async function finishCodexOauth(client, options, initial, oauth) {
  let current = initial;

  const workspaceId = pickWorkspaceId(current);
  if (workspaceId) {
    console.log("[5/5] Select workspace");
    emitStageEvent("workspace");
    const consentUrl = getContinueUrl(current);
    const consentReferer = consentUrl || `${options.authBase}/sign-in-with-chatgpt/codex/consent`;
    const selectedWorkspace = await authJsonStep(client, options.authBase, "POST", "/api/accounts/workspace/select", {
      workspace_id: workspaceId,
    }, { referer: consentReferer });
    current = selectedWorkspace.data;
  }

  const continued = await continueFlow(client, current);
  const callbackUrl = continued?.finalUrl || current?.continue_url || null;
  ensureCallbackHasOAuthCode(callbackUrl);
  const result = {
    callbackUrl,
    codeVerifier: oauth.codeVerifier,
    state: oauth.state,
    workspaceId: workspaceId || null,
  };
  await options.saveCheckpoint?.("callback_ready", { oauth: result });
  return result;
}

async function bindPhoneIfNeeded(client, options, current, addPhoneUrl) {
  console.log("[4/5] Phone binding is required");
  emitStageEvent("add_phone");
  const addPhonePageUrl = addPhoneUrl || `${options.authBase}/add-phone`;
  const addPhoneReferer = await prepareAddPhonePage(client, addPhonePageUrl);
  if (options.debugAuth) {
    console.log(`[debug] add-phone referer: ${addPhoneReferer}`);
    logAuthSnapshot(client, "before add-phone/send", `${options.authBase}/api/accounts/add-phone/send`, HAR_ADD_PHONE_COOKIE_NAMES);
    const sessionKeys = Object.keys(current?.["oai-client-auth-session"] || {});
    console.log(`[debug] session keys: ${sessionKeys.join(", ")}`);
  }

  let nextPhone = options.phone || "";
  let resumePhone = options.resumePhone || null;
  for (;;) {
    let phone;
    let phoneReferer;
    if (resumePhone?.phone && resumePhone?.phoneReferer) {
      phone = resumePhone.phone;
      phoneReferer = resumePhone.phoneReferer;
      resumePhone = null;
      console.log(`[resume] Continue waiting for the SMS sent to ${phone}.`);
      emitStageEvent("phone_otp");
    } else {
      phone = nextPhone || (await askInput(options.rl, "Phone number, E.164 format (p=quit): ", "phone"));
      nextPhone = "";
      if (!phone || phone.toLowerCase() === "p" || phone.toLowerCase() === "q") {
        throw new Error("Stopped before phone binding");
      }

      const sent = await trySendPhoneOtp(client, options.authBase, phone, addPhoneReferer);
      if (!sent.ok) {
        console.log(`[warn] Could not send SMS to ${phone}: ${sent.message}`);
        console.log("[info] Enter another phone number, or q to quit.");
        continue;
      }
      const phoneUrl = getContinueUrl(sent.data);
      phoneReferer = phoneUrl || `${authBase}/phone-verification`;
      emitStageEvent("phone_otp");
      await options.saveCheckpoint?.("phone_otp", {
        oauth: { ...options.checkpointOauth, phone, phoneReferer },
      });
    }
    for (;;) {
      const phoneCode = await askInput(options.rl, "Phone OTP (r=resend, p=change phone, q=quit): ", "phone_otp", {
        canResend: true,
      });
      const lower = phoneCode.toLowerCase();
      if (lower === "q") throw new Error("Stopped before phone OTP validation");
      if (lower === "p") {
        console.log("[info] Change phone number.");
        await options.saveCheckpoint?.("phone_required", { oauth: options.checkpointOauth });
        break;
      }
      if (lower === "r") {
        const resent = await trySendPhoneOtp(client, options.authBase, phone, addPhoneReferer);
        if (resent.ok) {
          console.log("[ok] SMS resend request accepted.");
        } else {
          console.log(`[warn] SMS resend failed: ${resent.message}`);
          console.log("[info] Use p to change phone number, or q to quit.");
        }
        continue;
      }
      if (!/^\d{4,8}$/.test(phoneCode)) {
        console.log("[warn] Phone OTP should be digits, or type r/p/q.");
        continue;
      }

      const validated = await tryValidatePhoneOtp(client, options.authBase, phoneCode, phoneReferer);
      if (validated.ok) {
        console.log("[ok] Phone OTP validated");
        return validated.data;
      }
      if (isExpiredCheckpointError(new Error(validated.message))) {
        throw new Error(validated.message);
      }

      console.log(`[warn] Phone OTP validation failed: ${validated.message}`);
      console.log("[info] Enter another code, r to resend, p to change phone, or q to quit.");
    }
  }
}

async function trySendPhoneOtp(client, authBase, phone, referer) {
  const primary = await postAddPhoneSend(client, authBase, phone, referer, {
    phone_number: phone,
    channel: "sms",
  });
  if (primary.ok) return primary;

  if (shouldRetryAddPhoneWithoutChannel(primary.message)) {
    const fallback = await postAddPhoneSend(client, authBase, phone, referer, {
      phone_number: phone,
    });
    if (fallback.ok) {
      console.log("[info] add-phone/send accepted without channel field.");
      return fallback;
    }
    return {
      ok: false,
      message: `${primary.message}; fallback without channel also failed: ${fallback.message}`,
    };
  }

  return primary;
}

async function postAddPhoneSend(client, authBase, phone, referer, payload) {
  try {
    const { data } = await authJsonStep(client, authBase, "POST", "/api/accounts/add-phone/send", payload, { referer });
    return { ok: true, data };
  } catch (error) {
    if (isProxyRiskControlError(error)) throw error;
    return { ok: false, message: error.message };
  }
}

async function tryValidatePhoneOtp(client, authBase, code, referer) {
  try {
    const { data } = await authJsonStep(client, authBase, "POST", "/api/accounts/phone-otp/validate", {
      code,
    }, { referer });
    return { ok: true, data };
  } catch (error) {
    if (isProxyRiskControlError(error)) throw error;
    return { ok: false, message: error.message };
  }
}

async function authJsonStep(client, authBase, method, pathname, body, options = {}) {
  return client.getJson(method, `${authBase}${pathname}`, {
    origin: authBase,
    referer: options.referer || `${authBase}/`,
    headers: options.headers,
    json: body,
  });
}

async function prepareAddPhonePage(client, addPhoneUrl) {
  const opened = await client.follow(addPhoneUrl, { referer: addPhoneUrl });
  return opened.finalUrl || addPhoneUrl;
}

async function buildSub2apiOauthExport({
  authBase,
  callbackUrl,
  codeVerifier,
  clientId,
  redirectUri,
  accountName,
  concurrency,
  priority,
  rateMultiplier,
  transport,
  cookie,
}) {
  const callback = new URL(callbackUrl);
  const code = callback.searchParams.get("code");
  if (!code) throw new Error("CHECKPOINT_INVALID: Codex callback URL does not contain OAuth code.");

  const tokenSet = await exchangeOAuthCode({
    authBase,
    clientId,
    code,
    codeVerifier,
    redirectUri,
    transport,
    cookie,
  });

  const claims = decodeJwtPayload(tokenSet.id_token);
  const authClaims = claims["https://api.openai.com/auth"] || {};
  const email = claims.email || "";
  const chatgptAccountId = claims.sid || "";
  const chatgptUserId = authClaims.user_id || claims.sub || "";
  const account = {
    name: accountName || buildAccountName(email),
    platform: "openai",
    type: "oauth",
    credentials: {
      access_token: tokenSet.access_token,
      chatgpt_account_id: chatgptAccountId,
      email,
      id_token: tokenSet.id_token,
      refresh_token: tokenSet.refresh_token,
    },
    extra: {
      account_id: chatgptAccountId,
      chatgpt_account_id: chatgptAccountId,
      chatgpt_user_id: chatgptUserId,
      client_id: clientId,
      email,
      openai_long_context_billing_enabled: false,
      openai_oauth_responses_websockets_v2_enabled: false,
      openai_oauth_responses_websockets_v2_mode: "off",
      privacy_mode: "training_set_failed",
    },
    concurrency: Number(concurrency || 10),
    priority: Number(priority || 1),
    rate_multiplier: Number(rateMultiplier || 1),
    auto_pause_on_expired: true,
  };

  return {
    account,
    data: {
      type: "sub2api-data",
      version: 1,
      exported_at: new Date().toISOString(),
      proxies: [],
      accounts: [account],
    },
  };
}

async function exchangeOAuthCode({ authBase, clientId, code, codeVerifier, redirectUri, transport, cookie }) {
  const res = await (transport ? transport.fetch(`${authBase}/oauth/token`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      ...browserHeadersForTransport(transport),
      ...(cookie ? { cookie } : {}),
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    retryRiskControl: true,
  }) : fetch(`${authBase}/oauth/token`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      ...browserHeadersForTransport(transport),
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
  }));
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Token endpoint returned non-JSON HTTP ${res.status}: ${text.slice(0, 180)}`);
  }
  if (!res.ok) {
    const detail = tokenErrorDetail(data);
    if (res.status === 400) {
      // authorization_code 兑换 400 = code 已被消耗/过期或 PKCE 不匹配，
      // 保存的 code 不可能再兑换成功，CHECKPOINT_INVALID 前缀触发弃档重登。
      throw new Error(
        `CHECKPOINT_INVALID: Token exchange failed with HTTP 400: ${detail}. The OAuth code cannot be reused; a fresh login is required.`,
      );
    }
    throw new Error(`Token exchange failed with HTTP ${res.status}: ${detail}`);
  }
  for (const key of ["access_token", "refresh_token", "id_token"]) {
    if (!data[key]) throw new Error(`Token response missing ${key}.`);
  }
  return data;
}

/** token 端点错误详情提取：error/error_description 可能是字符串，也可能是 {code,type,message} 嵌套对象。 */
function tokenErrorDetail(data) {
  const parts = [];
  const push = (value) => {
    if (typeof value === "string" && value.trim()) {
      parts.push(value.trim());
    } else if (value && typeof value === "object") {
      const nested = [value.code, value.type, value.message]
        .filter((item) => typeof item === "string" && item)
        .join(" ");
      parts.push(nested || JSON.stringify(value).slice(0, 180));
    }
  };
  push(data?.error_description);
  push(data?.error);
  if (!parts.length) parts.push(JSON.stringify(data).slice(0, 180));
  return parts.join(" | ").slice(0, 300);
}

async function refreshSub2apiOauthExport({ authBase, sourcePath, targetPath, fallbackClientId, transport }) {
  let data;
  try {
    data = JSON.parse(await fs.readFile(sourcePath, "utf8"));
  } catch (error) {
    throw new Error(`REFRESH_TOKEN_INVALID: 无法读取原 sub2api 文件：${error.message}`);
  }
  const account = data?.accounts?.[0];
  const credentials = account?.credentials;
  const refreshToken = credentials?.refresh_token;
  const clientId = account?.extra?.client_id || fallbackClientId;
  if (data?.type !== "sub2api-data" || !account || !refreshToken) {
    throw new Error("REFRESH_TOKEN_INVALID: 原文件缺少 OAuth 账号或 refresh_token");
  }

  const tokenSet = await refreshOAuthToken({ authBase, clientId, refreshToken, transport });
  credentials.access_token = tokenSet.access_token;
  credentials.refresh_token = tokenSet.refresh_token || refreshToken;
  if (tokenSet.id_token) credentials.id_token = tokenSet.id_token;

  if (credentials.id_token) {
    try {
      const claims = decodeJwtPayload(credentials.id_token);
      const authClaims = claims["https://api.openai.com/auth"] || {};
      const accountId = claims.sid || credentials.chatgpt_account_id || "";
      const userId = authClaims.user_id || claims.sub || account?.extra?.chatgpt_user_id || "";
      const email = claims.email || credentials.email || account?.extra?.email || "";
      credentials.chatgpt_account_id = accountId;
      credentials.email = email;
      account.extra = {
        ...(account.extra || {}),
        account_id: accountId,
        chatgpt_account_id: accountId,
        chatgpt_user_id: userId,
        client_id: clientId,
        email,
      };
      if (email) account.name = buildAccountName(email);
    } catch {
      // Keep the existing account metadata if the provider omits or changes the ID token format.
    }
  }

  data.type = "sub2api-data";
  data.version = 1;
  data.exported_at = new Date().toISOString();
  if (!Array.isArray(data.proxies)) data.proxies = [];
  await writeJsonAtomic(targetPath, data);
  return { email: credentials.email || "" };
}

async function refreshOAuthToken({ authBase, clientId, refreshToken, transport }) {
  const res = await (transport ? transport.fetch(`${authBase}/oauth/token`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      ...browserHeadersForTransport(transport),
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: refreshToken,
    }),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    retryRiskControl: true,
  }) : fetch(`${authBase}/oauth/token`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      ...browserHeadersForTransport(transport),
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: refreshToken,
    }),
  }));
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`REFRESH_TOKEN_INVALID: OAuth 刷新接口返回非 JSON，HTTP ${res.status}`);
  }
  if (!res.ok) {
    const message = data?.error_description || data?.error?.message || data?.error || "刷新令牌已失效";
    throw new Error(`REFRESH_TOKEN_INVALID: OAuth 刷新失败，HTTP ${res.status}：${String(message).slice(0, 180)}`);
  }
  if (!data.access_token) throw new Error("REFRESH_TOKEN_INVALID: OAuth 刷新响应缺少 access_token");
  return data;
}

async function askEmailOtp(rl, client, authBase) {
  for (;;) {
    const value = await askInput(rl, "Email OTP (r=resend, q=quit): ", "email_otp", { canResend: true });
    if (value.toLowerCase() === "q") throw new Error("Stopped before email OTP validation");
    if (value.toLowerCase() === "r") {
      console.log("[info] Resending email OTP...");
      await resendEmailOtp(client, authBase);
      console.log("[ok] Resend request accepted. Check inbox and spam folder.");
      continue;
    }
    if (/^\d{6}$/.test(value)) return value;
    console.log("[warn] Email OTP should be 6 digits, or type r to resend.");
  }
}

async function verifyEmailOtp(client, { authBase, rl, referer }) {
  for (;;) {
    const emailCode = await askEmailOtp(rl, client, authBase);
    try {
      const { data } = await authJsonStep(client, authBase, "POST", "/api/accounts/email-otp/validate", {
        code: emailCode,
      }, { referer });
      return data;
    } catch (error) {
      if (!isRejectedEmailOtpError(error)) throw error;
      console.log("[email-otp-rejected] 邮箱验证码错误，请重新输入，或输入 r 重新发送。");
    }
  }
}

function isRejectedEmailOtpError(error) {
  return /wrong_email_otp_code|wrong code|invalid (?:email )?(?:otp )?code|incorrect (?:email )?(?:otp )?code/i.test(
    String(error?.message || ""),
  );
}

async function resendEmailOtp(client, authBase) {
  const result = await client.request("POST", `${authBase}/api/accounts/email-otp/resend`, {
    origin: authBase,
    referer: `${authBase}/email-verification`,
    headers: {
      accept: "application/json, text/plain, */*",
    },
    json: {},
  });
  if (result.res.status === 429) {
    throw new Error("Too many email OTP resend attempts. Wait a while before retrying.");
  }
  assertOk(result, `POST ${authBase}/api/accounts/email-otp/resend`);
}

async function continueFlow(client, payload) {
  const url = payload?.continue_url || payload?.page?.payload?.url;
  if (!url) return null;
  if (isLocalCallback(url)) return { finalUrl: url, last: null };
  return client.follow(url);
}

function getContinueUrl(payload) {
  return payload?.continue_url || payload?.page?.payload?.url || null;
}

function logAuthSnapshot(client, label, url, expectedNames) {
  const actualNames = new Set(client.jar.namesFor(url));
  const actualSorted = [...actualNames].sort();
  const missing = [...expectedNames].filter((name) => !actualNames.has(name)).sort();
  const extra = actualSorted.filter((name) => !expectedNames.has(name)).sort();
  console.log(`[debug] ${label} cookie names: ${actualSorted.join(", ")}`);
  console.log(`[debug] ${label} missing vs HAR: ${missing.length ? missing.join(", ") : "<none>"}`);
  console.log(`[debug] ${label} extra vs HAR: ${extra.length ? extra.join(", ") : "<none>"}`);
  console.log(`[debug] ${label} target: ${url}`);
}

function extractFirstSessionId(html) {
  const text = decodeHtml(html);
  return (
    /"session_id"\s*:\s*"(us_[^"]+)"/.exec(text)?.[1] ||
    /session_id\\",\\"(us_[^"\\]+)/.exec(text)?.[1] ||
    /name="session_id"[^>]+value="(us_[^"]+)"/.exec(text)?.[1] ||
    /value="(us_[^"]+)"[^>]+name="session_id"/.exec(text)?.[1] ||
    /\bus_[A-Za-z0-9_-]{10,}\b/.exec(text)?.[0] ||
    null
  );
}

function maskSessionId(value) {
  if (!value || value.length <= 10) return "<redacted>";
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function mask(value) {
  if (!value) return "<none>";
  if (value.length <= 12) return "<redacted>";
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function decodeJwtPayload(jwt) {
  const [, payload] = String(jwt).split(".");
  if (!payload) throw new Error("Invalid id_token JWT.");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

function buildAccountName(email) {
  return email ? `oauth---${email}` : `oauth---${new Date().toISOString()}`;
}

function pickWorkspaceId(payload) {
  const workspaces = payload?.["oai-client-auth-session"]?.workspaces;
  if (!Array.isArray(workspaces) || workspaces.length === 0) return null;
  const organization = workspaces.find((item) => item?.kind === "organization" && item?.id);
  const firstAvailable = workspaces.find((item) => item?.id);
  return (organization || firstAvailable)?.id || null;
}

function hasWorkspace(payload) {
  const workspaces = payload?.["oai-client-auth-session"]?.workspaces;
  return Array.isArray(workspaces) && workspaces.length > 0;
}

function isPhoneBindingRequired(payload) {
  return payload?.page?.type === "add_phone" || isPhoneBindingUrl(getContinueUrl(payload));
}

function isPhoneBindingUrl(value) {
  try {
    return new URL(value).pathname === "/add-phone";
  } catch {
    return false;
  }
}

function unexpectedSessionSelectionError(payload) {
  let continuePath = "<none>";
  try {
    continuePath = new URL(getContinueUrl(payload)).pathname;
  } catch {}
  const pageType = payload?.page?.type || "<none>";
  return new Error(
    `SESSION_SELECTION_INVALID: session/select returned page=${pageType}, continue_path=${continuePath}; ` +
      "the selected account session is not ready for Codex authorization",
  );
}

function assertOk(result, label) {
  const { res, text } = result;
  if (res.status >= 200 && res.status < 300) return;
  const body = text.replace(/\s+/g, " ").slice(0, 220);
  throw new Error(`${label} failed with HTTP ${res.status}: ${body}`);
}

function isRiskControlResponse(res, text) {
  const mitigated = res?.headers?.get?.("cf-mitigated") || res?.headers?.get?.("x-cf-mitigated");
  if (mitigated && /challenge/i.test(mitigated)) return true;
  const contentType = String(res?.headers?.get?.("content-type") || "");
  const body = String(text || "");
  const challengePage = /Just a moment|cdn-cgi|challenge-platform|cf-challenge/i.test(body);
  if (res?.status === 403) return /text\/html/i.test(contentType) || challengePage;
  const htmlPage = /text\/html/i.test(contentType) || /<(?:!doctype\s+html|html|head|body)\b/i.test(body);
  return [400, 409].includes(Number(res?.status)) && htmlPage && challengePage;
}

function getSetCookie(headers) {
  if (Array.isArray(headers.rawSetCookie)) return headers.rawSetCookie;
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const combined = headers.get("set-cookie");
  if (!combined) return [];
  return combined.split(/,(?=\s*[^;,=\s]+=)/g).map((item) => item.trim());
}

function parseSetCookie(line, requestUrl) {
  const target = new URL(requestUrl);
  const parts = line.split(";").map((part) => part.trim());
  const [nameValue, ...attrs] = parts;
  const splitAt = nameValue.indexOf("=");
  if (splitAt <= 0) return null;
  const cookie = {
    name: nameValue.slice(0, splitAt),
    value: nameValue.slice(splitAt + 1),
    domain: target.hostname,
    path: "/",
    secure: false,
    expires: null,
  };
  for (const attr of attrs) {
    const [rawKey, ...rawValue] = attr.split("=");
    const key = rawKey.toLowerCase();
    const value = rawValue.join("=");
    if (key === "domain" && value) cookie.domain = value.replace(/^\./, "").toLowerCase();
    if (key === "path" && value) cookie.path = value;
    if (key === "secure") cookie.secure = true;
    if (key === "expires" && value) {
      const expires = Date.parse(value);
      if (!Number.isNaN(expires)) cookie.expires = expires;
    }
    if (key === "max-age" && value) {
      const seconds = Number(value);
      if (Number.isFinite(seconds)) cookie.expires = Date.now() + seconds * 1000;
    }
  }
  return cookie;
}

function cookieMatches(cookie, target) {
  const domain = cookie.domain.toLowerCase();
  const host = target.hostname.toLowerCase();
  const domainOk = host === domain || host.endsWith(`.${domain}`);
  const pathOk = target.pathname.startsWith(cookie.path || "/");
  const secureOk = !cookie.secure || target.protocol === "https:";
  return domainOk && pathOk && secureOk;
}

function isStoredCookie(cookie) {
  return Boolean(
    cookie &&
    typeof cookie === "object" &&
    typeof cookie.name === "string" &&
    typeof cookie.value === "string" &&
    typeof cookie.domain === "string" &&
    (!cookie.expires || Number.isFinite(Number(cookie.expires))),
  );
}

function createCheckpointWriter(checkpointPath, context) {
  return async (stage, payload = {}) => {
    const data = {
      version: 1,
      stage,
      updated_at: new Date().toISOString(),
      email: context.email,
      chatgpt_base: context.chatgptBase,
      auth_base: context.authBase,
      warning: "This file contains login cookies and OAuth state. Do not share it.",
      cookies: context.client.jar.toJSON(),
      web: context.web || null,
      ...payload,
    };
    await writePrivateJson(checkpointPath, data);
    emitEvent("checkpoint_saved", { stage, path: checkpointPath });
  };
}

async function readProtocolCheckpoint(checkpointPath) {
  const data = JSON.parse(await fs.readFile(checkpointPath, "utf8"));
  if (
    data?.version !== 1 ||
    typeof data.stage !== "string" ||
    typeof data.email !== "string" ||
    !Array.isArray(data.cookies)
  ) {
    throw new Error("CHECKPOINT_INVALID: malformed login checkpoint");
  }
  return data;
}

async function writePrivateJson(filePath, data) {
  await writeJsonAtomic(filePath, data, { mode: 0o600 });
  await fs.chmod(filePath, 0o600);
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

async function removeProtocolCheckpoint(checkpointPath) {
  try {
    await fs.unlink(checkpointPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function isExpiredCheckpointError(error) {
  return /CHECKPOINT_INVALID|SESSION_SELECTION_INVALID|CODEX_AUTH_LOGIN_REQUIRED|invalid_state|no longer valid|session.+(?:invalid|expired)|expired.+session/i.test(
    String(error?.message || ""),
  );
}

function shouldRetryAddPhoneWithoutChannel(message) {
  const text = String(message || "");
  return (
    text.includes("/api/accounts/add-phone/send") &&
    /HTTP (400|409)/i.test(text) &&
    /channel|invalid_state|no longer valid|session/i.test(text)
  );
}

function securityCheckRequiredError() {
  return new Error(
    "[security-check-required] Phone binding was rejected because the browser security-check state is missing. " +
      "The verified email checkpoint was kept, but repeating email login will not fix this response.",
  );
}

function isSecurityCheckRequiredError(error) {
  return String(error?.message || "").includes("[security-check-required]");
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === "--help" || item === "-h") args.help = true;
    else if (item === "--verbose" || item === "-v") args.verbose = true;
    else if (item === "--json-events") args.jsonEvents = true;
    else if (item === "--debug-auth") args.debugAuth = true;
    else if (item === "--web-only") args.webOnly = true;
    else if (item === "--setup-totp") args.setupTotp = true;
    else if (item.startsWith("--totp-result=")) args.totpResult = item.slice("--totp-result=".length);
    else if (item === "--totp-result") args.totpResult = argv[++i];
    else if (item.startsWith("--email=")) args.email = item.slice("--email=".length);
    else if (item === "--email") args.email = argv[++i];
    else if (item.startsWith("--phone=")) args.phone = item.slice("--phone=".length);
    else if (item === "--phone") args.phone = argv[++i];
    else if (item.startsWith("--out=")) args.out = item.slice("--out=".length);
    else if (item === "--out") args.out = argv[++i];
    else if (item.startsWith("--sub2api-out=")) args.sub2apiOut = item.slice("--sub2api-out=".length);
    else if (item === "--sub2api-out") args.sub2apiOut = argv[++i];
    else if (item.startsWith("--output-mode=")) args.outputMode = item.slice("--output-mode=".length);
    else if (item === "--output-mode") args.outputMode = argv[++i];
    else if (item === "--no-sub2api-export") args.noSub2apiExport = true;
    else if (item.startsWith("--refresh-sub2api=")) args.refreshSub2api = item.slice("--refresh-sub2api=".length);
    else if (item === "--refresh-sub2api") args.refreshSub2api = argv[++i];
    else if (item.startsWith("--checkpoint=")) args.checkpoint = item.slice("--checkpoint=".length);
    else if (item === "--checkpoint") args.checkpoint = argv[++i];
    else if (item.startsWith("--resume-checkpoint=")) args.resumeCheckpoint = item.slice("--resume-checkpoint=".length);
    else if (item === "--resume-checkpoint") args.resumeCheckpoint = argv[++i];
    else if (item.startsWith("--sub2api-name=")) args.sub2apiName = item.slice("--sub2api-name=".length);
    else if (item === "--sub2api-name") args.sub2apiName = argv[++i];
    else if (item.startsWith("--concurrency=")) args.concurrency = item.slice("--concurrency=".length);
    else if (item === "--concurrency") args.concurrency = argv[++i];
    else if (item.startsWith("--priority=")) args.priority = item.slice("--priority=".length);
    else if (item === "--priority") args.priority = argv[++i];
    else if (item.startsWith("--rate-multiplier=")) args.rateMultiplier = item.slice("--rate-multiplier=".length);
    else if (item === "--rate-multiplier") args.rateMultiplier = argv[++i];
    else if (item.startsWith("--proxy=")) args.proxy = item.slice("--proxy=".length);
    else if (item === "--proxy") args.proxy = argv[++i];
    else if (item.startsWith("--tls-profile=")) args.tlsProfile = item.slice("--tls-profile=".length);
    else if (item === "--tls-profile") args.tlsProfile = argv[++i];
    else if (item === "--native-http") args.nativeHttp = true;
    else if (item.startsWith("--chatgpt-base=")) args.chatgptBase = item.slice("--chatgpt-base=".length);
    else if (item === "--chatgpt-base") args.chatgptBase = argv[++i];
    else if (item.startsWith("--auth-base=")) args.authBase = item.slice("--auth-base=".length);
    else if (item === "--auth-base") args.authBase = argv[++i];
    else if (item.startsWith("--codex-client-id=")) args.codexClientId = item.slice("--codex-client-id=".length);
    else if (item === "--codex-client-id") args.codexClientId = argv[++i];
    else if (item.startsWith("--codex-redirect-uri=")) {
      args.codexRedirectUri = item.slice("--codex-redirect-uri=".length);
    } else if (item === "--codex-redirect-uri") args.codexRedirectUri = argv[++i];
    else throw new Error(`Unknown argument: ${item}`);
  }
  return args;
}

async function ask(rl, prompt) {
  return (await rl.question(prompt)).trim();
}

/** refresh 模式下尽力从原导出文件读出邮箱，供 starting 事件展示。 */
async function guessRefreshEmail(sourcePath) {
  try {
    const data = JSON.parse(await fs.readFile(path.resolve(sourcePath), "utf8"));
    return String(data?.accounts?.[0]?.credentials?.email || "").trim();
  } catch {
    return "";
  }
}

function trimSlash(value) {
  return value.replace(/\/+$/, "");
}

function normalizeProxyUrl(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error("账号代理必须是完整的 http://、https://、socks5:// 或 socks5h:// 地址");
  }
  if (!["http:", "https:", "socks5:", "socks5h:"].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error("账号代理只支持 http、https、socks5 和 socks5h 协议");
  }
  return parsed.toString();
}

function base64Url(buffer) {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function safeUrl(url) {
  try {
    const parsed = new URL(url);
    for (const key of parsed.searchParams.keys()) {
      if (/code|token|state|csrf|nonce|otp|email|phone|login_hint|challenge/i.test(key)) {
        parsed.searchParams.set(key, "<redacted>");
      }
    }
    return parsed.toString();
  } catch {
    return String(url);
  }
}

function summarizeHtml(html) {
  const title = /<title[^>]*>(.*?)<\/title>/is.exec(html)?.[1];
  const heading = /<h1[^>]*>.*?<span[^>]*>(.*?)<\/span>.*?<\/h1>/is.exec(html)?.[1];
  const text = decodeHtml((heading || title || "").replace(/<[^>]*>/g, "").trim());
  if (text) return text;
  if (/cdn-cgi|challenge-platform|cf-challenge/i.test(html)) return "Cloudflare challenge page";
  if (/sentinel/i.test(html)) return "Sentinel challenge page";
  return "HTML page";
}

function decodeHtml(text) {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function isLocalCallback(url) {
  try {
    const parsed = new URL(url);
    return (
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") &&
      parsed.pathname === "/auth/callback"
    );
  } catch {
    return false;
  }
}

// Rejects callback URLs that carry error=... instead of a code (e.g. the OAuth
// server denied the consent because its verifier was already consumed). Must
// throw with the CHECKPOINT_INVALID prefix so the callers drop the checkpoint
// and restart a fresh email login instead of persisting the poisoned URL.
function ensureCallbackHasOAuthCode(callbackUrl) {
  if (!callbackUrl || !isLocalCallback(callbackUrl)) return;
  const parsed = new URL(callbackUrl);
  if (parsed.searchParams.get("code")) return;
  const error = parsed.searchParams.get("error") || "missing code";
  const description = parsed.searchParams.get("error_description") || "";
  throw new Error(
    `CHECKPOINT_INVALID: Codex OAuth callback was rejected (${error}${description ? `: ${description}` : ""}); the consent verifier cannot be reused.`,
  );
}

function isAuthLoginPage(value) {
  try {
    return ["/log-in", "/log-in/password", "/log-in-or-create-account"].includes(new URL(value).pathname);
  } catch {
    return false;
  }
}

function printHelp() {
  console.log(`Usage:
  node src/protocol-login.mjs [options]

Options:
  --email <email>                 Email address. If omitted, prompt manually.
  --phone <phone>                 Phone number in E.164 format. If omitted, prompt when needed.
  --web-only                      Only complete ChatGPT web login, skip Codex OAuth.
  --setup-totp                    Sign in and set up TOTP 2FA; skip Codex OAuth.
  --totp-result <file>            Private 2FA setup result. Default: ${DEFAULT_TOTP_RESULT}
  --out <file>                    Output JSON path. Default: ${DEFAULT_OUT}
  --sub2api-out <file>            sub2api import JSON path. Default: ${DEFAULT_SUB2API_OUT}
  --output-mode <mode>            both, session, or sub2api. Default: both
  --no-sub2api-export             Do not exchange OAuth code or write sub2api import JSON.
  --refresh-sub2api <file>        Refresh an existing sub2api OAuth file without email login.
  --checkpoint <file>             Save resumable login state after email verification.
  --resume-checkpoint <file>      Resume a saved login state before requesting a new email code.
  --sub2api-name <name>           Account name in sub2api. Default: oauth---<email>
  --concurrency <number>          sub2api concurrency. Default: 10
  --priority <number>             sub2api priority. Default: 1
  --rate-multiplier <number>      sub2api rate_multiplier. Default: 1
  --proxy <url>                   Account proxy; supports http, socks5 and socks5h.
  --tls-profile <name>            curl_cffi browser profile. Default: auto-probe without proxy; chrome146 with proxy
  --native-http                   Disable the Python TLS fingerprint transport.
  --chatgpt-base <url>            Default: ${DEFAULT_CHATGPT_BASE}
  --auth-base <url>               Default: ${DEFAULT_AUTH_BASE}
  --codex-client-id <id>          Default: ${DEFAULT_CODEX_CLIENT_ID}
  --codex-redirect-uri <url>      Default: ${DEFAULT_CODEX_REDIRECT_URI}
  --verbose                       Print HTTP request status lines.
  --debug-auth                    Print auth cookie/page state diagnostics.
  --json-events                   v2 console mode: emit NDJSON events on stdout, read JSON commands from stdin.

Notes:
  Set CHATGPT_LOGIN_PASSWORD for password login and CHATGPT_TOTP_SECRET for automatic
  6-digit TOTP generation. Set CHATGPT_TOTP_PICKUP_URL to fetch the 6-digit code from an
  online 2FA pickup service (e.g. 2fa.show) when no local secret is configured; rejected
  codes are retried on the next 30s window before falling back to manual input.
  These values are read from the environment and are not logged.
  With --json-events, human-readable logs move to stderr and interactive prompts become
  {"type":"input_required",...} events answered by stdin lines like {"action":"input","value":"123456"}.
  TOSUB2_JOB_ATTEMPT sets the attempt number embedded in every event.
  Existing phone-bound accounts are supported. If session/select returns workspaces,
  the script skips add-phone/send and goes directly to workspace selection.
  OAuth code can only be exchanged once; rerun login if token exchange fails with invalid_grant.
`);
}

run()
  .then(() => {
    emitEvent("exit", { ok: true });
  })
  .catch((error) => {
    emitErrorEvent(error);
    if (isProxyRiskControlError(error)) {
      console.error(`[proxy-risk-retry] ${String(error.message || "Proxy security check").slice(0, 320)}`);
    } else {
      console.error(`[error] ${error.message}`);
    }
    process.exitCode = 1;
  });

function isProxyRiskControlError(error) {
  return /PROXY_RISK_CONTROL|PROXY_CONNECTION_RETRY/i.test(String(error?.message || ""));
}
