import nodeCrypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { errors } from '../../lib/http-errors.js';

/**
 * 上传管线：查重索引 → 新增/替换分流 → 最少绑定代理分配 → 余额后缀 → 回填。
 * 完整继承 v1 uploadJobsToSub2Api / buildSub2ApiUploadPayload 语义。
 * 注意：工厂参数 crypto 是应用加解密服务，Node crypto 模块用 nodeCrypto 别名避免遮蔽。
 */

export function createUploader({ db, crypto, client, getConfig, settingsGet, dataDir, proxySelector, logger }) {
  /** 读取账号当前导出文件（data/results/account-<id>.json）。 */
  function readAccountExport(accountId) {
    const exportPath = path.resolve(dataDir, 'results', `account-${accountId}.json`);
    return JSON.parse(fs.readFileSync(exportPath, 'utf8'));
  }

  async function uploadAccounts(accountIds, optionsOverride = {}) {
    const config = getConfig();
    if (!config?.base_url || !config?.admin_key) {
      throw errors.sub2apiNotConfigured('请先配置 sub2api 后端地址与管理员密钥');
    }
    // 默认分组取顶层 group_ids（与监控分组同源）；调用方显式传 group_ids 时以覆盖为准
    const options = mergeUploadOptions(
      { ...config.upload_defaults, group_ids: config.group_ids ?? [] },
      optionsOverride,
    );

    const accounts = [];
    const accountRows = [];
    for (const id of accountIds) {
      const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
      if (!row || !row.tokens_enc) continue;
      try {
        accounts.push(readAccountExport(id));
        accountRows.push(row);
      } catch (error) {
        logger?.warn?.({ accountId: id, err: error.message }, '读取账号导出文件失败，改用 tokens_enc 构建');
        const tokens = crypto.tryDecryptJson(row.tokens_enc, 'accounts.tokens_enc') || {};
        accounts.push(buildExportFromTokens(row, tokens));
        accountRows.push(row);
      }
    }
    if (!accounts.length) {
      return { created: 0, updated: 0, failed: accountIds.map((id) => ({ id, email: null, error: '账号不存在或缺少 tokens' })), updated_account_ids: [] };
    }

    // 远端全量索引
    const existing = await client.listAllOpenAiAccounts();
    const remoteByEmail = new Map();
    for (const acc of existing) {
      const email = client.accountEmail(acc);
      if (email) remoteByEmail.set(email, Number(acc.id));
    }

    // 代理分配（最少绑定 + 整批均匀）
    let proxySelection = null;
    if (!options.proxy_id && options.auto_select_proxy) {
      try {
        const proxyPayload = await client.listProxies();
        const proxies = Array.isArray(proxyPayload) ? proxyPayload : Array.isArray(proxyPayload?.data) ? proxyPayload.data : [];
        const activeProxyIds = new Set(
          proxies
            .filter((proxy) => proxy && Number.isInteger(Number(proxy.id)) && String(proxy.status || 'active') === 'active')
            .map((proxy) => Number(proxy.id)),
        );
        if (activeProxyIds.size) {
          const counts = new Map();
          for (const acc of existing) {
            const pid = Number(acc?.proxy_id);
            if (Number.isSafeInteger(pid) && pid > 0) counts.set(pid, (counts.get(pid) || 0) + 1);
          }
          proxySelection = { activeProxyIds, counts };
        }
      } catch {
        proxySelection = null;
      }
    }

    const toCreate = [];
    const toUpdate = [];
    const createdAccountIds = [];
    const emailById = new Map();
    accounts.forEach((exportData, index) => {
      const row = accountRows[index];
      const account = exportData?.accounts?.[0];
      if (!account?.credentials) return;
      const email = String(account.credentials.email || row.email || '').toLowerCase();
      emailById.set(row.id, email);
      const payload = buildPayload(account, options, proxySelection, row);
      const remoteId = email ? remoteByEmail.get(email) : null;
      if (Number.isSafeInteger(remoteId) && remoteId > 0) toUpdate.push({ id: row.id, payload, remoteId });
      else {
        toCreate.push({ id: row.id, payload });
        createdAccountIds.push(row.id);
      }
    });

    // 新增组：余额未查过则先实时查一次，追加 ---N 后缀
    for (const item of toCreate) {
      await appendBalanceSuffix(item, options, db, crypto);
    }

    let created = 0;
    const failed = [];
    const updatedAccountIds = [];

    if (toCreate.length) {
      try {
        await client.createAccountsBatch(
          toCreate.map((item) => item.payload),
          `tosub2-upload-${nodeCrypto.randomUUID()}`,
        );
        created = toCreate.length;
        // 批量创建响应不含新账号 ID：重拉远端索引按 email 回填真实 sub2api_account_id
        // （远端状态列、已上传统计、余额查询选路都依赖它；重拉失败退化为仅记上传时间，留待同步补齐）
        let createdIndexByEmail = null;
        try {
          const after = await client.listAllOpenAiAccounts();
          createdIndexByEmail = new Map();
          for (const acc of after) {
            const email = client.accountEmail(acc);
            if (email) createdIndexByEmail.set(email.toLowerCase(), Number(acc.id));
          }
        } catch (indexError) {
          logger?.warn?.({ err: indexError.message }, 'reload remote index after create failed');
        }
        const now = new Date().toISOString();
        const tx = db.transaction(() => {
          for (const item of toCreate) {
            const remoteId = createdIndexByEmail?.get(emailById.get(item.id));
            if (Number.isSafeInteger(remoteId) && remoteId > 0) {
              db.prepare(
                `UPDATE accounts SET sub2api_uploaded_at=?, sub2api_account_id=?, updated_at=? WHERE id=?`,
              ).run(now, remoteId, now, item.id);
            } else {
              db.prepare(
                `UPDATE accounts SET sub2api_uploaded_at=?, updated_at=? WHERE id=?`,
              ).run(now, now, item.id);
            }
            recordEvent(item.id, 'uploaded_sub2api', { mode: 'create', name: item.payload.name, remote_id: remoteId ?? null });
          }
        });
        tx();
      } catch (error) {
        for (const item of toCreate) {
          failed.push({ id: item.id, email: emailById.get(item.id), error: String(error.message || error).slice(0, 400) });
        }
      }
    }

    for (const item of toUpdate) {
      try {
        await client.updateAccount(item.remoteId, { credentials: item.payload.credentials });
        await client.clearError(item.remoteId);
        await client.setSchedulable(item.remoteId, true);
        updatedAccountIds.push(item.id);
        const now = new Date().toISOString();
        db.prepare(
          `UPDATE accounts SET sub2api_uploaded_at=?, sub2api_account_id=?, updated_at=? WHERE id=?`,
        ).run(now, item.remoteId, now, item.id);
        recordEvent(item.id, 'sub2api_replaced', { mode: 'replace', remote_id: item.remoteId });
      } catch (error) {
        failed.push({ id: item.id, email: emailById.get(item.id), error: String(error.message || error).slice(0, 400) });
      }
    }

    return { created, updated: updatedAccountIds.length, failed, updated_account_ids: updatedAccountIds };
  }

  function buildPayload(account, options, proxySelection, row) {
    const credentials = { ...(account.credentials || {}) };
    if (options.model_whitelist?.length) {
      credentials.model_mapping = Object.fromEntries(options.model_whitelist.map((model) => [model, model]));
    }
    const extra = { ...(account.extra && typeof account.extra === 'object' ? account.extra : {}) };
    if (options.disable_auto_pause_5h) extra.auto_pause_5h_disabled = true;
    else delete extra.auto_pause_5h_disabled;
    if (options.disable_auto_pause_7d) extra.auto_pause_7d_disabled = true;
    else delete extra.auto_pause_7d_disabled;
    // sub2api 账号级长上下文计费开关（OpenAI 账号超 272K 上下文按官方倍率计费）；上游缺省 false，这里显式写布尔值
    extra.openai_long_context_billing_enabled = options.enable_long_context_billing !== false;

    let proxyIdForAccount = options.proxy_id || 0;
    if (!proxyIdForAccount && proxySelection) {
      let minBound = Infinity;
      const candidates = [];
      for (const pid of proxySelection.activeProxyIds) {
        const bound = proxySelection.counts.get(pid) || 0;
        if (bound < minBound) {
          minBound = bound;
          candidates.length = 0;
          candidates.push(pid);
        } else if (bound === minBound) {
          candidates.push(pid);
        }
      }
      if (candidates.length) {
        proxyIdForAccount = candidates[Math.floor(Math.random() * candidates.length)];
        proxySelection.counts.set(proxyIdForAccount, (proxySelection.counts.get(proxyIdForAccount) || 0) + 1);
      }
    }

    // 未显式配置优先级时按余额分档（≤10→40 / 11-19→20 / 20-39→30 / ≥40→10），余额未知按 10 刀档
    const priority = options.priority ?? balanceTierPriority(row?.balance);

    const payload = {
      ...account,
      name: account.name || `oauth---${credentials.email || row.email}`,
      credentials,
      extra,
      status: 'active',
      schedulable: true,
      ...(options.group_ids?.length ? { group_ids: options.group_ids } : {}),
      ...(proxyIdForAccount ? { proxy_id: proxyIdForAccount } : {}),
      ...(options.concurrency !== null && options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
      ...(options.load_factor !== null && options.load_factor !== undefined ? { load_factor: options.load_factor } : {}),
      ...(priority !== null && priority !== undefined ? { priority } : {}),
    };
    delete payload.proxy_key;
    return payload;
  }

  async function appendBalanceSuffix(item, options, db, crypto) {
    const payload = item.payload;
    if (/---\d+$/.test(String(payload.name || ''))) return;
    const row = db.prepare('SELECT balance, balance_checked_at, tokens_enc FROM accounts WHERE id = ?').get(item.id);
    if (!row) return;
    let balance = row.balance;
    if (balance === null || balance === undefined) {
      // 实时查一次余额（失败不阻断，保持原名）。此时号尚未上传 sub2api，
      // 选路与登录一致：账号绑定代理 > 全局 alive 代理；无代理时受 strict_proxy 管控
      try {
        const tokens = crypto.tryDecryptJson(row.tokens_enc, 'accounts.tokens_enc') || {};
        if (!tokens.access_token) return;
        const { fetchChatgptCredits } = await import('../../core/chatgpt-credits.mjs');
        const { fetchWithTls } = await import('../../lib/openai-fetch.js');
        const credentials = crypto.tryDecryptJson(row.credentials_enc, 'accounts.credentials_enc') || {};
        const proxyUrl =
          credentials.proxy_url ||
          (proxySelector ? proxySelector.pickRandomAliveProxy()?.url : null) ||
          null;
        // 无可用代理且开启禁止直连时跳过补查（保持原名上传），绝不以本机 IP 直连
        if (!proxyUrl && settingsGet?.('engine.config')?.strict_proxy !== false) return;
        const result = await fetchChatgptCredits({
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          clientId: tokens.client_id,
          fetchImpl: (url, options) => fetchWithTls(url, options, { proxyUrl }),
        });
        balance = result.balance;
        db.prepare('UPDATE accounts SET balance=?, balance_checked_at=?, balance_error=NULL WHERE id=?').run(
          balance,
          new Date().toISOString(),
          item.id,
        );
      } catch {
        return;
      }
    }
    const usd = Math.round(Number(balance));
    if (Number.isFinite(usd)) {
      payload.name = `${payload.name}---${usd}`;
      // 实时补查到余额后同步校正分档优先级（buildPayload 构建时余额还是空）
      if (options.priority == null) payload.priority = balanceTierPriority(usd);
    }
  }

  function recordEvent(accountId, type, detail) {
    db.prepare('INSERT INTO account_events(account_id, type, detail, created_at) VALUES(?,?,?,?)').run(
      accountId,
      type,
      JSON.stringify(detail || {}),
      new Date().toISOString(),
    );
  }

  return { uploadAccounts };
}

export function buildExportFromTokens(row, tokens) {
  return {
    type: 'sub2api-data',
    version: 1,
    exported_at: new Date().toISOString(),
    proxies: [],
    accounts: [
      {
        name: `oauth---${tokens.email || row.email}`,
        platform: 'openai',
        type: 'oauth',
        credentials: {
          access_token: tokens.access_token,
          chatgpt_account_id: tokens.chatgpt_account_id,
          email: tokens.email || row.email,
          id_token: tokens.id_token,
          refresh_token: tokens.refresh_token,
        },
        extra: {
          account_id: tokens.chatgpt_account_id,
          chatgpt_account_id: tokens.chatgpt_account_id,
          chatgpt_user_id: tokens.chatgpt_user_id,
          client_id: tokens.client_id,
          email: tokens.email || row.email,
        },
        concurrency: 10,
        priority: 1,
        rate_multiplier: 1,
        auto_pause_on_expired: true,
      },
    ],
  };
}

/**
 * 余额分档默认优先级（仅在未显式配置 priority 时生效）：
 * ≤10 刀 → 40（优先消耗小额号），11-19 刀 → 20，20-39 刀 → 30，≥40 刀 → 10（大额号留作兜底）。
 * 档位取四舍五入后的整数余额，与名称 ---N 后缀同口径；未查过余额按默认 10 刀档计。
 */
export function balanceTierPriority(balance) {
  if (balance === null || balance === undefined || balance === '') return 20;
  const usd = Math.round(Number(balance));
  if (!Number.isFinite(usd)) return 20;
  if (usd <= 10) return 40;
  if (usd < 20) return 20;
  if (usd < 40) return 30;
  return 10;
}

export function mergeUploadOptions(defaults = {}, override = {}) {
  const merged = {
    group_ids: Array.isArray(defaults.group_ids)
      ? defaults.group_ids.map(Number).filter((v) => Number.isSafeInteger(v) && v > 0)
      : [],
    concurrency: defaults.concurrency ?? null,
    load_factor: defaults.load_factor ?? null,
    priority: defaults.priority ?? null,
    model_whitelist: defaults.model_whitelist || [],
    disable_auto_pause_5h: Boolean(defaults.disable_auto_pause_5h),
    disable_auto_pause_7d: Boolean(defaults.disable_auto_pause_7d),
    enable_long_context_billing: defaults.enable_long_context_billing !== false,
    auto_select_proxy: defaults.auto_select_proxy !== false,
    proxy_id: defaults.proxy_id ?? null,
    ...override,
  };
  return merged;
}
