import {
  fetchReserveAccountMessages,
  isAccountBannedFromMessages,
} from '../../core/outlook-mail.mjs';

/**
 * 账号停用/封禁后的邮箱辅证检查（03 §9 辅佐比对）：
 * 登录 403 停用、监控封禁关键词等场景先拉邮箱扫描封禁邮件再决定处置。
 * 结果写 account_events（ban_mail_check），命中时补 banned 标记；
 * 返回 { confirmed, result, reason } 供调用方决策（confirmed 才算封禁实锤）。
 */
export function createBanMailCheck({ db, decryptCredentials, logger }) {
  function record(accountId, detail) {
    try {
      db.prepare('INSERT INTO account_events(account_id, type, detail, created_at) VALUES(?,?,?,?)').run(
        accountId,
        'ban_mail_check',
        JSON.stringify(detail),
        new Date().toISOString(),
      );
    } catch (error) {
      logger?.warn?.({ accountId, err: error.message }, 'ban mail check event write failed');
    }
  }

  async function check(accountId, { source = 'engine' } = {}) {
    let account;
    try {
      account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
    } catch {}
    if (!account) return { confirmed: false, result: 'missing_account' };
    const outlook = decryptCredentials(account)?.outlook;
    if (!outlook?.client_id || !outlook?.refresh_token) {
      record(accountId, { source, result: 'skipped', reason: '缺少 Outlook 取件凭据' });
      return { confirmed: false, result: 'skipped' };
    }
    try {
      const messages = await fetchReserveAccountMessages({
        email: account.email,
        clientId: outlook.client_id,
        refreshToken: outlook.refresh_token,
      });
      const banInfo = isAccountBannedFromMessages(messages);
      if (banInfo.banned) {
        db.prepare('UPDATE accounts SET banned=1, banned_reason=?, updated_at=? WHERE id=?').run(
          banInfo.reason,
          new Date().toISOString(),
          accountId,
        );
        record(accountId, {
          source,
          result: 'confirmed',
          reason: banInfo.reason,
          messages_scanned: messages.length,
        });
        return { confirmed: true, result: 'confirmed', reason: banInfo.reason };
      }
      record(accountId, { source, result: 'not_found', messages_scanned: messages.length });
      return { confirmed: false, result: 'not_found' };
    } catch (error) {
      const message = String(error.message || error).slice(0, 300);
      record(accountId, { source, result: 'error', error: message });
      logger?.warn?.({ accountId, err: message }, 'ban mail check failed');
      return { confirmed: false, result: 'error' };
    }
  }

  return { check };
}
