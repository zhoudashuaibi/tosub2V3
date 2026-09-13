/**
 * 统一脱敏：
 * 1. 值替换 —— 进程内已知敏感值集合（密码/TOTP/token/admin_key/代理 URL），出现即打码。
 * 2. 模式替换 —— 正则兜底（Bearer token、sk- key、token JSON 键、代理 URL 账密段）。
 */

const knownValues = new Set();

export function registerSensitiveValue(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length >= 6) knownValues.add(text);
}

export function registerSensitiveValues(values) {
  for (const value of Array.isArray(values) ? values : []) registerSensitiveValue(value);
}

export function clearSensitiveValues() {
  knownValues.clear();
}

const PATTERN_RULES = [
  /Bearer\s+[\w.-]{8,}/gi,
  /\bsk-[A-Za-z0-9]{8,}\b/g,
  /((?:access|refresh|id)_token)["']?\s*[:=]\s*["']?[\w.-]{16,}/gi,
  /(password|totp_secret|admin_key|refresh_token)["']?\s*[:=]\s*["'][^"']{4,}["']/gi,
  /[a-z][a-z0-9+.-]*:\/\/[^/@:\s]+:[^@/\s]+@/gi,
];

export function sanitizeText(value) {
  let text = String(value ?? '');
  if (!text) return text;
  for (const known of knownValues) {
    if (text.includes(known)) text = text.split(known).join('***');
  }
  for (const rule of PATTERN_RULES) {
    text = text.replace(rule, (match) => {
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(match)) {
        // 代理 URL：保留协议与主机，替换账密
        try {
          const url = new URL(match.replace(/@$/, ''));
          return `${url.protocol}//***@${url.host}${url.pathname === '/' ? '' : url.pathname}`;
        } catch {
          return '***';
        }
      }
      if (/^Bearer/i.test(match)) return 'Bearer ***';
      if (/^sk-/i.test(match)) return 'sk-***';
      return `${match.split(/[:=]/)[0]}=***`;
    });
  }
  return text;
}

/** 代理 URL → 脱敏展示串：http://user:***@host:port */
export function maskProxyUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    const auth = parsed.username ? `${parsed.username}:***@` : '';
    return `${parsed.protocol}//${auth}${parsed.host}`;
  } catch {
    return '***';
  }
}

/**
 * 代理 URL → 认证账户名（可能是完整的脱敏展示串，密码段被 *** 顶掉，用户名仍在）。
 * 用户名是代理供应商那一侧的身份（不是 ChatGPT 账号），用于区分「同一台机器上不同的出口账号」。
 */
export function proxyAuthAccount(url) {
  try {
    const parsed = new URL(String(url || ''));
    return parsed.username ? decodeURIComponent(parsed.username) : null;
  } catch {
    return null;
  }
}

/** 管理密钥类字符串 → 尾 4 位掩码：sk-****abcd */
export function maskSecret(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const tail = text.slice(-4);
  return `sk-****${tail}`;
}
