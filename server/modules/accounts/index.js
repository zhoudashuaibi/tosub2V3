import fs from 'node:fs';
import path from 'node:path';
import { parsePagination } from '../../lib/db.js';
import { errors } from '../../lib/http-errors.js';
import { createPools } from './pools.js';
import { parseImportLines, parseTwofaLines, parsePasswordFileText, parseTosub2Export, parseSub2apiAccountsExport, credentialsForImport } from './import.js';
import { buildTosub2ExportPayload, tosub2ExportFilename } from './export.js';
import { buildExportFromTokens } from '../sub2api/upload.js';
import { createMailInit } from './mail-init.js';
import { createBanMailCheck } from './ban-mail-check.js';
import { sanitizeText } from '../../lib/sanitize.js';
import { UPLOAD_ORDERS, uploadOrderExpr, joinedMainPoolAtExpr } from '../../lib/upload-order.js';
import { createDiscardUsage } from './discard-usage.js';

const POOLS = ['reserve', 'main', 'discard'];

/**
 * 废弃池时间线派生列：
 *  - reserve_joined_at：加入备用号池时间（与 upload-order 同口径：imported_at 优先）
 *  - joined_main_at：「加入主号池时间」唯一口径，见 lib/upload-order.js joinedMainPoolAtExpr
 * 两者都只依赖已有字段与审计事件，不新增数据库列。
 */
const DISCARD_TIMELINE_COLUMNS = `COALESCE(accounts.imported_at, accounts.created_at) AS reserve_joined_at,
      ${joinedMainPoolAtExpr('accounts')} AS joined_main_at`;

/** 废弃池「已用额度」快照超过该时长即视为待同步（UI 会高亮同步入口）。 */
const DISCARD_USAGE_STALE_MS = 24 * 3600 * 1000;

/** 无快照或快照过期 → 待同步。 */
function isDiscardUsageStale(at) {
  if (!at) return true;
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) return true;
  return Date.now() - ms > DISCARD_USAGE_STALE_MS;
}

function initialBalanceFromSub2apiName(name) {
  const match = String(name || '').match(/---(\d+)$/);
  if (!match) return null;
  const balance = Number(match[1]);
  return Number.isSafeInteger(balance) && balance >= 0 ? balance : null;
}

