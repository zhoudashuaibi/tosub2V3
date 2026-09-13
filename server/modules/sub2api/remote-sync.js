/**
 * sub2api 远端同步服务：
 *  - syncRemoteStatus：按 email/ID 把远端账号关联回本地（回填 sub2api_account_id），
 *    并镜像远端真实 status 到 sub2api_status；远端已不存在的本地关联一并清除
 *  - resolveSub2apiProxy：余额查询选路——号已上传 sub2api 时解析其在远端绑定的代理 URL
 *
 * 远端全量索引（账号/代理列表）带 60s TTL 缓存：批量余额查询、巡检、同步共享一次拉取。
 */

const CACHE_TTL_MS = 60_000;

/** 废弃时代理快照的邮箱查找上限：翻到这么多远端账号还没命中就认「找不到」，避免退化成全量遍历。 */
const DISCARD_PROXY_EMAIL_LOOKUP_MAX = 200;

/** 从 sub2api 代理字段构造代理 URL（protocol://user:pass@host:port）。 */
export function buildProxyUrl(proxy) {
  const protocol = String(proxy?.protocol || 'http').toLowerCase();
  if (!['http', 'https', 'socks5', 'socks5h'].includes(protocol)) return null;
  const host = String(proxy?.host || '').trim();
  const port = Number(proxy?.port);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  const username = proxy?.username ? String(proxy.username) : '';
  const password = proxy?.password ? String(proxy.password || '') : '';
  const auth = username ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : '';
  return `${protocol}://${auth}${host}:${port}`;
}

/**
 * 从 sub2api 远端账号对象提取「当前出口代理」快照，用于废弃号池的 IP 归因。
 *
 * 上游返回形状不止一种，这里按优先级兼容（都不命中即返回 null = 没绑代理）：
 *   1. account.proxy 是对象：{ id, name, username, host, port }，id 缺失时回退 account.proxy_id
 *   2. 代理字段被平铺在账号上：discard_proxy_name / proxy_name 等
 *
 * 认证账号（username）是判断「同一个 IP 上是不是同一批号」的关键：
 * 同一台代理服务器换个认证账号就是另一条出口，只看 name 会误判。
 * 这里只取身份，不取密码。
 */
export function extractRemoteProxy(account) {
  const nested = account?.proxy && typeof account.proxy === 'object' ? account.proxy : null;
  const proxyId = Number(nested?.id ?? account?.proxy_id ?? 0);
  const name =
    nested?.name ??
    account?.proxy_name ??
    account?.discard_proxy_name ??
    (typeof account?.proxy === 'string' ? account.proxy : null);
  const username =
    nested?.username ?? account?.proxy_username ?? account?.proxy_user ?? account?.discard_proxy_user ?? null;
  const host = nested?.host ?? account?.proxy_host ?? null;
  const port = Number(nested?.port ?? account?.proxy_port ?? 0);
  const text = (value) => (value != null && String(value).trim() ? String(value).trim() : null);
  const [safeName, safeUser, safeHost] = [text(name), text(username), text(host)];
  const hasId = Number.isSafeInteger(proxyId) && proxyId > 0;
  const hasPort = Number.isSafeInteger(port) && port > 0;
  if (!hasId && !safeName && !safeUser && !safeHost) return null;
  return {
    id: hasId ? proxyId : null,
    name: safeName,
    username: safeUser,
    host: safeHost,
    port: hasPort ? port : null,
  };
}

