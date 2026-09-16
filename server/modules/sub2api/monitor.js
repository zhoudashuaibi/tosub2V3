import { sanitizeText } from '../../lib/sanitize.js';
import { errors } from '../../lib/http-errors.js';
import { uploadOrderExpr } from '../../lib/upload-order.js';

/**
 * sub2api 监控巡检（默认 5 分钟一轮）：
 *  - 只监控 OAuth 授权号（本系统上传的 free 号，type=oauth）；API Key 号（plus/pro/team 等）完全忽略
 *  - 每轮同步远端状态：按 email/ID 回填 sub2api_account_id、镜像远端真实 status（主号池“远端状态”列）
 *  - 每轮可选刷新已上传号余额（refresh_balance 配置项，默认关）：走 balance 任务通道，选路优先 sub2api 绑定代理
 *  - 拉全量监控分组账号 → error 账号分类（banned/rate_limit/临时错误）
 *  - OAuth 号限流不写 status=error，用 rate_limited_at 判定：重置时间超过阈值 → 移废弃池，否则保留观察
 *  - 401/会话过期 → 自动修复：有 refresh_token 先刷新（失败自动转完整登录），没有直接发完整登录；
 *    连续失败 max_repair_attempts 次暂停保留待重授（needs_reauth + 停自动修复 + 暂停远端调度，不再废弃）
 *  - 修复结果回执：发起修复只写「已发起」，任务终态由 noteRepairOutcome 写回同一行明细
 *    （outcome=ok/failed/parked/followup），日志必须能回答「修好了还是修废了」
 *  - 摘要里两种量必须分清（前端 chip 也按此标注，避免误读）：
 *    状态量（每轮都会重复出现的当前状态）：error_accounts / rate_limited / ban_unconfirmed / repair_pending
 *    动作量（只统计本轮真正发生的事）：discarded / discard_failed / repairing / repair_ok / repair_failed /
 *    repair_parked / uploaded / replenished
 *  - 封禁关键词（deactivated/banned/suspended 等）→ 必须邮箱辅证证实才移废弃池；
 *    未证实只暂停远端调度保留观察，绝不凭远端一句错误信息直接废弃
 *  - 自动补号（同一阈值双重约束，支持两种口径 replenish_mode）：
 *    count（默认）：sub2api 可用数（本地主池 × 远端非 error/非限流 + 在途 joining）低于阈值 →
 *      先从主池库存（未上传 sub2api 的 active 号，按 replenish_upload_order 排序）直接上传补缺口；
 *      主池库存（扣除本轮上传 + 在途登录）低于同一阈值 → 从备用池按 replenish_join_order 排序登录补入主池
 *      （每轮最多 3 个），下轮按需上传
 *    resource：按 sub2api 在架号（本地主池 × 远端匹配、非 error，限流/暂停调度/待重授均计入）的
 *      总并发与初始总余额计缺口（OR 语义），先按顺序上传库存补齐两缺口，库存资源 + 在途登录资源
 *      仍不达标再从备用池登录补入（每轮最多 3 个）
 * 单实例互斥；每轮结果与每账号动作写 monitor_logs，保留最近 100 轮。
 */

const PERMANENT_PATTERN = /account_deactivated|account_deleted|account_suspended|deactivated|permanently\s+deleted/i;
const LOG_ROUNDS_RETAINED = 100;

