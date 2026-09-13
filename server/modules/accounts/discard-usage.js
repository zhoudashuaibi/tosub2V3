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

import { proxyAuthAccount } from '../../lib/sanitize.js';
import { extractRemoteProxy } from '../sub2api/remote-sync.js';

/** 未知用量的原因词表 —— 与 buildMainBalanceEstimate 的 reason 保持一致，前端可复用同一套文案。 */
export const DISCARD_USAGE_REASONS = {
  not_linked: '未关联远端账号',
  remote_account_not_found: '远端无此账号',
  remote_used_amount_unknown: '远端未提供用量字段',
  fetch_failed: '查询远端失败',
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
 * 把「本地废弃行 + 远端账号 + 取到的用量」映射为同步结果（纯函数，重点单测对象）。
 *
 * reason 词表与 buildMainBalanceEstimate 的未知原因保持同一口径：
 *   not_linked                  从未关联远端
 *   remote_account_not_found    关联过 / 有邮箱，但远端查不到
 *   remote_used_amount_unknown  远端存在但拿不到用量字段
 *   fetch_failed                查询过程出错（结论不可信，需要重试）
 */
export function classifyDiscardUsage({ row, remote, used, lookupError = null }) {
  if (!remote) {
    return {
      used_amount: null,
      used_amount_source: null,
      remote_account_id: null,
      reason: row.sub2api_account_id == null ? 'not_linked' : lookupError ? 'fetch_failed' : 'remote_account_not_found',
      detail: lookupError,
    };
  }
  const remoteId = Number.isSafeInteger(Number(remote.id)) ? Number(remote.id) : null;
  if (!used) {
    return {
      used_amount: null,
      used_amount_source: null,
      remote_account_id: remoteId,
      reason: 'remote_used_amount_unknown',
      detail: null,
    };
  }
  return {
    used_amount: used.amount,
    used_amount_source: used.source,
    remote_account_id: remoteId,
    reason: null,
    detail: null,
  };
}

/**
 * 批量解析废弃号用量。逐条独立，单条失败只计入 failed 不影响其余。
 *
 * 关键设计：**不预先拉取完整远端账号列表**。
 * 早期实现调用 `listAllOpenAiAccounts()`（分页遍历 sub2api 全部 openai 账号）来建 email 索引，
 * 代价与远端账号总数成正比：号多时单页请求 × 数十页串行，最终撞上 120s 超时，
 * 整个同步请求以 504 失败——表现为「所有账号都失败」。
 *
 * 改为按需解析（见 resolveTargetRemote）：
 *   - 有 sub2api_account_id → 直接查单账号接口（1 次请求）
 *   - 没有 ID → 才走邮箱查找，且带条数上限
 * 请求量只与实际要同步的账号数成正比，与远端总量无关。
 *
 * @param {{ db: object, client?: object, getClient?: () => object, logger?: object,
 *           buildFilterWhere?: (query: object) => { where: string, params: any[] } }} deps
 *   client 与 getClient 二选一：getClient 用于「sub2api 模块晚于本模块注册」的场景。
 *   buildFilterWhere：账号模块注入的列表筛选器（buildAccountFilters），
 *   让「未选中时同步当前筛选」与列表/徽章口径完全一致。
 */
export function createDiscardUsage({
  db,
  client = null,
  getClient = null,
  getRemoteSync = null,
  logger = null,
  buildFilterWhere = null,
  /** 走邮箱查找时最多查几个远端账号（超过即判定找不到，避免退化成全量遍历） */
  emailLookupMaxAccounts = 2000,
}) {
  function resolveClient() {
    const resolved = getClient ? getClient() : client;
    if (!resolved) throw new Error('sub2api 客户端未初始化');
    return resolved;
  }

  /**
   * 解析一个目标账号的远端记录。返回 { remote, lookupError }。
   * lookupError 非空表示「查不到」这个结论因为请求异常而不可信，需要把原因带给用户
   * （否则用户无法区分「远端确实没这个号」和「sub2api 连不上」）。
   */
  async function resolveTargetRemote(api, row) {
    const linked = Number(row.sub2api_account_id);
    if (Number.isSafeInteger(linked) && linked > 0 && typeof api.getAccount === 'function') {
      try {
        const payload = await api.getAccount(linked);
        const account = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
        if (account && Number(account.id ?? linked)) return { remote: account, lookupError: null };
      } catch (error) {
        // 单账号查不到（远端已删）→ 继续尝试邮箱；网络类错误记下来但不直接放弃
        logger?.debug?.({ accountId: row.id, err: error.message }, 'discard usage: getAccount failed');
      }
    }

    const email = String(row.email || '').trim().toLowerCase();
    if (!email) return { remote: null, lookupError: null };

    if (typeof api.findAccountByEmail === 'function') {
      try {
        const remote = await api.findAccountByEmail(email, { maxAccounts: emailLookupMaxAccounts });
        return { remote: remote ?? null, lookupError: null };
      } catch (error) {
        logger?.warn?.({ accountId: row.id, err: error.message }, 'discard usage: email lookup failed');
        return { remote: null, lookupError: error.message };
      }
    }
    return { remote: null, lookupError: null };
  }

  /**
   * 取一个远端账号的累计已用额度。
   *
   * **必须显式查 /stats 接口**：账号对象（无论来自列表还是单账号接口）通常不含费用字段，
   * 累计消费在 `/api/v1/admin/accounts/{id}/stats?days=N` 的 summary.total_cost 里。
   * 这里与「主号池预估剩余余额」用完全相同的手法：拉 stats → 合并成 usage_stats →
   * 再交给 client.accountUsedAmount() 按同一张候选表取值。
   * 少了这一步会一律得到「远端未提供用量字段」。
   */
  async function fetchUsedAmount(api, remote) {
    const pick = (account) => (api.accountUsedAmount ? api.accountUsedAmount(account) : null);

    // 少数账号对象可能自带用量字段，命中就不必再打一次统计接口
    const direct = pick(remote);
    if (direct) return { used: direct };

    if (typeof api.getAccountStats !== 'function' || remote?.id == null) return { used: null };

    try {
      const payload = await api.getAccountStats(remote.id, 90);
      const stats = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
      // 与「主号池预估剩余余额」完全一致：合并成 usage_stats 后再走同一张候选表
      return { used: pick({ ...remote, usage_stats: stats }) };
    } catch (error) {
      // 统计接口失败不阻断：没合并到就是没取到，按「远端未提供用量字段」归类
      logger?.debug?.({ remoteId: remote.id, err: error.message }, 'discard usage: getAccountStats failed');
      return { used: null };
    }
  }
  /**
   * 需要同步的废弃号：显式 ids，或按当前筛选/陈旧度筛全部废弃号。
   *
   * @param {object} options
   * @param {number[]|null} options.ids 明确目标（选中项），给了就只同步这些
   * @param {boolean} options.force 忽略快照新旧全量重算
   * @param {object|null} options.filters 当前列表筛选（q / reason / 废弃日期区间）。
   *   没选中的同步必须与按钮上的「待同步 N」同一口径，否则按钮写 20、实际扫全池 1498。
   */
  function selectTargets({ ids = null, force = false, filters = null } = {}) {
    if (Array.isArray(ids) && ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',');
      return db
        .prepare(`SELECT id, email, sub2api_account_id, discard_used_amount_at FROM accounts WHERE pool='discard' AND id IN (${placeholders}) ORDER BY id`)
        .all(...ids);
    }
    // 筛选条件由账号模块注入（与列表 buildAccountFilters 完全同源），保证「徽章数字 =
    // 同步范围」；没有注入器时退化为全池，保持旧行为。
    const scoped = typeof buildFilterWhere === 'function' && filters ? buildFilterWhere(filters) : null;
    const rows = scoped
      ? db
          .prepare(
            `SELECT id, email, sub2api_account_id, discard_used_amount_at FROM accounts ${scoped.where} ORDER BY id`,
          )
          .all(...scoped.params)
      : db
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

  /**
   * 废弃号池「废弃时的出口代理」快照。
   *
   * 主来源是调用方在废弃当下同步过来的远端绑定代理（sub2api 账号的 proxy_id → 代理名 + 认证账号）。
   * 兜底来源是本机 tosub2 代理：账号最后一次任务的 jobs.proxy_id（登录/修复任务真正走的出口）。
   *
   * 为什么兜底要单独查而不复用远端值：登录类废弃（login_failed / repair_failed）的号往往
   * 根本不在远端、也就没有远端绑定，但这批号恰恰是「本机代理出口被拉黑」最可疑的那批，
   * 有本机代理 id 也比空着强。两者都不会瞎猜：一个都没有就保持为空。
   */
  function writeProxySnapshot(accountId, proxy) {
    const pick = (value) => (value == null || String(value).trim() === '' ? null : String(value).trim());
    const rawId = Number(proxy?.id);
    const id = Number.isSafeInteger(rawId) && rawId > 0 ? rawId : null;
    const name = pick(proxy?.name);
    const username = pick(proxy?.username);
    if (!id && !name && !username) return null;
    const now = new Date().toISOString();
    const result = db
      .prepare(
        `UPDATE accounts SET discard_proxy_name=?, discard_proxy_user=?, discard_proxy_id=?, discard_proxy_at=?, updated_at=?
         WHERE id=? AND pool='discard'`,
      )
      .run(name, username, id, now, now, accountId);
    // 账号已被移回主池/删除时流水数=0：不留快照，也不留事件（否则列是空的、事件却写着有代理）
    if (result.changes === 0) return null;
    // 审计事件与「废弃」本身分开记：废弃当时挂的是哪条出口，事后要能单独回溯
    recordEvent(accountId, 'discard_proxy_snapshot', { proxy_id: id, name, username });
    return now;
  }

  /**
   * 本机 tosub2 代理兜底：该号最后一条用过代理的任务。
   *
   * 唯一索引保证每个账号同时只有一条活跃任务，所以「最后一次」就是废弃当时那次；
   * 按 created_at DESC 而不是 updated_at，避免任务收尾时的补写把顺序搅乱。
   * jobs.proxy_label 是 sub2api 绑定代理的展示名（余额任务走远端选路时记的），
   * 老库可能没有这一列，取不到就当没有，绝不因此让快照失败。
   */
  function resolveJobProxy(accountId) {
    let row = null;
    try {
      row = db
        .prepare(
          `SELECT proxy_id, proxy_label FROM jobs
           WHERE account_id=? AND (proxy_id IS NOT NULL OR proxy_label IS NOT NULL)
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(accountId);
    } catch {
      try {
        row = db
          .prepare(
            `SELECT proxy_id, NULL AS proxy_label FROM jobs
             WHERE account_id=? AND proxy_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
          )
          .get(accountId);
      } catch {
        return null;
      }
    }
    if (!row) return null;
    const local = Number(row.proxy_id);
    const localRow = Number.isSafeInteger(local) && local > 0
      ? db.prepare('SELECT id, label, display_url FROM proxies WHERE id=?').get(local)
      : null;
    const boundId = Number(row.proxy_id);
    return {
      id: localRow?.id ?? (Number.isSafeInteger(boundId) && boundId > 0 ? boundId : null),
      // 本机代理没起名字时退回 sub2api 绑定代理的展示名（余额任务走远端选路时记的）
      name: localRow?.label ?? row.proxy_label ?? null,
      username: proxyAuthAccount(localRow?.display_url),
    };
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
   * @param {{ ids?: number[]|null, force?: boolean, filters?: object|null,
   *           concurrency?: number, quiet?: boolean }} options
   *   quiet=true 时不写审计事件（用于废弃当下的自动快照，避免与 moved_to_discard 事件重复）
   */
  async function sync({ ids = null, force = false, filters = null, concurrency = 6, quiet = false } = {}) {
    const summary = {
      scanned: 0,
      updated: 0,
      not_linked: 0,
      remote_account_not_found: 0,
      remote_used_amount_unknown: 0,
      fetch_failed: 0,
      failed: 0,
    };
    const items = [];

    const targets = selectTargets({ ids, force, filters });
    summary.scanned = targets.length;
    if (targets.length === 0) return { summary, items };

    const api = resolveClient();

    for (let start = 0; start < targets.length; start += concurrency) {
      const batch = targets.slice(start, start + concurrency);
      const settled = await Promise.all(
        batch.map(async (row) => {
          // 单个账号的任何异常都不能中断整批：否则一条坏数据会让用户看到「全部失败」
          try {
            const { remote, lookupError } = await resolveTargetRemote(api, row);
            // 远端已定位到才需要查统计接口；没定位到直接归类
            const used = remote ? (await fetchUsedAmount(api, remote)).used : null;
            const resolved = classifyDiscardUsage({ row, remote, used, lookupError });

            if (resolved.reason) return { row, resolved, written: false };

            const at = writeSnapshot(row.id, {
              used_amount: resolved.used_amount,
              used_amount_source: resolved.used_amount_source,
            });
            if (!quiet) {
              recordEvent(row.id, 'discard_usage_synced', {
                used_amount: resolved.used_amount,
                source: resolved.used_amount_source,
                remote_id: resolved.remote_account_id,
              });
            }
            return { row, resolved, written: true, used_amount_at: at };
          } catch (error) {
            logger?.warn?.({ accountId: row.id, err: error.message }, 'discard usage: account failed');
            return {
              row,
              resolved: {
                used_amount: null,
                used_amount_source: null,
                remote_account_id: null,
                reason: 'fetch_failed',
                detail: error.message,
              },
              written: false,
            };
          }
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
          // 失败原因带给前端：用户需要看到「是账号不在远端」还是「sub2api 连不上」
          detail: resolved.detail ?? null,
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
   *
   * 走一条串行队列：批量废弃一次可能几百个号，若每个都并发打远端（每个 1~2 个请求）
   * 会把 sub2api 打爆；串行与早先「逐条 await」的语义一致，只是不再阻塞调用方。
   */
  let discardSnapshotQueue = Promise.resolve();

  function snapshotAfterDiscard(accountId, snapshot = {}) {
    const run = async () => {
      // 代理快照自己吞异常，成功与否只影响返回值
      const proxyWritten = await snapshotDiscardProxy(accountId, snapshot.proxy ?? null);
      try {
        const result = await sync({ ids: [accountId], concurrency: 1, quiet: true });
        const item = result.items[0] ?? null;
        return item ? { ...item, proxy_written: proxyWritten } : proxyWritten ? { proxy_written: true } : null;
      } catch (error) {
        logger?.warn?.({ accountId, err: error.message }, 'discard usage snapshot failed');
        return proxyWritten ? { proxy_written: true } : null;
      }
    };
    // 队列必须永不 reject：调用方基本都不 await（废弃是 fire-and-forget），
    // 一旦链上留下未处理的 reject，Node 会把它当未捕获异常处理。
    // 因此这里用 then(run, run) 续链（上一个失败也换 run 顶上），并对结果再兜一层 catch。
    discardSnapshotQueue = discardSnapshotQueue.then(run, run).catch(() => null);
    return discardSnapshotQueue;
  }

  /**
   * 代理快照：远端绑定优先，其次本机任务出口。整段吞异常 —— 代理列只是取证信息，
   * 绝不能因为它失败而影响用量快照或废弃流转。
   *
   * remoteProxy：调用方（巡检）在废弃当下同步过来的**远端账号对象**（不是代理对象）。
   * 有它就地从对象里提取，不必再查远端 —— 也查不到：事务提交后号可能已被暂停/删除，
   * 或已被改绑，事后再查拿到的不是废弃当时的出口。
   */
  async function snapshotDiscardProxy(accountId, remoteProxy) {
    try {
      // 传进来的可能是「带 proxy 的远端账号」，也可能是已经提好的代理对象（两者的字段同名，
      // extractRemoteProxy 都能认）。号没绑代理时它返回 null → 继续走下面的回退，
      // 不能当成「解析成功但值为空」而提前收工。
      let resolved = extractRemoteProxy(remoteProxy);
      // 调用方没给（手动批量废弃、登录终局失败）→ 自己去远端找一次；
      // 远端同步模块可能晚于本模块注册，用 getRemoteSync 惰性取。
      if (!resolved) {
        const remoteSync = getRemoteSync ? getRemoteSync() : null;
        if (remoteSync?.resolveDiscardProxy) {
          const row = db.prepare('SELECT email, sub2api_account_id FROM accounts WHERE id=?').get(accountId);
          if (row) {
            resolved = await remoteSync.resolveDiscardProxy({
              accountId: row.sub2api_account_id,
              email: row.email,
            });
          }
        }
      }
      if (!resolved) resolved = resolveJobProxy(accountId);
      return Boolean(writeProxySnapshot(accountId, resolved));
    } catch (error) {
      logger?.debug?.({ accountId, err: error.message }, 'discard proxy snapshot failed');
      return false;
    }
  }

  return { sync, snapshotAfterDiscard, selectTargets };
}
