import {
  fetchReserveAccountMessages,
  extractBalanceFromMessages,
  isAccountBannedFromMessages,
} from '../../core/outlook-mail.mjs';

/**
 * 备用号池邮件初始化：拉最近 10 封邮件 → 初始余额 / 封禁关键字。
 * 并发 3，队列内串行。
 */

const CONCURRENCY = 3;

export function createMailInit({ db, decryptCredentials, logger }) {
  const queue = [];
  let active = 0;

  function enqueue(accountIds, { source = 'manual' } = {}) {
    const now = new Date().toISOString();
    for (const id of accountIds) {
      db.prepare(
        `UPDATE accounts SET mail_status='checking', updated_at=? WHERE id=? AND pool='reserve' AND status != 'joining'`,
      ).run(now, id);
      queue.push({ accountId: id, source });
    }
    pump();
  }

  function pump() {
    while (active < CONCURRENCY && queue.length) {
      const task = queue.shift();
      active += 1;
      runOne(task).finally(() => {
        active -= 1;
        pump();
      });
    }
  }

  async function runOne({ accountId, source }) {
    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
    if (!account) return;
    const outlook = decryptCredentials(account)?.outlook;
    const now = new Date().toISOString();
    if (!outlook?.client_id || !outlook?.refresh_token) {
      db.prepare(
        `UPDATE accounts SET mail_status='fetch_failed', mail_error='缺少 Outlook 取件凭据', last_checked_at=?, updated_at=? WHERE id=?`,
      ).run(now, now, accountId);
      return;
    }
    try {
      const messages = await fetchReserveAccountMessages({
        email: account.email,
        clientId: outlook.client_id,
        refreshToken: outlook.refresh_token,
      });
      const balanceInfo = extractBalanceFromMessages(messages);
      const banInfo = isAccountBannedFromMessages(messages);
      db.prepare(
        `UPDATE accounts SET mail_status='ok',
           initial_balance=?, has_balance=?, banned=?, banned_reason=?,
           mail_error=NULL, last_checked_at=?, updated_at=? WHERE id=?`,
      ).run(
        balanceInfo.hasBalance ? balanceInfo.balance : null,
        balanceInfo.hasBalance ? 1 : 0,
        banInfo.banned ? 1 : 0,
        banInfo.banned ? banInfo.reason : null,
        now,
        now,
        accountId,
      );
      db.prepare('INSERT INTO account_events(account_id, type, detail, created_at) VALUES(?,?,?,?)').run(
        accountId,
        'mail_checked',
        JSON.stringify({ source, balance: balanceInfo.balance ?? null, banned: banInfo.banned }),
        now,
      );
    } catch (error) {
      const message = String(error.message || error).slice(0, 500);
      db.prepare(
        `UPDATE accounts SET mail_status='fetch_failed', mail_error=?, last_checked_at=?, updated_at=? WHERE id=?`,
      ).run(message, now, now, accountId);
      logger?.warn?.({ accountId, err: message }, 'mail init failed');
    }
  }

  return { enqueue };
}
