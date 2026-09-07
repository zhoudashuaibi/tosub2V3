import { extractMailboxOtpCandidates } from "./mail-otp.mjs";

export const DEFAULT_OUTLOOK_ENDPOINT = "https://8t92.cc/api/fetch-mails";

// 与 ChatGPT/OpenAI 登录相关的发件域。只有这些域的邮件才会被提取验证码，
// 避免把邮箱里其他服务的验证码误当作 ChatGPT 登录码提交。
const OPENAI_SENDER_DOMAINS = [
  "openai.com",
  "tm.openai.com",
  "email.openai.com",
  "chatgpt.com",
  "codex.chatgpt.com",
];

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_MESSAGES = 5;
const RESERVE_MAIL_MAX_MESSAGES = 10;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateOutlookEndpoint(value) {
  try {
    const parsed = new URL(String(value || "").trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function normalizeOutlookEndpoint(value) {
  const endpoint = String(value || "").trim() || DEFAULT_OUTLOOK_ENDPOINT;
  if (!validateOutlookEndpoint(endpoint)) return DEFAULT_OUTLOOK_ENDPOINT;
  return endpoint;
}

function isOutlookClientId(value) {
  return UUID_PATTERN.test(String(value || "").trim());
}

/**
 * 解析 Outlook 导入文本，每行格式：邮箱----密码----clientId----refreshToken
 * 返回结构化的凭据数组，校验失败时抛出包含行号的错误。
 */
export function parseOutlookEntries(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) throw new Error("请至少输入一行 Outlook 邮箱信息");

  const seen = new Set();
  const entries = [];
  lines.forEach((line, index) => {
    const parts = line.split("----");
    if (parts.length < 4) {
      throw new Error(`第 ${index + 1} 行格式错误，需要 4 段：邮箱----密码----clientId----refreshToken`);
    }
    const email = parts[0].trim().toLowerCase();
    const outlookPassword = parts[1].trim();
    const outlookClientId = parts[2].trim();
    const outlookRefreshToken = parts.slice(3).join("----").trim();
    if (!email || !email.includes("@")) throw new Error(`第 ${index + 1} 行邮箱格式错误`);
    if (!outlookPassword) throw new Error(`第 ${index + 1} 行邮箱密码不能为空`);
    if (!isOutlookClientId(outlookClientId)) {
      throw new Error(`第 ${index + 1} 行 clientId 格式错误，应为 UUID 形态`);
    }
    if (outlookRefreshToken.length < 100) {
      throw new Error(`第 ${index + 1} 行 refresh_token 格式错误`);
    }
    if (seen.has(email)) throw new Error(`第 ${index + 1} 行邮箱重复：${email}`);
    seen.add(email);
    entries.push({ email, outlookPassword, outlookClientId, outlookRefreshToken });
  });
  return entries;
}

/**
 * 调用 8t92 风格的 fetch-mails 接口，提取目标邮箱的验证码候选。
 *
 * @param {object} params - { endpoint, email, clientId, refreshToken, password }
 * @param {object} options - { fetchImpl, timeoutMs, baselineTime, senderFilter }
 *   - baselineTime: 毫秒时间戳；早于该时间的邮件被视为旧邮件并被过滤。
 *     baseline 阶段（记录已有旧验证码）传入 null，不做时间过滤。
 *   - senderFilter: 默认 true，只保留 OpenAI 发件域邮件。
 * @returns {Promise<Array<{code,score,key,receivedAt}>>}
 */
export async function fetchOutlookOtpCandidates(params, options = {}) {
  const endpoint = normalizeOutlookEndpoint(params?.endpoint);
  const email = String(params?.email || "").trim().toLowerCase();
  const clientId = String(params?.clientId || "").trim();
  const refreshToken = String(params?.refreshToken || "").trim();
  const password = String(params?.password || "").trim();
  if (!email) throw new Error("Outlook 收码缺少邮箱");
  if (!clientId) throw new Error("Outlook 收码缺少 clientId");
  if (!refreshToken) throw new Error("Outlook 收码缺少 refresh_token");

  const fetchImpl = options.fetchImpl || fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || DEFAULT_TIMEOUT_MS);
  let response;
  try {
    const body = {
      lines: `${email}----${password}----${clientId}----${refreshToken}`,
      options: {
        tokenKind: "refresh_token",
        redirectUri: "",
        folderScope: "inbox",
        maxMessages: MAX_MESSAGES,
        bodyContent: "html",
        includeBody: true,
        includeHeaders: false,
      },
    };
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": "Mozilla/5.0 ChatGPT-Onboarding-Console/1.0",
      },
      body: JSON.stringify(body),
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Outlook 取件接口返回 HTTP ${response.status}`);
    const payload = await response.json();
    const messages = pickTargetMessages(payload, email);
    const baselineTime = options.baselineTime ?? null;
    const useSenderFilter = options.senderFilter !== false;
    return extractCandidatesFromMessages(messages, { baselineTime, useSenderFilter });
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("Outlook 取件接口请求超时");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function pickTargetMessages(payload, targetEmail) {
  if (!payload || typeof payload !== "object") return [];
  const results = Array.isArray(payload.results)
    ? payload.results
    : Array.isArray(payload.accounts)
      ? payload.accounts
      : Array.isArray(payload.value)
        ? payload.value
        : [];
  const normalizedTarget = String(targetEmail).toLowerCase();
  const matched = results.find((item) => {
    if (!item || typeof item !== "object") return false;
    if (item.ok === false) return false;
    return String(item.email || "").toLowerCase() === normalizedTarget;
  });
  if (!matched) return [];
  return Array.isArray(matched.messages) ? matched.messages : [];
}

function isOpenAiSender(message) {
  const from = message?.from || message?.sender || {};
  const address = String(
    (from.emailAddress && (from.emailAddress.address || from.emailAddress)) ||
      from.address ||
      from ||
      "",
  )
    .trim()
    .toLowerCase();
  if (!address) return false;
  return OPENAI_SENDER_DOMAINS.some(
    (domain) => address === domain || address.endsWith(`@${domain}`) || address.endsWith(`.${domain}`),
  );
}

function getMessageTime(message) {
  const raw = message?.receivedDateTime || message?.sentDateTime || message?.createdDateTime;
  if (!raw) return null;
  const ms = Date.parse(String(raw).replace(/^(\d{4}-\d{2}-\d{2})\s/, "$1T"));
  return Number.isFinite(ms) ? ms : null;
}

function extractCandidatesFromMessages(messages, { baselineTime, useSenderFilter }) {
  const candidates = [];
  messages.forEach((message) => {
    if (useSenderFilter && !isOpenAiSender(message)) return;
    const receivedAt = getMessageTime(message);
    // 时间门槛：基准时间之前的邮件一律视为旧邮件，不产生候选。
    // baseline 阶段 baselineTime 为 null，不做时间过滤，全部记入 baseline key。
    if (baselineTime !== null && receivedAt !== null && receivedAt < baselineTime) return;

    const text = [
      message?.subject,
      message?.bodyPreview,
      message?.body?.content,
      message?.uniqueBody?.content,
    ]
      .map((value) => String(value ?? ""))
      .join("\n");
    const extracted = extractMailboxOtpCandidates(text);
    extracted.forEach((candidate) => {
      candidates.push({
        ...candidate,
        receivedAt: candidate.receivedAt || receivedAt,
      });
    });
  });
  return candidates;
}

// ---------------------------------------------------------------------------
// 备用号池（reserve pool）专用：拉取邮件列表并提取余额 / 封禁信息。
// 与收码场景不同，这里不做发件人过滤（封禁邮件、余额邮件都要看），
// 并且扫描最近 RESERVE_MAIL_MAX_MESSAGES 封。
// ---------------------------------------------------------------------------

/**
 * 拉取某个 Outlook 邮箱最近的邮件列表（原始 message 对象），用于备用号池的余额/封禁判断。
 * @param {{endpoint:string,email:string,clientId:string,refreshToken:string,password:string}} params
 * @param {{fetchImpl?:Function,timeoutMs?:number,maxMessages?:number}} [options]
 * @returns {Promise<Array>} messages 数组（Graph 风格）
 */
export async function fetchReserveAccountMessages(params, options = {}) {
  const endpoint = normalizeOutlookEndpoint(params?.endpoint);
  const email = String(params?.email || "").trim().toLowerCase();
  const clientId = String(params?.clientId || "").trim();
  const refreshToken = String(params?.refreshToken || "").trim();
  const password = String(params?.password || "").trim();
  if (!email) throw new Error("备用号池拉取邮件缺少邮箱");
  if (!clientId) throw new Error("备用号池拉取邮件缺少 clientId");
  if (!refreshToken) throw new Error("备用号池拉取邮件缺少 refresh_token");

  const fetchImpl = options.fetchImpl || fetch;
  const maxMessages = Number(options.maxMessages) || RESERVE_MAIL_MAX_MESSAGES;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const body = {
      lines: `${email}----${password}----${clientId}----${refreshToken}`,
      options: {
        tokenKind: "refresh_token",
        redirectUri: "",
        folderScope: "inbox",
        maxMessages,
        bodyContent: "html",
        includeBody: true,
        includeHeaders: false,
      },
    };
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": "Mozilla/5.0 ChatGPT-Onboarding-Console/1.0",
      },
      body: JSON.stringify(body),
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Outlook 取件接口返回 HTTP ${response.status}`);
    const payload = await response.json();
    return pickTargetMessages(payload, email);
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("Outlook 取件接口请求超时");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/** 将 message 拍平为纯文本（去 HTML 标签、合并空白）。 */
function reserveMessageText(message) {
  const parts = [
    message?.subject,
    message?.bodyPreview,
    message?.body?.content,
    message?.uniqueBody?.content,
  ].map((value) => String(value ?? "").replace(/<[^>]*>/g, " "));
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/** 按收件时间倒序排列 messages。 */
function sortMessagesByTime(messages) {
  return [...messages].sort((a, b) => {
    const ta = getMessageTime(a) || 0;
    const tb = getMessageTime(b) || 0;
    return tb - ta;
  });
}

/** 余额邮件关键词。匹配各语言的获赠积分通知，balance = 数值 / 25。 */
const BALANCE_KEYWORDS = [
  /we[\s']*ve\s+added\s+([\d,]+(?:\.\d+)?)\s+credits\b/i,
  /添加(?:了)?\s*([\d,]+(?:\.\d+)?)\s*(?:个)?\s*额度/i,
  /([\d,]+(?:\.\d+)?)\s*クレジットを追加しました/,
  /([\d,]+(?:\.\d+)?)\s*크레딧을 추가했습니다/,
  /agregamos\s+([\d,]+(?:\.\d+)?)\s+créditos\b/i,
  /(?:đã\s+)?cộng\s+([\d,]+(?:\.\d+)?)\s+credit\b/i,
];

/**
 * 从邮件列表提取余额信息。
 * 匹配多语言的获赠积分邮件，balance = credits / 25。
 * 取最近一封匹配邮件的数值。
 * @param {Array} messages
 * @returns {{balance:number,hasBalance:true}|{hasBalance:false}}
 */
export function extractBalanceFromMessages(messages) {
  const sorted = sortMessagesByTime(messages);
  for (const message of sorted) {
    const source = reserveMessageText(message);
    for (const pattern of BALANCE_KEYWORDS) {
      const match = source.match(pattern);
      if (match) {
        const credits = Number(match[1].replace(/,/g, ""));
        if (Number.isFinite(credits)) {
          return { balance: credits / 25, hasBalance: true };
        }
      }
    }
  }
  return { hasBalance: false };
}

/** 封禁关键词正则。匹配 account_deactivated / account has been deactivated / has been suspended /
 *  中文「账户已被停用 / 账号已被封禁」等（OpenAI 封禁邮件会按账号语言本地化）。 */
const BANNED_KEYWORDS = /account(?:[\s_-]+(?:has\s+been)?)?[\s_-]*(?:deactivat\w*|suspended|disabled|permanently\s+deleted)|(?:deactivated|suspended|disabled)[\s\S]{0,60}account|your\s+account\s+(?:has\s+been\s+)?(?:deactivated|suspended|disabled|banned)|(?:账户|帐号|账号)(?:已|现已)?(?:被)?(?:停用|禁用|封禁)/i;

/**
 * 扫描邮件列表判断账号是否被封禁。
 * @param {Array} messages
 * @returns {{banned:boolean,reason?:string}}
 */
export function isAccountBannedFromMessages(messages) {
  const sorted = sortMessagesByTime(messages);
  for (const message of sorted) {
    const source = reserveMessageText(message);
    if (!source) continue;
    if (BANNED_KEYWORDS.test(source)) {
      return { banned: true, reason: "邮件命中封禁关键词" };
    }
  }
  return { banned: false };
}

