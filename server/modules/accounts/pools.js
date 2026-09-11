import { errors } from '../../lib/http-errors.js';

/**
 * 三级号池状态机与池流转事务（docs 04-04）。
 * 所有 pool 变更必须走这里的函数：单事务「改 accounts + 写 account_events」，
 * WHERE pool=... 乐观锁，受影响行数=0 报冲突。
 *
 * @param {object} db
 * @param {object} crypto
 * @param {{ onDiscarded?: (accountId: number) => unknown }} [hooks]
 *   onDiscarded：账号**成功**进入废弃池后的回调（快照用量等）。放在这里是因为
 *   废弃入口有多条（手动批量、401/429 巡检、登录终局失败、永久封禁），散在各调用点
 *   会漏 —— 漏掉的那条路径上的号就永远是「未同步」。best-effort：不 await、吞异常，
 *   绝不影响转池事务的结果。
 */
export function createPools(db, crypto, { onDiscarded = null } = {}) {
  function recordEvent(accountId, type, detail) {
    db.prepare('INSERT INTO account_events(account_id, type, detail, created_at) VALUES(?,?,?,?)').run(
      accountId,
      type,
      JSON.stringify(detail ?? {}),
      new Date().toISOString(),
    );
  }

  /**
   * 事务提交后触发废弃钩子。必须在 tx() 成功之后调用，否则回滚的流转也会抓快照；
   * 同步抛错同样要吞掉：快照失败不能把已经成功的废弃变成报错。
   */
  function notifyDiscarded(accountId) {
    if (typeof onDiscarded !== 'function') return;
    try {
      Promise.resolve(onDiscarded(accountId)).catch(() => {});
    } catch {
      /* ignore：best-effort */
    }
  }

  /** reserve → main：登录成功 + tokens/余额入库。 */
  function joinSucceeded(accountId, { tokensEnc, balance, balanceCheckedAt, keepInitial = true }) {
    const now = new Date().toISOString();
    const tx = db.transaction(() => {
      const result = db
        .prepare(
          `UPDATE accounts SET pool='main', status='active', tokens_enc=?, last_login_at=?,
             balance=?, balance_checked_at=?, balance_error=NULL,
             mail_error=NULL, updated_at=?,
             initial_balance = ${keepInitial ? 'initial_balance' : 'NULL'},
             has_balance = ${keepInitial ? 'has_balance' : '0'}
           WHERE id=? AND pool='reserve'`,
        )
        .run(tokensEnc ?? null, now, balance ?? null, balanceCheckedAt ?? null, now, accountId);
      if (result.changes === 0) {
        // 主号池账号重新授权成功（login/refresh 任务）：重授成功即解锁自动修复
        // （清除连败计数与 auto_repair_blocked，needs_reauth 暂停保留的号恢复修复资格）
        const mainResult = db
          .prepare(
            `UPDATE accounts SET status='active', tokens_enc=?, last_login_at=?,
               balance=COALESCE(?, balance), balance_checked_at=COALESCE(?, balance_checked_at),
               repair_fail_count=0, auto_repair_blocked=0, updated_at=?
             WHERE id=? AND pool='main'`,
          )
          .run(tokensEnc ?? null, now, balance ?? null, balanceCheckedAt ?? null, now, accountId);
        if (mainResult.changes === 0) {
          throw errors.poolTransferConflict('账号不在可移入主号池的状态');
        }
        recordEvent(accountId, 'login_succeeded', { source: 'reauthorize' });
        return { pool: 'main', reauth: true };
      }
      recordEvent(accountId, 'join_succeeded', { balance: balance ?? null });
      return { pool: 'main' };
    });
    return tx();
  }

  /** 登录失败：回备用池（status=mail_failed + 错误）或直接废弃（永久封禁）。 */
  function joinFailed(accountId, { error, jobId = null, permanent = false }) {
    const now = new Date().toISOString();
    const tx = db.transaction(() => {
      if (permanent) {
        const result = db
          .prepare(
            `UPDATE accounts SET pool='discard', status='discarded', discard_reason='login_failed',
               discard_detail=?, discarded_at=?, mail_error=?, updated_at=? WHERE id=? AND pool='reserve'`,
          )
          .run(String(error || '').slice(0, 2000), now, String(error || '').slice(0, 500), now, accountId);
        if (result.changes === 0) {
          throw errors.poolTransferConflict('账号状态已变化');
        }
        recordEvent(accountId, 'moved_to_discard', { reason: 'login_failed', error: String(error || '').slice(0, 500), job_id: jobId });
        return { pool: 'discard', reason: 'login_failed' };
      }
      const result = db
        .prepare(
          `UPDATE accounts SET status='mail_failed', mail_error=?, updated_at=? WHERE id=? AND pool='reserve' AND status IN ('joining','mail_failed','mail_pending','mail_ok')`,
        )
        .run(String(error || '').slice(0, 500), now, accountId);
      if (result.changes === 0) {
        // 主号池授权失败 → needs_reauth
        const mainResult = db
          .prepare(
            `UPDATE accounts SET status='needs_reauth', updated_at=? WHERE id=? AND pool='main' AND status='authorizing'`,
          )
          .run(now, accountId);
        if (mainResult.changes === 0) return { pool: null, skipped: true };
        recordEvent(accountId, 'login_failed', { error: String(error || '').slice(0, 500), job_id: jobId });
        return { pool: 'main', status: 'needs_reauth' };
      }
      recordEvent(accountId, 'join_failed', { error: String(error || '').slice(0, 500), job_id: jobId });
      return { pool: 'reserve', status: 'mail_failed' };
    });
    const result = tx();
    // 永久封禁直接进废弃池：与 moveToDiscard 一样，落库后立刻抓一次用量快照
    if (result?.pool === 'discard') notifyDiscarded(accountId);
    return result;
  }

  /** main → discard。reason ∈ banned_401 | rate_limited_429 | repair_failed | login_failed | manual */
  function moveToDiscard(accountId, reason, detail = '', { fromPools = ['main', 'reserve'] } = {}) {
    const now = new Date().toISOString();
    const tx = db.transaction(() => {
      const result = db
        .prepare(
          `UPDATE accounts SET pool='discard', status='discarded', discard_reason=?, discard_detail=?,
             discarded_at=?, updated_at=? WHERE id=? AND pool IN (${fromPools.map((p) => `'${p}'`).join(',')})`,
        )
        .run(reason, String(detail || '').slice(0, 2000), now, now, accountId);
      if (result.changes === 0) throw errors.poolTransferConflict('账号不在可废弃的状态');
      recordEvent(accountId, 'moved_to_discard', { reason, detail: String(detail || '').slice(0, 500) });
      return { pool: 'discard', reason };
    });
    const result = tx();
    // 废弃当下抓一次用量快照：sub2api 只有「当前累计」、没有历史时点查询，
    // 错过此刻之后再补也只能拿到当前值
    notifyDiscarded(accountId);
    return result;
  }

  /** discard → main（needs_reauth）。 */
  function restore(accountId) {
    const now = new Date().toISOString();
    const tx = db.transaction(() => {
      const result = db
        .prepare(
          `UPDATE accounts SET pool='main', status='needs_reauth', discard_reason=NULL, discard_detail=NULL,
             discarded_at=NULL, updated_at=? WHERE id=? AND pool='discard'`,
        )
        .run(now, accountId);
      if (result.changes === 0) throw errors.poolTransferConflict('账号不在废弃号池');
      recordEvent(accountId, 'restored', {});
      return { status: 'needs_reauth' };
    });
    return tx();
  }

  return { joinSucceeded, joinFailed, moveToDiscard, restore, recordEvent };
}
