/**
 * 废弃号池「已用额度」快照。
 *
 * 取值与「主号池预估剩余余额」完全同源：sub2api 管理端账号用量
 * （client.accountUsedAmount → used_amount / consumed_amount / total_cost / usage.* /
 *   usage_stats.summary.total_cost）。
 *
 * 为什么需要快照列而不是每次现查：
 *  1. sub2api 只保留账号**当前累计**用量，不提供历史时点查询，所以「废弃那一刻的用量」
 *     只能在废弃当下抓一次；事后刷新得到的是当前累计值，UI 会标注同步时间。
 *  2. 远端账号可能被删除（远端同步只扫主号池，废弃号的 sub2api_account_id 会变陈旧），
 *     快照能保住已有数字。
 *
 * 远端解析沿用与主池预估相同的双路回退：sub2api_account_id 命中 → 否则按 email 命中。
 */

/** 未知用量的原因词表 —— 与 buildMainBalanceEstimate 的 reason 保持一致，前端可复用同一套文案。 */
export const DISCARD_USAGE_REASONS = {
  not_linked: '未关联远端账号',
  remote_account_not_found: '远端无此账号',
  remote_used_amount_unknown: '远端未提供用量字段',
};

/** 快照超过该时长即视为待同步（与 UI 的 used_amount_stale 判定同一口径）。 */
export const DISCARD_USAGE_STALE_MS = 24 * 3600 * 1000;

/** 无快照或快照过期 → 待同步。时间戳是 ISO 字符串，Date.parse 失败也按待同步处理。 */
export function isStale(at, staleMs = DISCARD_USAGE_STALE_MS) {
  if (!at) return true;
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) return true;
  return Date.now() - ms > staleMs;
}

/**
 * 按 id / email 建远端账号索引（语义与 modules/sub2api/remote-sync.js buildAccountIndex 一致）。
 */
export function buildRemoteIndex(remoteAccounts, accountEmail) {
  const byId = new Map();
  const byEmail = new Map();
  for (const account of remoteAccounts) {
    const id = Number(account?.id);
    if (Number.isSafeInteger(id) && id > 0) byId.set(id, account);
    const email = accountEmail(account);
    if (email) byEmail.set(String(email).toLowerCase(), account);
  }
  return { byId, byEmail };
}

/** 单个本地行 → 远端账号（双路回退）。 */
export function resolveRemoteAccount(row, index) {
  const linked = Number(row.sub2api_account_id);
  if (Number.isSafeInteger(linked) && linked > 0) {
    const hit = index.byId.get(linked);
    if (hit) return hit;
  }
  const email = String(row.email || '').trim().toLowerCase();
  return email ? index.byEmail.get(email) ?? null : null;
}

/**
 * 把「本地废弃行 + 远端账号」映射为用量解析结果（纯函数，重点单测对象）。
 *
 * @returns {{ used_amount: number|null, used_amount_source: string|null, remote_account_id: number|null, reason: string|null }}
 */
export function resolveDiscardUsage(row, remote, accountUsedAmount) {
  if (!remote) {
    return {
      used_amount: null,
      used_amount_source: null,
      remote_account_id: null,
      reason: row.sub2api_account_id == null ? 'not_linked' : 'remote_account_not_found',
    };
  }
  const used = accountUsedAmount ? accountUsedAmount(remote) : null;
  return {
    used_amount: used?.amount ?? null,
    used_amount_source: used?.source ?? null,
    remote_account_id: Number.isSafeInteger(Number(remote.id)) ? Number(remote.id) : null,
    reason: used ? null : 'remote_used_amount_unknown',
  };
}

/**
 * 批量解析废弃号用量。逐条独立，单条失败只计入 failed 不影响其余。
 *
 * @param {{ db: object, client?: object, getClient?: () => object, logger?: object }} deps
 *   client 与 getClient 二选一：getClient 用于「sub2api 模块晚于本模块注册」的场景。
 */
