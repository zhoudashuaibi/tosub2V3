import { parsePagination } from '../../lib/db.js';
import { errors } from '../../lib/http-errors.js';
import { normalizeProxyUrl } from '../../core/risk-control.mjs';
import { maskProxyUrl } from '../../lib/sanitize.js';
import { proxySupportsSessionRotation } from '../../core/tls-transport.mjs';
import { createProxySelector } from './selector.js';
import { createTestWorker } from './test-worker.js';

const PROTOCOLS = ['http:', 'https:', 'socks5:', 'socks5h:'];

export function createProxiesModule({ logger }) {
  return async function proxiesModule(app) {
    const db = app.db;
    const crypto = app.crypto;
    const selector = createProxySelector(db, crypto);
    const testWorker = createTestWorker({ logger });
    app.decorate('proxySelector', selector);

    function proxyView(row) {
      return {
        id: row.id,
        display_url: row.display_url,
        label: row.label,
        protocol: row.protocol,
        status: row.status,
        last_latency_ms: row.last_latency_ms,
        last_checked_at: row.last_checked_at,
        fail_count: row.fail_count,
        rotatable: Boolean(row.rotatable),
        last_error: row.last_error ? maskProxyUrl(row.last_error) : null,
        created_at: row.created_at,
      };
    }

    app.get('/api/v1/proxies', async (request) => {
      const { page, pageSize, offset } = parsePagination(request.query);
      const filters = [];
      const params = [];
      if (request.query.status) {
        filters.push('status = ?');
        params.push(String(request.query.status));
      }
      if (request.query.q) {
        filters.push('(label LIKE ? OR display_url LIKE ?)');
        params.push(`%${request.query.q}%`, `%${request.query.q}%`);
      }
      const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
      const total = db.prepare(`SELECT COUNT(*) AS n FROM proxies ${where}`).get(...params).n;
      const items = db
        .prepare(`SELECT * FROM proxies ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
        .all(...params, pageSize, offset);
      const statsRows = db.prepare(`SELECT status, COUNT(*) AS n FROM proxies GROUP BY status`).all();
      const stats = { alive: 0, dead: 0, cf_challenge: 0, unknown: 0, testing: 0 };
      for (const row of statsRows) stats[row.status] = row.n;
      return { items: items.map(proxyView), total, page, page_size: pageSize, stats };
    });

    app.post(
      '/api/v1/proxies/import',
      {
        schema: {
          body: {
            type: 'object',
            required: ['text'],
            additionalProperties: false,
            properties: { text: { type: 'string', maxLength: 2_000_000 } },
          },
        },
      },
      async (request, reply) => {
        const lines = String(request.body.text || '').split(/\r?\n/);
        let created = 0;
        const duplicates = [];
        const invalidLines = [];
        const now = new Date().toISOString();
        const tx = db.transaction(() => {
          lines.forEach((rawLine, index) => {
            const line = rawLine.trim();
            if (!line || line.startsWith('#')) return;
            const [rawUrl, label] = line.split('----').map((part) => part.trim());
            let normalized;
            try {
              normalized = normalizeProxyUrl(rawUrl);
            } catch (error) {
              invalidLines.push({ line: index + 1, reason: error.message });
              return;
            }
            let parsed;
            try {
              parsed = new URL(normalized);
            } catch {
              invalidLines.push({ line: index + 1, reason: 'URL 无法解析' });
              return;
            }
            if (!PROTOCOLS.includes(parsed.protocol)) {
              invalidLines.push({ line: index + 1, reason: `不支持的协议 ${parsed.protocol.replace(':', '')}` });
              return;
            }
            const urlHash = crypto.sha256Hex(normalized);
            const existing = db.prepare('SELECT id FROM proxies WHERE url_hash = ?').get(urlHash);
            if (existing) {
              if (label) {
                db.prepare('UPDATE proxies SET label=?, updated_at=? WHERE id=?').run(label, now, existing.id);
              }
              duplicates.push(maskProxyUrl(normalized));
              return;
            }
            db.prepare(
              `INSERT INTO proxies(url_enc, url_hash, display_url, protocol, label, status, rotatable, created_at, updated_at)
               VALUES(?,?,?,?,?,'unknown',?,?,?)`,
            ).run(
              crypto.encrypt(normalized, 'proxies.url_enc'),
              urlHash,
              maskProxyUrl(normalized),
              parsed.protocol.replace(':', ''),
              label || null,
              proxySupportsSessionRotation(normalized) ? 1 : 0,
              now,
              now,
            );
            created += 1;
          });
        });
        tx();
        reply.code(201);
        return { created, duplicates, invalid_lines: invalidLines };
      },
    );

    app.post(
      '/api/v1/proxies/test',
      {
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            properties: { ids: { type: 'array', items: { type: 'integer' }, maxItems: 2000 } },
          },
        },
      },
      async (request, reply) => {
        if (testWorker.isBusy()) throw errors.conflict('已有测活批次进行中', 'TEST_RUNNING');
        const ids = Array.isArray(request.body?.ids) && request.body.ids.length
          ? request.body.ids
          : null;
        const rows = ids
          ? db.prepare(`SELECT id, url_enc FROM proxies WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids)
          : db.prepare(`SELECT id, url_enc FROM proxies WHERE status != 'alive'`).all();
        const targets = rows
          .map((row) => ({ id: row.id, url: crypto.tryDecrypt(row.url_enc, 'proxies.url_enc') }))
          .filter((item) => item.url);
        if (!targets.length) {
          reply.code(202);
          return { started: 0 };
        }
        const now = new Date().toISOString();
        const markTx = db.transaction(() => {
          for (const target of targets) {
            db.prepare(`UPDATE proxies SET status='testing', updated_at=? WHERE id=?`).run(now, target.id);
          }
        });
        markTx();

        // 后台执行，结果逐条落库
        void (async () => {
          try {
            await testWorker.testProxies(targets, (id, result) => {
              const nowIso = new Date().toISOString();
              if (result.status === 'dead') {
                const row = db.prepare('SELECT consecutive_dead FROM proxies WHERE id=?').get(id);
                const consecutive = (row?.consecutive_dead || 0) + 1;
                db.prepare(
                  `UPDATE proxies SET status='dead', consecutive_dead=?, last_checked_at=?, last_latency_ms=NULL,
                     last_error=?, updated_at=? WHERE id=?`,
                ).run(consecutive, nowIso, result.error, nowIso, id);
              } else {
                db.prepare(
                  `UPDATE proxies SET status=?, consecutive_dead=0, last_checked_at=?, last_latency_ms=?,
                     last_error=NULL, updated_at=? WHERE id=?`,
                ).run(result.status, nowIso, result.latency, nowIso, id);
              }
            });
          } catch (error) {
            logger.error({ err: error.message }, 'proxy test batch failed');
            db.prepare(`UPDATE proxies SET status='unknown', updated_at=? WHERE status='testing'`).run(
              new Date().toISOString(),
            );
          }
        })();

        reply.code(202);
        return { started: targets.length };
      },
    );

    app.patch(
      '/api/v1/proxies/:id',
      {
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            properties: { label: { type: 'string', maxLength: 200 } },
          },
        },
      },
      async (request) => {
        const id = Number(request.params.id);
        const row = db.prepare('SELECT * FROM proxies WHERE id = ?').get(id);
        if (!row) throw errors.notFound('代理不存在');
        db.prepare('UPDATE proxies SET label=?, updated_at=? WHERE id=?').run(
          request.body.label ?? row.label,
          new Date().toISOString(),
          id,
        );
        return proxyView(db.prepare('SELECT * FROM proxies WHERE id = ?').get(id));
      },
    );

    app.delete('/api/v1/proxies/:id', async (request) => {
      const id = Number(request.params.id);
      const tx = db.transaction(() => {
        // jobs.proxy_id 外键无 ON DELETE 规则，先解除引用再删
        db.prepare('UPDATE jobs SET proxy_id = NULL WHERE proxy_id = ?').run(id);
        const result = db.prepare('DELETE FROM proxies WHERE id = ?').run(id);
        if (result.changes === 0) throw errors.notFound('代理不存在');
      });
      tx();
      return { ok: true };
    });

    app.post(
      '/api/v1/proxies/batch-delete',
      {
        schema: {
          body: {
            type: 'object',
            required: ['ids'],
            additionalProperties: false,
            properties: { ids: { type: 'array', items: { type: 'integer' }, maxItems: 2000 } },
          },
        },
      },
      async (request) => {
        const ids = request.body.ids;
        const tx = db.transaction(() => {
          for (const id of ids) {
            db.prepare('UPDATE jobs SET proxy_id = NULL WHERE proxy_id = ?').run(id);
            db.prepare('DELETE FROM proxies WHERE id = ?').run(id);
          }
        });
        tx();
        return { deleted: ids.length };
      },
    );
  };
}