export function createRemoteSync({ db, client, getConfig, logger }) {
  let cache = { accounts: null, accountsAt: 0, proxies: null, proxiesAt: 0 };

  function buildAccountIndex(list) {
    const byId = new Map();
    const byEmail = new Map();
    const emailRank = new Map(); // email → 已收录账号的 id，用于保留最小 id
    // email → 远端 id 列表（按出现顺序）。只有真的出现多份的邮箱会留下记录：
    // 历史上传并发（手动上传 × 巡检补号）会在远端给同一个号建两份，本地只可能关联其中一份，
    // 另一份既没人回推凭据、又还在接流量，必须能被巡检发现。
    const idsByEmail = new Map();
    for (const account of list) {
      const id = Number(account?.id);
      const validId = Number.isSafeInteger(id) && id > 0;
      if (validId) byId.set(id, account);
      const email = client.accountEmail(account);
      if (!email) continue;
      const key = email.toLowerCase();
      // 同一邮箱多份时取最小 id（最早创建），与上传回填口径一致，且与远端返回顺序无关
      const rank = validId ? id : Number.POSITIVE_INFINITY;
      if (!emailRank.has(key) || rank < emailRank.get(key)) {
        byEmail.set(key, account);
        emailRank.set(key, rank);
      }
      if (validId) {
        const ids = idsByEmail.get(key);
        if (ids) ids.push(id);
        else idsByEmail.set(key, [id]);
      }
    }
    const duplicatesByEmail = new Map();
    for (const [email, ids] of idsByEmail) {
      if (ids.length > 1) duplicatesByEmail.set(email, ids.slice().sort((a, b) => a - b));
    }
    return { byId, byEmail, duplicatesByEmail };
  }

  async function remoteAccountIndex() {
    if (!cache.accounts || Date.now() - cache.accountsAt > CACHE_TTL_MS) {
      const index = buildAccountIndex(await client.listAllOpenAiAccounts());
      cache = { ...cache, accounts: index, accountsAt: Date.now() };
    }
    return cache.accounts;
  }

  async function remoteProxyIndex() {
    if (!cache.proxies || Date.now() - cache.proxiesAt > CACHE_TTL_MS) {
      const payload = await client.listProxies();
      const proxies = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
      const byId = new Map();
      for (const proxy of proxies) {
        const id = Number(proxy?.id);
        if (Number.isSafeInteger(id) && id > 0) byId.set(id, proxy);
      }
      cache = { ...cache, proxies: byId, proxiesAt: Date.now() };
    }
    return cache.proxies;
  }

  function recordEvent(accountId, type, detail) {
    db.prepare('INSERT INTO account_events(account_id, type, detail, created_at) VALUES(?,?,?,?)').run(
      accountId,
      type,
      JSON.stringify(detail || {}),
      new Date().toISOString(),
    );
  }

  /**
   * 重复远端账号：同一邮箱在远端存在多份（并发上传遗留的孤儿副本）。
   * 只在「重复集合发生变化」时记事件，避免每轮巡检刷屏；返回值用于汇总与告警。
   */
  function noteDuplicate(accountId, email, remoteIds, linkedId) {
    const detail = { remote_ids: remoteIds, linked_remote_id: linkedId ?? null };
    const last = db
      .prepare(`SELECT detail FROM account_events WHERE account_id=? AND type='sub2api_duplicate' ORDER BY id DESC LIMIT 1`)
      .get(accountId);
    if (last?.detail === JSON.stringify(detail)) return false;
    recordEvent(accountId, 'sub2api_duplicate', detail);
    logger?.warn?.({ accountId, email, remoteIds }, '远端存在同邮箱重复账号，孤儿副本不会被回推凭据，建议清理');
    return true;
  }

  /**
   * 同步远端状态到本地主号池：
   *  - 远端存在 → 回填 sub2api_account_id（缺失/不符时）+ 镜像 status + sub2api_synced_at
   *  - 远端不存在 → 清除本地 sub2api_account_id / sub2api_status（远端已被删除）
   *  - 同邮箱多份 → 记 sub2api_duplicate 事件（集合变化时才记），并统计 stats.duplicates
   * remoteAccounts：调用方已拉取的全量远端账号（巡检复用），缺省自行拉取。
   */
  async function syncRemoteStatus({ remoteAccounts = null } = {}) {
    const index = remoteAccounts ? buildAccountIndex(remoteAccounts) : await remoteAccountIndex();
    const rows = db
      .prepare(`SELECT id, email, sub2api_account_id, sub2api_status FROM accounts WHERE pool = 'main'`)
      .all();
    const now = new Date().toISOString();
    const stats = { scanned: rows.length, linked: 0, unlinked: 0, status_updated: 0, duplicates: 0, duplicate_new: 0, duplicate_items: [] };
    const tx = db.transaction(() => {
      for (const row of rows) {
        const remote =
          (Number.isInteger(Number(row.sub2api_account_id)) && index.byId.get(Number(row.sub2api_account_id))) ||
          index.byEmail.get(String(row.email || '').toLowerCase()) ||
          null;
        if (remote) {
          const remoteId = Number(remote.id);
          const remoteStatus = String(remote.status || 'unknown');
          const idChanged = Number(row.sub2api_account_id) !== remoteId;
          const duplicates = index.duplicatesByEmail.get(String(row.email || '').toLowerCase());
          if (duplicates) {
            // duplicates 每轮都计数（未清理的重复会一直挂在巡检日志里提醒），
            // duplicate_items 只在集合变化时带明细，避免每轮往 monitor_logs.summary 里塞大数组
            stats.duplicates += 1;
            const extras = duplicates.filter((id) => id !== remoteId);
            if (noteDuplicate(row.id, row.email, duplicates, remoteId) && stats.duplicate_items.length < 10) {
              stats.duplicate_new += 1;
              stats.duplicate_items.push({ email: row.email, remote_ids: duplicates, extras });
            }
          }
          if (!idChanged && row.sub2api_status === remoteStatus) continue;
          db.prepare(
            `UPDATE accounts SET sub2api_account_id=?, sub2api_status=?, sub2api_synced_at=?,
               sub2api_uploaded_at=COALESCE(sub2api_uploaded_at, ?), updated_at=? WHERE id=?`,
          ).run(remoteId, remoteStatus, now, now, now, row.id);
          if (idChanged) {
            recordEvent(row.id, 'sub2api_linked', { remote_id: remoteId, source: 'sync' });
            stats.linked += 1;
          } else {
            stats.status_updated += 1;
          }
        } else if (row.sub2api_account_id != null || row.sub2api_status != null) {
          db.prepare(
            `UPDATE accounts SET sub2api_account_id=NULL, sub2api_status=NULL, sub2api_synced_at=?, updated_at=? WHERE id=?`,
          ).run(now, now, row.id);
          recordEvent(row.id, 'sub2api_unlinked', { source: 'sync', reason: 'remote_missing' });
          stats.unlinked += 1;
        }
      }
    });
    tx();
    // 只在重复集合变化时告警：未清理的重复仍会以 duplicates 计数留在每轮 info 日志与巡检汇总里
    if (stats.duplicate_new) {
      logger?.warn?.(
        { duplicates: stats.duplicates, emails: stats.duplicate_items.map((item) => item.email) },
        '远端存在重复账号，孤儿副本不会被回推凭据，需要清理',
      );
    }
    logger?.info?.(stats, 'sub2api remote sync done');
    return stats;
  }

  /**
   * 余额查询选路：号已上传 sub2api（按 ID 或 email 命中远端）且绑定了代理时，
   * 返回该代理的直连 URL；未配置 sub2api / 号不在远端 / 未绑代理返回 null（走本机选路）。
   */
  async function resolveSub2apiProxy(accountId) {
    const config = getConfig();
    if (!config?.base_url || !config?.admin_key) return null;
    const row = db.prepare('SELECT email, sub2api_account_id FROM accounts WHERE id = ?').get(accountId);
    if (!row) return null;
    const index = await remoteAccountIndex();
    const remote =
      (Number.isInteger(Number(row.sub2api_account_id)) && index.byId.get(Number(row.sub2api_account_id))) ||
      index.byEmail.get(String(row.email || '').toLowerCase()) ||
      null;
    const proxyId = Number(remote?.proxy_id);
    if (!Number.isSafeInteger(proxyId) || proxyId <= 0) return null;
    const proxy = (await remoteProxyIndex()).get(proxyId);
    const url = buildProxyUrl(proxy);
    if (!url) return null;
    return { url, remote_id: Number(remote.id), proxy_id: proxyId, proxy_name: proxy.name || null };
  }

  /**
   * 废弃瞬间的代理快照：优先用调用方已经拿到的远端账号对象（巡检本来就有，
   * 且那是「废弃那一刻」的真实绑定，事后 60s 缓存过期重查可能已被改绑）；
   * 没有时按 id → 邮箱回退查一次远端。
   *
   * 回退刻意分两档，避免批量废弃把 sub2api 打爆（每次废弃都会走这里，量大时会被放大千倍）：
   *   · 有 sub2api_account_id → 只查单个账号（1 次请求，与远端总量无关）
   *   · 没有 ID → 才走**有上限**的邮箱查找（client.findAccountByEmail，翻到上限就认「找不到」）。
   *     这里绝不用全量远端索引（remoteAccountIndex）：那会按远端账号总数翻几十页，
   *     废弃池里成百上千个「从未上传」的号逐个走一遍，等价于把远端列表扫上千次 ——
   *     废弃用量同步早期就是踩了这个坑（见 discard-usage.js 的注释）。
   * 远端账号已不存在（本地号从未上传 / 远端已被清理）时返回 null —— 不猜。
   */
  async function resolveDiscardProxy({ remote = null, accountId = null, email = null } = {}) {
    let target = remote;
    if (!target) {
      const linked = Number(accountId);
      if (Number.isSafeInteger(linked) && linked > 0 && typeof client.getAccount === 'function') {
        try {
          const payload = await client.getAccount(linked);
          const account = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
          if (account && Number(account.id ?? linked)) target = account;
        } catch (error) {
          logger?.debug?.({ accountId: linked, err: error.message }, 'discard proxy: getAccount failed');
        }
      }
    }
    if (!target) {
      const key = String(email || '').trim().toLowerCase();
      if (!key || typeof client.findAccountByEmail !== 'function') return null;
      try {
        target = (await client.findAccountByEmail(key, { maxAccounts: DISCARD_PROXY_EMAIL_LOOKUP_MAX })) ?? null;
      } catch (error) {
        logger?.debug?.({ err: error.message }, 'discard proxy: email lookup failed');
        return null;
      }
    }
    if (!target) return null;
    const snapshot = extractRemoteProxy(target);
    if (!snapshot) return null;
    // 远端账号通常只给 proxy_id，名字/认证账号要另查一次代理列表（有 60s 缓存，批量废弃不会放大请求量）
    if (snapshot.name || snapshot.username || !snapshot.id) return snapshot;
    const proxy = (await remoteProxyIndex()).get(snapshot.id);
    if (!proxy) return snapshot;
    return {
      id: snapshot.id,
      name: proxy.name != null && String(proxy.name).trim() ? String(proxy.name).trim() : null,
      username:
        proxy.username != null && String(proxy.username).trim()
          ? String(proxy.username).trim()
          : snapshot.username,
      host: proxy.host != null && String(proxy.host).trim() ? String(proxy.host).trim() : snapshot.host,
      port: Number.isSafeInteger(Number(proxy.port)) && Number(proxy.port) > 0 ? Number(proxy.port) : snapshot.port,
    };
  }

  return { syncRemoteStatus, resolveSub2apiProxy, resolveDiscardProxy };
}
