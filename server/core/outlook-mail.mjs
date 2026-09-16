export const OUTLOOK_TOKEN_URL = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
export const OUTLOOK_MESSAGES_URL = "https://outlook.office.com/api/v2.0/me/messages";
// 与现有邮箱凭据授权保持一致；仅 IMAP scope 的令牌可能无法读取 REST 邮件。
export const OUTLOOK_SCOPE = "https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/Mail.ReadWrite offline_access";

const DEFAULT_TIMEOUT_MS = 60_000;
const RESERVE_MAIL_MAX_MESSAGES = 10;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
 * 微软官方直连取件。固定官方端点，不使用旧的 endpoint 或邮箱密码。
 * 返回与验证码、余额、封禁检查共用的 camelCase 邮件结构。
 */
export async function fetchOutlookMessages(params, options = {}) {
  const email = String(params?.email || "").trim().toLowerCase();
  const clientId = String(params?.clientId || "").trim();
  const refreshToken = String(params?.refreshToken || "").trim();
  if (!email) throw new Error("Outlook 取件缺少邮箱");
  if (!clientId) throw new Error("Outlook 取件缺少 clientId");
  if (!refreshToken) throw new Error("Outlook 取件缺少 refresh_token");

  const fetchImpl = options.fetchImpl || fetch;
  const requested = Number(options.maxMessages);
  const maxMessages = Number.isFinite(requested) && requested > 0
    ? Math.min(50, Math.max(1, Math.floor(requested)))
    : RESERVE_MAIL_MAX_MESSAGES;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || DEFAULT_TIMEOUT_MS);
  let stage = "微软授权";
  try {
    const tokenResponse = await fetchImpl(OUTLOOK_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: refreshToken,
        scope: OUTLOOK_SCOPE,
      }).toString(),
      redirect: "error",
      signal: controller.signal,
    });
    if (!tokenResponse.ok) {
      const error = await tokenResponse.json().catch(() => null);
      // 不把上游响应正文带入日志，避免凭据或邮件内容被回显。
      const code = typeof error?.error === "string" && /^[a-z_]{1,64}$/.test(error.error) ? error.error : "";
      throw new Error(`HTTP ${tokenResponse.status}${code ? `（${code}）` : ""}`);
    }
    const token = await tokenResponse.json();
    if (typeof token?.access_token !== "string" || !token.access_token.trim()) {
      throw new Error("响应缺少 access_token");
    }

    stage = "Outlook 邮件读取";
    const url = new URL(OUTLOOK_MESSAGES_URL);
    url.search = new URLSearchParams({
      $top: String(maxMessages),
      $orderby: "ReceivedDateTime desc",
      $select: "Id,Subject,From,ReceivedDateTime,BodyPreview,Body,IsRead",
    }).toString();
    const response = await fetchImpl(url.toString(), {
      method: "GET",
      headers: {
        authorization: `Bearer ${token.access_token}`,
        accept: "application/json",
        Prefer: "outlook.body-content-type=html",
      },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (!Array.isArray(payload?.value)) throw new Error("响应缺少邮件列表");
    return payload.value.map((message) => {
      const sender = message?.From?.EmailAddress;
      return {
        id: message?.Id,
        subject: message?.Subject,
        bodyPreview: message?.BodyPreview,
        isRead: message?.IsRead,
        receivedDateTime: message?.ReceivedDateTime,
        from: { emailAddress: sender ? { name: sender.Name, address: sender.Address } : null },
        body: {
          content: message?.Body?.Content,
          contentType: String(message?.Body?.ContentType || "").toLowerCase(),
        },
      };
    });
  } catch (error) {
    if (controller.signal.aborted || error?.name === "AbortError") {
      throw new Error(`${stage}请求超时`);
    }
    // 网络异常及 JSON 解析错误可能含响应片段，只返回固定错误类别。
    let detail = "请求失败";
    if (/^(HTTP \d{3}(（[a-z_]+）)?|响应缺少 access_token|响应缺少邮件列表)$/.test(error?.message)) {
      detail = error.message;
    } else if (error instanceof SyntaxError) {
      detail = "响应不是有效 JSON";
    }
    throw new Error(`${stage}失败：${detail}`);
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// 备用号池（reserve pool）专用：拉取邮件列表并提取余额 / 封禁信息。
// 不做发件人过滤（封禁邮件、余额邮件都要看），扫描最近 RESERVE_MAIL_MAX_MESSAGES 封。
// （登录收码已改为 redeem401 远程登录，本文件不再承担验证码提取职责。）
// ---------------------------------------------------------------------------

/**
 * 拉取最近邮件用于备用号池余额及封禁检查，不做发件人过滤。
 * @param {{email:string,clientId:string,refreshToken:string}} params
 * @param {{fetchImpl?:Function,timeoutMs?:number,maxMessages?:number}} [options]
 */
export async function fetchReserveAccountMessages(params, options = {}) {
  return fetchOutlookMessages(params, options);
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

