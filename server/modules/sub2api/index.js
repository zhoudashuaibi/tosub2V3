import { errors } from '../../lib/http-errors.js';
import { maskSecret } from '../../lib/sanitize.js';
import { createSub2apiClient } from './client.js';
import { createUploader } from './upload.js';
import { createMonitor } from './monitor.js';
import { createProxyReplacer } from './proxy-replace.js';
import { createRemoteSync } from './remote-sync.js';
import { createBanMailCheck } from '../accounts/ban-mail-check.js';

const CONFIG_KEY = 'sub2api.config';

export function createSub2apiModule({ engine, logger }) {
  return async function sub2apiModule(app) {
    const db = app.db;
    const client = createSub2apiClient(() => app.settings.get(CONFIG_KEY));
    app.decorate('sub2apiClient', client);

    const uploader = createUploader({
      db,
      crypto: app.crypto,
      client,
      getConfig: () => app.settings.get(CONFIG_KEY),
      settingsGet: (key) => app.settings.get(key),
      dataDir: app.config.dataDir,
      proxySelector: app.proxySelector,
      logger,
    });
    app.decorate('sub2apiUploader', uploader);

    const remoteSync = createRemoteSync({
      db,
      client,
      getConfig: () => app.settings.get(CONFIG_KEY),
      logger,
    });
    app.decorate('sub2apiRemoteSync', remoteSync);

    const monitor = createMonitor({
      db,
      crypto: app.crypto,
      client,
      getConfig: () => app.settings.get(CONFIG_KEY),
      pools: app.accountsPools,
      engine,
      uploader,
      remoteSync,
      banMailCheck: createBanMailCheck({
        db,
        getEndpoint: () => app.settings.get('outlook.fetch').endpoint,
        decryptCredentials: (account) => app.crypto.tryDecryptJson(account?.credentials_enc, 'accounts.credentials_enc'),
        logger,
      }),
      logger,
    });
    app.decorate('sub2apiMonitor', monitor);

    const replaceProxies = createProxyReplacer({ client, logger });

    // 余额查询选路注入：号已上传 sub2api 时优先用其在远端绑定的代理（未上传仍走本机代理/直连）
    engine.setBalanceProxyResolver?.((accountId) => remoteSync.resolveSub2apiProxy(accountId));

    // 引擎 hook：修复链路产物回传远端（refresh 成功，或 refresh 失败自动转的完整登录成功）；
    // 主池已上架号的手动完整登录重授也回传（新凭证 + 清错误 + 恢复调度，修复失败暂停保留的号由此复活）
    const previousHandler = engine.hooks.onTokensSaved;
    engine.hooks.onTokensSaved = async (job, runtime, tokens) => {
      await previousHandler?.(job, runtime, tokens);
      if (!job.account_id) return;
      const isRepairChain = job.type === 'refresh' || (job.type === 'login' && job.resume_job_id);
      const row = db.prepare('SELECT pool, sub2api_account_id FROM accounts WHERE id = ?').get(job.account_id);
      const mainReauth =
        row?.pool === 'main' && row?.sub2api_account_id != null && Number.isInteger(Number(row.sub2api_account_id));
      if ((isRepairChain || mainReauth) && job.account_id) {
        try {
          await monitor.pushRepairedCredentials(job.account_id);
        } catch (error) {
          logger.warn({ accountId: job.account_id, err: error.message }, 'push repaired credentials failed');
        }
      }
    };

    // 引擎 hook：自动修复任务终态 → 成功清零 / 失败计数熔断（挂在 accounts 模块池流转回调之后）
    const previousLoginFinished = engine.hooks.onLoginFinished;
    engine.hooks.onLoginFinished = (job, account, result) => {
      try {
        previousLoginFinished?.(job, account, result);
      } catch (error) {
        logger.warn({ jobId: job?.id, err: error.message }, 'onLoginFinished handler failed');
      }
      monitor.noteRepairOutcome(job, result || {});
    };

    function configView() {
      const config = app.settings.get(CONFIG_KEY) || {};
      return {
        base_url: config.base_url || '',
        admin_key_masked: config.admin_key ? maskSecret(config.admin_key) : '',
        has_admin_key: Boolean(config.admin_key),
        group_ids: config.group_ids || [],
        upload_defaults: config.upload_defaults || {},
        join_auto_upload: Boolean(config.join_auto_upload),
        monitor: config.monitor || {},
      };
    }

    function validateConfigInput(body) {
      const baseUrl = String(body.base_url || '').trim().replace(/\/+$/, '');
      if (baseUrl) {
        let parsed;
        try {
          parsed = new URL(baseUrl);
        } catch {
          throw errors.validation('sub2api 后端地址格式不正确');
        }
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          throw errors.validation('sub2api 后端地址必须使用 HTTP 或 HTTPS');
        }
      }
      return body;
    }

    app.get('/api/v1/sub2api/config', async () => configView());

    function normalizeUploadDefaults(input = {}) {
      const num = (v) => {
        if (v === '' || v === null || v === undefined) return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      };
      return {
        concurrency: num(input.concurrency),
        load_factor: num(input.load_factor),
        priority: num(input.priority),
        model_whitelist: Array.isArray(input.model_whitelist)
          ? input.model_whitelist.map(String).map((s) => s.trim()).filter(Boolean)
          : [],
        disable_auto_pause_5h: Boolean(input.disable_auto_pause_5h),
        disable_auto_pause_7d: Boolean(input.disable_auto_pause_7d),
        enable_long_context_billing: input.enable_long_context_billing !== false,
        auto_select_proxy: input.auto_select_proxy !== false,
        proxy_id: Number.isSafeInteger(Number(input.proxy_id)) && Number(input.proxy_id) > 0
          ? Number(input.proxy_id)
          : null,
      };
    }

    app.put('/api/v1/sub2api/config', async (request) => {
      validateConfigInput(request.body || {});
      const current = app.settings.get(CONFIG_KEY) || {};
      const body = request.body || {};
      const adminKeyInput = String(body.admin_key ?? '').trim();
      const nextAdminKey =
        !adminKeyInput || adminKeyInput === '****' ? current.admin_key || '' : adminKeyInput;
      const next = {
        base_url: String(body.base_url ?? current.base_url ?? '').trim().replace(/\/+$/, ''),
        admin_key: nextAdminKey,
        group_ids: Array.isArray(body.group_ids)
          ? body.group_ids.map(Number).filter((v) => Number.isSafeInteger(v) && v > 0)
          : current.group_ids || [],
        upload_defaults: normalizeUploadDefaults(body.upload_defaults ?? current.upload_defaults ?? {}),
        join_auto_upload: body.join_auto_upload ?? Boolean(current.join_auto_upload),
        monitor: body.monitor || current.monitor || {},
      };
      app.settings.set(CONFIG_KEY, next);
      monitor.startIfEnabled();
      return { config: configView() };
    });

    app.post('/api/v1/sub2api/test', async (request) => {
      const body = request.body || {};
      const current = app.settings.get(CONFIG_KEY) || {};
      const override =
        body.base_url || body.admin_key
          ? {
              base_url: String(body.base_url || current.base_url || '').trim().replace(/\/+$/, ''),
              admin_key: String(body.admin_key || current.admin_key || '').trim(),
            }
          : null;
      try {
        return await client.testConnection(override);
      } catch (error) {
        if (error.code === 'SUB2API_NOT_CONFIGURED') throw error;
        throw errors.sub2apiUnavailable(error.message);
      }
    });

    app.get('/api/v1/sub2api/groups', async () => {
      const payload = await client.listGroups();
      const groups = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
      return {
        items: groups.map((group) => ({ id: group.id, name: group.name, status: group.status ?? 'active' })),
      };
    });

    app.get('/api/v1/sub2api/proxies', async () => {
      const payload = await client.listProxies({ withCount: true });
      const proxies = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
      return {
        items: proxies.map((proxy) => ({
          id: proxy.id,
          name: proxy.name,
          protocol: proxy.protocol,
          host: proxy.host,
          port: proxy.port,
          ip_address: proxy.ip_address ?? null,
          status: proxy.status ?? 'active',
          account_count: Number(proxy.account_count ?? 0) || 0,
        })),
      };
    });

    // 一键更换代理 IP：创建新代理 → 旧代理上的账号随机均分改绑 → 删除旧代理
    app.post(
      '/api/v1/sub2api/proxies/replace',
      {
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['text'],
            properties: {
              text: { type: 'string', minLength: 1 },
              protocol: { type: 'string', enum: ['http', 'https', 'socks5', 'socks5h'] },
              delete_old: { type: 'boolean' },
            },
          },
        },
      },
      async (request) =>
        replaceProxies({
          text: request.body.text,
          protocol: request.body.protocol || 'http',
          deleteOld: request.body.delete_old !== false,
        }),
    );

    app.get('/api/v1/sub2api/remote-accounts', async (request) => {
      const email = String(request.query.email || '').trim().toLowerCase();
      if (!email) throw errors.validation('email 参数不能为空');
      const accounts = await client.listAllOpenAiAccounts();
      const found = accounts.find((acc) => client.accountEmail(acc) === email);
      if (!found) return { found: false, account: null };
      return {
        found: true,
        account: {
          id: found.id,
          name: found.name,
          status: found.status,
          error_message: found.error_message ?? null,
          group_ids: found.group_ids ?? [],
          proxy_id: found.proxy_id ?? null,
        },
      };
    });

    // 手动同步远端状态：回填 sub2api_account_id + 镜像远端真实 status（巡检每轮也会自动同步）
    app.post('/api/v1/sub2api/sync-remote', async (request, reply) => {
      const config = app.settings.get(CONFIG_KEY);
      if (!config?.base_url || !config?.admin_key) {
        throw Object.assign(new Error('请先配置 sub2api'), { status: 422, code: 'SUB2API_NOT_CONFIGURED' });
      }
      const result = await remoteSync.syncRemoteStatus();
      reply.code(200);
      return { ok: true, ...result };
    });

    app.get('/api/v1/sub2api/monitor', async () => monitor.view());

    app.get('/api/v1/sub2api/monitor/logs', async (request) => {
      const limit = Math.min(100, Math.max(1, Number.parseInt(request.query.limit || '20', 10) || 20));
      return { items: monitor.recentLogs(limit) };
    });

    app.post('/api/v1/sub2api/monitor', async (request) => {
      const body = request.body || {};
      const current = app.settings.get(CONFIG_KEY) || {};
      const nextMonitor = { ...(current.monitor || {}) };
      for (const key of [
        'enabled',
        'interval_minutes',
        'cooldown_minutes',
        'auto_repair',
        'max_repair_attempts',
        'auto_replenish',
        'refresh_balance',
        'balance_refresh_interval_minutes',
        'reserve_threshold',
        'main_stock_threshold',
        'replenish_mode',
        'concurrency_target',
        'initial_balance_target',
        'replenish_upload_order',
        'replenish_join_order',
        'pause_on_discard',
        'rate_limit_reset_threshold_hours',
        'banned_patterns',
        'rate_limit_patterns',
      ]) {
        if (body[key] !== undefined) nextMonitor[key] = body[key];
      }
      // resource 口径校验：至少一项目标 > 0；并发目标 > 0 时必须先配置上传默认每号并发，
      // 否则在架号并发恒计 0、缺口永远存在，会持续烧备用池
      if (nextMonitor.replenish_mode === 'resource') {
        const concTarget = Math.max(0, Number(nextMonitor.concurrency_target) || 0);
        const balTarget = Math.max(0, Number(nextMonitor.initial_balance_target) || 0);
        if (concTarget <= 0 && balTarget <= 0) {
          throw errors.validation('resource 口径下「总并发保底」和「初始总余额保底」至少设置一项');
        }
        if (concTarget > 0 && !(Number(current.upload_defaults?.concurrency) > 0)) {
          throw errors.validation('设置总并发保底前，请先在「上传默认」中配置每号并发');
        }
      }
      app.settings.set(CONFIG_KEY, { ...current, monitor: nextMonitor });
      monitor.startIfEnabled();
      return monitor.view();
    });

    app.post('/api/v1/sub2api/monitor/check', async (request, reply) => {
      const view = await monitor.runCheck({ source: 'manual' });
      reply.code(202);
      return { ok: true, monitor: view };
    });

    // 上传入口（主号池批量上传路由在 accounts 模块注册，这里注册复用实现）
    app.decorate('runUpload', async (ids, options) => uploader.uploadAccounts(ids, options));
  };
}
