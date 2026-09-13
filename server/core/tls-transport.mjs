import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = path.join(__dirname, "tls_transport.py");
const DEFAULT_PROFILE = "chrome146";
const DEFAULT_TIMEOUT_MS = 30_000;
const PROFILE_PROBE_TIMEOUT_MS = 15_000;
const PROFILE_PROBE_TOTAL_TIMEOUT_MS = 300_000;
const PROFILE_PROBE_CONCURRENCY = 4;
const DEFAULT_SAME_PROXY_RISK_RETRIES = 5;
const DEFAULT_SAME_PROXY_RISK_RETRY_DELAY_MS = 1_000;
const DEFAULT_CLOUDFLARE_SOLVER_TIMEOUT_MS = 70_000;
const UNCONFIGURED = Symbol("unconfigured");

export function browserIdentityForTlsProfile(profile = DEFAULT_PROFILE) {
  const normalizedProfile = String(profile || DEFAULT_PROFILE).trim();
  const majorVersion = Number(/^chrome(\d+)/i.exec(normalizedProfile)?.[1] || 146);
  const usesMacOs = majorVersion >= 119;
  const platformToken = usesMacOs
    ? "Macintosh; Intel Mac OS X 10_15_7"
    : "Windows NT 10.0; Win64; x64";
  const platform = usesMacOs ? "macOS" : "Windows";
  return {
    profile: normalizedProfile,
    browser: "chrome",
    browserMajorVersion: majorVersion,
    userAgent:
      `Mozilla/5.0 (${platformToken}) AppleWebKit/537.36 ` +
      `(KHTML, like Gecko) Chrome/${majorVersion}.0.0.0 Safari/537.36`,
    secChUa:
      `"Chromium";v="${majorVersion}", "Google Chrome";v="${majorVersion}", "Not.A/Brand";v="99"`,
    secChUaMobile: "?0",
    secChUaPlatform: `"${platform}"`,
    acceptLanguage: "zh-CN,zh;q=0.9,en;q=0.8",
    locale: "zh-CN",
    languages: ["zh-CN", "zh", "en"],
    timezoneId: "Asia/Shanghai",
    os: usesMacOs ? "macos" : "windows",
    osVersion: usesMacOs ? "15.7.0" : "10.0",
    platform: usesMacOs ? "MacIntel" : "Win32",
  };
}

export class TlsFingerprintTransport {
  constructor({
    enabled = true,
    profile = DEFAULT_PROFILE,
    verbose = false,
    maxProxySessionAttempts = 10,
    sameProxyRiskRetries = DEFAULT_SAME_PROXY_RISK_RETRIES,
    sameProxyRiskRetryDelayMs = DEFAULT_SAME_PROXY_RISK_RETRY_DELAY_MS,
    cloudflareSolver = true,
    cloudflareSolverTimeoutMs = DEFAULT_CLOUDFLARE_SOLVER_TIMEOUT_MS,
  } = {}) {
    this.enabled = Boolean(enabled);
    this.profile = profile || DEFAULT_PROFILE;
    this.identityProfile = this.profile;
    this.verbose = Boolean(verbose);
    this.child = null;
    this.stdoutBuffer = "";
    this.stderrBuffer = "";
    this.pending = new Map();
    this.nextId = 1;
    this.configuredProxy = UNCONFIGURED;
    this.configuredProfile = null;
    this.closed = false;
    this.remainingProxySessionAttempts = normalizeProxyAttemptLimit(maxProxySessionAttempts);
    this.sameProxyRiskRetries = normalizeRetryLimit(sameProxyRiskRetries, DEFAULT_SAME_PROXY_RISK_RETRIES);
    this.sameProxyRiskRetryDelayMs = normalizeRetryLimit(
      sameProxyRiskRetryDelayMs,
      DEFAULT_SAME_PROXY_RISK_RETRY_DELAY_MS,
    );
    this.cloudflareSolver = Boolean(cloudflareSolver);
    this.cloudflareSolverTimeoutMs = normalizeRetryLimit(
      cloudflareSolverTimeoutMs,
      DEFAULT_CLOUDFLARE_SOLVER_TIMEOUT_MS,
    );
  }