export function createMonitor({ db, crypto, client, getConfig, pools, engine, uploader, remoteSync = null, banMailCheck, logger }) {
  const state = {
    running: false,
    timer: null,
    lastCheckAt: null,
    nextCheckAt: null,
    lastError: null,
    lastResult: null,
  };

  function monitorConfig() {
    return getConfig()?.monitor || {};
  }

  function startIfEnabled() {
    stop();
    const config = monitorConfig();
    if (!config.enabled) return;
    const intervalMs = Math.max(1, Number(config.interval_minutes) || 5) * 60_000;
    state.timer = setInterval(() => {
      runCheck({ source: 'timer' }).catch((error) => {
        state.lastError = sanitizeText(String(error.message || error)).slice(0, 400);
        logger.error({ err: error.message }, 'sub2api monitor check failed');
      });
    }, intervalMs);
    state.timer.unref?.();
    state.nextCheckAt = new Date(Date.now() + intervalMs).toISOString();
  }

  function stop() {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
    state.nextCheckAt = null;
  }

  function view() {
    const config = monitorConfig();
    return {
      enabled: Boolean(config.enabled),
      running: state.running,
      interval_minutes: config.interval_minutes ?? 5,
      cooldown_minutes: config.cooldown_minutes ?? 5,
      auto_repair: config.auto_repair !== false,
      max_repair_attempts: config.max_repair_attempts ?? 2,
      auto_replenish: Boolean(config.auto_replenish),
      refresh_balance: Boolean(config.refresh_balance),
      balance_refresh_interval_minutes: config.balance_refresh_interval_minutes ?? 60,
      reserve_threshold: config.reserve_threshold ?? 10,
      main_stock_threshold: config.main_stock_threshold ?? null,
      replenish_mode: config.replenish_mode === 'resource' ? 'resource' : 'count',
      concurrency_target: config.concurrency_target ?? 0,
      initial_balance_target: config.initial_balance_target ?? 0,
      replenish_upload_order: config.replenish_upload_order ?? 'balance_asc',
      replenish_join_order: config.replenish_join_order ?? 'balance_desc',
      rate_limit_reset_threshold_hours: config.rate_limit_reset_threshold_hours ?? 12,
      // 设置页回显用：不回显会导致保存时把这些字段覆盖成空
      pause_on_discard: config.pause_on_discard !== false,
      banned_patterns: config.banned_patterns || [],
      rate_limit_patterns: config.rate_limit_patterns || [],
      last_check_at: state.lastCheckAt,
      next_check_at: state.nextCheckAt,
      last_error: state.lastError,
      last_result: state.lastResult,
    };
  }

  function startLog(source) {
    const info = db
      .prepare('INSERT INTO monitor_logs(source, started_at, status) VALUES (?, ?, ?)')
      .run(source, new Date().toISOString(), 'running');
    return Number(info.lastInsertRowid);
  }

  function finishLog(logId, status, result, error = null) {
    db.prepare('UPDATE monitor_logs SET finished_at=?, status=?, error=?, summary=? WHERE id=?').run(
      new Date().toISOString(),
      status,
      error ? sanitizeText(error).slice(0, 400) : null,
      JSON.stringify(result ?? {}),
      logId,
    );
    db.prepare(
      `DELETE FROM monitor_logs WHERE id NOT IN (SELECT id FROM monitor_logs ORDER BY id DESC LIMIT ${LOG_ROUNDS_RETAINED})`,
    ).run();
  }

  function writeLogItems(logId, items) {
    if (!items.length) return;
    const insert = db.prepare(
      'INSERT INTO monitor_log_items(log_id, email, remote_id, action, reason, detail) VALUES (?,?,?,?,?,?)',
    );
    const tx = db.transaction(() => {
      for (const item of items) {
        insert.run(
          logId,
          item.email ?? null,
          Number.isInteger(Number(item.remote_id)) ? Number(item.remote_id) : null,
          item.action,
          String(item.reason || '').slice(0, 100),
          String(item.detail || '').slice(0, 300),
        );
      }
    });
    tx();
  }

  /** 最近 N 轮巡检日志（含每账号明细）。 */
  function recentLogs(limit = 20) {
    const logs = db
      .prepare('SELECT * FROM monitor_logs ORDER BY id DESC LIMIT ?')
      .all(Math.min(100, Math.max(1, limit)));
    if (!logs.length) return [];
    const placeholders = logs.map(() => '?').join(',');
    const itemRows = db
      .prepare(`SELECT * FROM monitor_log_items WHERE log_id IN (${placeholders}) ORDER BY id ASC`)
      .all(...logs.map((row) => row.id));
    const itemsByLog = new Map();
    for (const row of itemRows) {
      if (!itemsByLog.has(row.log_id)) itemsByLog.set(row.log_id, []);
      itemsByLog.get(row.log_id).push({
        email: row.email,
        remote_id: row.remote_id,
        action: row.action,
        reason: row.reason,
        detail: row.detail,
        outcome: row.outcome ?? null,
        outcome_at: row.outcome_at ?? null,
        outcome_detail: row.outcome_detail ?? null,
      });
    }
    return logs.map((row) => ({
      id: row.id,
      source: row.source,
      started_at: row.started_at,
      finished_at: row.finished_at,
      status: row.status,
      error: row.error,
      summary: safeParseSummary(row.summary),
      items: itemsByLog.get(row.id) || [],
    }));
  }

  /**
   * 修复结果回执：把任务终态写回本轮巡检日志里那条「修复中」明细，
   * 否则日志永远停在「已发起」，看不出修复成功还是失败。
   * 只认最近一条未回执（或已转完整登录）的 repairing 明细；回执可能发生在好几轮之后。
   */
  function markRepairOutcome(email, outcome, detail = '') {
    if (!email) return false;
    const target = db
      .prepare(
        `SELECT id FROM monitor_log_items
         WHERE email = ? COLLATE NOCASE AND action = 'repairing' AND (outcome IS NULL OR outcome = 'followup')
         ORDER BY id DESC LIMIT 1`,
      )
      .get(String(email));
    if (!target) return false;
    db.prepare('UPDATE monitor_log_items SET outcome=?, outcome_at=?, outcome_detail=? WHERE id=?').run(
      outcome,
      new Date().toISOString(),
      String(detail || '').slice(0, 300),
      target.id,
    );
    return true;
  }

  /** 距上轮成功巡检以来落地的修复回执计数（动作量）；首轮无锚点（null）时只报状态量。 */
  function repairOutcomeCounts(sinceIso) {
    const counts = { repair_ok: 0, repair_failed: 0, repair_parked: 0 };
    if (!sinceIso) return counts;
    const rows = db
      .prepare(`SELECT outcome, COUNT(*) AS n FROM monitor_log_items WHERE outcome_at >= ? GROUP BY outcome`)
      .all(sinceIso);
    for (const row of rows) {
      if (row.outcome === 'ok') counts.repair_ok = row.n;
      else if (row.outcome === 'failed') counts.repair_failed = row.n;
      else if (row.outcome === 'parked') counts.repair_parked = row.n;
    }
    return counts;
  }

  /**
   * 在途自动修复数（状态量）：主池、最近发起过自动修复、且登录/刷新任务还没落地。
   * 有这个数，「本轮发起修复 0」才不会被误读成「没有号在修」。
   */
  function countInFlightRepairs() {
    return db
      .prepare(
        `SELECT COUNT(*) AS n FROM accounts a
         WHERE a.pool='main' AND a.status='authorizing' AND a.last_auto_repair_at IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM jobs j WHERE j.account_id=a.id AND j.type = 'login'
               AND j.status IN ('queued','running','awaiting_input')
           )`,
      )
      .get().n;
  }

  /** 本轮结果骨架：状态量每轮都会重复出现，动作量只记本轮真正发生的事。 */
  function emptyResult() {
    return {
      // 状态量（当前状态，重复出现属正常）
      error_accounts: 0, // 远端 status=error 的号数
      rate_limited: 0, // 本轮观察到限流的号数（超阈值会被同时计入 discarded）
      ban_unconfirmed: 0, // 疑似封禁、等邮件辅证的号数
      repair_pending: 0, // 修复任务在途、还没回执的号数
      // 动作量（本轮真正发生的事）
      discarded: 0,
      discard_failed: 0,
      repairing: 0, // 本轮新发起的自动修复
      repair_ok: 0, // 距上轮以来回执成功的修复
      repair_failed: 0, // 距上轮以来回执失败的修复
      repair_parked: 0, // 距上轮以来因连败暂停待重授
      uploaded: 0,
      replenished: 0,
    };
  }

  async function runCheck({ source = 'manual' } = {}) {
    if (state.running) return view();
    const config = getConfig();
    if (!config?.base_url || !config?.admin_key) {
      throw errors.sub2apiNotConfigured('请先配置 sub2api');
    }
    state.running = true;
    const logId = startLog(source);
    const items = [];
    const result = emptyResult();
    // 回执锚点：上一轮成功巡检的结束时间；首轮无锚点，只报状态量
    const outcomeSince = state.lastCheckAt;
    let accounts = null;
    try {
      const monitor = monitorConfig();
      const groupIds = Array.isArray(config.group_ids) ? config.group_ids : [];
      // 401 只代表会话过期（自动修复：refresh 失败转完整登录），旧配置残留的裸 401 模式在此剔除
      const bannedPatterns = (monitor.banned_patterns || [])
        .filter(Boolean)
        .filter((p) => String(p).trim().toLowerCase() !== '401')
        .map((p) => new RegExp(p, 'i'));
      const rateLimitPatterns = (monitor.rate_limit_patterns || []).filter(Boolean).map((p) => new RegExp(p, 'i'));
      const resetThresholdMs =
        Math.max(0, Number(monitor.rate_limit_reset_threshold_hours ?? 12)) * 3600_000;

      // 全量拉取一次：限流态不写 status=error，按 status 过滤会漏掉
      accounts = await client.listAllOpenAiAccounts();

      // 每轮顺带同步远端状态（回填 sub2api_account_id / 镜像远端 status），失败不阻断巡检
      if (remoteSync) {
        try {
          result.remote_sync = await remoteSync.syncRemoteStatus({ remoteAccounts: accounts });
        } catch (error) {
          logger.warn({ err: error.message }, 'remote sync in monitor failed');
        }
      }

      // 只监控本系统上传的 OAuth 授权号（free 号，oauth---邮箱 命名）：
      // type=oauth 过滤掉 API Key 号（plus/pro/team 等），本地邮箱匹配过滤掉非本系统上传的
      const localAccounts = db.prepare(`SELECT * FROM accounts WHERE pool IN ('main','reserve')`).all();
      const localByEmail = new Map(localAccounts.map((row) => [row.email.toLowerCase(), row]));
      const tracked = [];
      const trackedIdxByEmail = new Map();
      for (const remote of accounts) {
        if (String(remote.type || 'oauth') !== 'oauth') continue;
        if (!inMonitoredGroups(remote, groupIds)) continue;
        const email = client.accountEmail(remote);
        const local = email ? localByEmail.get(email.toLowerCase()) : null;
        if (!local) continue;
        // 远端同邮箱重复条目（历史上传重复）只跟踪一条，避免 error 计数虚高、
        // 同一本地号每轮重复处理：优先本地已关联的远端 ID，未关联时取首个
        const key = email.toLowerCase();
        const existingIdx = trackedIdxByEmail.get(key);
        if (existingIdx != null) {
          const linkedId = Number(local.sub2api_account_id);
          if (Number(remote.id) === linkedId && Number(tracked[existingIdx].remote.id) !== linkedId) {
            tracked[existingIdx] = { remote, local, email };
          }
          continue;
        }
        trackedIdxByEmail.set(key, tracked.length);
        tracked.push({ remote, local, email });
      }
      result.scanned = tracked.length;
      const errorMonitored = tracked.filter(({ remote }) => String(remote.status || '') === 'error');
      result.error_accounts = errorMonitored.length;

      for (const { remote, local, email } of tracked) {
        // OAuth 号限流态：重置时间距今超过阈值 → 废弃；短期限流 → 保留观察
        const rateLimit = client.accountRateLimit(remote);
        if (rateLimit.limited_now) {
          result.rate_limited += 1;
          const resetAt = rateLimit.rate_limit_reset_at;
          const resetMs = resetAt ? Date.parse(resetAt) - Date.now() : Number.NaN;
          const resetDesc = resetAt
            ? `${new Date(resetAt).toLocaleString('zh-CN', { hour12: false })}（约 ${formatDuration(resetMs)}）`
            : '未知时间';
          if (!Number.isFinite(resetMs) || resetMs > resetThresholdMs) {
            await discardAndLog({
              local,
              email,
              remote,
              monitor,
              reason: 'rate_limited_429',
              detail: `限流至 ${resetDesc}`,
              result,
              items,
            });
          } else {
            items.push({
              email,
              remote_id: remote?.id,
              action: 'rate_limited_waiting',
              reason: 'rate_limited_429',
              detail: `限流中，${resetDesc} 后恢复（低于废弃阈值，保留主池）`,
            });
          }
          continue;
        }

        if (String(remote.status || '') !== 'error') continue;
        const errorMessage = client.accountErrorMessage(remote) || 'unknown error';

        const bannedHit = bannedPatterns.some((re) => re.test(errorMessage));
        const permanentHit = PERMANENT_PATTERN.test(errorMessage);
        if (bannedHit || permanentHit) {
          // 封禁必须叠加邮箱辅证：未证实前不废弃，只暂停远端调度保留观察
          const source = bannedHit ? 'monitor_banned_pattern' : 'monitor_permanent_pattern';
          const verdict = await confirmBanByMail(local, source);
          if (verdict.confirmed) {
            db.prepare('UPDATE accounts SET auto_repair_blocked=1, updated_at=? WHERE id=?').run(
              new Date().toISOString(),
              local.id,
            );
            await discardAndLog({
              local,
              email,
              remote,
              monitor,
              reason: 'banned_401',
              detail: `${errorMessage}（邮件辅证证实：${verdict.reason || '封禁邮件命中'}）`,
              result,
              items,
            });
          } else {
            await pauseRemote(remote, monitor, '疑似封禁待辅证');
            result.ban_unconfirmed += 1;
            items.push({
              email,
              remote_id: remote?.id,
              action: 'ban_unconfirmed',
              reason: bannedHit ? 'banned_pattern' : 'permanent_pattern',
              detail: `${errorMessage}（邮件辅证 ${verdict.result}，不废弃，保留观察）`,
            });
          }
          continue;
        }
        if (rateLimitPatterns.some((re) => re.test(errorMessage))) {
          await discardAndLog({
            local,
            email,
            remote,
            monitor,
            reason: 'rate_limited_429',
            detail: errorMessage,
            result,
            items,
          });
          continue;
        }

        // 临时错误 → 自动重登修复（发起只写「已发起」，终态由 noteRepairOutcome 回执到本行）
        const repair = await tryAutoRepair(local, monitor, remote);
        if (repair.ok) {
          result.repairing += 1;
          items.push({
            email,
            remote_id: remote?.id,
            action: 'repairing',
            reason: 'auto_repair',
            detail: `${errorMessage}｜已发起远程登录修复，结果落地后回写本行`,
          });
        } else {
          // 没发起也要说清为什么：在途/冷却/熔断/缺凭据，避免日志只写「未处理」让人以为修复没下文
          const skip = repairSkipMeta(repair);
          items.push({
            email,
            remote_id: remote?.id,
            action: skip.action,
            reason: skip.reason,
            detail: `${errorMessage}｜${skip.note}`,
          });
        }
      }

      // 巡检可选刷新已上传号的余额（refresh_balance 配置项，默认关）：
      // 走 balance 任务通道并发消化，选路优先 sub2api 绑定代理。
      // balance_refresh_interval_minutes 节流：距上次查询不足间隔的号本轮跳过（0=每轮都查）
      if (monitor.refresh_balance) {
        const balanceIntervalMs =
          Math.max(0, Number(monitor.balance_refresh_interval_minutes ?? 60)) * 60_000;
        let balanceQueued = 0;
        let balanceSkipped = 0;
        for (const { remote, local } of tracked) {
          if (client.accountRateLimit(remote).limited_now) continue; // 限流中的号不再打扰
          if (local.pool !== 'main' || !local.tokens_enc) continue;
          if (
            balanceIntervalMs > 0 &&
            local.balance_checked_at &&
            Date.now() - Date.parse(local.balance_checked_at) < balanceIntervalMs
          ) {
            balanceSkipped += 1;
            continue;
          }
          // 同账号活跃任务唯一索引：登录/修复/余额任一在途都留待下轮
          const active = db
            .prepare(`SELECT id FROM jobs WHERE account_id=? AND status IN ('queued','running','awaiting_input')`)
            .get(local.id);
          if (active) continue;
          try {
            engine.submitJob({ accountId: local.id, type: 'balance', note: 'monitor 巡检查余额' });
            balanceQueued += 1;
          } catch {
            // 同账号活跃任务唯一索引冲突（如修复中）→ 留待下轮
          }
        }
        result.balance_queued = balanceQueued;
        result.balance_skipped_fresh = balanceSkipped;
      }

      // 自动补号（级联：主池库存上传 + 备用池登录）
      if (monitor.auto_replenish) {
        const replenish = await replenishIfNeeded(monitor, config, accounts, items);
        result.replenished = replenish.replenished;
        result.uploaded = replenish.uploaded;
        result.available_count = replenish.available;
        result.stock_count = replenish.stock_count;
        if (replenish.fleet_concurrency != null) result.fleet_concurrency = replenish.fleet_concurrency;
        if (replenish.fleet_initial_balance != null) result.fleet_initial_balance = replenish.fleet_initial_balance;
      }

      // 修复回执（上一轮之后落地的终态）+ 在途修复状态量：回答「修好了还是修废了」
      Object.assign(result, repairOutcomeCounts(outcomeSince));
      result.repair_pending = countInFlightRepairs();

      state.lastCheckAt = new Date().toISOString();
      state.lastError = null;
      state.lastResult = result;
      finishLog(logId, 'done', result);
      writeLogItems(logId, items);
      logger.info({ source, ...result }, 'sub2api monitor check done');
    } catch (error) {
      // 失败的轮次也要让界面看到错误：定时器路径由 setInterval 的 catch 兜底，手动巡检只有这里
      state.lastError = sanitizeText(String(error.message || error)).slice(0, 400);
      finishLog(logId, 'failed', result, String(error.message || error));
      writeLogItems(logId, items);
      throw error;
    } finally {
      state.running = false;
    }
    return view();
  }

  /**
   * main → discard（best-effort）。返回 { ok, error }：调用方必须据此决定是否计入「废弃」，
   * 否则状态冲突（账号已不在可废弃池）时日志会谎报「本轮废弃 1」，而且下轮还会重复报同一个号。
   */
  async function discardLocal(local, reason, detail, remote, monitor) {
    try {
      // 用量/出口代理/Codex 指纹收敛快照都不在这里做：pools.moveToDiscard 落库后会统一触发
      // onDiscarded 钩子，所有废弃入口（手动/巡检/登录终局失败）走同一条 best-effort 通道。
      // remote 必须一起传下去：代理绑定与收敛档位都只在「废弃这一刻」可靠，事务提交后这个号
      // 会被暂停调度、也可能被改绑/删号/改档位，事后再查就取不到封号当时的状态了。
      pools.moveToDiscard(local.id, reason, detail, { proxy: remote ?? null });
    } catch (error) {
      logger.debug({ accountId: local.id }, `monitor discard skipped: ${error.message}`);
      return { ok: false, error: sanitizeText(String(error.message || error)).slice(0, 200) };
    }
    if (monitor.pause_on_discard !== false && Number.isInteger(Number(remote?.id))) {
      try {
        await client.setSchedulable(Number(remote.id), false);
      } catch (error) {
        logger.warn({ accountId: local.id, err: error.message }, 'pause remote on discard failed');
      }
    }
    return { ok: true };
  }

  /** 废弃 + 计数 + 记日志：只有真进了废弃池才算「废弃」，失败单独记一条 discard_failed。 */
  async function discardAndLog({ local, email, remote, monitor, reason, detail, result, items }) {
    const outcome = await discardLocal(local, reason, detail, remote, monitor);
    if (!outcome.ok) {
      result.discard_failed += 1;
      items.push({
        email,
        remote_id: remote?.id,
        action: 'discard_failed',
        reason,
        detail: `${detail}｜废弃失败：${outcome.error}`,
      });
      return false;
    }
    result.discarded += 1;
    items.push({ email, remote_id: remote?.id, action: 'discarded', reason, detail });
    return true;
  }

  /**
   * 修复连败处置：不废弃，暂停保留待重授。
   * 置 needs_reauth + auto_repair_blocked（阻止巡检继续自动修复），并暂停远端调度
   * 避免 sub2api 拿失效凭证继续打流量。重授成功后由 joinSucceeded / pushRepairedCredentials 解锁。
   */
  async function parkForReauth(local, remoteId, detail) {
    const now = new Date().toISOString();
    const cas = db
      .prepare(`UPDATE accounts SET status='needs_reauth', auto_repair_blocked=1, updated_at=? WHERE id=? AND pool='main'`)
      .run(now, local.id);
    if (cas.changes === 0) return false;
    pools.recordEvent(local.id, 'repair_parked', { detail: String(detail || '').slice(0, 300) });
    if (remoteId != null && Number.isInteger(Number(remoteId))) {
      try {
        await client.setSchedulable(Number(remoteId), false);
      } catch (error) {
        logger.warn({ accountId: local.id, err: error.message }, 'pause remote on repair parked failed');
      }
    }
    return true;
  }

  /** 封禁邮件辅证：证实才 confirmed=true；无检查器/缺凭据/出错一律视为未证实，绝不据此废弃。 */
  async function confirmBanByMail(local, source) {
    if (!banMailCheck?.check) return { confirmed: false, result: 'no_checker' };
    try {
      return await banMailCheck.check(local.id, { source });
    } catch (error) {
      logger.warn({ accountId: local.id, err: error.message }, 'ban mail confirm failed');
      return { confirmed: false, result: 'error' };
    }
  }

  async function pauseRemote(remote, monitor, detail) {
    if (monitor.pause_on_discard === false || !Number.isInteger(Number(remote?.id))) return;
    try {
      await client.setSchedulable(Number(remote.id), false);
    } catch (error) {
      logger.warn({ remoteId: remote?.id, err: error.message }, `pause remote failed: ${detail}`);
    }
  }

  /**
   * 自动修复资格：未关闭、无活跃任务、未封禁、不在冷却期、修复失败次数未达上限。
   * 修复方式：redeem401 远程登录重新获取授权文件（登录由远端服务完成，本地无需凭据）。
   * 修复连败达上限不再废弃：暂停保留待重授（见 parkForReauth）。
   *
   * 返回结构化结果：{ ok: true, repairType } 或 { ok: false, code }
   * code ∈ auto_repair_off | blocked | ineligible | active | parked | cooldown |
   *        state_changed
   * —— 让巡检日志能写明「这轮为什么没发起修复」，而不是笼统的「未处理」。
   */
  async function tryAutoRepair(local, monitor, remote = null) {
    if (monitor.auto_repair === false) return { ok: false, code: 'auto_repair_off' };
    if (local.auto_repair_blocked) return { ok: false, code: 'blocked' };
    if (local.pool !== 'main') return { ok: false, code: 'ineligible' };
    // 收编保险门：远端健康的收编号绝不自动登录（自动修复本就只对 error 号触发，双保险）；
    // 远端 error（如 token 撤销 401）时收编号照常修复（远程登录重新取授权）
    if (local.adopted_remote && remote && String(remote.status || '') !== 'error') return { ok: false, code: 'ineligible' };
    const active = db
      .prepare(`SELECT type, status, stage FROM jobs WHERE account_id=? AND status IN ('queued','running','awaiting_input')`)
      .get(local.id);
    if (active) return { ok: false, code: 'active', job: active };
    const maxAttempts = Number(monitor.max_repair_attempts) || 2;
    if ((local.repair_fail_count || 0) >= maxAttempts) {
      await parkForReauth(local, remote?.id ?? local.sub2api_account_id, `自动修复连续失败 ${local.repair_fail_count} 次`);
      return { ok: false, code: 'parked' };
    }
    const cooldownMs = Math.max(0, Number(monitor.cooldown_minutes ?? 5)) * 60_000;
    if (local.last_auto_repair_at && Date.now() - Date.parse(local.last_auto_repair_at) < cooldownMs) {
      return { ok: false, code: 'cooldown' };
    }
    const repairType = 'login';

    const now = new Date().toISOString();
    const previousStatus = ['active', 'needs_reauth'].includes(local.status) ? local.status : 'active';
    const cas = db
      .prepare(`UPDATE accounts SET status='authorizing', last_auto_repair_at=?, updated_at=? WHERE id=? AND pool='main' AND status IN ('active','needs_reauth')`)
      .run(now, now, local.id);
    if (cas.changes === 0) return { ok: false, code: 'state_changed' };
    let job = null;
    try {
      job = engine.submitJob({ accountId: local.id, type: repairType, note: 'sub2api 自动修复' });
    } catch (error) {
      // 任务没建成必须回滚 CAS：否则账号卡在 authorizing，之后每轮都因「无凭据变更」被跳过
      db.prepare(`UPDATE accounts SET status=?, updated_at=? WHERE id=? AND pool='main' AND status='authorizing'`).run(
        previousStatus,
        new Date().toISOString(),
        local.id,
      );
      logger.warn({ accountId: local.id, err: error.message }, 'submit auto repair job failed');
      return { ok: false, code: 'state_changed' };
    }
    pools.recordEvent(local.id, 'auto_repair_started', { source: 'monitor', type: repairType });
    return { ok: true, repairType, jobId: job?.id ?? null };
  }

  /**
   * 自动修复任务终态回写（由引擎 onLoginFinished 钩子调用）：
   *  - 成功 → repair_fail_count 清零 + 巡检日志回执 ok
   *  - 失败 → 计数 +1，达到 max_repair_attempts 暂停保留待重授（不再直接废弃）；回执 failed / parked
   */
  function noteRepairOutcome(job, { ok, message = '' } = {}) {
    try {
      if (!job?.account_id || job.type !== 'login') return;
      const row = db
        .prepare(`SELECT email, pool, last_auto_repair_at, repair_fail_count, sub2api_account_id FROM accounts WHERE id=?`)
        .get(job.account_id);
      if (!row || row.pool !== 'main' || !row.last_auto_repair_at) return;
      // 只统计自动修复链路（30 分钟内发起过修复）；手动授权不受影响
      if (Date.now() - Date.parse(row.last_auto_repair_at) > 30 * 60_000) return;
      const now = new Date().toISOString();
      if (ok) {
        if (row.repair_fail_count > 0) {
          db.prepare('UPDATE accounts SET repair_fail_count=0, updated_at=? WHERE id=?').run(now, job.account_id);
        }
        markRepairOutcome(row.email, 'ok', '修复成功：新凭据已回推远端并恢复调度');
        return;
      }
      const maxAttempts = Number(monitorConfig().max_repair_attempts) || 2;
      const count = (row.repair_fail_count || 0) + 1;
      db.prepare('UPDATE accounts SET repair_fail_count=?, updated_at=? WHERE id=?').run(count, now, job.account_id);
      pools.recordEvent(job.account_id, 'repair_failed_attempt', { count, job_id: job.id });
      if (count >= maxAttempts) {
        markRepairOutcome(row.email, 'parked', `修复连续失败 ${count} 次，已暂停保留待重授`);
        parkForReauth({ id: job.account_id }, row.sub2api_account_id, `自动修复连续失败 ${count} 次`).catch((error) => {
          logger.warn({ accountId: job.account_id, err: error.message }, 'repair park failed');
        });
      } else {
        markRepairOutcome(
          row.email,
          'failed',
          `修复失败（第 ${count}/${maxAttempts} 次）${message ? `：${message}` : ''}，下轮冷却结束后重试`,
        );
      }
    } catch (error) {
      logger.warn({ jobId: job?.id, err: error.message }, 'note repair outcome failed');
    }
  }

  /**
   * 自动补号入口：按 replenish_mode 分流（共用一次远端全量拉取与 email 索引）。
   *  - count（默认）：以本地主池为准 × 远端实际状态联合计数，见 replenishByCount
   *  - resource：按 sub2api 在架号总并发 + 初始总余额计缺口，见 replenishByResource
   */
  async function replenishIfNeeded(monitor, config, accounts = null, items = []) {
    const groupIds = Array.isArray(config.group_ids) ? config.group_ids : [];
    try {
      const allAccounts = accounts ?? (await client.listAllOpenAiAccounts());
      const remoteByEmail = new Map();
      for (const remote of allAccounts) {
        if (String(remote.type || 'oauth') !== 'oauth') continue;
        if (!inMonitoredGroups(remote, groupIds)) continue;
        const email = client.accountEmail(remote);
        if (email) remoteByEmail.set(email, remote);
      }
      if (monitor.replenish_mode === 'resource') {
        return await replenishByResource(monitor, config, remoteByEmail, items);
      }
      return await replenishByCount(monitor, config, remoteByEmail, items);
    } catch (error) {
      logger.warn({ err: error.message }, 'replenish check failed');
      return { replenished: 0, uploaded: 0, available: null, stock_count: null };
    }
  }

  /** 主池库存保底（备用池 → 主池水位）：null/未设置沿用 reserve_threshold（旧行为），0=不从备用池自动补入。 */
  function mainStockThreshold(monitor) {
    return Math.max(0, Number(monitor.main_stock_threshold ?? monitor.reserve_threshold) || 0);
  }

  /**
   * count 口径补号（历史行为）：以本地主池为准 × 远端实际状态联合计数，避免只看远端导致的计数虚高：
   *  - 可用 = 本地 pool=main 的号在远端（监控分组内、type=oauth）非 error 且非限流中 + 在途 joining
   *  - 第一段：可用低于保底阈值 → 优先把主池库存（未上传远端的 active 号，余额小优先）直接上传补缺口
   *  - 第二段：主池库存（扣除本轮上传 + 在途 joining）低于主池库存保底 → 从备用池登录补入主池（每轮最多 3 个），
   *    不必等库存耗尽；下轮巡检再按需上传
   *  - 已废弃号远端未删、他人上传的号、远端已被删除的本地号，一律不计入可用
   */
  async function replenishByCount(monitor, config, remoteByEmail, items) {
    const threshold = Number(monitor.reserve_threshold) || 10;
    const localMain = db.prepare(`SELECT email FROM accounts WHERE pool='main'`).all();
    let activeCount = 0;
    for (const row of localMain) {
      const remote = remoteByEmail.get(String(row.email || '').toLowerCase());
      if (!remote) continue;
      if (String(remote.status || 'active') === 'error') continue;
      if (client.accountRateLimit(remote).limited_now) continue;
      activeCount += 1;
    }
    const joining = countJoiningReserve();
    const available = activeCount + joining;

    // 主池库存：active、有 tokens、无活跃任务、未封禁，且远端尚不存在（按邮箱匹配，防重复上传）
    const stock = loadMainStock(remoteByEmail, monitor);

    // 第一段：sub2api 缺口 → 直接上传主池库存补足（按配置顺序挑号，默认余额小优先）
    let uploaded = 0;
    const gap = threshold - available;
    if (gap > 0 && stock.length && uploader) {
      const targets = stock.slice(0, gap);
      try {
        const outcome = await uploader.uploadAccounts(
          targets.map((row) => row.id),
          {},
        );
        uploaded = Number(outcome?.created || 0) + Number(outcome?.updated || 0);
        const failedById = new Map((outcome?.failed || []).map((fail) => [fail.id, fail]));
        for (const row of targets) {
          const fail = failedById.get(row.id);
          items.push(
            fail
              ? {
                  email: row.email,
                  remote_id: null,
                  action: 'upload_failed',
                  reason: 'replenish',
                  detail: String(fail.error || '').slice(0, 300),
                }
              : {
                  email: row.email,
                  remote_id: null,
                  action: 'uploaded',
                  reason: 'replenish',
                  detail: `可用 ${available} 低于 ${threshold}，从主池库存上传`,
                },
          );
        }
      } catch (error) {
        logger.warn({ err: error.message }, 'replenish upload failed');
      }
    }

    // 第二段：主池库存（扣除本轮上传 + 在途 joining）低于主池库存保底 → 从备用池登录补入（每轮最多 3 个，不必等库存耗尽）
    let replenished = 0;
    const stockThreshold = mainStockThreshold(monitor);
    const remainingStock = Math.max(0, stock.length - uploaded) + joining;
    if (remainingStock < stockThreshold) {
      replenished = submitReserveJoins(monitor.replenish_join_order ?? 'balance_desc', Math.min(3, stockThreshold - remainingStock));
    }
    return { replenished, uploaded, available, stock_count: remainingStock };
  }

  /** 主池库存：active、有 tokens、无活跃任务、未封禁，且远端尚不存在（按邮箱匹配，防重复上传）。 */
  function loadMainStock(remoteByEmail, monitor) {
    return db
      .prepare(
        `SELECT a.id, a.email, a.initial_balance, a.balance FROM accounts a
         WHERE a.pool='main' AND a.status='active' AND a.banned=0 AND a.tokens_enc IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM jobs j WHERE j.account_id=a.id AND j.status IN ('queued','running','awaiting_input')
           )
         ORDER BY ${uploadOrderExpr(monitor.replenish_upload_order ?? 'balance_asc', 'main')}, a.id ASC`,
      )
      .all()
      .filter((row) => !remoteByEmail.has(String(row.email || '').toLowerCase()));
  }

  /** 在途 joining：备用池已发起登录且有活跃任务的号数。 */
  function countJoiningReserve() {
    return db
      .prepare(
        `SELECT COUNT(*) AS n FROM accounts a
         WHERE a.pool='reserve' AND a.status='joining'
           AND EXISTS (SELECT 1 FROM jobs j WHERE j.account_id=a.id AND j.status IN ('queued','running','awaiting_input'))`,
      )
      .get().n;
  }

  /** 备用池选号登录补入（两口径共用）：CAS 置 joining + 发登录任务，返回发起数。 */
  function submitReserveJoins(joinOrder, limit) {
    // 按金额排序时保留 has_balance 优先（余额未知的排最后），默认金额大优先
    const balancePrefix = String(joinOrder).startsWith('time') ? '' : 'has_balance DESC, ';
    const candidates = db
      .prepare(
        `SELECT a.id FROM accounts a WHERE a.pool='reserve' AND a.banned=0
           AND a.status IN ('mail_pending','mail_failed','mail_ok')
         ORDER BY ${balancePrefix}${uploadOrderExpr(joinOrder, 'reserve')}, a.id ASC LIMIT ?`,
      )
      .all(Math.max(0, Number(limit) || 0));
    for (const candidate of candidates) {
      const now = new Date().toISOString();
      const tx = db.transaction(() => {
        const cas = db
          .prepare(`UPDATE accounts SET status='joining', updated_at=? WHERE id=? AND pool='reserve' AND status != 'joining'`)
          .run(now, candidate.id);
        if (cas.changes === 0) return;
        pools.recordEvent(candidate.id, 'join_started', { source: 'monitor_replenish' });
        engine.submitJob({ accountId: candidate.id, type: 'login', note: '自动补号' });
      });
      tx();
    }
    return candidates.length;
  }

  /** 每号并发取值：远端记录 concurrency > 上传默认并发 > 0（未配置时该号不计入并发口径）。 */
  function accountConcurrency(remote, defaultConcurrency) {
    const c = Number(remote?.concurrency);
    if (Number.isFinite(c) && c > 0) return c;
    return Number.isFinite(defaultConcurrency) && defaultConcurrency > 0 ? defaultConcurrency : 0;
  }

  /** 贡献口径的初始余额：initial_balance 为空回退 balance（老数据），再为空计 0。 */
  function accountInitialBalance(row) {
    const b = Number(row.initial_balance ?? row.balance);
    return Number.isFinite(b) ? b : 0;
  }

  /**
   * sub2api 在架号资源统计（resource 口径）：本地主池 × 远端匹配（oauth、监控分组内）且远端非 error。
   * 限流中/暂停调度/待重授均计入：限流号按现有巡检逻辑要么短期恢复要么被废弃（废弃后自然掉出统计）；
   * 待重授号的资产还在，重授成功自动回到统计。
   */
  function fleetResourceStats(remoteByEmail, defaultConcurrency) {
    const localMain = db.prepare(`SELECT email, initial_balance, balance FROM accounts WHERE pool='main'`).all();
    let concurrency = 0;
    let initialBalance = 0;
    let count = 0;
    for (const row of localMain) {
      const remote = remoteByEmail.get(String(row.email || '').toLowerCase());
      if (!remote) continue;
      if (String(remote.status || 'active') === 'error') continue;
      concurrency += accountConcurrency(remote, defaultConcurrency);
      initialBalance += accountInitialBalance(row);
      count += 1;
    }
    return { concurrency, initialBalance, count };
  }

  /**
   * resource 口径补号：不按号的数量，按 sub2api 在架号的总并发与初始总余额（OR 语义）计缺口。
   *  - 第一段：按 replenish_upload_order 顺序遍历主池库存，逐个累加（并发，初始余额）贡献，
   *    两个缺口都补齐即停，选中的号一次性批量上传
   *  - 第二段：主池库存数量（扣除本轮上传 + 在途 joining）低于主池库存保底 → 从备用池登录补入（每轮最多 3 个），
   *    与 count 口径同一水位；库存只按数量保底，不要求资源镜像整套在架目标（主池囤整套闲号一天就死完）
   */
  async function replenishByResource(monitor, config, remoteByEmail, items) {
    const defaultConcurrency = Number(config?.upload_defaults?.concurrency);
    const concTarget = Math.max(0, Number(monitor.concurrency_target) || 0);
    const balTarget = Math.max(0, Number(monitor.initial_balance_target) || 0);
    const fleet = fleetResourceStats(remoteByEmail, defaultConcurrency);
    let gapConc = Math.max(0, concTarget - fleet.concurrency);
    let gapBal = Math.max(0, balTarget - fleet.initialBalance);

    const stock = loadMainStock(remoteByEmail, monitor);

    // 第一段：贪心选号直到两个缺口都补齐或库存耗尽
    let uploaded = 0;
    const targets = [];
    if ((gapConc > 0 || gapBal > 0) && stock.length) {
      let conc = gapConc;
      let bal = gapBal;
      for (const row of stock) {
        if (conc <= 0 && bal <= 0) break;
        targets.push(row);
        conc = Math.max(0, conc - accountConcurrency(null, defaultConcurrency));
        bal = Math.max(0, bal - accountInitialBalance(row));
      }
    }
    if (targets.length && uploader) {
      const fleetDesc = `并发 ${fleet.concurrency}/${concTarget}，初始余额 $${fleet.initialBalance.toFixed(2)}/${balTarget}`;
      try {
        const outcome = await uploader.uploadAccounts(
          targets.map((row) => row.id),
          {},
        );
        uploaded = Number(outcome?.created || 0) + Number(outcome?.updated || 0);
        const failedById = new Map((outcome?.failed || []).map((fail) => [fail.id, fail]));
        for (const row of targets) {
          const fail = failedById.get(row.id);
          items.push(
            fail
              ? {
                  email: row.email,
                  remote_id: null,
                  action: 'upload_failed',
                  reason: 'replenish',
                  detail: String(fail.error || '').slice(0, 300),
                }
              : {
                  email: row.email,
                  remote_id: null,
                  action: 'uploaded',
                  reason: 'replenish',
                  detail: `${fleetDesc}，从主池库存上传`,
                },
          );
        }
      } catch (error) {
        logger.warn({ err: error.message }, 'replenish upload failed');
      }
    }

    // 第二段：剩余库存 + 在途 joining 的数量低于主池库存保底 → 备用池登录补入（每轮最多 3 个）
    const remainingStock = Math.max(0, stock.length - uploaded) + countJoiningReserve();
    const stockThreshold = mainStockThreshold(monitor);
    let replenished = 0;
    if (remainingStock < stockThreshold) {
      replenished = submitReserveJoins(monitor.replenish_join_order ?? 'balance_desc', Math.min(3, stockThreshold - remainingStock));
    }
    return {
      replenished,
      uploaded,
      available: fleet.count,
      stock_count: remainingStock,
      fleet_concurrency: fleet.concurrency,
      fleet_initial_balance: Number(fleet.initialBalance.toFixed(2)),
    };
  }

  function inMonitoredGroups(account, groupIds) {
    if (!groupIds.length) return true;
    const accountGroupIds = [
      ...(Array.isArray(account?.group_ids) ? account.group_ids : []),
      ...(Array.isArray(account?.account_groups) ? account.account_groups.map((item) => item?.group_id) : []),
    ].map(Number).filter(Number.isSafeInteger);
    return groupIds.some((id) => accountGroupIds.includes(Number(id)));
  }

  /** 修复成功回写远端（引擎 hooks 或 refresh 完成后调用）。 */
  async function pushRepairedCredentials(accountId) {
    const config = getConfig();
    const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
    if (!row?.tokens_enc) return false;
    const tokens = crypto.tryDecryptJson(row.tokens_enc, 'accounts.tokens_enc');
    if (!tokens?.access_token) return false;
    let remoteId = row.sub2api_account_id;
    if (!Number.isInteger(remoteId)) {
      const accounts = await client.listAllOpenAiAccounts();
      const remote = accounts.find((acc) => client.accountEmail(acc) === row.email.toLowerCase());
      remoteId = remote ? Number(remote.id) : null;
    }
    if (!Number.isInteger(remoteId)) return false;
    const credentials = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      id_token: tokens.id_token,
      chatgpt_account_id: tokens.chatgpt_account_id,
      email: tokens.email,
    };
    await client.updateAccount(remoteId, { credentials });
    await client.clearError(remoteId);
    await client.setSchedulable(remoteId, true);
    // 修复成功解锁：清除连败计数与自动修复封锁（needs_reauth 暂停保留的号由此恢复自动修复资格）
    db.prepare('UPDATE accounts SET repair_fail_count=0, auto_repair_blocked=0, updated_at=? WHERE id=?').run(
      new Date().toISOString(),
      accountId,
    );
    pools.recordEvent(accountId, 'sub2api_replaced', { source: 'auto_repair' });
    return true;
  }

  return { startIfEnabled, stop, view, runCheck, recentLogs, pushRepairedCredentials, noteRepairOutcome, state };
}

