import { errors } from '../../lib/http-errors.js';
import { parsePagination } from '../../lib/db.js';
import { normalizeCodexFingerprintMode } from '../sub2api/upload.js';
import { createRedeemClient } from './redeem-client.js';
import { createTeamService } from './service.js';
import { createTeamUploader } from './upload.js';

const CONFIG_KEY = 'team.config';
const CARD_STATUSES = ['unextracted', 'healthy', 'need_reclaim', 'cannot_reclaim', 'mixed'];
const ACCOUNT_HEALTH_STATUSES = ['healthy', 'need_reclaim', 'cannot_reclaim', 'unknown'];
const MAX_UPLOAD_ACCOUNTS = 500;

export function createTeamModule({ logger }) {
  return async function teamModule(app) {
    const db = app.db;
    const redeemClient = createRedeemClient(() => app.settings.get(CONFIG_KEY)?.redeem_base_url);
    const uploader = createTeamUploader({
      db,
      crypto: app.crypto,
      client: app.sub2apiClient,
      getSub2apiConfig: () => app.settings.get('sub2api.config'),
      getTeamConfig: () => app.settings.get(CONFIG_KEY),
      logger,
    });
    const service = createTeamService({
      db,
      crypto: app.crypto,
      redeemClient,
      getTeamConfig: () => app.settings.get(CONFIG_KEY),
      uploader,
      logger,
    });

    function parseHealthJson(raw) {
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    }

    function cardView(row) {
      return { ...row, health: parseHealthJson(row.health) };
    }

    function cardStats() {
      const rows = db.prepare('SELECT status, COUNT(*) AS n FROM team_cards GROUP BY status').all();
      const byStatus = Object.fromEntries(rows.map((r) => [r.status, r.n]));
      return {
        total: rows.reduce((sum, r) => sum + r.n, 0),
        unextracted: byStatus.unextracted ?? 0,
        healthy: byStatus.healthy ?? 0,
        need_reclaim: byStatus.need_reclaim ?? 0,
        cannot_reclaim: byStatus.cannot_reclaim ?? 0,
        mixed: byStatus.mixed ?? 0,
      };
    }

    function accountStats() {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS total,
             SUM(CASE WHEN health_status = 'healthy' THEN 1 ELSE 0 END) AS healthy,
             SUM(CASE WHEN health_status = 'need_reclaim' THEN 1 ELSE 0 END) AS need_reclaim,
             SUM(CASE WHEN sub2api_account_id IS NOT NULL THEN 1 ELSE 0 END) AS uploaded
           FROM team_accounts`,
        )
        .get();
      return {
        total: row.total ?? 0,
        healthy: row.healthy ?? 0,
        need_reclaim: row.need_reclaim ?? 0,
        uploaded: row.uploaded ?? 0,
      };
    }

    // ---- 卡密 ----

    app.get('/api/v1/team/cards', async (request) => {
      const { page, pageSize, offset } = parsePagination(request.query);
      const status = String(request.query.status || '').trim();
      const q = String(request.query.q || '').trim();
      const where = [];
      const params = [];
      if (CARD_STATUSES.includes(status)) {
        where.push('c.status = ?');
        params.push(status);
      }
      if (q) {
        where.push('c.card_code LIKE ?');
        params.push(`%${q}%`);
      }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const total = db.prepare(`SELECT COUNT(*) AS n FROM team_cards c ${whereSql}`).get(...params).n;
      const items = db
        .prepare(
          `SELECT c.*,
             (SELECT COUNT(*) FROM team_accounts a WHERE a.card_id = c.id) AS account_count,
             (SELECT COUNT(*) FROM team_accounts a WHERE a.card_id = c.id AND a.sub2api_account_id IS NOT NULL) AS uploaded_count
           FROM team_cards c ${whereSql}
           ORDER BY c.updated_at DESC, c.id DESC LIMIT ? OFFSET ?`,
        )
        .all(...params, pageSize, offset)
        .map(cardView);
      return { items, total, page, page_size: pageSize, stats: cardStats() };
    });

    app.post(
      '/api/v1/team/cards/import',
      {
        schema: {
          body: {
            type: 'object',
            required: ['text'],
            properties: { text: { type: 'string', minLength: 1 } },
          },
        },
      },
      async (request, reply) => {
        const result = service.importCards(request.body.text);
        reply.code(result.imported ? 201 : 200);
        return result;
      },
    );

    app.post(
      '/api/v1/team/cards/batch-delete',
      {
        schema: {
          body: {
            type: 'object',
            required: ['ids'],
            properties: { ids: { type: 'array', items: { type: 'integer' }, minItems: 1, maxItems: 1000 } },
          },
        },
      },
      async (request) => service.deleteCards(request.body.ids),
    );

    // ---- 账号 ----

    app.get('/api/v1/team/accounts', async (request) => {
      const { page, pageSize, offset } = parsePagination(request.query);
      const status = String(request.query.status || '').trim();
      const uploaded = String(request.query.uploaded || '').trim();
      const cardId = Number.parseInt(request.query.card_id || '', 10);
      const q = String(request.query.q || '').trim();
      const where = [];
      const params = [];
      if (ACCOUNT_HEALTH_STATUSES.includes(status)) {
        where.push('a.health_status = ?');
        params.push(status);
      }
      // 同时接受 '1'/'0' 与 'true'/'false'：号池接口用的是后者，
      // 前端两处可共用同一个筛选控件，差异在服务端抹平而不是让调用方记住。
      if (['1', 'true'].includes(uploaded)) {
        where.push('a.sub2api_account_id IS NOT NULL');
      } else if (['0', 'false'].includes(uploaded)) {
        where.push('a.sub2api_account_id IS NULL');
      }
      if (Number.isSafeInteger(cardId) && cardId > 0) {
        where.push('a.card_id = ?');
        params.push(cardId);
      }
      if (q) {
        where.push('(a.email LIKE ? OR a.short_name LIKE ? OR c.card_code LIKE ?)');
        params.push(`%${q}%`, `%${q}%`, `%${q}%`);
      }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const total = db
        .prepare(`SELECT COUNT(*) AS n FROM team_accounts a JOIN team_cards c ON c.id = a.card_id ${whereSql}`)
        .get(...params).n;
      const items = db
        .prepare(
          `SELECT a.id, a.card_id, c.card_code, a.email, a.short_name, a.name, a.health_status,
             a.sub2api_account_id, a.sub2api_uploaded_at, a.created_at, a.updated_at
           FROM team_accounts a JOIN team_cards c ON c.id = a.card_id ${whereSql}
           ORDER BY a.updated_at DESC, a.id DESC LIMIT ? OFFSET ?`,
        )
        .all(...params, pageSize, offset);
      return { items, total, page, page_size: pageSize, stats: accountStats() };
    });

    app.get('/api/v1/team/stats', async () => ({ cards: cardStats(), accounts: accountStats() }));

    // ---- 会话（健康检查 / 提取找回 / 状态轮询） ----

    app.post(
      '/api/v1/team/health-check',
      {
        schema: {
          body: {
            type: 'object',
            required: ['ids'],
            properties: { ids: { type: 'array', items: { type: 'integer' }, minItems: 1, maxItems: 1000 } },
          },
        },
      },
      async (request, reply) => {
        const session = service.startHealthCheck(request.body.ids);
        reply.code(202);
        return { session };
      },
    );

    app.post(
      '/api/v1/team/reclaim',
      {
        schema: {
          body: {
            type: 'object',
            required: ['ids', 'mode'],
            properties: {
              ids: { type: 'array', items: { type: 'integer' }, minItems: 1, maxItems: 1000 },
              mode: { type: 'string', enum: ['401', 'all'] },
            },
          },
        },
      },
      async (request, reply) => {
        const session = service.startReclaim(request.body.ids, request.body.mode);
        reply.code(202);
        return { session };
      },
    );

    app.get('/api/v1/team/session', async () => service.view());

    // ---- 上传 ----

    app.post(
      '/api/v1/team/upload',
      {
        schema: {
          body: {
            type: 'object',
            required: ['account_ids'],
            properties: {
              account_ids: { type: 'array', items: { type: 'integer' }, minItems: 1, maxItems: MAX_UPLOAD_ACCOUNTS },
            },
          },
        },
      },
      async (request) => {
        const session = service.view();
        if (session.running && session.kind === 'reclaim') {
          throw errors.conflict('提取/找回会话进行中，请等待完成后再上传', 'TEAM_SESSION_BUSY');
        }
        const sub2apiConfig = app.settings.get('sub2api.config');
        if (!sub2apiConfig?.base_url || !sub2apiConfig?.admin_key) {
          throw errors.validation('请先在「Sub2API」页配置后端地址与管理员密钥');
        }
        return uploader.uploadTeamAccounts(request.body.account_ids);
      },
    );

    // ---- 配置 ----

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
        codex_fingerprint_mode: normalizeCodexFingerprintMode(input.codex_fingerprint_mode),
        auto_select_proxy: input.auto_select_proxy !== false,
        proxy_id:
          Number.isSafeInteger(Number(input.proxy_id)) && Number(input.proxy_id) > 0 ? Number(input.proxy_id) : null,
      };
    }

    function configView() {
      const config = app.settings.get(CONFIG_KEY) || {};
      return {
        redeem_base_url: config.redeem_base_url || 'https://30d.team',
        auto_upload_after_reclaim: config.auto_upload_after_reclaim !== false,
        group_ids: config.group_ids || [],
        upload_defaults: config.upload_defaults || {},
      };
    }

    app.get('/api/v1/team/config', async () => configView());

    app.put('/api/v1/team/config', async (request) => {
      const body = request.body || {};
      const current = app.settings.get(CONFIG_KEY) || {};
      let baseUrl = String(body.redeem_base_url ?? current.redeem_base_url ?? 'https://30d.team')
        .trim()
        .replace(/\/+$/, '');
      if (baseUrl) {
        try {
          const parsed = new URL(baseUrl);
          if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('bad protocol');
        } catch {
          throw errors.validation('兑换服务地址格式不正确（需 http/https）');
        }
      }
      const next = {
        redeem_base_url: baseUrl,
        auto_upload_after_reclaim:
          body.auto_upload_after_reclaim ?? (current.auto_upload_after_reclaim !== false),
        group_ids: Array.isArray(body.group_ids)
          ? body.group_ids.map(Number).filter((v) => Number.isSafeInteger(v) && v > 0)
          : current.group_ids || [],
        upload_defaults: normalizeUploadDefaults(body.upload_defaults ?? current.upload_defaults ?? {}),
      };
      app.settings.set(CONFIG_KEY, next);
      return { config: configView() };
    });
  };
}