  async configure(proxy, { force = false } = {}) {
    if (!this.enabled) return;
    if (!force && this.configuredProxy === (proxy || null) && this.configuredProfile === this.profile) return;
    const result = await this.send({
      operation: "configure",
      proxy: proxy || null,
      impersonate: this.profile,
      verifyTls: shouldVerifyTlsForProxy(proxy),
    });
    const actualProfile = String(result?.profile || "").trim();
    if (/^chrome\d+[a-z]?$/i.test(actualProfile)) this.profile = actualProfile;
    const identityProfile = String(result?.identityProfile || actualProfile || this.profile).trim();
    this.identityProfile = /^chrome\d+[a-z]?$/i.test(identityProfile) ? identityProfile : this.profile;
    this.configuredProxy = proxy || null;
    this.configuredProfile = this.profile;
  }

  async resetSession() {
    if (!this.enabled) return;
    await this.configure(this.configuredProxy === UNCONFIGURED ? null : this.configuredProxy, { force: true });
  }

  async prepareProxy(proxyTemplate, validationUrl) {
    if (!this.enabled) return null;
    const template = String(proxyTemplate || "").trim();
    if (!template) {
      if (this.profile === "auto") {
        const result = await this.send({
          operation: "probe_profiles",
          url: validationUrl,
          probeTimeoutMs: PROFILE_PROBE_TIMEOUT_MS,
          concurrency: PROFILE_PROBE_CONCURRENCY,
          timeoutMs: PROFILE_PROBE_TOTAL_TIMEOUT_MS,
        });
        this.profile = String(result.profile);
        this.configuredProxy = null;
        this.configuredProfile = this.profile;
        console.log(
          `[tls] 本机直连指纹探测通过：${this.profile}（共探测 ${Number(result.attempts) || 1} 个候选）。`,
        );
        return null;
      }
      await this.configure(null, { force: true });
      return null;
    }

    const canRotate = proxySupportsSessionRotation(template);
    if (canRotate && this.remainingProxySessionAttempts <= 0) {
      throw new Error("PROXY_RISK_CONTROL: 代理会话检测额度已用尽");
    }
    // 非轮换代理可能由服务商端按连接换出口 IP（如 1024proxy Rotating），风控后保持同一代理重连即可换 IP
    const maxAttempts = canRotate ? 1 : this.sameProxyRiskRetries + 1;
    if (!canRotate) {
      console.log(
        `[proxy] 未检测到可轮换的会话编号，同一代理最多检测 ${maxAttempts} 次（重连可能更换出口 IP）`,
      );
    }
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const proxy = canRotate ? rotateProxySession(template) : template;
      if (canRotate) {
        this.remainingProxySessionAttempts -= 1;
      }
      try {
        await this.configure(proxy, { force: true });
        const response = await this.request("GET", validationUrl, {
          timeoutMs: DEFAULT_TIMEOUT_MS,
          discardBody: true,
        });
        if (canRotate) console.log(`[proxy-session-attempt] ${randomUUID()}`);
        const challenge = response.headers.get("cf-mitigated") || response.headers.get("x-cf-mitigated");
        if (response.status >= 200 && response.status < 400 && !challenge) {
          console.log(`[proxy] 代理检测通过（第 ${attempt} 次，出口会话 ${maskSession(proxy)}）`);
          return proxy;
        }
        lastError = new Error(`HTTP ${response.status}${challenge ? "，返回安全校验页面" : ""}`);
        if (canRotate) {
          console.log(`[proxy] 本次代理检测失败：${lastError.message}，等待更换会话`);
        } else if (attempt < maxAttempts) {
          console.log(
            `[proxy] 代理检测失败：${lastError.message}，保持同一代理重试 ${attempt}/${this.sameProxyRiskRetries}`,
          );
          await delay(this.sameProxyRiskRetryDelayMs);
        } else {
          console.log(`[proxy] 代理检测失败：${lastError.message}`);
        }
      } catch (error) {
        lastError = error;
        if (canRotate) {
          console.log(`[proxy] 本次代理连接失败：${redactProxyError(error.message)}，等待更换会话`);
          throw new Error(`PROXY_CONNECTION_RETRY: ${redactProxyError(error.message)}`);
        } else if (attempt < maxAttempts) {
          console.log(
            `[proxy] 代理连接失败：${redactProxyError(error.message)}，保持同一代理重试 ${attempt}/${this.sameProxyRiskRetries}`,
          );
          await delay(this.sameProxyRiskRetryDelayMs);
        } else {
          console.log(`[proxy] 代理连接失败：${redactProxyError(error.message)}`);
        }
      }
    }
    throw new Error(
      canRotate
        ? `PROXY_RISK_CONTROL: 代理本次检测失败：${redactProxyError(lastError?.message || "未知错误")}`
        : `代理检测失败：${redactProxyError(lastError?.message || "未知错误")}`,
    );
  }

  async request(method, url, options = {}) {
    if (!this.enabled) {
      const response = await fetch(url, options);
      return response;
    }
    if (Object.hasOwn(options, "proxy")) await this.configure(options.proxy || null);
    else if (this.configuredProxy === UNCONFIGURED) await this.configure(null);
    const headers = options.headers instanceof Headers
      ? [...options.headers.entries()]
      : Object.entries(options.headers || {});
    const body = encodeBody(options.body);
    const request = {
      operation: "request",
      method,
      url,
      headers,
      body,
      timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
      discardBody: Boolean(options.discardBody),
    };
    let result;
    let retries = 0;
    let cloudflareSolveAttempted = false;
    for (;;) {
      try {
        result = await this.send(request);
      } catch (error) {
        if (options.retryRiskControl && this.hasConfiguredProxy() && isRetryableProxyConnectionError(error)) {
          throw new Error(
            `PROXY_CONNECTION_RETRY: ${method} ${safeRequestTarget(url)} failed: ` +
              redactProxyError(error?.message || "proxy connection failed"),
          );
        }
        throw error;
      }
      if (
        isRiskControlResult(result)
        && this.cloudflareSolver
        && !cloudflareSolveAttempted
        && isSupportedCloudflareChallenge(result)
      ) {
        cloudflareSolveAttempted = true;
        try {
          const solved = await this.solveCloudflareChallenge(url, result, headers);
          if (solved?.ok) {
            console.log(`[cloudflare] 安全校验已完成，正在使用原代理会话重放 ${method} 请求。`);
            result = await this.send(request);
            if (!isRiskControlResult(result)) break;
            console.log("[cloudflare] 校验后重放仍返回安全校验，继续执行代理兜底流程。");
          } else {
            console.log(`[cloudflare] 安全校验未通过（HTTP ${Number(solved?.status) || 0}），继续执行代理兜底流程。`);
          }
        } catch (error) {
          console.log(`[cloudflare] 安全校验处理失败：${safeCloudflareError(error)}，继续执行代理兜底流程。`);
        }
      }
      if (!options.retryRiskControl || !isRiskControlResult(result)) break;
      if (!this.hasConfiguredProxy() || retries >= this.sameProxyRiskRetries) {
        if (this.hasConfiguredProxy() && retries > 0) {
          console.log(`[proxy] 同一代理连续重试 ${retries} 次仍触发安全校验，准备更换代理会话。`);
        }
        throw new Error(
          `PROXY_RISK_CONTROL: ${method} ${safeRequestTarget(url)} returned HTTP ${Number(result.status)} ` +
            `with a security-check page after ${retries} same-proxy retries`,
        );
      }
      retries += 1;
      console.log(
        `[proxy] 当前代理出口触发安全校验，保持同一代理重试 ${retries}/${this.sameProxyRiskRetries}。`,
      );
      if (this.sameProxyRiskRetryDelayMs > 0) await delay(this.sameProxyRiskRetryDelayMs);
    }
    const responseHeaders = new Headers();
    const rawSetCookie = [];
    for (const [name, value] of result.headers || []) {
      if (name.toLowerCase() === "set-cookie") rawSetCookie.push(value);
      else responseHeaders.append(name, value);
    }
    Object.defineProperty(responseHeaders, "rawSetCookie", { value: rawSetCookie });
    Object.defineProperty(responseHeaders, "transportCookies", { value: result.cookies || [] });
    const text = result.body ? Buffer.from(result.body, "base64").toString("utf8") : "";
    return {
      status: Number(result.status),
      ok: Number(result.status) >= 200 && Number(result.status) < 300,
      headers: responseHeaders,
      text: async () => text,
      json: async () => JSON.parse(text),
    };
  }

  async fetch(url, options = {}) {
    return this.request(options.method || "GET", url, options);
  }

  async solveCloudflareChallenge(url, result, headers) {
    const userAgent = headers.find(([name]) => String(name).toLowerCase() === "user-agent")?.[1]
      || browserIdentityForTlsProfile(this.identityProfile || this.profile).userAgent;
    return this.send({
      operation: "solve_cloudflare",
      url,
      challengeBody: result.body || "",
      userAgent: String(userAgent),
      browserIdentity: browserIdentityForTlsProfile(this.identityProfile || this.profile),
      nodeCommand: process.execPath,
      solverTimeoutMs: this.cloudflareSolverTimeoutMs,
      timeoutMs: this.cloudflareSolverTimeoutMs,
    });
  }

  async generateSentinelTokens({ flow, deviceID, pageUrl, includeSessionObserver = true } = {}) {
    if (!this.enabled) {
      throw new Error("动态 Sentinel 令牌需要启用 Python TLS 传输层");
    }
    const identity = browserIdentityForTlsProfile(this.identityProfile || this.profile);
    return this.send({
      operation: "generate_sentinel_tokens",
      flow: String(flow || "default"),
      deviceID: String(deviceID || ""),
      pageUrl: String(pageUrl || "https://auth.openai.com/create-account/password"),
      includeSessionObserver: Boolean(includeSessionObserver),
      userAgent: identity.userAgent,
      browserIdentity: identity,
      nodeCommand: process.execPath,
      timeoutMs: 120_000,
    });
  }

  hasConfiguredProxy() {
    return this.enabled && this.configuredProxy !== UNCONFIGURED && Boolean(this.configuredProxy);
  }

  async send(message) {
    if (this.closed) throw new Error("TLS transport is closed");
    await this.ensureChild();
    const id = String(this.nextId++);
    const payload = { id, ...message };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`TLS transport timed out after ${message.timeoutMs || DEFAULT_TIMEOUT_MS}ms`));
      }, Number(message.timeoutMs || DEFAULT_TIMEOUT_MS) + 5_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  async ensureChild() {
    if (this.child) return;
    const python = findPythonCommand();
    if (!python) {
      throw new Error("未找到可用的 Python curl_cffi 环境，请先运行 python -m pip install -r requirements.txt；也可以设置 TOSUB2_PYTHON 指定 Python 路径");
    }
    this.child = spawn(python.command, [...python.args, WORKER_SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.consumeStdout(chunk));
    this.child.stderr.on("data", (chunk) => {
      this.stderrBuffer = `${this.stderrBuffer}${chunk}`.slice(-4_000);
      if (this.verbose) process.stderr.write(`[tls] ${chunk}`);
    });
    this.child.on("error", (error) => this.failPending(error));
    this.child.on("close", (code, signal) => {
      this.child = null;
      this.configuredProxy = UNCONFIGURED;
      this.configuredProfile = null;
      if (!this.closed) this.failPending(new Error(`TLS worker exited unexpectedly with ${signal || code}`));
    });
  }

  consumeStdout(chunk) {
    this.stdoutBuffer += chunk;
    let newline;
    while ((newline = this.stdoutBuffer.indexOf("\n")) >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        this.failPending(new Error(`TLS worker returned invalid JSON: ${error.message}`));
        continue;
      }
      const pending = this.pending.get(String(message.id));
      if (!pending) continue;
      this.pending.delete(String(message.id));
      clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(String(message.error || "TLS worker request failed")));
    }
  }

  failPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (!this.child) return;
    this.child.kill();
    this.child = null;
    this.failPending(new Error("TLS transport closed"));
  }
}