function finiteNonNegativeAmount(value) {
  if (value === null || value === undefined || value === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

export function buildMainBalanceEstimate(rows, remoteAccounts, { accountEmail, accountUsedAmount }) {
  const byId = new Map(remoteAccounts.filter((account) => account?.id != null).map((account) => [String(account.id), account]));
  const byEmail = new Map(
    remoteAccounts
      .map((account) => [String(accountEmail(account) || '').trim().toLowerCase(), account])
      .filter(([email]) => email),
  );
  const items = [];
  let total = 0;
  let calculable = 0;

  for (const row of rows) {
    const remote = (row.sub2api_account_id != null && byId.get(String(row.sub2api_account_id))) || byEmail.get(String(row.email || '').trim().toLowerCase());
    const initialMissing = row.initial_balance === null || row.initial_balance === undefined || row.initial_balance === '';
    const localInitial = initialMissing ? null : finiteNonNegativeAmount(row.initial_balance);
    const suffixInitial = initialMissing && remote ? initialBalanceFromSub2apiName(remote.name) : null;
    const initial = localInitial ?? suffixInitial;
    const initialBalanceSource = localInitial !== null ? 'local' : suffixInitial !== null ? 'sub2api_name_suffix' : null;
    const used = remote ? accountUsedAmount(remote) : null;
    let reason = null;
    if (!remote) reason = row.sub2api_account_id == null ? 'not_uploaded' : 'remote_account_not_found';
    else if (initial === null) reason = 'initial_balance_unknown';
    else if (!used) reason = 'remote_used_amount_unknown';

    const item = {
      id: row.id,
      email: row.email,
      initial_balance: initial,
      initial_balance_source: initialBalanceSource,
      sub2api_account_id: remote?.id ?? row.sub2api_account_id ?? null,
      used_amount: used?.amount ?? null,
      used_amount_source: used?.source ?? null,
      estimated_remaining: null,
      reason,
    };
    if (!reason) {
      item.estimated_remaining = Math.max(0, Number((initial - used.amount).toFixed(2)));
      total += item.estimated_remaining;
      calculable += 1;
    }
    items.push(item);
  }

  return {
    scope: 'main',
    estimate: true,
    source: 'sub2api_admin_usage_minus_initial_balance',
    queried_at: new Date().toISOString(),
    account_count: rows.length,
    calculable_count: calculable,
    unknown_count: rows.length - calculable,
    total_estimated_remaining: Number(total.toFixed(2)),
    items,
  };
}

const SORT_WHITELIST = {
  reserve: {
    created_at: 'created_at',
    email: 'email',
    imported_at: 'imported_at',
    balance: 'initial_balance',
    initial_balance: 'initial_balance',
    banned: 'banned',
    mail_status: 'mail_status',
    last_checked_at: 'last_checked_at',
  },
  main: {
    created_at: 'created_at',
    email: 'email',
    balance: 'balance',
    status: 'status',
    // 远端状态是派生列：远端镜像 status 优先（未同步过回退本地登录状态），active < 其他状态 < 未上传
    remote_status: `CASE WHEN sub2api_account_id IS NULL THEN 2 WHEN COALESCE(sub2api_status, status) = 'active' THEN 0 ELSE 1 END`,
    last_login_at: 'last_login_at',
    sub2api_uploaded_at: 'sub2api_uploaded_at',
  },
  discard: {
    created_at: 'created_at',
    email: 'email',
    discarded_at: 'discarded_at',
    // 时间线列：SELECT 里的派生别名，SQLite 允许 ORDER BY 引用它
    reserve_joined_at: 'reserve_joined_at',
    joined_main_at: 'joined_main_at',
    // 未知用量的号要沉底：ASC 下 NULL 会顶到最前。
    // 不能用 COALESCE(v, -1) —— 该列被输出别名遮蔽，表达式里的标识符会解析成别名本身，
    // 于是 COALESCE 永远拿到非 NULL 的别名，兜底形同虚设（实测两个方向都排在最后才失败）。
    // 显式两段排序：先按「是否为空」分组，再按值排序，ASC/DESC 都稳定。
    discard_used_amount: 'CASE WHEN accounts.discard_used_amount IS NULL THEN 1 ELSE 0 END, accounts.discard_used_amount',
  },
};

export function parseDiscardedAtRange(query = {}) {
  const parse = (value, name) => {
    if (value === undefined || value === null || value === '') return null;
    const timestamp = Date.parse(String(value));
    if (!Number.isFinite(timestamp)) throw errors.validation(`${name} 必须是有效的 ISO 时间`);
    return new Date(timestamp).toISOString();
  };
  const from = parse(query.discarded_from, 'discarded_from');
  const to = parse(query.discarded_to, 'discarded_to');
  if (from && to && from >= to) throw errors.validation('discarded_from 必须早于 discarded_to');
  return { from, to };
}

export function appendDiscardedAtFilters(filters, params, query = {}) {
  const { from, to } = parseDiscardedAtRange(query);
  if (from) {
    filters.push('discarded_at >= ?');
    params.push(from);
  }
  if (to) {
    filters.push('discarded_at < ?');
    params.push(to);
  }
}

export function createAccountsModule({ engine, logger }) {
  return async function accountsModule(app) {
    const db = app.db;
    const crypto = app.crypto;
    const pools = createPools(db, crypto);
    // 废弃号用量快照：sub2api 模块可能晚于本模块注册，用 getClient 惰性取。
    // buildFilterWhere 注入列表筛选器（buildAccountFilters），使「未选中时同步当前筛选」
    // 与列表/徽章同一口径 —— 传进来的 query 里没有 pool，这里固定补成 discard。
    const discardUsage = createDiscardUsage({
      db,
      getClient: () => app.sub2apiClient,
      logger,
      buildFilterWhere: (query) => buildAccountFilters({ ...query, pool: 'discard' }),
    });
    // 让 sub2api 监控的自动废弃路径也能复用同一条快照通道
    // （monitor 在 sub2api 模块里创建、本模块更早注册，因此用全局引用反向传递）
    globalThis.__tosub2DiscardUsage = discardUsage;
    const mailInit = createMailInit({
      db,
      decryptCredentials: (account) => crypto.tryDecryptJson(account.credentials_enc, 'accounts.credentials_enc'),
      logger,
    });
    const banMailCheck = createBanMailCheck({
      db,
      decryptCredentials: (account) => crypto.tryDecryptJson(account?.credentials_enc, 'accounts.credentials_enc'),
      logger,
    });

    const decryptCredentials = (account) =>
      crypto.tryDecryptJson(account?.credentials_enc, 'accounts.credentials_enc') || {};

    /** 按 order 重排手动批量操作的 ids；金额=COALESCE(实时余额,初始余额)，时间=加入当前池的时间。 */
    const orderIdsForUpload = (ids, order, pool) => {
      if (!order || ids.length < 2) return ids;
      const direction = order.endsWith('_desc') ? 'DESC' : 'ASC';
      const placeholders = ids.map(() => '?').join(',');
      const rows = db
        .prepare(
          `SELECT a.id FROM accounts a WHERE a.id IN (${placeholders}) ORDER BY ${uploadOrderExpr(order, pool)}, a.id ${direction}`,
        )
        .all(...ids);
      const ordered = new Set(rows.map((row) => row.id));
      return [...rows.map((row) => row.id), ...ids.filter((id) => !ordered.has(id))];
    };

    // 引擎回调：登录任务终态 → 池流转
    engine.hooks.onLoginFinished = (job, account, { ok, code, message, canceled }) => {
      if (!job?.account_id) return;
      try {
        if (canceled) {
          // 用户放弃：回池但不算失败
          if (account?.pool === 'reserve') {
            db.prepare(
              `UPDATE accounts SET status='mail_failed', mail_error='任务已取消', updated_at=? WHERE id=? AND pool='reserve' AND status='joining'`,
            ).run(new Date().toISOString(), job.account_id);
          } else {
            db.prepare(
              `UPDATE accounts SET status='needs_reauth', updated_at=? WHERE id=? AND pool='main' AND status='authorizing'`,
            ).run(new Date().toISOString(), job.account_id);
          }
          return;
        }
        if (ok) return;
        pools.joinFailed(job.account_id, {
          error: message || code || '登录失败',
          jobId: job.id,
          permanent: /login_failed_permanent/.test(code || ''),
        });
      } catch (error) {
        logger.warn({ accountId: job.account_id, err: error.message }, 'onLoginFinished hook failed');
      }
    };

    engine.hooks.onTokensSaved = (job, runtime, tokens) => {
      if (!job?.account_id) return;
      try {
        // 转池必须最先执行：如需派生任务须延迟到 onLoginFinished（任务终态后），
        // 否则同账号活跃任务唯一索引冲突会把整个转池中断
        const result = pools.joinSucceeded(job.account_id, {
          tokensEnc: crypto.encryptJson(tokens, 'accounts.tokens_enc'),
          balance: null,
          balanceCheckedAt: null,
        });
        // 登录最终成功后删 checkpoint（token 已入库）
        const checkpointPath = path.resolve(app.config.dataDir, 'checkpoints', String(job.account_id), 'login.json');
        fs.rmSync(checkpointPath, { force: true });
        // 可选：新加入主号池后自动上传 sub2api
        const sub2apiConfig = app.settings.get('sub2api.config');
        if (sub2apiConfig?.join_auto_upload && !result.reauth) {
          app.sub2apiUploader?.uploadAccounts([job.account_id], {}).catch((error) =>
            logger.warn({ err: error.message }, 'join_auto_upload failed'),
          );
        }
      } catch (error) {
        logger.error({ accountId: job.account_id, err: error.message }, 'onTokensSaved hook failed');
      }
    };

    engine.hooks.onPermanentFailure = (job, runtime, message) => {
      if (!job?.account_id) return;
      try {
        pools.moveToDiscard(job.account_id, 'login_failed', message, { fromPools: ['reserve', 'main'] });
      } catch (error) {
        logger.warn({ err: error.message }, 'onPermanentFailure hook failed');
      }
      // 邮箱辅证：拉封禁邮件比对（异步，不阻塞任务终态流转）
      Promise.resolve(banMailCheck.check(job.account_id, { source: 'login_permanent_failure' })).catch(() => {});
    };

    // ---------------- 主号池预估余额（Sub2API 管理端只读） ----------------
    app.get('/api/v1/accounts/main-balance-estimate', async () => {
      const client = app.sub2apiClient;
      const config = app.settings.get('sub2api.config');
      if (!client || !config?.base_url || !config?.admin_key) {
        throw errors.validation('请先配置 sub2api 管理员密钥和后端地址');
      }
      const rows = db
        .prepare(`SELECT id, email, initial_balance, sub2api_account_id FROM accounts WHERE pool='main' ORDER BY id ASC`)
        .all();
      const remoteAccounts = await client.listAllOpenAiAccounts();
      const localIds = new Set(rows.filter((row) => row.sub2api_account_id != null).map((row) => String(row.sub2api_account_id)));
      const localEmails = new Set(rows.map((row) => String(row.email || '').trim().toLowerCase()).filter(Boolean));
      const relevantRemoteAccounts = remoteAccounts.filter(
        (account) => localIds.has(String(account?.id)) || localEmails.has(String(client.accountEmail(account) || '')),
      );
      const remoteWithStats = [];
      const concurrency = 6;
      for (let start = 0; start < relevantRemoteAccounts.length; start += concurrency) {
        const batch = relevantRemoteAccounts.slice(start, start + concurrency);
        const results = await Promise.all(
          batch.map(async (account) => {
            try {
              const payload = await client.getAccountStats(account.id, 90);
              const stats = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
              return { ...account, usage_stats: stats };
            } catch (error) {
              logger.warn({ accountId: account.id, err: error.message }, 'sub2api account stats query failed');
              return account;
            }
          }),
        );
        remoteWithStats.push(...results);
      }
      return buildMainBalanceEstimate(rows, remoteWithStats, client);
    });

    // ---------------- 列表 ----------------
    /**
     * 把 query 翻译成 WHERE 子句（列表、按筛选导出、按筛选全选共用同一套口径）。
     * 放在 handler 外层：多个路由要复用，避免「列表过滤」与「导出过滤」两套实现漂移。
     */
    function buildAccountFilters(query) {
      const pool = String(query.pool || '');
      if (!POOLS.includes(pool)) throw errors.validation('pool 必须是 reserve / main / discard');
      const filters = ['pool = ?'];
      const params = [pool];
      if (query.q) {
        filters.push('email LIKE ?');
        params.push(`%${String(query.q)}%`);
      }
      if (query.status) {
        filters.push('status = ?');
        params.push(String(query.status));
      }
      if (query.banned === 'true' || query.banned === '1') filters.push('banned = 1');
      if (query.banned === 'false' || query.banned === '0') filters.push('banned = 0');
      if (query.has_balance === 'true') filters.push('has_balance = 1');
      if (query.has_balance === 'false' || query.has_balance === '0') filters.push('has_balance = 0');
      // 备用池快捷筛选「可用」：未封禁、不在加入流程且有已知余额，与 poolStats / dashboard 口径一致
      if (pool === 'reserve' && query.available === 'true') {
        filters.push("banned = 0 AND status != 'joining' AND has_balance = 1");
      }
      if (pool === 'discard') {
        if (query.reason) {
          const reason = String(query.reason);
          // 历史 NULL 归入 manual，与 poolStats 统计口径一致
          if (reason === 'manual') filters.push("(discard_reason = 'manual' OR discard_reason IS NULL)");
          else {
            filters.push('discard_reason = ?');
            params.push(reason);
          }
        }
        appendDiscardedAtFilters(filters, params, query);
      }
      if (pool === 'main' && (query.uploaded === 'true' || query.uploaded === 'false')) {
        filters.push(query.uploaded === 'true' ? 'sub2api_account_id IS NOT NULL' : 'sub2api_account_id IS NULL');
      }
      // 远端状态筛选与列表展示口径一致：远端镜像 status 优先，未同步回退本地登录状态
      if (pool === 'main' && query.remote_status) {
        const remoteStatus = String(query.remote_status);
        if (remoteStatus === 'not_uploaded') filters.push('sub2api_account_id IS NULL');
        else if (remoteStatus === 'active')
          filters.push("sub2api_account_id IS NOT NULL AND COALESCE(sub2api_status, status) = 'active'");
        else if (remoteStatus === 'abnormal')
          filters.push("sub2api_account_id IS NOT NULL AND COALESCE(sub2api_status, status) != 'active'");
      }
      return { pool, where: `WHERE ${filters.join(' AND ')}`, params };
    }

    /** 解析 sort 参数为 ORDER BY 片段（白名单内的列 + 稳定 tiebreaker）。 */
    function resolveAccountSort(query, pool) {
      const defaultSort = pool === 'discard' ? 'discarded_at:desc' : 'created_at';
      const sortParam = String(query.sort || defaultSort);
      const sortKey = sortParam.replace(/:(asc|desc)$/i, '');
      const sortDir = /:desc$/i.test(sortParam) ? 'DESC' : 'ASC';
      const sortColumn = SORT_WHITELIST[pool][sortKey] || defaultSort.replace(/:(asc|desc)$/i, '');
      return { sortColumn, sortDir };
    }

    /**
     * 按筛选取出全部 id（上限保护）。
     *
     * 用途：前端「选中全部 N 条筛选结果」后要执行批量操作，而批量接口只收 id 列表。
     * 这里让服务端用与列表完全相同的口径解析行集合，前端拿到 id 后再按接口 maxItems 分片。
     * 上限同时兜住两件事：生成的 id 列表长度，以及每个分片 SQL 的绑定变量数量。
     */
    function selectAllMatchingAccountIds(query, limit) {
      const { where, params } = buildAccountFilters(query);
      const { sortColumn, sortDir } = resolveAccountSort(query, query.pool);
      const total = db.prepare(`SELECT COUNT(*) AS n FROM accounts ${where}`).get(...params).n;
      const rows = db
        .prepare(`SELECT id FROM accounts ${where} ORDER BY ${sortColumn} ${sortDir}, id DESC`)
        .all(...params);
      return {
        ids: rows.map((row) => row.id).slice(0, limit),
        total,
        truncated: rows.length > limit,
      };
    }

    app.get('/api/v1/accounts', async (request) => {
      const { page, pageSize, offset } = parsePagination(request.query);
      const { pool, where, params } = buildAccountFilters(request.query);
      const { sortColumn, sortDir } = resolveAccountSort(request.query, pool);

      const total = db.prepare(`SELECT COUNT(*) AS n FROM accounts ${where}`).get(...params).n;
      // 时间线派生列只对当页 ≤200 行计算，成本可忽略
      const extraColumns = pool === 'discard' ? `, ${DISCARD_TIMELINE_COLUMNS}` : '';
      const rows = db
        .prepare(`SELECT accounts.*${extraColumns} FROM accounts ${where} ORDER BY ${sortColumn} ${sortDir}, id DESC LIMIT ? OFFSET ?`)
        .all(...params, pageSize, offset);
      return {
        items: rows.map((row) => accountView(row, pool)),
        total,
        page,
        page_size: pageSize,
        stats: poolStats(pool, request.query),
      };
    });

    function accountView(row, pool) {
      const base = { id: row.id, email: row.email, pool: row.pool, status: row.status, note: row.note };
      if (pool === 'reserve') {
        const credentials = decryptCredentials(row);
        return {
          ...base,
          initial_balance: row.initial_balance,
          has_balance: Boolean(row.has_balance),
          banned: Boolean(row.banned),
          banned_reason: row.banned_reason,
          mail_status: row.mail_status,
          mail_error: row.mail_error ? sanitizeText(row.mail_error) : null,
          imported_at: row.imported_at,
          last_checked_at: row.last_checked_at,
          has_2fa: Boolean(credentials?.totp_pickup_code || credentials?.totp_secret),
          has_password: Boolean(credentials?.password),
        };
      }
      if (pool === 'main') {
        const tokens = row.tokens_enc ? crypto.tryDecryptJson(row.tokens_enc, 'accounts.tokens_enc') : null;
        const credentials = decryptCredentials(row);
        return {
          ...base,
          balance: row.balance,
          balance_checked_at: row.balance_checked_at,
          balance_error: row.balance_error ? sanitizeText(row.balance_error) : null,
          last_login_at: row.last_login_at,
          sub2api_account_id: row.sub2api_account_id,
          sub2api_uploaded_at: row.sub2api_uploaded_at,
          // 远端真实 status（巡检/手动同步镜像）优先；未同步过回退本地登录状态推导
          remote_status: row.sub2api_account_id
            ? row.sub2api_status || (row.status === 'active' ? 'active' : row.status)
            : null,
          has_refresh_token: Boolean(tokens?.refresh_token),
          has_password: Boolean(credentials?.password),
          has_totp: Boolean(credentials?.totp_secret),
          has_2fa: Boolean(credentials?.totp_pickup_code || credentials?.totp_secret),
          auto_repair_blocked: Boolean(row.auto_repair_blocked),
        };
      }
      return {
        ...base,
        discard_reason: row.discard_reason,
        discard_detail: row.discard_detail ? sanitizeText(row.discard_detail) : null,
        // balance 保留给导出与既有调用方；UI 不再把它当作「废弃时余额」展示
        balance: row.balance,
        banned: Boolean(row.banned),
        discarded_at: row.discarded_at,
        // ---- 时间线 ----
        reserve_joined_at: row.reserve_joined_at ?? row.imported_at ?? row.created_at ?? null,
        joined_main_at: row.joined_main_at ?? null,
        // ---- 已用额度（sub2api 用量口径，与「主池预估剩余余额」同源）----
        used_amount: row.discard_used_amount ?? null,
        used_amount_at: row.discard_used_amount_at ?? null,
        used_amount_source: row.discard_used_amount_source ?? null,
        used_amount_stale: isDiscardUsageStale(row.discard_used_amount_at),
      };
    }

    /**
     * 各池徽章/汇总统计。
     * @param {string} pool
     * @param {object} [query] 列表接口的原始查询参数：discard 池的统计会跟随其中的
     *   搜索词与废弃日期（但剔除 reason 维度自身），使徽章数字与当前列表口径一致。
     */
    function poolStats(pool, query = {}) {
      if (pool === 'reserve') {
        const rows = db
          .prepare(
            `SELECT status, COUNT(*) AS n, SUM(banned) AS banned FROM accounts WHERE pool='reserve' GROUP BY status`,
          )
          .all();
        const stats = {};
        for (const row of rows) stats[row.status] = row.n;
        stats.banned = rows.reduce((sum, row) => sum + (row.banned || 0), 0);
        // 可用 = 未封禁且不在加入流程（与 dashboard reserve_available 口径一致）
        stats.available = db
          .prepare(`SELECT COUNT(*) AS n FROM accounts WHERE pool='reserve' AND banned=0 AND status != 'joining'`)
          .get().n;
        // 余额统计：已知初始余额（has_balance=1）求和 + 计数，未知余额不计入
        const aggregate = db
          .prepare(
            `SELECT COALESCE(SUM(initial_balance),0) AS total_balance,
                    SUM(CASE WHEN has_balance=1 THEN 1 ELSE 0 END) AS with_balance,
                    SUM(CASE WHEN has_balance=0 THEN 1 ELSE 0 END) AS no_balance
             FROM accounts WHERE pool='reserve'`,
          )
          .get();
        stats.total_balance = Number(aggregate.total_balance || 0);
        stats.with_balance = Number(aggregate.with_balance || 0);
        stats.no_balance = Number(aggregate.no_balance || 0);
        return stats;
      }
      if (pool === 'main') {
        const rows = db.prepare(`SELECT status, COUNT(*) AS n FROM accounts WHERE pool='main' GROUP BY status`).all();
        const stats = {};
        for (const row of rows) stats[row.status] = row.n;
        const aggregate = db
          .prepare(
            `SELECT COALESCE(SUM(balance),0) AS total_balance,
                    SUM(CASE WHEN sub2api_account_id IS NOT NULL THEN 1 ELSE 0 END) AS uploaded
             FROM accounts WHERE pool='main'`,
          )
          .get();
        stats.total_balance = Number(aggregate.total_balance || 0);
        stats.uploaded = Number(aggregate.uploaded || 0);
        return stats;
      }
      // 统计口径跟随当前筛选（搜索词 + 废弃日期 + 其它非分面条件），否则用户筛了日期，
      // 徽章仍显示全库总量，看起来就是「今天没那么多，为什么写 845」。
      // 唯一剔除的是「原因」维度自身：把 reason 也算进去的话，选中某个原因后其它徽章
      // 全部变 0，用户就再也切不到别的原因了（分面统计的标准做法）。
      const { where, params } = buildAccountFilters({ ...query, reason: undefined });
      const rows = db
        .prepare(`SELECT discard_reason, COUNT(*) AS n FROM accounts ${where} GROUP BY discard_reason`)
        .all(...params);
      const stats = {};
      for (const row of rows) stats[row.discard_reason || 'manual'] = row.n;
      // 已用额度汇总：已知用量的号参与求和、未知单独计数（口径同备用池 total_balance/with_balance）。
      // 时间戳是 ISO 字符串，字典序即时间序，直接用 cutoff 字符串比较，避免 SQL 里做时间函数转换。
      const cutoff = new Date(Date.now() - DISCARD_USAGE_STALE_MS).toISOString();
      const usage = db
        .prepare(
          `SELECT COALESCE(SUM(discard_used_amount),0) AS used_amount_total,
                  SUM(CASE WHEN discard_used_amount IS NOT NULL THEN 1 ELSE 0 END) AS used_amount_known,
                  SUM(CASE WHEN discard_used_amount_at IS NULL OR discard_used_amount_at < ? THEN 1 ELSE 0 END) AS used_amount_stale
             FROM accounts ${where}`,
        )
        .get(cutoff, ...params);
      stats.used_amount_total = Number(usage.used_amount_total || 0);
      stats.used_amount_known = Number(usage.used_amount_known || 0);
      stats.used_amount_stale = Number(usage.used_amount_stale || 0);
      return stats;
    }

    // ---------------- 导入（备用池） ----------------
    // 把增量凭据字段（2FA 取件码 / ChatGPT 密码）合并进已有账号的加密凭据
    const mergeCredentials = (accountId, patch) => {
      const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
      if (!account) return false;
      db.prepare('UPDATE accounts SET credentials_enc = ?, updated_at = ? WHERE id = ?').run(
        crypto.encryptJson({ ...decryptCredentials(account), ...patch }, 'accounts.credentials_enc'),
        new Date().toISOString(),
        accountId,
      );
      return true;
    };

    app.post(
      '/api/v1/accounts/import',
      {
        // sub2api 账号导出单个账号约 12KB（长 token + notes），批量导入放大请求体：
        // 路由级单独放宽到 32MB（全局仍是 2MB），约支持单次 2500 个账号
        bodyLimit: 32 * 1024 * 1024,
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            properties: {
              text: { type: 'string', maxLength: 32_000_000 },
              twofa_text: { type: 'string', maxLength: 500_000 },
              passwords_text: { type: 'string', maxLength: 2_000_000 },
              force_discard: { type: 'boolean' },
              force_remote: { type: 'boolean' },
              // 远端已有账号收编进主号池：直接关联远端账号（导入时不登录、不上传），
              // 供多台机器共用同一 sub2api 但本地号池不同步的场景对齐主号池视图；
              // 远端健康时巡检零动作，远端 error 时照常自动修复（见 monitor.tryAutoRepair）
              adopt_remote: { type: 'boolean' },
            },
          },
        },
      },
      async (request, reply) => {
        const {
          text = '',
          twofa_text = '',
          passwords_text = '',
          force_discard = false,
          force_remote = false,
          adopt_remote = false,
        } = request.body;
        if (!String(text).trim() && !String(twofa_text).trim() && !String(passwords_text).trim()) {
          throw errors.validation('导入内容不能为空');
        }
        // JSON 文件统一入口：tosubV2 跨实例导出（type: tosub2-accounts）或
        // sub2api 账号导出（accounts 数组，notes 携带邮箱四段/GPT 密码/两步验证；
        // credentials 里的 OAuth tokens 忽略，全部进备用池，加入主号池走 join-main 登录授权）
        let parsed;
        let invalidLines;
        let duplicatesInBatch;
        const trimmedText = String(text).trimStart();
        const looksLikeJson = trimmedText.startsWith('{') || trimmedText.startsWith('[');
        let jsonData = null;
        if (looksLikeJson) {
          try {
            jsonData = JSON.parse(String(text));
          } catch {
            jsonData = null;
          }
        }
        if (jsonData && !Array.isArray(jsonData) && jsonData.type === 'tosub2-accounts') {
          const tosub2 = parseTosub2Export(text);
          if (!tosub2.ok) throw errors.validation(`tosubV2 导出文件解析失败：${tosub2.error}`);
          parsed = tosub2.entries.map((entry) => ({ ok: true, ...entry }));
          invalidLines = tosub2.invalid;
          duplicatesInBatch = [];
        } else if (jsonData && (Array.isArray(jsonData) || Array.isArray(jsonData.accounts))) {
          const sub2api = parseSub2apiAccountsExport(text);
          if (!sub2api.ok) throw errors.validation(`账号导出文件解析失败：${sub2api.error}`);
          parsed = sub2api.entries.map((entry) => ({ ok: true, ...entry }));
          invalidLines = sub2api.invalid;
          duplicatesInBatch = [];
        } else if (trimmedText.startsWith('{')) {
          throw errors.validation(
            'JSON 文件无法识别：需要 tosubV2 账号导出（type: tosub2-accounts）或 sub2api 账号导出（accounts 数组）',
          );
        } else {
          parsed = parseImportLines(text);
          invalidLines = parsed.filter((r) => !r.ok && !r.duplicateInBatch).map(({ line, reason }) => ({ line, reason }));
          duplicatesInBatch = [...new Set(parsed.filter((r) => r.duplicateInBatch).map((r) => r.email))];
        }
        const twofaParsed = parseTwofaLines(twofa_text);
        // 邮箱 -> 2FA 取件码；随导入逐个绑定并从 Map 移除，剩余的兜底关联到已有账号
        const twofaByEmail = new Map(twofaParsed.filter((r) => r.ok).map((r) => [r.email, r.pickupCode]));
        const twofaTotal = twofaByEmail.size;
        const twofaInvalidLines = twofaParsed.filter((r) => !r.ok).map(({ line, reason }) => ({ line, reason }));
        // ChatGPT 会话导出文件：邮箱 -> ChatGPT 登录密码
        const passwordFile = parsePasswordFileText(passwords_text);
        const passwordByEmail = passwordFile.passwords;
        const passwordTotal = passwordByEmail.size;

        const good = parsed.filter((r) => r.ok);
        const duplicatesInReserve = [];
        const duplicatesInMain = [];
        const duplicatesInDiscard = [];
        const duplicatesRemote = [];
        const adoptedRemote = [];
        const created = [];

        // 远端 sub2api 查重（已配置且可连通才检查）：email → 远端账号，
        // adopt_remote 收编主号池时直接回填 sub2api_account_id / 镜像 status
        let remoteByEmail = null;
        const sub2apiConfig = app.settings.get('sub2api.config');
        if (sub2apiConfig?.base_url && sub2apiConfig?.admin_key && app.sub2apiClient) {
          try {
            const accounts = await app.sub2apiClient.listAllOpenAiAccounts();
            remoteByEmail = new Map();
            for (const account of accounts) {
              const email = app.sub2apiClient.accountEmail(account);
              if (email && !remoteByEmail.has(email)) remoteByEmail.set(email, account);
            }
          } catch (error) {
            logger.warn({ err: sanitizeText(String(error.message)) }, 'remote dedup check failed');
          }
        }
        const remoteAccountFor = (email) => {
          const account = remoteByEmail?.get(email);
          if (!account) return null;
          const remoteId = Number(account.id);
          return Number.isSafeInteger(remoteId) && remoteId > 0 ? { id: remoteId, status: String(account.status || 'unknown') } : null;
        };

        // 主号池条目（tosubV2 文件带 OAuth tokens）入库：新号直插 main，
        // 已有号刷新 tokens/凭据；备用池号升级进主号池（joining 中除外）
        const importMainEntry = (entry, existing, now) => {
          const tokensEnc = crypto.encryptJson(entry.tokens, 'accounts.tokens_enc');
          // 同步维护账号级导出文件：refresh 任务（自动修复首选路径）的数据源，
          // 缺失会让 refresh 直接失败退化成完整登录（见 engine.handleSaveTokens / launcher buildArgs）
          const writeAccountExportFile = (accountId) => {
            const exportPath = path.resolve(app.config.dataDir, 'results', `account-${accountId}.json`);
            fs.mkdirSync(path.dirname(exportPath), { recursive: true });
            fs.writeFileSync(exportPath, JSON.stringify(buildExportFromTokens({ id: accountId, email: entry.email }, entry.tokens), null, 2), { mode: 0o600 });
          };
          const mergeEncryptedCredentials = (accountId) => {
            const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
            return crypto.encryptJson({ ...decryptCredentials(account), ...credentialsForImport(entry) }, 'accounts.credentials_enc');
          };
          if (!existing) {
            const result = db
              .prepare(
                `INSERT INTO accounts(email, pool, status, note, credentials_enc, tokens_enc,
                   balance, balance_checked_at, last_login_at, created_at, updated_at)
                 VALUES(?, 'main', ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(email) DO NOTHING`,
              )
              .run(
                entry.email,
                entry.mainStatus,
                entry.note || null,
                crypto.encryptJson(credentialsForImport(entry), 'accounts.credentials_enc'),
                tokensEnc,
                entry.balance,
                entry.balance == null ? null : now,
                entry.lastLoginAt || now,
                now,
                now,
              );
            if (result.changes === 0) return null;
            const id = Number(result.lastInsertRowid);
            pools.recordEvent(id, 'imported', { source: 'tosub2', pool: 'main' });
            writeAccountExportFile(id);
            return { id, email: entry.email, status: entry.mainStatus, pool: 'main' };
          }
          if (existing.pool === 'main') {
            duplicatesInMain.push(entry.email);
            db.prepare(
              `UPDATE accounts SET tokens_enc=?, credentials_enc=?,
                 balance=COALESCE(?, balance), balance_checked_at=COALESCE(?, balance_checked_at),
                 last_login_at=COALESCE(?, last_login_at), updated_at=? WHERE id=?`,
            ).run(tokensEnc, mergeEncryptedCredentials(existing.id), entry.balance, entry.balance == null ? null : now, entry.lastLoginAt, now, existing.id);
            pools.recordEvent(existing.id, 'tokens_refreshed', { source: 'tosub2_import' });
            writeAccountExportFile(existing.id);
            return null;
          }
          if (existing.pool === 'reserve') {
            const cas = db
              .prepare(
                `UPDATE accounts SET pool='main', status=?, tokens_enc=?, credentials_enc=?,
                   balance=?, balance_checked_at=?, last_login_at=?, updated_at=?
                 WHERE id=? AND pool='reserve' AND status != 'joining'`,
              )
              .run(entry.mainStatus, tokensEnc, mergeEncryptedCredentials(existing.id), entry.balance, entry.balance == null ? null : now, entry.lastLoginAt || now, now, existing.id);
            if (cas.changes === 0) {
              // 加入任务进行中：不换池，退化为刷新凭据（见下方 reserve 分支语义）
              duplicatesInReserve.push(entry.email);
              db.prepare('UPDATE accounts SET credentials_enc = ?, updated_at = ? WHERE id = ?').run(
                mergeEncryptedCredentials(existing.id),
                now,
                existing.id,
              );
              return null;
            }
            pools.recordEvent(existing.id, 'join_succeeded', { source: 'tosub2_import' });
            writeAccountExportFile(existing.id);
            return { id: existing.id, email: entry.email, status: entry.mainStatus, pool: 'main' };
          }
          // discard
          if (!force_discard) {
            duplicatesInDiscard.push({ email: entry.email, reason: existing.discard_reason || 'manual' });
            return null;
          }
          db.prepare(
            `UPDATE accounts SET pool='main', status=?, tokens_enc=?, credentials_enc=?,
               balance=?, balance_checked_at=?, last_login_at=?,
               discard_reason=NULL, discard_detail=NULL, discarded_at=NULL,
               banned=0, banned_reason=NULL, updated_at=? WHERE id=?`,
          ).run(entry.mainStatus, tokensEnc, mergeEncryptedCredentials(existing.id), entry.balance, entry.balance == null ? null : now, entry.lastLoginAt || now, now, existing.id);
          pools.recordEvent(existing.id, 'restored', { source: 'tosub2_import', to: 'main' });
          writeAccountExportFile(existing.id);
          return { id: existing.id, email: entry.email, status: entry.mainStatus, pool: 'main' };
        };

        const insertTx = db.transaction(() => {
          for (const entry of good) {
            // 显式粘贴的 2FA / 密码文本优先，否则保留 tosubV2 文件里已带的值
            entry.pickupCode = twofaByEmail.get(entry.email) || entry.pickupCode || null;
            entry.chatgptPassword = passwordByEmail.get(entry.email) || entry.chatgptPassword || null;
            const existing = db
              .prepare('SELECT id, pool, status, discard_reason FROM accounts WHERE email = ? COLLATE NOCASE')
              .get(entry.email);
            if (entry.tokens) {
              const imported = importMainEntry(entry, existing, new Date().toISOString());
              if (imported) created.push(imported);
              if (entry.pickupCode) twofaByEmail.delete(entry.email);
              if (entry.chatgptPassword) passwordByEmail.delete(entry.email);
              continue;
            }
            if (existing) {
              if (existing.pool === 'reserve') {
                // 备用池号已在远端 sub2api 且选择收编：升级进主号池并直接关联远端账号，
                // 导入时不登录（adopted_remote=1，远端健康零动作、error 才自动修复）；
                // initial_balance/has_balance 保留，joining 中的号退化回刷新凭据
                if (adopt_remote) {
                  const remote = remoteAccountFor(entry.email);
                  if (remote) {
                    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(existing.id);
                    const now = new Date().toISOString();
                    const cas = db
                      .prepare(
                        `UPDATE accounts SET pool='main', status='active', credentials_enc=?,
                           sub2api_account_id=?, sub2api_status=?, sub2api_uploaded_at=?, sub2api_synced_at=?,
                           adopted_remote=1, repair_fail_count=0,
                           mail_error=NULL, updated_at=?
                         WHERE id=? AND pool='reserve' AND status != 'joining'`,
                      )
                      .run(
                        crypto.encryptJson(
                          { ...decryptCredentials(account), ...credentialsForImport(entry) },
                          'accounts.credentials_enc',
                        ),
                        remote.id,
                        remote.status,
                        now,
                        now,
                        now,
                        existing.id,
                      );
                    if (cas.changes > 0) {
                      pools.recordEvent(existing.id, 'imported', { source: 'adopt_remote', from: 'reserve', to: 'main' });
                      pools.recordEvent(existing.id, 'sub2api_linked', { remote_id: remote.id, source: 'import_adopt' });
                      created.push({ id: existing.id, email: entry.email, status: 'active', pool: 'main' });
                      adoptedRemote.push(entry.email);
                      if (entry.pickupCode) twofaByEmail.delete(entry.email);
                      if (entry.chatgptPassword) passwordByEmail.delete(entry.email);
                      continue;
                    }
                  }
                }
                duplicatesInReserve.push(entry.email);
                // 更新凭据（同 v1 语义：重复导入即刷新凭据）
                const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(existing.id);
                db.prepare('UPDATE accounts SET credentials_enc = ?, updated_at = ? WHERE id = ?').run(
                  crypto.encryptJson({ ...decryptCredentials(account), ...credentialsForImport(entry) }, 'accounts.credentials_enc'),
                  new Date().toISOString(),
                  existing.id,
                );
                if (entry.pickupCode) twofaByEmail.delete(entry.email);
                if (entry.chatgptPassword) passwordByEmail.delete(entry.email);
                continue;
              }
              if (existing.pool === 'main') {
                duplicatesInMain.push(entry.email);
                // 重复账号不重新导入，但 2FA 取件码 / ChatGPT 密码仍写入，供后续重新授权/自动修复使用
                const patch = {};
                if (entry.pickupCode) patch.totp_pickup_code = entry.pickupCode;
                if (entry.chatgptPassword) patch.password = entry.chatgptPassword;
                if (Object.keys(patch).length && mergeCredentials(existing.id, patch)) {
                  if (entry.pickupCode) twofaByEmail.delete(entry.email);
                  if (entry.chatgptPassword) passwordByEmail.delete(entry.email);
                }
                continue;
              }
              if (existing.pool === 'discard') {
                if (!force_discard) {
                  duplicatesInDiscard.push({ email: entry.email, reason: existing.discard_reason || 'manual' });
                  continue;
                }
                // force：清废弃记录重新入备用池（tosubV2 文件带的封禁/余额元数据一并还原）
                db.prepare(
                  `UPDATE accounts SET pool='reserve', status='mail_pending', credentials_enc=?,
                     note=COALESCE(?, note), initial_balance=?, has_balance=?, banned=?, banned_reason=?,
                     discard_reason=NULL, discard_detail=NULL, discarded_at=NULL,
                     mail_status='pending', mail_error=NULL,
                     imported_at=?, updated_at=? WHERE id=?`,
                ).run(
                  crypto.encryptJson(credentialsForImport(entry), 'accounts.credentials_enc'),
                  entry.note || null,
                  entry.hasBalance ? entry.initialBalance : null,
                  entry.hasBalance ? 1 : 0,
                  entry.banned ? 1 : 0,
                  entry.banned ? entry.bannedReason || '导入时标记为封禁' : null,
                  new Date().toISOString(),
                  new Date().toISOString(),
                  existing.id,
                );
                pools.recordEvent(existing.id, 'imported', { source: 'manual', force: 'discard' });
                created.push({ id: existing.id, email: entry.email, status: 'mail_pending' });
                if (entry.pickupCode) twofaByEmail.delete(entry.email);
                if (entry.chatgptPassword) passwordByEmail.delete(entry.email);
                continue;
              }
            }
            const remote = remoteAccountFor(entry.email);
            if (remote && adopt_remote && !force_remote) {
              // 本地无记录但远端已有：收编进主号池并关联远端账号，导入时不登录不上传。
              // adopted_remote=1：远端健康时巡检零动作（修复只对 error 号触发，再加保险门）；
              // 远端 401/error 时正常自动修复（无本地 tokens → 完整登录重授权）
              const now = new Date().toISOString();
              const result = db
                .prepare(
                  `INSERT INTO accounts(email, pool, status, note, credentials_enc,
                     sub2api_account_id, sub2api_status, sub2api_uploaded_at, sub2api_synced_at,
                     adopted_remote, created_at, updated_at)
                   VALUES(?, 'main', 'active', ?, ?, ?, ?, ?, ?, 1, ?, ?)
                   ON CONFLICT(email) DO NOTHING`,
                )
                .run(
                  entry.email,
                  entry.note || null,
                  crypto.encryptJson(credentialsForImport(entry), 'accounts.credentials_enc'),
                  remote.id,
                  remote.status,
                  now,
                  now,
                  now,
                  now,
                );
              if (result.changes === 0) continue;
              const id = Number(result.lastInsertRowid);
              pools.recordEvent(id, 'imported', { source: 'adopt_remote', pool: 'main', no_relogin_while_healthy: true });
              pools.recordEvent(id, 'sub2api_linked', { remote_id: remote.id, source: 'import_adopt' });
              created.push({ id, email: entry.email, status: 'active', pool: 'main' });
              adoptedRemote.push(entry.email);
              if (entry.pickupCode) twofaByEmail.delete(entry.email);
              if (entry.chatgptPassword) passwordByEmail.delete(entry.email);
              continue;
            }
            if (remoteByEmail?.has(entry.email) && !force_remote) {
              // 远端已有：未选择收编（或远端 id 异常无法安全关联）时仅提示重复
              duplicatesRemote.push(entry.email);
              continue;
            }
            const now = new Date().toISOString();
            const result = db
              .prepare(
                `INSERT INTO accounts(email, pool, status, note, credentials_enc,
                   initial_balance, has_balance, banned, banned_reason,
                   mail_status, imported_at, created_at, updated_at)
                 VALUES(?, 'reserve', 'mail_pending', ?, ?,
                   ?, ?, ?, ?,
                   'pending', ?, ?, ?)
                 ON CONFLICT(email) DO NOTHING`,
              )
              .run(
                entry.email,
                entry.note || null,
                crypto.encryptJson(credentialsForImport(entry), 'accounts.credentials_enc'),
                entry.hasBalance ? entry.initialBalance : null,
                entry.hasBalance ? 1 : 0,
                entry.banned ? 1 : 0,
                entry.banned ? entry.bannedReason || '导入时标记为封禁' : null,
                now,
                now,
                now,
              );
            if (result.changes === 0) continue;
            const id = Number(result.lastInsertRowid);
            pools.recordEvent(id, 'imported', { source: 'manual' });
            created.push({ id, email: entry.email, status: 'mail_pending' });
            if (entry.pickupCode) twofaByEmail.delete(entry.email);
            if (entry.chatgptPassword) passwordByEmail.delete(entry.email);
          }
        });
        insertTx();

        // 兜底：未随导入文本绑定的 2FA 取件码 / ChatGPT 密码，按邮箱更新任意池的已有账号
        const twofaUnmatched = [];
        for (const [email, pickupCode] of twofaByEmail) {
          const existing = db.prepare('SELECT id FROM accounts WHERE email = ? COLLATE NOCASE').get(email);
          if (existing) mergeCredentials(existing.id, { totp_pickup_code: pickupCode });
          else twofaUnmatched.push(email);
        }
        const passwordsUnmatched = [];
        for (const [email, chatgptPassword] of passwordByEmail) {
          const existing = db.prepare('SELECT id FROM accounts WHERE email = ? COLLATE NOCASE').get(email);
          if (existing) mergeCredentials(existing.id, { password: chatgptPassword });
          else passwordsUnmatched.push(email);
        }

        // 异步邮件初始化（主号池直入的账号不需要）
        const reserveCreated = created.filter((c) => c.pool !== 'main');
        if (reserveCreated.length) mailInit.enqueue(reserveCreated.map((c) => c.id), { source: 'import' });

        reply.code(201);
        return {
          created: created.length,
          main_created: created.length - reserveCreated.length,
          accounts: created,
          duplicates_in_batch: duplicatesInBatch,
          duplicates_in_reserve: duplicatesInReserve,
          duplicates_in_main: duplicatesInMain,
          duplicates_in_discard: duplicatesInDiscard,
          duplicates_remote: duplicatesRemote,
          adopted_remote: adoptedRemote,
          invalid_lines: invalidLines,
          twofa_bound: twofaTotal - twofaUnmatched.length,
          twofa_unmatched: twofaUnmatched,
          twofa_invalid_lines: twofaInvalidLines,
          passwords_bound: passwordTotal - passwordsUnmatched.length,
          passwords_unmatched: passwordsUnmatched,
          passwords_error: passwordFile.error,
        };
      },
    );

    // ---------------- 单账号手动添加（进主号池，v1 兼容） ----------------
    app.post(
      '/api/v1/accounts',
      {
        schema: {
          body: {
            type: 'object',
            required: ['email'],
            additionalProperties: false,
            properties: {
              email: { type: 'string', maxLength: 320 },
              password: { type: 'string', maxLength: 512 },
              mail_api_url: { type: 'string', maxLength: 2048 },
              totp_secret: { type: 'string', maxLength: 256 },
              totp_pickup_code: { type: 'string', maxLength: 256 },
              phone: { type: 'string', maxLength: 32 },
              outlook: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  password: { type: 'string', maxLength: 512 },
                  client_id: { type: 'string', maxLength: 64 },
                  refresh_token: { type: 'string', maxLength: 4096 },
                },
              },
            },
          },
        },
      },
      async (request, reply) => {
        const body = request.body;
        const email = String(body.email || '').trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw errors.validation('邮箱格式错误');
        const credentials = {};
        if (body.password) credentials.password = body.password;
        if (body.mail_api_url) credentials.mail_api_url = body.mail_api_url;
        if (body.totp_secret) credentials.totp_secret = body.totp_secret;
        if (body.totp_pickup_code) credentials.totp_pickup_code = body.totp_pickup_code;
        if (body.phone) credentials.phone = body.phone;
        if (body.outlook?.refresh_token) credentials.outlook = body.outlook;
        if (!Object.keys(credentials).length) throw errors.validation('凭据至少提供一项');

        const existing = db.prepare('SELECT id, pool FROM accounts WHERE email = ? COLLATE NOCASE').get(email);
        if (existing) throw errors.conflict('账号已存在', 'ACCOUNT_STATE_INVALID');

        const now = new Date().toISOString();
        let accountId;
        const tx = db.transaction(() => {
          const result = db
            .prepare(
              `INSERT INTO accounts(email, pool, status, credentials_enc, last_login_at, created_at, updated_at)
               VALUES(?, 'main', 'authorizing', ?, NULL, ?, ?)`,
            )
            .run(email, crypto.encryptJson(credentials, 'accounts.credentials_enc'), now, now);
          accountId = Number(result.lastInsertRowid);
          pools.recordEvent(accountId, 'imported', { source: 'manual-main' });
        });
        tx();
        const job = engine.submitJob({ accountId, type: 'login', note: '手动添加账号' });
        reply.code(201);
        return {
          account: accountView(db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId), 'main'),
          job_id: job.id,
        };
      },
    );

    // ---------------- 凭据查看/编辑（备用池） ----------------
    const maskCredential = (value) => {
      const text = String(value || '');
      if (!text) return null;
      if (text.length <= 10) return '****';
      return `${text.slice(0, 4)}…${text.slice(-4)}`;
    };

    const credentialsView = (credentials) => ({
      password: maskCredential(credentials?.password),
      totp_pickup_code: maskCredential(credentials?.totp_pickup_code),
      totp_secret: maskCredential(credentials?.totp_secret),
      outlook: {
        password: maskCredential(credentials?.outlook?.password),
        client_id: credentials?.outlook?.client_id || null,
        refresh_token: maskCredential(credentials?.outlook?.refresh_token),
      },
    });

    app.get('/api/v1/accounts/:id/credentials', async (request) => {
      const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(request.params.id));
      if (!account) throw errors.notFound('账号不存在');
      if (account.pool !== 'reserve') throw errors.accountState('仅备用号池账号支持编辑凭据');
      return { credentials: credentialsView(decryptCredentials(account)) };
    });

    app.patch(
      '/api/v1/accounts/:id/credentials',
      {
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            properties: {
              password: { type: 'string', maxLength: 512 },
              totp_pickup_code: { type: 'string', maxLength: 256 },
              totp_secret: { type: 'string', maxLength: 256 },
              outlook_password: { type: 'string', maxLength: 512 },
              outlook_client_id: { type: 'string', maxLength: 64 },
              outlook_refresh_token: { type: 'string', maxLength: 4096 },
            },
          },
        },
      },
      async (request) => {
        const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(request.params.id));
        if (!account) throw errors.notFound('账号不存在');
        if (account.pool !== 'reserve') throw errors.accountState('仅备用号池账号支持编辑凭据');

        const body = request.body || {};
        // 字段语义：缺省 = 不改；空串 = 清空；非空 = 校验后更新
        const fields = {
          password: body.password,
          totp_pickup_code: body.totp_pickup_code,
          totp_secret: body.totp_secret,
          outlook_password: body.outlook_password,
          outlook_client_id: body.outlook_client_id,
          outlook_refresh_token: body.outlook_refresh_token,
        };
        const touched = Object.entries(fields).filter(([, v]) => v !== undefined);
        if (!touched.length) throw errors.validation('至少修改一项');

        if (fields.totp_pickup_code && !/^[A-Za-z0-9_-]{8,128}$/.test(fields.totp_pickup_code)) {
          throw errors.validation('2FA 取件码应为 8-128 位字母数字');
        }
        if (fields.totp_secret) {
          const normalized = fields.totp_secret.toUpperCase().replace(/[\s=]/g, '');
          if (!/^[A-Z2-7]{16,128}$/.test(normalized)) {
            throw errors.validation('2FA 密钥必须是仅含 A-Z 和 2-7 的 Base32 字符串');
          }
          fields.totp_secret = normalized;
        }
        if (fields.outlook_client_id && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fields.outlook_client_id)) {
          throw errors.validation('clientId 不是 UUID');
        }
        if (fields.outlook_refresh_token && fields.outlook_refresh_token.length < 100) {
          throw errors.validation('refresh_token 长度不足');
        }

        const credentials = decryptCredentials(account);
        const apply = (key, value) => {
          if (value === undefined) return false;
          if (value === '') delete credentials[key];
          else credentials[key] = value;
          return true;
        };
        const changed = [];
        if (apply('password', fields.password)) changed.push('password');
        if (apply('totp_pickup_code', fields.totp_pickup_code)) changed.push('totp_pickup_code');
        if (apply('totp_secret', fields.totp_secret)) changed.push('totp_secret');
        credentials.outlook = { ...(credentials.outlook || {}) };
        if (fields.outlook_password !== undefined) {
          if (fields.outlook_password === '') delete credentials.outlook.password;
          else credentials.outlook.password = fields.outlook_password;
          changed.push('outlook.password');
        }
        if (fields.outlook_client_id !== undefined) {
          if (fields.outlook_client_id === '') delete credentials.outlook.client_id;
          else credentials.outlook.client_id = fields.outlook_client_id;
          changed.push('outlook.client_id');
        }
        if (fields.outlook_refresh_token !== undefined) {
          if (fields.outlook_refresh_token === '') delete credentials.outlook.refresh_token;
          else credentials.outlook.refresh_token = fields.outlook_refresh_token;
          changed.push('outlook.refresh_token');
        }

        db.prepare('UPDATE accounts SET credentials_enc = ?, updated_at = ? WHERE id = ?').run(
          crypto.encryptJson(credentials, 'accounts.credentials_enc'),
          new Date().toISOString(),
          account.id,
        );
        pools.recordEvent(account.id, 'credentials_updated', { fields: changed });
        const fresh = db.prepare('SELECT * FROM accounts WHERE id = ?').get(account.id);
        return { account: accountView(fresh, 'reserve'), credentials: credentialsView(decryptCredentials(fresh)) };
      },
    );

    // ---------------- refresh-mail ----------------
    app.post('/api/v1/accounts/:id/refresh-mail', async (request) => {
      const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(request.params.id));
      if (!account) throw errors.notFound('账号不存在');
      if (account.pool !== 'reserve') throw errors.accountState('仅备用号池账号可刷新邮件状态');
      mailInit.enqueue([account.id], { source: 'manual' });
      return { ok: true };
    });

    // ---------------- join-main ----------------
    app.post(
      '/api/v1/accounts/join-main',
      {
        schema: {
          body: {
            type: 'object',
            required: ['ids'],
            additionalProperties: false,
            properties: {
              ids: { type: 'array', items: { type: 'integer' }, maxItems: 500 },
              order: { type: 'string', enum: UPLOAD_ORDERS },
              // 强制加入：被邮件封禁标记的号也放行，并清除封禁标记（用户否决封禁判断）
              force: { type: 'boolean' },
            },
          },
        },
      },
      async (request, reply) => {
        const force = Boolean(request.body.force);
        const started = [];
        const skipped = [];
        const ids = orderIdsForUpload(request.body.ids, request.body.order, 'reserve');
        for (const id of ids) {
          const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
          if (!account || account.pool !== 'reserve') {
            skipped.push({ id, reason: 'ACCOUNT_STATE_INVALID' });
            continue;
          }
          if (account.status === 'joining') {
            skipped.push({ id, reason: 'CONFLICT' });
            continue;
          }
          if (account.banned && !force) {
            skipped.push({ id, reason: 'banned' });
            continue;
          }
          const credentials = decryptCredentials(account);
          if (!credentials.outlook?.refresh_token) {
            skipped.push({ id, reason: '缺少 Outlook 取件凭据' });
            continue;
          }
          const now = new Date().toISOString();
          const tx = db.transaction(() => {
            const cas = db
              .prepare(
                `UPDATE accounts SET status='joining', banned=0, banned_reason=NULL, updated_at=? WHERE id=? AND pool='reserve' AND status != 'joining'`,
              )
              .run(now, id);
            if (cas.changes === 0) throw errors.conflict('账号已在加入队列', 'ACCOUNT_STATE_INVALID');
            pools.recordEvent(
              id,
              'join_started',
              account.banned ? { force: true, cleared_banned_reason: account.banned_reason } : {},
            );
            engine.submitJob({ accountId: id, type: 'login', note: force ? 'join-main (force)' : 'join-main' });
          });
          try {
            tx();
            started.push(id);
          } catch (error) {
            skipped.push({ id, reason: error.code === 'ACCOUNT_STATE_INVALID' ? 'CONFLICT' : error.message });
          }
        }
        reply.code(202);
        return { started, skipped };
      },
    );

    // ---------------- batch-authorize ----------------
    app.post(
      '/api/v1/accounts/batch-authorize',
      {
        schema: {
          body: {
            type: 'object',
            required: ['ids'],
            additionalProperties: false,
            properties: { ids: { type: 'array', items: { type: 'integer' }, maxItems: 500 } },
          },
        },
      },
      async (request, reply) => {
        const started = [];
        const skipped = [];
        for (const id of request.body.ids) {
          const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
          if (!account || account.pool !== 'main') {
            skipped.push({ id, reason: '账号不在主号池' });
            continue;
          }
          if (!['active', 'needs_reauth', 'authorizing'].includes(account.status)) {
            skipped.push({ id, reason: 'ACCOUNT_STATE_INVALID' });
            continue;
          }
          const tokens = account.tokens_enc
            ? crypto.tryDecryptJson(account.tokens_enc, 'accounts.tokens_enc')
            : null;
          const credentials = decryptCredentials(account);
          let type = null;
          if (tokens?.refresh_token) type = 'refresh';
          else if (credentials.password || credentials.outlook?.refresh_token || credentials.mail_api_url) type = 'login';
          if (!type) {
            skipped.push({ id, reason: '凭据不全' });
            continue;
          }
          const now = new Date().toISOString();
          const tx = db.transaction(() => {
            const cas = db
              .prepare(
                `UPDATE accounts SET status='authorizing', updated_at=? WHERE id=? AND pool='main' AND status IN ('active','needs_reauth')`,
              )
              .run(now, id);
            if (cas.changes === 0) throw errors.conflict('账号已被占用', 'ACCOUNT_STATE_INVALID');
            engine.submitJob({ accountId: id, type, note: 'batch-authorize' });
          });
          try {
            tx();
            started.push(id);
          } catch (error) {
            skipped.push({ id, reason: 'CONFLICT' });
          }
        }
        reply.code(202);
        return { started: started.length, skipped };
      },
    );

    // ---------------- batch-refresh-balance ----------------
    app.post(
      '/api/v1/accounts/batch-refresh-balance',
      {
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            properties: { ids: { type: 'array', items: { type: 'integer' }, maxItems: 1000 } },
          },
        },
      },
      async (request, reply) => {
        const ids = Array.isArray(request.body?.ids) && request.body.ids.length
          ? request.body.ids
          : db.prepare(`SELECT id FROM accounts WHERE pool='main' AND tokens_enc IS NOT NULL`).all().map((r) => r.id);
        let started = 0;
        for (const id of ids) {
          const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
          if (!account || account.pool !== 'main' || !account.tokens_enc) continue;
          const active = db
            .prepare(`SELECT id FROM jobs WHERE account_id=? AND status IN ('queued','running','awaiting_input') AND type='balance'`)
            .get(id);
          if (active) continue;
          try {
            engine.submitJob({ accountId: id, type: 'balance', note: 'batch-refresh-balance' });
            started += 1;
          } catch (error) {
            logger.warn({ accountId: id, err: error.message }, 'submit balance job failed');
          }
        }
        reply.code(202);
        return { started };
      },
    );

    // ---------------- batch-upload-sub2api ----------------
    app.post(
      '/api/v1/accounts/batch-upload-sub2api',
      {
        schema: {
          body: {
            type: 'object',
            required: ['ids'],
            additionalProperties: false,
            properties: {
              ids: { type: 'array', items: { type: 'integer' }, maxItems: 500 },
              options: { type: 'object' },
              order: { type: 'string', enum: UPLOAD_ORDERS },
            },
          },
        },
      },
      async (request) => {
        const { ids, options, order } = request.body;
        const valid = orderIdsForUpload(ids, order, 'main').filter((id) => {
          const account = db.prepare('SELECT tokens_enc FROM accounts WHERE id = ? AND pool = ?').get(id, 'main');
          return Boolean(account?.tokens_enc);
        });
        if (!valid.length) throw errors.validation('所选账号均不在主号池或缺少 OAuth tokens');
        const result = await app.sub2apiUploader.uploadAccounts(valid, options || {});
        return result;
      },
    );

    // ---------------- discard / restore / delete ----------------
    app.post(
      '/api/v1/accounts/batch-discard',
      {
        schema: {
          body: {
            type: 'object',
            required: ['ids'],
            additionalProperties: false,
            properties: {
              ids: { type: 'array', items: { type: 'integer' }, maxItems: 500 },
              detail: { type: 'string', maxLength: 500 },
            },
          },
        },
      },
      async (request) => {
        let discarded = 0;
        const discardedIds = [];
        for (const id of request.body.ids) {
          try {
            pools.moveToDiscard(id, 'manual', request.body.detail || '手动废弃', { fromPools: ['main', 'reserve'] });
            discarded += 1;
            discardedIds.push(id);
          } catch (error) {
            logger.debug({ accountId: id }, `discard skipped: ${error.message}`);
          }
        }
        // 废弃当下抓一次用量快照（异步、不阻塞响应）：sub2api 不提供历史时点查询，
        // 错过此刻就只能拿到「当前累计」了
        void snapshotDiscardedUsage(discardedIds);
        return { discarded };
      },
    );

    // ---------------- 废弃池「已用额度」----------------
    /**
     * 抓取刚被废弃账号的用量快照。best-effort：不 await、不动响应，
     * 与 banMailCheck.check 的「异步、不阻塞终态流转」模式一致。
     */
    async function snapshotDiscardedUsage(ids) {
      if (!ids.length) return;
      if (!sub2apiConfigured()) return;
      for (const id of ids) {
        // 串行即可：废弃是低频手动动作，且每条内部已吞异常
        await discardUsage.snapshotAfterDiscard(id);
      }
    }

    function sub2apiConfigured() {
      const config = app.settings?.get?.('sub2api.config');
      return Boolean(config?.base_url && config?.admin_key);
    }

    /**
     * 同步废弃池「已用额度」。
     * 三种范围：给 ids → 只同步这些；不给 ids 但给 filters → 只同步当前筛选下待同步的
     * （按钮上的「待同步 N」就是这个数）；两者都没有 → 全池待同步项。
     * 默认只补没有快照或快照过期（>24h）的号；force=true 时忽略新旧全量重算。
     * 逐个查询远端用量统计，故需要显式触发。
     */
    app.post(
      '/api/v1/accounts/discard-usage-sync',
      {
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ids: { type: 'array', items: { type: 'integer' }, maxItems: 500 },
              force: { type: 'boolean' },
              // 当前列表筛选：与 buildAccountFilters 同字段（pool 由服务端固定为 discard）
              filters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  q: { type: 'string', maxLength: 200 },
                  reason: { type: 'string', maxLength: 40 },
                  discarded_from: { type: 'string', maxLength: 40 },
                  discarded_to: { type: 'string', maxLength: 40 },
                },
              },
            },
          },
        },
      },
      async (request) => {
        if (!sub2apiConfigured()) {
          throw errors.validation('请先配置 sub2api 管理员密钥和后端地址');
        }
        const { ids, force, filters } = request.body ?? {};
        const result = await discardUsage.sync({
          ids: ids ?? null,
          force: Boolean(force),
          // 有明确 ids 时忽略筛选：选中项就是范围
          filters: ids?.length ? null : filters ?? null,
        });
        return { ok: true, ...result };
      },
    );

    app.post('/api/v1/accounts/:id/restore', async (request) => {
      const id = Number(request.params.id);
      try {
        const result = pools.restore(id);
        return { ok: true, status: result.status };
      } catch (error) {
        throw errors.poolTransferConflict('账号不在废弃号池');
      }
    });

    /**
     * 批量移回主号池。
     * 前端原先是 N 次串行单条 /restore 请求（选 200 条就是 200 个请求），
     * 这里在同一个事务里走 pools.restore，逐条失败只跳过不中断。
     */
    app.post(
      '/api/v1/accounts/batch-restore',
      {
        schema: {
          body: {
            type: 'object',
            required: ['ids'],
            additionalProperties: false,
            properties: { ids: { type: 'array', items: { type: 'integer' }, maxItems: 500 } },
          },
        },
      },
      async (request) => {
        let restored = 0;
        for (const id of request.body.ids) {
          try {
            pools.restore(id);
            restored += 1;
          } catch (error) {
            logger.debug({ accountId: id }, `restore skipped: ${error.message}`);
          }
        }
        return { restored, skipped: request.body.ids.length - restored };
      },
    );

    app.post(
      '/api/v1/accounts/batch-delete',
      {
        schema: {
          body: {
            type: 'object',
            required: ['ids'],
            additionalProperties: false,
            properties: { ids: { type: 'array', items: { type: 'integer' }, maxItems: 500 } },
          },
        },
      },
      async (request) => {
        let deleted = 0;
        const tx = db.transaction(() => {
          for (const id of request.body.ids) {
            const account = db.prepare('SELECT id FROM accounts WHERE id = ?').get(id);
            if (!account) continue;
            db.prepare('UPDATE jobs SET account_id = NULL WHERE account_id = ?').run(id);
            db.prepare('DELETE FROM account_events WHERE account_id = ?').run(id);
            db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
            fs.rmSync(path.resolve(app.config.dataDir, 'checkpoints', String(id)), { recursive: true, force: true });
            try {
              fs.rmSync(path.resolve(app.config.dataDir, 'results', `account-${id}.json`), { force: true });
            } catch {}
            deleted += 1;
          }
        });
        tx();
        return { deleted };
      },
    );

    /**
     * 「选中全部筛选结果」用：按当前筛选返回全部 id（默认上限 5000）。
     * 前端据此执行批量操作，避免只选中当前页。
     */
    app.get('/api/v1/accounts/ids', async (request) => {
      const limit = Math.min(10_000, Math.max(1, Number.parseInt(request.query.limit || '5000', 10) || 5000));
      return selectAllMatchingAccountIds(request.query, limit);
    });

    // ---------------- export ----------------
    /** 把一批账号行渲染成指定导出格式（`ids` / `pool` / 按筛选三个入口共用）。 */
    function renderAccountExport(rows, format, reply) {
      if (format === 'tosub2') {
        const payload = buildTosub2ExportPayload({
          rows,
          decryptCredentials,
          decryptTokens: (row) =>
            row.tokens_enc ? crypto.tryDecryptJson(row.tokens_enc, 'accounts.tokens_enc') : null,
        });
        reply.header('content-type', 'application/json; charset=utf-8');
        reply.header('content-disposition', `attachment; filename="${tosub2ExportFilename()}"`);
        return payload;
      }

      if (format === 'source') {
        const lines = rows.map((row) => {
          const credentials = decryptCredentials(row);
          const parts = [
            row.email,
            credentials.password || credentials.outlook?.password || '',
            credentials.mail_api_url || credentials.outlook?.client_id || '',
            credentials.totp_secret || credentials.outlook?.refresh_token || '',
          ];
          return parts.join('----');
        });
        reply.header('content-type', 'text/plain; charset=utf-8');
        reply.header('content-disposition', 'attachment; filename="accounts-source.txt"');
        return `${lines.join('\n')}\n`;
      }

      // sub2api 格式：合并各账号导出文件
      const accounts = [];
      for (const row of rows) {
        const exportPath = path.resolve(app.config.dataDir, 'results', `account-${row.id}.json`);
        if (!fs.existsSync(exportPath)) continue;
        try {
          const data = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
          if (Array.isArray(data?.accounts)) accounts.push(...data.accounts);
        } catch {}
      }
      const payload = {
        type: 'sub2api-data',
        version: 1,
        exported_at: new Date().toISOString(),
        proxies: [],
        accounts,
      };
      reply.header('content-type', 'application/json');
      reply.header('content-disposition', 'attachment; filename="sub2api-import.json"');
      return payload;
    }

    app.get('/api/v1/accounts/export', async (request, reply) => {
      const format = String(request.query.format || 'sub2api');
      const ids = String(request.query.ids || '')
        .split(',')
        .map((v) => Number(v.trim()))
        .filter((v) => Number.isInteger(v) && v > 0);
      let rows;
      if (ids.length) {
        const placeholders = ids.map(() => '?').join(',');
        rows = db.prepare(`SELECT * FROM accounts WHERE id IN (${placeholders})`).all(...ids);
      } else if (['reserve', 'main'].includes(String(request.query.pool || ''))) {
        // 整池导出（tosub2 跨实例迁移）
        const pool = String(request.query.pool);
        rows = db.prepare(`SELECT * FROM accounts WHERE pool=? ORDER BY id`).all(pool);
      } else {
        throw errors.validation('ids 不能为空');
      }
      return renderAccountExport(rows, format, reply);
    });

    /**
     * 按当前筛选导出：勾选「全部 N 条」后导出时用。
     * 走 GET /accounts/export?ids=... 会把几千个 id 塞进 query string（长度与 URL 双重限制），
     * 这里改为传筛选条件，行集合由服务端按与列表完全相同的口径解析。
     */
    app.get('/api/v1/accounts/export-by-filter', async (request, reply) => {
      const format = String(request.query.format || 'tosub2');
      const { where, params } = buildAccountFilters(request.query);
      const { sortColumn, sortDir } = resolveAccountSort(request.query, request.query.pool);
      const rows = db
        .prepare(`SELECT * FROM accounts ${where} ORDER BY ${sortColumn} ${sortDir}, id DESC`)
        .all(...params);
      return renderAccountExport(rows, format, reply);
    });

    // ---------------- events ----------------
    app.get('/api/v1/accounts/:id/events', async (request) => {
      const id = Number(request.params.id);
      const account = db.prepare('SELECT id FROM accounts WHERE id = ?').get(id);
      if (!account) throw errors.notFound('账号不存在');
      const rows = db
        .prepare('SELECT type, detail, created_at FROM account_events WHERE account_id = ? ORDER BY created_at DESC LIMIT 200')
        .all(id);
      return {
        items: rows.map((row) => {
          let detail = row.detail;
          try {
            detail = JSON.parse(row.detail);
          } catch {}
          return { type: row.type, detail, created_at: row.created_at };
        }),
      };
    });

    app.decorate('accountsPools', pools);
    app.decorate('accountsMailInit', mailInit);
  };
}