export function createDiscardUsage({ db, client = null, getClient = null, logger = null }) {
  function resolveClient() {
    const resolved = getClient ? getClient() : client;
    if (!resolved) throw new Error('sub2api 客户端未初始化');
    return resolved;
  }
  /** 需要同步的废弃号：显式 ids，或按陈旧度/force 筛全部废弃号。 */
  function selectTargets({ ids = null, force = false } = {}) {
    if (Array.isArray(ids) && ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',');
      return db
        .prepare(`SELECT id, email, sub2api_account_id, discard_used_amount_at FROM accounts WHERE pool='discard' AND id IN (${placeholders}) ORDER BY id`)
        .all(...ids);
    }
    const rows = db
      .prepare(`SELECT id, email, sub2api_account_id, discard_used_amount_at FROM accounts WHERE pool='discard' ORDER BY id`)
      .all();
    if (force) return rows;
    // 默认只补没快照或快照过期的：一次几百个远端请求代价高，不能每次点都全量跑
    return rows.filter((row) => isStale(row.discard_used_amount_at));
  }

  function writeSnapshot(accountId, { used_amount, used_amount_source }) {
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE accounts SET discard_used_amount=?, discard_used_amount_at=?, discard_used_amount_source=?, updated_at=?
       WHERE id=? AND pool='discard'`,
    ).run(used_amount, now, used_amount_source ?? null, now, accountId);
    return now;
  }

  function recordEvent(accountId, type, detail) {
    db.prepare('INSERT INTO account_events(account_id, type, detail, created_at) VALUES(?,?,?,?)').run(
      accountId,
      type,
      JSON.stringify(detail ?? {}),
      new Date().toISOString(),
    );
  }

  /**
   * 同步废弃号用量。
   * @param {{ ids?: number[]|null, force?: boolean, concurrency?: number, quiet?: boolean }} options
   *   quiet=true 时不写审计事件（用于废弃当下的自动快照，避免与 moved_to_discard 事件重复）
   */
  async function sync({ ids = null, force = false, concurrency = 6, quiet = false } = {}) {
    const summary = {
      scanned: 0,
      updated: 0,
      not_linked: 0,
      remote_account_not_found: 0,
      remote_used_amount_unknown: 0,
      failed: 0,
    };
    const items = [];

    const targets = selectTargets({ ids, force });
    summary.scanned = targets.length;
    if (targets.length === 0) return { summary, items };

    // 一次全量拉远端账号列表，再按 id/email 建索引：避免逐号调用 list 接口
    const api = resolveClient();
    const remoteAccounts = await api.listAllOpenAiAccounts();
    const index = buildRemoteIndex(remoteAccounts, (account) => api.accountEmail(account));

    for (let start = 0; start < targets.length; start += concurrency) {
      const batch = targets.slice(start, start + concurrency);
      const settled = await Promise.all(
        batch.map(async (row) => {
          const resolved = resolveDiscardUsage(row, resolveRemoteAccount(row, index), (account) =>
            api.accountUsedAmount(account),
          );
          if (resolved.reason) return { row, resolved, written: false };
          const used = {
            used_amount: resolved.used_amount,
            used_amount_source: resolved.used_amount_source,
          };
          const at = writeSnapshot(row.id, used);
          if (!quiet) {
            recordEvent(row.id, 'discard_usage_synced', {
              used_amount: used.used_amount,
              source: used.used_amount_source,
              remote_id: resolved.remote_account_id,
            });
          }
          return { row, resolved, written: true, used_amount_at: at };
        }),
      );

      for (const entry of settled) {
        const { row, resolved } = entry;
        if (resolved.reason) {
          summary[resolved.reason] = (summary[resolved.reason] ?? 0) + 1;
        } else if (entry.written) {
          summary.updated += 1;
        }
        items.push({
          id: row.id,
          email: row.email,
          used_amount: resolved.used_amount,
          used_amount_source: resolved.used_amount_source,
          used_amount_at: entry.used_amount_at ?? row.discard_used_amount_at ?? null,
          remote_account_id: resolved.remote_account_id,
          reason: resolved.reason,
          ok: !resolved.reason,
        });
      }
    }

    logger?.info?.({ ...summary }, 'discard usage sync done');
    return { summary, items };
  }

  /**
   * 废弃当下的自动快照：单个账号，best-effort。
   * 调用点不做 await（与 banMailCheck.check 的「异步、不阻塞终态流转」模式一致），
   * 因此这里必须自己吞掉所有异常。
   */
  async function snapshotAfterDiscard(accountId) {
    try {
      const result = await sync({ ids: [accountId], concurrency: 1, quiet: true });
      return result.items[0] ?? null;
    } catch (error) {
      logger?.warn?.({ accountId, err: error.message }, 'discard usage snapshot failed');
      return null;
    }
  }

  return { sync, snapshotAfterDiscard, selectTargets };
}