export class DirectTlsProfileProbe {
  constructor({
    explicitProfile = "",
    validationUrl = "https://chatgpt.com/",
    transportFactory = () => new TlsFingerprintTransport({ enabled: true, profile: "auto" }),
  } = {}) {
    this.profile = String(explicitProfile || "").trim() || null;
    this.validationUrl = validationUrl;
    this.transportFactory = transportFactory;
    this.pending = null;
  }

  async resolve() {
    if (this.profile) return this.profile;
    if (this.pending) return this.pending;

    const operation = this.probe();
    this.pending = operation;
    try {
      return await operation;
    } finally {
      if (this.pending === operation) this.pending = null;
    }
  }

  async probe() {
    const transport = this.transportFactory();
    try {
      await transport.prepareProxy(null, this.validationUrl);
      const profile = String(transport.profile || "").trim();
      if (!/^chrome\d+[a-z]?$/i.test(profile)) {
        throw new Error(`自动探测返回了无效的 TLS 指纹：${profile || "<empty>"}`);
      }
      this.profile = profile;
      return profile;
    } finally {
      await transport.close();
    }
  }
}

export function shouldUseTlsTransport({ chatgptBase, authBase, nativeHttp = false } = {}) {
  if (nativeHttp) return false;
  return [chatgptBase, authBase].some((value) => {
    try {
      return ["chatgpt.com", "auth.openai.com"].some((host) => new URL(value).hostname === host || new URL(value).hostname.endsWith(`.${host}`));
    } catch {
      return false;
    }
  });
}

