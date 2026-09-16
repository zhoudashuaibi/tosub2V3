import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { applyEvent, isPermanentAccountFailure, isUserQuit } from './events.js';
import { createLauncher } from './launcher.js';
import { createAutoInput, readSub2apiExport } from './auto-input.js';
import { fetchChatgptCredits } from '../../core/chatgpt-credits.mjs';
import { fetchWithTls } from '../../lib/openai-fetch.js';
import { sanitizeText } from '../../lib/sanitize.js';
import { errors } from '../../lib/http-errors.js';

const ACTIVE_STATUSES = ['queued', 'running', 'awaiting_input'];
const MAX_PROXY_SESSIONS = 10;
const MAX_CONNECTION_FAILURES = 20;
const BALANCE_CONCURRENCY = 5;
const BALANCE_PROXY_ATTEMPTS = 3;

export function createJobsEngine({ config, db, logger }) {
  const launcher = createLauncher({ config, logger });
  const autoInput = createAutoInput({ config: { settingsGet: (k) => config.settingsGet?.(k) }, logger });
  const running = new Map(); // jobId -> runtime { childHandle, account, proxyUrl, restarting, stageStartedAt, deferredTimers }
  let tickTimer = null;
  let stopped = false;
  let balanceActive = 0;
  let balanceProxyResolver = null; // sub2api 模块注入：号已上传时解析远端绑定代理
  const hooks = {}; // 可选外部回调：onLoginSucceeded / onLoginFailed / onAccountEvent

  const stmt = {
    getJob: db.prepare('SELECT * FROM jobs WHERE id = ?'),
    queuedJobs: db.prepare(
      `SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at ASC, rowid ASC`,
    ),
    activeCount: db.prepare(
      `SELECT COUNT(*) AS n FROM jobs WHERE status IN ('running','awaiting_input') AND type != 'balance'`,
    ),
    patchJob: null, // 动态构建
    getAccount: db.prepare('SELECT * FROM accounts WHERE id = ?'),
  };

  function patchJob(id, patch) {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    const sets = keys.map((k) => `${toSnake(k)} = ?`).join(', ');
    db.prepare(`UPDATE jobs SET ${sets}, updated_at = ? WHERE id = ?`).run(
      ...keys.map((k) => patch[k]),
      new Date().toISOString(),
      id,
    );
  }

  function getRuntime(jobId) {
    return running.get(jobId);
  }

  /** 选路等引擎侧信息追加到任务日志（任务详情页可见）。 */
  function appendJobLog(job, line) {
    try {
      fs.appendFileSync(path.resolve(config.dataDir, job.log_path), `[engine] ${line}\n`);
    } catch {}
  }

  // ------------------------------------------------------------------
  // 创建任务（与账号状态 CAS 同事务）
  // ------------------------------------------------------------------
  function submitJob({ accountId, type, resumeJobId = null, proxyId = null, note = '' }) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const logPath = path.join('logs', `${id}.log`);
    const job = {
      id,
      account_id: accountId,
      type,
      status: 'queued',
      attempt: 1,
      proxy_id: proxyId,
      proxy_attempts: 0,
      log_path: logPath,
      resume_job_id: resumeJobId,
      created_at: now,
      updated_at: now,
    };
    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO jobs(id, account_id, type, status, attempt, proxy_id, proxy_attempts, log_path, resume_job_id, created_at, updated_at)
         VALUES(@id, @account_id, @type, @status, @attempt, @proxy_id, @proxy_attempts, @log_path, @resume_job_id, @created_at, @updated_at)`,
      ).run(toParams(job));
      fs.mkdirSync(path.dirname(path.resolve(config.dataDir, logPath)), { recursive: true });
      fs.appendFileSync(
        path.resolve(config.dataDir, logPath),
        `[engine] job created type=${type} account=${accountId} ${note}\n`,
      );
    });
    tx();
    logger.info({ jobId: id, type, accountId }, 'job submitted');
    return stmt.getJob.get(id);
  }

  // ------------------------------------------------------------------
  // 调度循环
  // ------------------------------------------------------------------
  function start() {
    recoverInterrupted();
    stopped = false;
    tickTimer = setInterval(tick, 1000);
    tickTimer.unref?.();
    tick();
  }

  function recoverInterrupted() {
    const now = new Date().toISOString();
    const rows = db
      .prepare(`SELECT * FROM jobs WHERE status IN ('running','awaiting_input')`)
      .all();
    if (!rows.length) return;
    const tx = db.transaction(() => {
      for (const row of rows) {
        db.prepare(
          `UPDATE jobs SET status = 'queued', prompt_kind = NULL, updated_at = ?,
             error = COALESCE(error, '服务重启，自动重新排队') WHERE id = ?`,
        ).run(now, row.id);
      }
    });
    tx();
    logger.info({ recovered: rows.length }, 'requeued interrupted jobs after restart');
  }

  function engineConfig() {
    return config.settingsGet?.('engine.config') || { max_concurrent_jobs: 20, job_timeout_minutes: 30 };
  }

  /** 无可用代理时禁止本机直连（默认开启；旧库 engine.config 缺字段同样视为开启）。 */
  function strictProxyEnabled() {
    return engineConfig().strict_proxy !== false;
  }

  function tick() {
    if (stopped) return;
    const maxJobs = Number(engineConfig().max_concurrent_jobs) || 20;
    let active = stmt.activeCount.get().n;
    for (const job of stmt.queuedJobs.all()) {
      if (active >= maxJobs) break;
      if (job.type === 'balance') continue; // balance 走独立通道
      launchJob(job);
      active += 1;
    }
    scheduleBalanceJobs();
    checkTimeouts();
  }

  function scheduleBalanceJobs() {
    if (balanceActive >= BALANCE_CONCURRENCY) return;
    const rows = db
      .prepare(`SELECT * FROM jobs WHERE status = 'queued' AND type = 'balance' ORDER BY created_at ASC LIMIT ?`)
      .all(BALANCE_CONCURRENCY - balanceActive);
    for (const job of rows) {
      balanceActive += 1;
      patchJob(job.id, { status: 'running', started_at: new Date().toISOString() });
      runBalanceJob(job)
        .catch((error) => {
          logger.error({ jobId: job.id, err: error.message }, 'balance job crashed');
          const message = sanitizeText(String(error.message)).slice(0, 500);
          if (job.account_id) {
            db.prepare('UPDATE accounts SET balance_error=?, updated_at=? WHERE id=?').run(
              message,
              new Date().toISOString(),
              job.account_id,
            );
          }
          patchJob(job.id, { status: 'failed', error: message, finished_at: new Date().toISOString() });
        })
        .finally(() => {
          balanceActive -= 1;
        });
    }
  }

  async function runBalanceJob(job) {
    const account = stmt.getAccount.get(job.account_id);
    if (!account || !account.tokens_enc) throw new Error('账号缺少 OAuth tokens');
    const tokens = config.cryptoTryDecryptJson(account.tokens_enc, 'accounts.tokens_enc') || {};
    const credentials = config.cryptoTryDecryptJson(account.credentials_enc, 'accounts.credentials_enc') || {};

    // 已上传 sub2api 的号优先用远端绑定代理查询（与线上出口 IP 一致，避免换 IP 查询触发风控）；
    // 远端代理失败只做同代理重试（服务商端会轮换出口 IP），不回退本机选路
    if (balanceProxyResolver) {
      let remoteRoute = null;
      try {
        remoteRoute = await balanceProxyResolver(job.account_id);
      } catch (error) {
        logger.warn({ jobId: job.id, err: error.message }, 'resolve sub2api-bound proxy failed');
      }
      if (remoteRoute?.url) {
        const label = `sub2api 代理 #${remoteRoute.proxy_id}${remoteRoute.proxy_name ? ` (${remoteRoute.proxy_name})` : ''}`;
        patchJob(job.id, { proxy_label: label });
        appendJobLog(job, `balance via sub2api-bound proxy: ${label}, remote_account=${remoteRoute.remote_id}`);
        logger.info(
          { jobId: job.id, remoteAccountId: remoteRoute.remote_id, proxy: remoteRoute.proxy_name },
          'balance job via sub2api-bound proxy',
        );
        let result = null;
        for (let attempt = 1; attempt <= BALANCE_PROXY_ATTEMPTS && !result; attempt += 1) {
          try {
            result = await fetchChatgptCredits({
              accessToken: tokens.access_token,
              refreshToken: tokens.refresh_token,
              clientId: tokens.client_id,
              fetchImpl: (url, options) => fetchWithTls(url, options, { proxyUrl: remoteRoute.url }),
            });
          } catch (error) {
            if (attempt >= BALANCE_PROXY_ATTEMPTS) throw error;
            logger.warn({ jobId: job.id, attempt, err: error.message }, 'sub2api-bound proxy balance attempt failed');
            await new Promise((resolve) => setTimeout(resolve, 1500));
          }
        }
        persistBalanceResult(job, account, tokens, result, 'sub2api_proxy');
        return;
      }
    }

    // 未上传 sub2api：选路与登录一致：有可用代理先走代理（账号绑定代理 > 全局 alive 代理）。
    // 无可用代理时受 strict_proxy 管控（默认禁止直连直接失败）；代理连接失败/风控时换代理重试，重试耗尽直接失败。
    const excludeIds = [];
    for (let attempt = 1; ; attempt += 1) {
      const proxy = selectProxyForJob(job, credentials, excludeIds);
      if (!proxy.url && strictProxyEnabled()) {
        throw errors.conflict('无可用代理（已开启禁止直连）', 'NO_ALIVE_PROXY');
      }
      // 重试等场景可能残留 sub2api 标签：本机选路一律覆盖为空
      patchJob(job.id, { proxy_id: proxy.id, proxy_label: null });
      appendJobLog(job, `balance ${proxy.url ? `via local proxy #${proxy.id ?? '?'}` : 'direct (no local proxy)'}`);
      logger.info({ jobId: job.id, attempt, proxyId: proxy.id }, `balance job ${proxy.url ? 'via proxy' : 'direct'}`);

      let result;
      try {
        result = await fetchChatgptCredits({
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          clientId: tokens.client_id,
          fetchImpl: (url, options) => fetchWithTls(url, options, { proxyUrl: proxy.url }),
        });
      } catch (error) {
        const proxyFailure =
          proxy.url && /PROXY_CONNECTION_RETRY|PROXY_RISK_CONTROL/.test(String(error?.message || ''));
        if (!proxyFailure || attempt >= BALANCE_PROXY_ATTEMPTS) throw error;
        if (proxy.id) {
          excludeIds.push(proxy.id);
          config.recordProxyFailure?.(proxy.id);
        }
        logger.warn({ jobId: job.id, proxyId: proxy.id, attempt, err: error.message }, 'balance proxy failed, switching proxy');
        continue;
      }

      persistBalanceResult(job, account, tokens, result, 'job');
      return;
    }
  }

  function persistBalanceResult(job, account, tokens, result, source) {
    const now = new Date().toISOString();
    db.prepare(
      'UPDATE accounts SET balance = ?, balance_checked_at = ?, balance_error = NULL, updated_at = ? WHERE id = ?',
    ).run(result.balance, now, now, account.id);
    if (result.refreshedAccessToken) {
      tokens.access_token = result.refreshedAccessToken;
      db.prepare('UPDATE accounts SET tokens_enc = ?, updated_at = ? WHERE id = ?').run(
        config.cryptoEncryptJson(tokens, 'accounts.tokens_enc'),
        now,
        account.id,
      );
    }
    recordAccountEvent(account.id, 'balance_refreshed', { balance: result.balance, job_id: job.id, source });
    patchJob(job.id, { status: 'completed', finished_at: now });
  }

  function checkTimeouts() {
    const timeoutMinutes = Number(engineConfig().job_timeout_minutes) || 30;
    const cutoff = Date.now() - timeoutMinutes * 60 * 1000;
    const rows = db
      .prepare(`SELECT * FROM jobs WHERE status IN ('running','awaiting_input') AND type != 'balance'`)
      .all();
    for (const job of rows) {
      const started = Date.parse(job.started_at || job.created_at);
      if (Number.isFinite(started) && started < cutoff) {
        logger.warn({ jobId: job.id }, 'job timed out');
        cancelInternal(job.id, `任务超过 ${timeoutMinutes} 分钟未完成，已自动取消`);
      }
    }
  }

  // ------------------------------------------------------------------
  // 启动子进程任务
  // ------------------------------------------------------------------
  function redeemLoginEnabled(job) {
    if (job.type !== 'login') return false;
    const provider = config.settingsGet?.('login.provider') || {};
    return provider.mode !== 'protocol'; // 默认 redeem401（缺省视为开启）
  }

  function launchJob(job, { preserveAttempt = false } = {}) {
    const account = stmt.getAccount.get(job.account_id);
    const credentials = config.cryptoTryDecryptJson(account?.credentials_enc, 'accounts.credentials_enc') || {};
    const accountView = { ...account, credentials };

    // redeem401 远程登录由服务端完成登录与收码，本机不需要出口代理，
    // 也不受 strict_proxy（禁止直连）约束——这里根本没有到上游的直连请求
    const redeemLogin = redeemLoginEnabled(job);
    const provider = redeemLogin ? config.settingsGet?.('login.provider') || {} : null;
    const proxy = redeemLogin ? { id: null, url: '' } : selectProxyForJob(job, credentials);
    if (!redeemLogin && !proxy.url && strictProxyEnabled()) {
      // 服务器 IP 一旦被上游拉黑，本机直连登录即封号：无可用代理时直接失败，绝不直连
      const message = '无可用代理（已开启禁止直连），任务未启动';
      appendJobLog(job, 'no alive proxy and strict_proxy on, refuse direct connection');
      logger.warn({ jobId: job.id, accountId: job.account_id }, 'no alive proxy, strict_proxy on');
      patchJob(job.id, { status: 'failed', error: message, finished_at: new Date().toISOString() });
      hooks.onLoginFinished?.(stmt.getJob.get(job.id), accountView, { ok: false, code: 'NO_ALIVE_PROXY', message });
      return stmt.getJob.get(job.id);
    }
    patchJob(job.id, {
      status: 'running',
      proxy_id: redeemLogin ? null : proxy.id,
      ...(preserveAttempt ? {} : {}),
    });
    if (redeemLogin) {
      appendJobLog(job, `redeem401 remote login (base=${provider.redeem401_base_url || 'https://redeem.lazmeow.com'})`);
    }

    const runtime = {
      jobId: job.id,
      account: accountView,
      proxyUrl: proxy.url,
      restarting: false,
      closed: false,
      stageStartedAt: {},
      connectionFailures: 0,
    };
    running.set(job.id, runtime);

    const fresh = stmt.getJob.get(job.id);
    const handle = launcher.launch(
      fresh,
      { account: accountView, proxyUrl: proxy.url, attempt: fresh.attempt },
      {
        onEvent: (event) => handleEvent(fresh, runtime, event),
        onExited: (code, signal, spawnError) => handleExit(fresh, runtime, code, signal, spawnError),
      },
    );
    runtime.childHandle = handle;
    return fresh;
  }

  function selectProxyForJob(job, credentials, excludeIds = []) {
    if (credentials?.proxy_url) return { id: job.proxy_id, url: credentials.proxy_url };
    return config.pickProxy(excludeIds);
  }

  // ------------------------------------------------------------------
  // 事件处理
  // ------------------------------------------------------------------
  function handleEvent(jobRow, runtime, event) {
    const fresh = stmt.getJob.get(jobRow.id);
    if (!fresh || ['completed', 'failed', 'canceled'].includes(fresh.status)) return;
    if (runtime.restarting) return;

    const transition = applyEvent(fresh, event);
    if (event.type === 'stage') {
      runtime.stageStartedAt[event.stage] = Date.now();
    }
    if (transition.jobPatch && Object.keys(transition.jobPatch).length) {
      patchJob(fresh.id, transition.jobPatch);
    }
    if (transition.accountPatch && Object.keys(transition.accountPatch).length && fresh.account_id) {
      const sets = Object.keys(transition.accountPatch)
        .map((k) => `${toSnake(k)} = @${k}`)
        .join(', ');
      db.prepare(`UPDATE accounts SET ${sets}, updated_at = @updated_at WHERE id = @id`).run({
        ...transition.accountPatch,
        updated_at: new Date().toISOString(),
        id: fresh.account_id,
      });
    }
    for (const action of transition.actions || []) dispatchAction(fresh, runtime, action);
    if (transition.jobPatch?.status === 'completed') {
      // 成功终态回调：此时任务已落库 completed，派生的后续任务（如补查余额）不受同账号活跃任务唯一索引限制
      hooks.onLoginFinished?.(stmt.getJob.get(fresh.id), runtime.account, { ok: true });
    }
  }

  function dispatchAction(job, runtime, action) {
    switch (action.kind) {
      case 'auto_input':
        handleAutoInput(job, runtime, action.event);
        break;
      case 'save_tokens':
        handleSaveTokens(job, runtime, action.event);
        break;
      case 'save_totp':
        handleSaveTotp(job, runtime, action.event);
        break;
      case 'classify_error':
        handleClassifyError(job, runtime, action.event);
        break;
      case 'note_risk_retry':
        logger.info({ jobId: job.id, reason: action.event.reason }, 'child risk retry');
        break;
      default:
        break;
    }
  }

  function handleAutoInput(job, runtime, promptEvent) {
    const stageStartedAt =
      promptEvent.kind === 'email_otp' ? runtime.stageStartedAt.email_otp || Date.now() : undefined;
    autoInput
      .attempt(job, runtime.account, promptEvent, { stageStartedAt })
      .then((result) => {
        if (runtime.closed || runtime.restarting) return;
        if (result.submit) {
          runtime.childHandle?.sendCommand(result.submit).catch(() => {});
          return;
        }
        if (result.defer) {
          const timer = setTimeout(() => {
            const fresh = stmt.getJob.get(job.id);
            if (!fresh || fresh.status !== 'awaiting_input' || runtime.closed || runtime.restarting) return;
            handleAutoInput(fresh, runtime, promptEvent);
          }, result.defer);
          timer.unref?.();
          return;
        }
        // 无自动源：保持 awaiting_input 等人工
      })
      .catch((error) => {
        logger.warn({ jobId: job.id, err: String(error.message || error) }, 'auto input failed');
      });
  }

  function handleSaveTokens(job, runtime, event) {
    try {
      const exportData = readSub2apiExport(config.dataDir, event.path || path.join('data', 'results', `${job.id}.json`));
      const accountEntry = exportData?.accounts?.[0];
      if (!accountEntry?.credentials) throw new Error('产物缺少 accounts[0].credentials');
      const creds = accountEntry.credentials;
      const tokens = {
        access_token: creds.access_token || '',
        refresh_token: creds.refresh_token || '',
        id_token: creds.id_token || '',
        chatgpt_account_id: creds.chatgpt_account_id || accountEntry.extra?.chatgpt_account_id || '',
        chatgpt_user_id: accountEntry.extra?.chatgpt_user_id || '',
        client_id: accountEntry.extra?.client_id || 'app_EMoamEEZ73f0CkXaXp7hrann',
        email: creds.email || accountEntry.extra?.email || runtime.account?.email || '',
        obtained_at: new Date().toISOString(),
      };
      if (!tokens.access_token || !tokens.refresh_token) throw new Error('产物缺少 access_token/refresh_token');
      const tokensEnc = config.cryptoEncryptJson(tokens, 'accounts.tokens_enc');
      // 维护账号级导出文件（refresh 任务的数据源）
      const accountExportPath = path.resolve(config.dataDir, 'results', `account-${job.account_id}.json`);
      fs.mkdirSync(path.dirname(accountExportPath), { recursive: true });
      fs.writeFileSync(accountExportPath, JSON.stringify(exportData, null, 2), { mode: 0o600 });
      db.prepare('UPDATE accounts SET tokens_enc = ?, updated_at = ? WHERE id = ?').run(
        tokensEnc,
        new Date().toISOString(),
        job.account_id,
      );
      // 钩子可能被包装成 async（sub2api 模块），同步异常与 Promise 拒绝都要落日志，不能静默
      Promise.resolve(hooks.onTokensSaved?.(job, runtime, tokens, exportData)).catch((error) =>
        logger.error({ jobId: job.id, err: error?.message || String(error) }, 'onTokensSaved hook failed'),
      );
    } catch (error) {
      logger.error({ jobId: job.id, err: error.message }, 'save tokens failed');
      patchJob(job.id, { error: `产物解析失败：${sanitizeText(error.message).slice(0, 300)}` });
    }
  }
  function handleSaveTotp(job, runtime, event) {
    if (!job.account_id) return;
    const account = stmt.getAccount.get(job.account_id);
    if (!account) return;
    const credentials = config.cryptoTryDecryptJson(account.credentials_enc, 'accounts.credentials_enc') || {};
    if (event.secret) {
      credentials.totp_secret = event.secret;
      db.prepare('UPDATE accounts SET credentials_enc = ?, updated_at = ? WHERE id = ?').run(
        config.cryptoEncryptJson(credentials, 'accounts.credentials_enc'),
        new Date().toISOString(),
        job.account_id,
      );
      recordAccountEvent(job.account_id, 'totp_setup', { source: 'job' });
    }
  }

  function handleClassifyError(job, runtime, event) {
    const code = event.code || 'INTERNAL';
    const message = String(event.message || '');

    // 永久性账号失败：标记 + 移废弃
    if (isPermanentAccountFailure(message)) {
      // 任务错误加前缀，避免在任务中心被误读为验证码/阶段类失败
      patchJob(job.id, { error: `【账号已停用/封禁】${message}`.slice(0, 2000) });
      if (job.account_id) {
        db.prepare('UPDATE accounts SET auto_repair_blocked = 1, updated_at = ? WHERE id = ?').run(
          new Date().toISOString(),
          job.account_id,
        );
        hooks.onPermanentFailure?.(job, runtime, message);
      }
      finishRuntime(job.id);
      hooks.onLoginFinished?.(stmt.getJob.get(job.id), runtime.account, { ok: false, code, message });
      return;
    }

    // REFRESH_TOKEN_INVALID → 自动转完整登录
    if (code === 'REFRESH_TOKEN_INVALID' && job.type === 'refresh') {
      const followUp = submitJob({
        accountId: job.account_id,
        type: 'login',
        resumeJobId: job.id,
        note: 'refresh 失败自动转完整登录',
      });
      if (followUp && job.account_id) {
        casAccountStatus(job.account_id, 'authorizing');
      }
      finishRuntime(job.id);
      hooks.onLoginFinished?.(stmt.getJob.get(job.id), runtime.account, { ok: false, code, message, followUpJobId: followUp?.id });
      return;
    }

    // 代理风控/连接类错误 → 杀进程换会话/换代理重启
    if (event.retry_proxy && code !== 'REFRESH_TOKEN_INVALID') {
      scheduleProxyRestart(job, runtime, code);
      return;
    }

    finishRuntime(job.id);
    hooks.onLoginFinished?.(stmt.getJob.get(job.id), runtime.account, {
      ok: false,
      code,
      message,
      canceled: isUserQuit(message),
    });
  }

  function scheduleProxyRestart(job, runtime, code) {
    const fresh = stmt.getJob.get(job.id);
    if (!fresh || !['failed', 'canceled'].includes(fresh.status) || runtime.restarting) return;
    if ((fresh.proxy_attempts || 0) >= MAX_PROXY_SESSIONS) {
      logger.warn({ jobId: job.id }, 'proxy session budget exhausted');
      finishRuntime(job.id);
      hooks.onLoginFinished?.(fresh, runtime.account, { ok: false, code, message: '代理会话预算已耗尽' });
      return;
    }
    if (code === 'PROXY_CONNECTION_RETRY') {
      runtime.connectionFailures += 1;
      if (fresh.proxy_id) config.recordProxyFailure?.(fresh.proxy_id);
      if (runtime.connectionFailures >= MAX_CONNECTION_FAILURES) {
        logger.warn({ jobId: job.id, failures: runtime.connectionFailures }, 'connection failures exceeded');
        finishRuntime(job.id);
        hooks.onLoginFinished?.(fresh, runtime.account, { ok: false, code, message: '代理连接连续失败过多' });
        return;
      }
    }

    runtime.restarting = true;
    const backoff = Math.min(15_000, 1000 * 2 ** Math.min(4, runtime.connectionFailures));
    const attempt = (fresh.attempt || 1) + 1;
    patchJob(job.id, {
      status: 'queued',
      attempt,
      error: `代理风控重启（${code}），第 ${attempt} 次尝试`,
      prompt_kind: null,
      stage: null,
    });
    const timer = setTimeout(async () => {
      try {
        await runtime.childHandle?.kill();
      } catch {}
      running.delete(job.id);
      const requeued = stmt.getJob.get(job.id);
      if (requeued && requeued.status === 'queued') {
        const active = stmt.activeCount.get().n;
        const maxJobs = Number(engineConfig().max_concurrent_jobs) || 20;
        if (active < maxJobs) launchJob(requeued);
      }
    }, backoff);
    timer.unref?.();
  }

  function handleExit(jobRow, runtime, code, signal, spawnError) {
    if (runtime.closed || runtime.restarting) return;
    const fresh = stmt.getJob.get(jobRow.id);
    if (!fresh || ['completed', 'failed', 'canceled'].includes(fresh.status)) {
      finishRuntime(jobRow.id);
      return;
    }
    // 子进程非零退出且无 error 事件 → 崩溃视为 INTERNAL
    const message = spawnError
      ? spawnError.message
      : `子进程异常退出（code=${code}${signal ? ` signal=${signal}` : ''}）`;
    handleEvent(jobRow, runtime, { type: 'error', code: 'INTERNAL', message, ts: new Date().toISOString() });
    const updated = stmt.getJob.get(jobRow.id);
    finishRuntime(jobRow.id);
    hooks.onLoginFinished?.(updated, runtime.account, { ok: false, code: 'INTERNAL', message });
  }

  function finishRuntime(jobId) {
    const runtime = running.get(jobId);
    if (runtime) {
      runtime.closed = true;
      autoInput.reset(jobId);
    }
    running.delete(jobId);
  }

  // ------------------------------------------------------------------
  // 人工输入 / 取消 / 重试
  // ------------------------------------------------------------------
  async function submitInput(jobId, action, value) {
    const job = stmt.getJob.get(jobId);
    if (!job) throw errors.notFound('任务不存在');
    if (job.status !== 'awaiting_input') throw errors.jobNotAwaitingInput();
    const runtime = running.get(jobId);
    if (!runtime?.childHandle) throw errors.jobNotAwaitingInput();

    if (action === 'input') {
      if (value === undefined || value === null || String(value) === '') {
        throw errors.validation('输入值不能为空');
      }
      await runtime.childHandle.sendCommand({ action: 'input', value: String(value) });
      patchJob(jobId, { status: 'running', prompt_kind: null });
      return { ok: true };
    }
    if (action === 'resend') {
      await runtime.childHandle.sendCommand({ action: 'resend' });
      return { ok: true };
    }
    if (action === 'quit') {
      await runtime.childHandle.sendCommand({ action: 'quit' });
      return { ok: true };
    }
    throw errors.validation('action 必须是 input / resend / quit');
  }

  async function cancel(jobId, reason = '用户取消') {
    const job = stmt.getJob.get(jobId);
    if (!job) throw errors.notFound('任务不存在');
    if (['completed', 'failed', 'canceled'].includes(job.status)) throw errors.jobNotCancelable();
    await cancelInternal(jobId, reason);
    return stmt.getJob.get(jobId);
  }

  async function cancelInternal(jobId, reason) {
    const runtime = running.get(jobId);
    if (runtime) {
      runtime.closed = true;
      runtime.restarting = true; // 阻止后续事件
      if (runtime.childHandle) await runtime.childHandle.kill();
      running.delete(jobId);
    }
    patchJob(jobId, {
      status: 'canceled',
      error: sanitizeText(reason).slice(0, 500),
      finished_at: new Date().toISOString(),
      prompt_kind: null,
    });
    const job = stmt.getJob.get(jobId);
    if (!job) return;
    // 排队中的任务没有 runtime（进程从未起过），账号视图必须自己查：
    // 否则「取消全部」只把 jobs 标成 canceled，账号永远停在 joining/authorizing，
    // 备用池列表就会一直显示「加入中」，且「加入主号池」按钮永久禁用。
    const account = runtime?.account || (job.account_id ? stmt.getAccount.get(job.account_id) : null);
    hooks.onLoginFinished?.(job, account, { ok: false, code: 'CANCELED', message: reason, canceled: true });
  }

  async function cancelAll() {
    const rows = db
      .prepare(`SELECT id FROM jobs WHERE status IN ('queued','running','awaiting_input')`)
      .all();
    for (const row of rows) {
      try {
        await cancelInternal(row.id, '批量取消');
      } catch (error) {
        logger.warn({ jobId: row.id, err: error.message }, 'cancel-all skipped');
      }
    }
    return rows.length;
  }

  function retry(jobId, { proxyId = null } = {}) {
    const job = stmt.getJob.get(jobId);
    if (!job) throw errors.notFound('任务不存在');
    if (!['completed', 'failed', 'canceled'].includes(job.status)) {
      throw errors.conflict('任务仍在进行，无法重试', 'JOB_NOT_RETRYABLE');
    }
    if (!job.account_id) throw errors.validation('任务未绑定账号，无法重试');
    const active = db
      .prepare(`SELECT id FROM jobs WHERE account_id = ? AND status IN ('queued','running','awaiting_input')`)
      .get(job.account_id);
    if (active) throw errors.conflict('该账号已有活跃任务', 'ACCOUNT_STATE_INVALID');

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO jobs(id, account_id, type, status, attempt, proxy_id, proxy_attempts, log_path, resume_job_id, created_at, updated_at)
       VALUES(?,?,?,?,1,?,0,?,?,?,?)`,
    ).run(id, job.account_id, job.type, 'queued', proxyId, path.join('logs', `${id}.log`), jobId, now, now);
    if (job.type !== 'balance') casAccountStatus(job.account_id, 'authorizing');
    return stmt.getJob.get(id);
  }

  /**
   * 账号状态 CAS。
   *
   * pool 必须跟着状态一起传：authorizing 是主号池语义，备用池对应的是 joining
   * （由调用方自行 CAS）。少了这层约束，给备用号重试/提交登录任务会把账号写成
   * authorizing —— 取消回滚按 `pool='reserve' AND status='joining'` 兜底时就再也
   * 匹配不到，号会永久卡在「授权中」。
   */
  function casAccountStatus(accountId, status, fromStatuses = null, pool = 'main') {
    const from = fromStatuses
      ? `AND status IN (${fromStatuses.map((s) => `'${s}'`).join(',')})`
      : '';
    const result = db
      .prepare(`UPDATE accounts SET status = ?, updated_at = ? WHERE id = ? AND pool = ? ${from}`)
      .run(status, new Date().toISOString(), accountId, pool);
    return result.changes > 0;
  }

  function recordAccountEvent(accountId, type, detail) {
    db.prepare('INSERT INTO account_events(account_id, type, detail, created_at) VALUES(?,?,?,?)').run(
      accountId,
      type,
      JSON.stringify(detail || {}),
      new Date().toISOString(),
    );
  }

  async function shutdown() {
    stopped = true;
    if (tickTimer) clearInterval(tickTimer);
    const jobs = [...running.values()];
    await Promise.all(
      jobs.map(async (runtime) => {
        try {
          await runtime.childHandle?.kill();
        } catch {}
      }),
    );
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE jobs SET status = 'queued', prompt_kind = NULL, updated_at = ?,
       error = COALESCE(error, '服务关闭，自动重新排队')
       WHERE status IN ('running','awaiting_input') AND type != 'balance'`,
    ).run(now);
    db.prepare(
      `UPDATE jobs SET status = 'queued', updated_at = ? WHERE status = 'running' AND type = 'balance'`,
    ).run(now);
  }

  return {
    start,
    shutdown,
    submitJob,
    submitInput,
    cancel,
    cancelAll,
    retry,
    hooks,
    getRuntime,
    recoverInterrupted,
    setBalanceProxyResolver: (resolver) => {
      balanceProxyResolver = typeof resolver === 'function' ? resolver : null;
    },
  };
}

function toSnake(key) {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function toParams(job) {
  return Object.fromEntries(Object.entries(job).map(([k, v]) => [toSnake(k), v]));
}
