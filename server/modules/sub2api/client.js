import { AppError, errors } from '../../lib/http-errors.js';
import { sanitizeText } from '../../lib/sanitize.js';

/**
 * sub2api admin API 客户端：x-api-key 头、120s 超时。
 * 错误信息过脱敏后抛 SUB2API_UNAVAILABLE / UPSTREAM_ERROR。
 */

const REQUEST_TIMEOUT_MS = 120_000;

export function createSub2apiClient(getConfig) {
  async function request(endpoint, options = {}, configOverride = null) {
    const config = configOverride || getConfig();
    if (!config?.base_url) throw errors.sub2apiNotConfigured('请先配置 sub2api 后端地址');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${config.base_url.replace(/\/+$/, '')}${endpoint}`, {
        ...options,
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-api-key': config.admin_key,
          ...(options.headers || {}),
        },
      });
      const text = await response.text();
      let payload = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = null;
      }
      if (!response.ok) {
        const message = responseMessage(payload, text).slice(0, 400);
        throw new AppError(502, 'SUB2API_UNAVAILABLE', `sub2api 返回 HTTP ${response.status}${message ? `：${message}` : ''}`);
      }
      return payload;
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error?.name === 'AbortError') {
        throw new AppError(504, 'SUB2API_UNAVAILABLE', 'sub2api 请求超时（120s）');
      }
      throw new AppError(502, 'SUB2API_UNAVAILABLE', `无法连接 sub2api：${sanitizeText(String(error.message || error))}`);
    } finally {
      clearTimeout(timer);
    }
  }

  function listGroups() {
    return request('/api/v1/admin/groups/all?platform=openai');
  }

  function listProxies({ withCount = false } = {}) {
    return request(`/api/v1/admin/proxies/all${withCount ? '?with_count=true' : ''}`);
  }

  function createProxy(proxy) {
    return request('/api/v1/admin/proxies', { method: 'POST', body: JSON.stringify(proxy) });
  }

  function deleteProxiesBatch(ids) {
    return request('/api/v1/admin/proxies/batch-delete', { method: 'POST', body: JSON.stringify({ ids }) });
  }

  function bulkUpdateAccounts(payload) {
    return request('/api/v1/admin/accounts/bulk-update', { method: 'POST', body: JSON.stringify(payload) });
  }

  async function listAllOpenAiAccounts({ status = null } = {}, configOverride = null) {
    let page = 1;
    let pages = 1;
    const accounts = [];
    do {
      const query = new URLSearchParams({ page: String(page), page_size: '100', platform: 'openai' });
      if (status) query.set('status', status);
      const payload = await request(`/api/v1/admin/accounts?${query}`, {}, configOverride);
      const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
      const items = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];
      accounts.push(...items.filter((account) => account && String(account.platform || 'openai') === 'openai'));
      const reportedPages = Number(data?.pages);
      pages = Number.isSafeInteger(reportedPages) && reportedPages > 0 ? reportedPages : items.length >= 100 ? page + 1 : page;
      page += 1;
    } while (page <= pages && page <= 1000);
    return accounts;
  }

  /**
   * 按邮箱查找单个远端账号。
   *
   * 与 listAllOpenAiAccounts 的区别：这里按页扫描并在命中时**立即返回**，
   * 不会把远端全部账号拉完。上限 maxAccounts 兜住最坏情况（邮箱不存在时），
   * 一旦超过就当作「找不到」而不是继续翻页——
   * 否则在账号量大的实例上会退化成全量遍历并撞上请求超时。
   */
  async function findAccountByEmail(email, { maxAccounts = 2000, configOverride = null } = {}) {
    const target = String(email || '').trim().toLowerCase();
    if (!target) return null;
    const pageSize = 100;
    const maxPages = Math.max(1, Math.ceil(maxAccounts / pageSize));
    for (let page = 1; page <= maxPages; page += 1) {
      const query = new URLSearchParams({ page: String(page), page_size: String(pageSize), platform: 'openai' });
      const payload = await request(`/api/v1/admin/accounts?${query}`, {}, configOverride);
      const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
      const items = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];
      const hit = items.find((account) => accountEmail(account) === target);
      if (hit) return hit;
      if (items.length < pageSize) return null;
    }
    return null;
  }

  function getAccount(id) {
    return request(`/api/v1/admin/accounts/${id}`);
  }

  function getAccountStats(id, days = 90) {
    const safeDays = Math.min(90, Math.max(1, Math.floor(Number(days) || 90)));
    return request(`/api/v1/admin/accounts/${encodeURIComponent(id)}/stats?days=${safeDays}`);
  }

  function createAccountsBatch(accounts, idempotencyKey) {
    return request('/api/v1/admin/accounts/batch', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ accounts }),
    });
  }

  function updateAccount(id, payload) {
    return request(`/api/v1/admin/accounts/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
  }

  function clearError(id) {
    return request(`/api/v1/admin/accounts/${id}/clear-error`, { method: 'POST', body: '{}' });
  }

  function setSchedulable(id, schedulable) {
    return request(`/api/v1/admin/accounts/${id}/schedulable`, {
      method: 'POST',
      body: JSON.stringify({ schedulable }),
    });
  }

  /**
   * 从 Sub2API 管理端账号对象读取明确的累计消费字段。
   * 不把 balance/credits 当作已用金额，也不调用账号凭据对应的 OpenAI 接口。
   */
  function accountUsedAmount(account) {
    const candidates = [
      ['used_amount', account?.used_amount],
      ['consumed_amount', account?.consumed_amount],
      ['total_cost', account?.total_cost],
      ['cost', account?.cost],
      ['usage.used_amount', account?.usage?.used_amount],
      ['usage.consumed_amount', account?.usage?.consumed_amount],
      ['usage.total_cost', account?.usage?.total_cost],
      ['usage.cost', account?.usage?.cost],
      ['usage.totalCost', account?.usage?.totalCost],
      ['billing.used_amount', account?.billing?.used_amount],
      ['billing.total_cost', account?.billing?.total_cost],
      ['billing.cost', account?.billing?.cost],
      ['usage_stats.summary.total_cost', account?.usage_stats?.summary?.total_cost],
      ['stats.summary.total_cost', account?.stats?.summary?.total_cost],
      ['account_usage_stats.summary.total_cost', account?.account_usage_stats?.summary?.total_cost],
    ];
    for (const [source, value] of candidates) {
      const amount = Number(value);
      if (value !== null && value !== undefined && value !== '' && Number.isFinite(amount) && amount >= 0) {
        return { amount, source };
      }
    }
    return null;
  }

  /** 账号邮箱提取：credentials.email → extra.email → name 正则。 */
  function accountEmail(account) {
    const direct = [account?.credentials?.email, account?.extra?.email]
      .map((value) => String(value || '').trim().toLowerCase())
      .find((value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value));
    if (direct) return direct;
    const match = String(account?.name || '').toLowerCase().match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
    return match ? match[0] : null;
  }

  /** 错误信息提取（多字段），供分类器拼接匹配。 */
  function accountErrorMessage(account) {
    return [account?.error_message, account?.last_error, account?.message, account?.error?.message]
      .map((value) => (typeof value === 'string' ? value : ''))
      .filter(Boolean)
      .join(' | ');
  }

  /** OAuth 号限流态：sub2api 不写 status=error，用 rate_limited_at/rate_limit_reset_at 表示。 */
  function accountRateLimit(account) {
    const rateLimitedAt = account?.rate_limited_at ?? null;
    const resetAt = account?.rate_limit_reset_at ?? null;
    let limitedNow = Boolean(rateLimitedAt);
    if (limitedNow && resetAt) {
      const resetMs = Date.parse(resetAt);
      if (Number.isFinite(resetMs) && resetMs <= Date.now()) limitedNow = false; // 重置时间已过，脏标记
    }
    return { rate_limited_at: rateLimitedAt, rate_limit_reset_at: resetAt, limited_now: limitedNow };
  }

  async function testConnection(configOverride) {
    const t0 = Date.now();
    const payload = await request('/api/v1/admin/groups/all?platform=openai', {}, configOverride);
    const groups = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
    return { ok: true, groups: groups.length, latency_ms: Date.now() - t0 };
  }

  return {
    request,
    listGroups,
    listProxies,
    createProxy,
    deleteProxiesBatch,
    bulkUpdateAccounts,
    listAllOpenAiAccounts,
    getAccount,
    getAccountStats,
    createAccountsBatch,
    updateAccount,
    clearError,
    setSchedulable,
    findAccountByEmail,
    accountEmail,
    accountUsedAmount,
    accountErrorMessage,
    accountRateLimit,
    testConnection,
  };
}

function responseMessage(payload, text) {
  const message = payload?.error?.message || payload?.message || payload?.error || '';
  return typeof message === 'string' && message.trim() ? message.trim() : String(text || '').slice(0, 160);
}