function findPythonCommand() {
  const configured = String(process.env.TOSUB2_PYTHON || "").trim();
  const candidates = configured
    ? [{ command: configured, args: [] }]
    : process.platform === "win32"
      ? [{ command: "python", args: [] }, { command: "py", args: ["-3"] }]
      : [{ command: "python3", args: [] }, { command: "python", args: [] }];
  for (const candidate of candidates) {
    const check = spawnSync(candidate.command, [...candidate.args, "-c", "import curl_cffi"], {
      stdio: "ignore",
      windowsHide: true,
    });
    if (check.status === 0) return candidate;
  }
  return null;
}

function encodeBody(body) {
  if (body === undefined || body === null) return null;
  if (typeof body === "string") return Buffer.from(body, "utf8").toString("base64");
  if (body instanceof URLSearchParams) return Buffer.from(body.toString(), "utf8").toString("base64");
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) return Buffer.from(body).toString("base64");
  return Buffer.from(String(body), "utf8").toString("base64");
}

export function rotateProxySession(proxyUrl) {
  const parsed = new URL(proxyUrl);
  const username = decodeURIComponent(parsed.username);
  const rotatedUsername = username.replace(/(^|-)sid-[A-Za-z0-9]+(?=-|$)/, `$1sid-${randomSessionId()}`);
  if (rotatedUsername !== username) {
    parsed.username = rotatedUsername;
    return parsed.toString();
  }

  const password = decodeURIComponent(parsed.password);
  const rotatedPassword = rotateKookeeySession(password);
  if (rotatedPassword !== password) parsed.password = rotatedPassword;
  return parsed.toString();
}

