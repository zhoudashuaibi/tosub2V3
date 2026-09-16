import fs from 'node:fs';
import path from 'node:path';
import { cleanupFinishedJobs, parsePagination } from '../../lib/db.js';
import { errors } from '../../lib/http-errors.js';

/** 列表里的错误摘要长度：足够看出原因，又不至于让轮询响应体膨胀。 */
const ERROR_SUMMARY_MAX = 120;

function truncateError(message) {
  const text = String(message);
  return text.length <= ERROR_SUMMARY_MAX ? text : `${text.slice(0, ERROR_SUMMARY_MAX)}…`;
}

export function createJobsModule({ engine }) {
  return async function jobsModule(app) {
    const db = app.db;

    /**
     * 任务行 → 视图对象。
     *
     * 输入必须来自 listJobsQuery 的 LEFT JOIN 结果（含 account_email / proxy_display_url），
     * 这样一页 N 行只需 1 条 SQL，而不是每行 2 次额外查询（原 2N+1 在 2s 轮询下是热点）。
     */
    function jobView(row, { detail = false } = {}) {
      const active = ['queued', 'running', 'awaiting_input'].includes(row.status);
      const error = row.error ?? null;
      return {
        id: row.id,
        account_id: row.account_id,
        email: row.account_email ?? null,
        type: row.type,
        status: row.status,
        stage: row.stage,
        prompt_kind: row.prompt_kind,
        attempt: row.attempt,
        proxy_id: row.proxy_id,
        // 本机代理（proxy_id join）优先；余额任务走 sub2api 绑定代理时记录在 proxy_label
        proxy_display: row.proxy_display_url ?? row.proxy_label ?? null,
        has_error: Boolean(error),
        // 列表只带摘要：error 最长 2000 字符，200 行 × 2s 轮询纯属浪费带宽
        error_summary: error ? truncateError(error) : null,
        ...(detail ? { error } : {}),
        created_at: row.created_at,
        started_at: row.started_at,
        finished_at: row.finished_at,
        has_result: Boolean(row.result_path),
        can_cancel: active,
        can_retry: !active,
      };
    }

    const LIST_COLUMNS = `j.*, a.email AS account_email, p.display_url AS proxy_display_url`;

    /** 列表与详情共用的 JOIN 查询（单条 SQL，取代 jobView 里的逐行查询）。 */
    function selectJobs(where, orderLimit = '') {
      return db.prepare(
        `SELECT ${LIST_COLUMNS}
           FROM jobs j
           LEFT JOIN accounts a ON a.id = j.account_id
           LEFT JOIN proxies  p ON p.id = j.proxy_id
           ${where} ${orderLimit}`,
      );
    }

    /** 把 query 里的筛选条件翻译成 WHERE 子句（列表与筛选感知 stats 共用）。 */
    function buildJobFilters(query) {
      const filters = [];
      const params = [];
      if (query.status) {
        // active 是前端聚合页签：排队/进行中/待输入
        if (query.status === 'active') {
          filters.push("j.status IN ('queued','running','awaiting_input')");
        } else {
          filters.push('j.status = ?');
          params.push(String(query.status));
        }
      }
      if (query.type) {
        filters.push('j.type = ?');
        params.push(String(query.type));
      }
      if (query.account_id) {
        filters.push('j.account_id = ?');
        params.push(Number(query.account_id));
      }
      if (query.q) {
        filters.push('a.email LIKE ?');
        params.push(`%${String(query.q)}%`);
      }
      return { where: filters.length ? `WHERE ${filters.join(' AND ')}` : '', params };
    }

    app.get('/api/v1/jobs', async (request) => {
      const { page, pageSize, offset } = parsePagination(request.query);
      const { where, params } = buildJobFilters(request.query);
      // 全局「待输入提醒」只需要计数，不需要任何任务行；
      // 历史任务页只需要行，不需要每次重算 stats。用两个开关避免做无用的那部分。
      const wantItems = request.query.stats_only !== '1';
      const wantStats = request.query.items_only !== '1';

      const total = db
        .prepare(`SELECT COUNT(*) AS n FROM jobs j LEFT JOIN accounts a ON a.id = j.account_id ${where}`)
        .get(...params).n;

      const items = wantItems
        ? selectJobs(where, 'ORDER BY j.created_at DESC, j.id DESC LIMIT ? OFFSET ?')
            .all(...params, pageSize, offset)
            .map((row) => jobView(row))
        : [];

      // 筛选感知：页签切换到「失败」时不该再显示全局排队数；一次 GROUP BY 取代 3 次 COUNT
      const stats = { queued: 0, running: 0, awaiting_input: 0 };
      if (wantStats) {
        for (const row of db
          .prepare(
            `SELECT j.status AS status, COUNT(*) AS n FROM jobs j LEFT JOIN accounts a ON a.id = j.account_id ${where} GROUP BY j.status`,
          )
          .all(...params)) {
          if (row.status in stats) stats[row.status] = row.n;
        }
      }

      return { items, total, page, page_size: pageSize, stats };
    });

    app.get('/api/v1/jobs/:id', async (request) => {
      const row = selectJobs('WHERE j.id = ?').get(request.params.id);
      if (!row) throw errors.notFound('任务不存在');
      const view = jobView(row, { detail: true });
      view.has_result =
        (row.result_path && fs.existsSync(path.resolve(app.config.dataDir, row.result_path))) ||
        (row.result_path && fs.existsSync(row.result_path)) ||
        fs.existsSync(path.resolve(app.config.dataDir, 'results', `${row.id}.json`));
      view.can_download = view.has_result && row.status === 'completed';
      if (view.can_download) view.result_path = row.result_path || `results/${row.id}.json`;
      return view;
    });

    app.get('/api/v1/jobs/:id/logs', async (request) => {
      const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(request.params.id);
      if (!row) throw errors.notFound('任务不存在');
      const logPath = path.resolve(app.config.dataDir, row.log_path);
      const after = Math.max(0, Number.parseInt(request.query.after || '0', 10) || 0);
      const limit = Math.min(256 * 1024, Math.max(1024, Number.parseInt(request.query.limit || '65536', 10) || 65536));
      let chunk = '';
      let nextOffset = after;
      let eof = true;
      try {
        const stat = fs.statSync(logPath);
        if (stat.size > after) {
          const fd = fs.openSync(logPath, 'r');
          try {
            const length = Math.min(limit, stat.size - after);
            const buffer = Buffer.alloc(length);
            fs.readSync(fd, buffer, 0, length, after);
            chunk = buffer.toString('utf8');
            nextOffset = after + length;
          } finally {
            fs.closeSync(fd);
          }
        }
        eof = nextOffset >= stat.size;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      return { chunk, next_offset: nextOffset, eof };
    });

    app.get('/api/v1/jobs/:id/result', async (request, reply) => {
      const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(request.params.id);
      if (!row) throw errors.notFound('任务不存在');
      const candidates = [
        row.result_path && path.resolve(app.config.dataDir, row.result_path),
        path.resolve(app.config.dataDir, 'results', `${row.id}.json`),
      ].filter(Boolean);
      const found = candidates.find((p) => fs.existsSync(p));
      if (!found) throw errors.notFound('任务产物不存在');
      reply.header('content-type', 'application/json');
      reply.header('content-disposition', `attachment; filename="${row.id}.json"`);
      return reply.send(fs.createReadStream(found));
    });

    app.post('/api/v1/jobs/:id/cancel', async (request) => {
      const job = await engine.cancel(request.params.id);
      return { job: jobView(job) };
    });

    app.post('/api/v1/jobs/:id/retry', async (request, reply) => {
      const proxyId = request.body?.proxy_id ? Number(request.body.proxy_id) : null;
      const job = engine.retry(request.params.id, { proxyId });
      reply.code(202);
      return { job: jobView(job) };
    });

    app.post('/api/v1/jobs/cancel-all', async () => {
      const canceled = await engine.cancelAll();
      return { canceled };
    });

    // 手动清理：删除 N 天前结束的终态任务（任务默认全量保留，不自动清理）
    app.post(
      '/api/v1/jobs/cleanup',
      {
        schema: {
          body: {
            type: 'object',
            required: ['days'],
            additionalProperties: false,
            properties: {
              days: { type: 'integer', minimum: 0, maximum: 3650 },
            },
          },
        },
      },
      async (request) => {
        const deleted = cleanupFinishedJobs(db, app.config.dataDir, request.body.days);
        return { deleted };
      },
    );
  };
}