function safeParseSummary(text) {
  try {
    return JSON.parse(text || '{}');
  } catch {
    return {};
  }
}

/**
 * 未发起自动修复时的日志动作与说明（按 tryAutoRepair 的 code）：
 * 「修复中」只能说明任务已提交，这些状态才说明为什么这一轮没发起、以及修复有没有下文。
 */
const REPAIR_SKIP_META = {
  active: { action: 'repair_pending', reason: 'repair_in_flight', note: '修复任务在途，结果落地后回写本行' },
  cooldown: { action: 'repair_cooldown', reason: 'repair_cooldown', note: '修复冷却期内，下轮再试' },
  parked: { action: 'repair_parked', reason: 'repair_parked', note: '修复连败达上限，已暂停保留待重授' },
  blocked: { action: 'repair_parked', reason: 'repair_parked', note: '自动修复已封锁，待重新授权解锁' },
  auto_repair_off: { action: 'ignored', reason: 'auto_repair_off', note: '自动修复未开启，仅记录不处理' },
  state_changed: { action: 'ignored', reason: 'state_changed', note: '账号状态已变化，本轮跳过' },
  ineligible: { action: 'ignored', reason: 'temp_error', note: '不符合自动修复条件' },
};

/** code → 日志动作；在途修复带上任务类型/阶段，便于判断是卡在排队还是真在跑。 */
function repairSkipMeta(repair) {
  const base = REPAIR_SKIP_META[repair?.code] || REPAIR_SKIP_META.ineligible;
  if (repair?.code !== 'active' || !repair.job) return base;
  const stage = repair.job.stage ? `·${repair.job.stage}` : '';
  return { ...base, note: `修复任务在途（${repair.job.type}${stage}），结果落地后回写本行` };
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '未知';
  const hours = Math.floor(ms / 3600_000);
  if (hours >= 24) return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
  if (hours >= 1) return `${hours} 小时 ${Math.floor((ms % 3600_000) / 60_000)} 分`;
  return `${Math.max(1, Math.floor(ms / 60_000))} 分钟`;
}