export function proxySupportsSessionRotation(proxyUrl) {
  try {
    const parsed = new URL(proxyUrl);
    const username = decodeURIComponent(parsed.username);
    if (/(^|-)sid-[A-Za-z0-9]+(?=-|$)/.test(username)) return true;
    return rotateKookeeySession(decodeURIComponent(parsed.password)) !== decodeURIComponent(parsed.password);
  } catch {
    return false;
  }
}

function rotateKookeeySession(password) {
  const match = /^(.*-[A-Za-z]{2})-([0-9]{8})-(\d+m)$/i.exec(password);
  if (!match) return password;
  return `${match[1]}-${randomNumericSessionId()}-${match[3]}`;
}

function randomSessionId() {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  return Array.from({ length: 8 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}

function randomNumericSessionId() {
  return String(Math.floor(10_000_000 + Math.random() * 90_000_000));
}

function normalizeProxyAttemptLimit(value) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 10;
}

function normalizeRetryLimit(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function isRiskControlResult(result) {
  const headers = new Map(
    (result?.headers || []).map(([name, value]) => [String(name).toLowerCase(), String(value)]),
  );
  const mitigated = headers.get("cf-mitigated") || headers.get("x-cf-mitigated");
  if (mitigated && /challenge/i.test(mitigated)) return true;
  const status = Number(result?.status);
  const contentType = headers.get("content-type") || "";
  const body = result?.body ? Buffer.from(result.body, "base64").toString("utf8") : "";
  const challengePage = /Just a moment|cdn-cgi|challenge-platform|cf-challenge/i.test(body);
  if (status === 403) return /text\/html/i.test(contentType) || challengePage;
  const htmlPage = /text\/html/i.test(contentType) || /<(?:!doctype\s+html|html|head|body)\b/i.test(body);
  return [400, 409].includes(status) && htmlPage && challengePage;
}

function isSupportedCloudflareChallenge(result) {
  if (!result?.body) return false;
  try {
    return /\b_cf_chl_opt\b/.test(Buffer.from(result.body, "base64").toString("utf8"));
  } catch {
    return false;
  }
}

function safeCloudflareError(error) {
  return String(error?.message || error || "未知错误")
    .replace(/https?:\/\/\S+/gi, "<已隐藏地址>")
    .slice(0, 220);
}

function shouldVerifyTlsForProxy(proxyUrl) {
  if (!proxyUrl) return true;
  try {
    const hostname = new URL(proxyUrl).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return !["localhost", "127.0.0.1", "::1"].includes(hostname);
  } catch {
    return true;
  }
}

function isRetryableProxyConnectionError(error) {
  const message = String(error?.message || error || "");
  return (
    /\b(?:Timeout|ProxyError|ConnectionError|ConnectError|SSLError)\b/i.test(message)
    || /timed?\s*out|operation timed out/i.test(message)
    || /curl:\s*\((?:5|6|7|18|28|35|47|52|55|56|92)\)/i.test(message)
    || /could not resolve|failed to connect|connection (?:reset|refused|closed|aborted)/i.test(message)
    || /recv failure|send failure|empty reply|unexpected eof|tls connect error/i.test(message)
  );
}

function safeRequestTarget(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "<invalid-url>";
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function maskSession(proxyUrl) {
  try {
    const parsed = new URL(proxyUrl);
    const username = decodeURIComponent(parsed.username);
    const password = decodeURIComponent(parsed.password);
    const source = /(^|-)sid-[A-Za-z0-9]+(?=-|$)/.test(username) ? username : password;
    const fingerprint = createHash("sha256").update(source).digest("hex").slice(0, 6);
    if (/(^|-)sid-[A-Za-z0-9]+(?=-|$)/.test(username)) {
      return username.replace(/(sid-)[A-Za-z0-9]+/, `$1<redacted:${fingerprint}>`);
    }
    return `${username || "proxy"}-session-<redacted:${fingerprint}>`;
  } catch {
    return "<redacted>";
  }
}

function redactProxyError(message) {
  return String(message || "").replace(/(https?|socks5h?):\/\/[^\s/]+:[^\s/@]+@/gi, "$1://<redacted>@").slice(0, 220);
}
