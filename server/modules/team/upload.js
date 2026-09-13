import nodeCrypto from 'node:crypto';
import { errors } from '../../lib/http-errors.js';
import { mergeUploadOptions, normalizeCodexFingerprintMode } from '../sub2api/upload.js';
import { allocateShortName, extractAccountEmail } from './names.js';

/**
 * Team 号上传器：与 sub2api/upload.js 同一套创建/更新语义，但
 * - 数据源为 team_accounts（凭据存 account_enc，含完整 sub2api account 对象）
 * - 上传选项取 team.config（与现有号池的上传默认配置完全独立）
 * - 账号名使用简短名 team-MMDD-HHMM-N，remark 记录所属卡密
 * - 不做余额后缀
 */

export function createTeamUploader({ db, crypto, client, getSub2apiConfig, getTeamConfig, logger }) {
  function loadRows(accountIds) {
    const rows = [];
    for (const id of accountIds) {
      const row = db
        .prepare(
          `SELECT a.*, c.card_code FROM team_accounts a JOIN team_cards c ON c.id = a.card_id WHERE a.id = ?`,
        )
        .get(Number(id));
      if (!row || !row.account_enc) continue;
      rows.push(row);
    }
    return rows;
  }

  function ensureShortName(row, now) {
    if (row.short_name) return row.short_name;
    const shortName = allocateShortName(db);
    db.prepare('UPDATE team_accounts SET short_name = ?, updated_at = ? WHERE id = ?').run(shortName, now, row.id);
    return shortName;
  }

  async function buildProxySelection(options, existing) {
    if (options.proxy_id || !options.auto_select_proxy) return null;
    try {
      const proxyPayload = await client.listProxies();
      const proxies = Array.isArray(proxyPayload) ? proxyPayload : Array.isArray(proxyPayload?.data) ? proxyPayload.data : [];
      const activeProxyIds = new Set(
        proxies
          .filter((proxy) => proxy && Number.isInteger(Number(proxy.id)) && String(proxy.status || 'active') === 'active')
          .map((proxy) => Number(proxy.id)),
      );
      if (!activeProxyIds.size) return null;
      const counts = new Map();
      for (const acc of existing) {
        const pid = Number(acc?.proxy_id);
        if (Number.isSafeInteger(pid) && pid > 0) counts.set(pid, (counts.get(pid) || 0) + 1);
      }
      return { activeProxyIds, counts };
    } catch {
      return null;
    }
  }

  function pickLeastBoundProxy(proxySelection) {
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
    if (!candidates.length) return 0;
    const picked = candidates[Math.floor(Math.random() * candidates.length)];
    proxySelection.counts.set(picked, (proxySelection.counts.get(picked) || 0) + 1);
    return picked;
  }

  function buildPayload(account, row, options, proxySelection, now) {
    const credentials = { ...(account.credentials || {}) };
    if (options.model_whitelist?.length) {
      credentials.model_mapping = Object.fromEntries(options.model_whitelist.map((model) => [model, model]));
    }
    const extra = { ...(account.extra && typeof account.extra === 'object' ? account.extra : {}) };
    if (options.disable_auto_pause_5h) extra.auto_pause_5h_disabled = true;
    else delete extra.auto_pause_5h_disabled;
    if (options.disable_auto_pause_7d) extra.auto_pause_7d_disabled = true;
    else delete extra.auto_pause_7d_disabled;
    extra.openai_long_context_billing_enabled = options.enable_long_context_billing !== false;
    // Codex 指纹收敛：与 sub2api/upload.js 同一语义（off 不写键，收敛种子由 sub2api 侧托管）
    const fingerprintMode = normalizeCodexFingerprintMode(options.codex_fingerprint_mode);
    if (fingerprintMode !== 'off') extra.codex_fingerprint_mode = fingerprintMode;
    else delete extra.codex_fingerprint_mode;

    let proxyIdForAccount = options.proxy_id || 0;
    if (!proxyIdForAccount && proxySelection) proxyIdForAccount = pickLeastBoundProxy(proxySelection);

    const payload = {
      ...account,
      name: ensureShortName(row, now),
      remark: row.card_code,
      credentials,
      extra,
      status: 'active',
      schedulable: true,
      ...(options.group_ids?.length ? { group_ids: options.group_ids } : {}),
      ...(proxyIdForAccount ? { proxy_id: proxyIdForAccount } : {}),
      ...(options.concurrency !== null && options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
      ...(options.load_factor !== null && options.load_factor !== undefined ? { load_factor: options.load_factor } : {}),
      ...(options.priority !== null && options.priority !== undefined ? { priority: options.priority } : {}),
    };
    delete payload.proxy_key;
    return payload;
  }

  async function uploadTeamAccounts(accountIds, optionsOverride = {}) {
    const sub2apiConfig = getSub2apiConfig();
    if (!sub2apiConfig?.base_url || !sub2apiConfig?.admin_key) {
      throw errors.sub2apiNotConfigured('请先在 Sub2API 页面配置后端地址与管理员密钥');
    }
    const teamConfig = getTeamConfig() || {};
    const options = mergeUploadOptions(
      { ...(teamConfig.upload_defaults || {}), group_ids: teamConfig.group_ids ?? [] },
      optionsOverride,
    );

    const rows = loadRows(accountIds);
    if (!rows.length) {
      return {
        created: 0,
        updated: 0,
        failed: accountIds.map((id) => ({ id: Number(id), email: null, error: '账号不存在或缺少凭据' })),
      };
    }
    const now = new Date().toISOString();

    // 远端全量索引（按 email 查重分流）
    const existing = await client.listAllOpenAiAccounts();
    const remoteByEmail = new Map();
    for (const acc of existing) {
      const email = client.accountEmail(acc);
      if (email) remoteByEmail.set(email, Number(acc.id));
    }
    const proxySelection = await buildProxySelection(options, existing);

    const toCreate = [];
    const toUpdate = [];
    const failed = [];
    const emailById = new Map();
    for (const row of rows) {
      const account = crypto.tryDecryptJson(row.account_enc, 'team_accounts.account_enc');
      if (!account || typeof account !== 'object' || !account.credentials) {
        failed.push({ id: row.id, email: row.email, error: '凭据解密失败或缺失' });
        continue;
      }
      const email = extractAccountEmail(account) || String(row.email || '').toLowerCase();
      emailById.set(row.id, email);
      const payload = buildPayload(account, row, options, proxySelection, now);
      const remoteId = email ? remoteByEmail.get(email) : null;
      if (Number.isSafeInteger(remoteId) && remoteId > 0) toUpdate.push({ id: row.id, payload, remoteId });
      else toCreate.push({ id: row.id, payload, email });
    }

    let created = 0;
    const updatedIds = [];

    if (toCreate.length) {
      try {
        await client.createAccountsBatch(
          toCreate.map((item) => item.payload),
          `team-upload-${nodeCrypto.randomUUID()}`,
        );
        created = toCreate.length;
        // 批量创建响应不含新账号 ID：重拉远端索引按 email 回填
        let createdIndexByEmail = null;
        try {
          const after = await client.listAllOpenAiAccounts();
          createdIndexByEmail = new Map();
          for (const acc of after) {
            const email = client.accountEmail(acc);
            if (email) createdIndexByEmail.set(email.toLowerCase(), Number(acc.id));
          }
        } catch (indexError) {
          logger?.warn?.({ err: indexError.message }, 'reload remote index after team create failed');
        }
        const writeBack = db.transaction(() => {
          for (const item of toCreate) {
            const remoteId = createdIndexByEmail?.get(String(item.email).toLowerCase());
            if (Number.isSafeInteger(remoteId) && remoteId > 0) {
              db.prepare(
                `UPDATE team_accounts SET sub2api_uploaded_at = ?, sub2api_account_id = ?, updated_at = ? WHERE id = ?`,
              ).run(now, remoteId, now, item.id);
            } else {
              db.prepare(`UPDATE team_accounts SET sub2api_uploaded_at = ?, updated_at = ? WHERE id = ?`).run(now, now, item.id);
            }
          }
        });
        writeBack();
      } catch (error) {
        for (const item of toCreate) {
          failed.push({ id: item.id, email: item.email, error: String(error.message || error).slice(0, 400) });
        }
      }
    }

    for (const item of toUpdate) {
      try {
        await client.updateAccount(item.remoteId, { credentials: item.payload.credentials });
        await client.clearError(item.remoteId);
        await client.setSchedulable(item.remoteId, true);
        updatedIds.push(item.id);
        db.prepare(
          `UPDATE team_accounts SET sub2api_uploaded_at = ?, sub2api_account_id = ?, updated_at = ? WHERE id = ?`,
        ).run(now, item.remoteId, now, item.id);
      } catch (error) {
        failed.push({ id: item.id, email: emailById.get(item.id), error: String(error.message || error).slice(0, 400) });
      }
    }

    return { created, updated: updatedIds.length, failed, updated_account_ids: updatedIds };
  }

  return { uploadTeamAccounts };
}
