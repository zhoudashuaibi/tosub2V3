/**
 * 任务列表查询契约测试。
 *
 * 重点覆盖：
 *  1. 回归 —— 列表不再对每行做 2 次额外查询（原 2N+1 在 2s 轮询下是热点），一页只发固定条 SQL
 *  2. 排序 tiebreaker —— 批量任务同毫秒 created_at 时翻页不重不漏
 *  3. 筛选感知 stats —— 切到「失败」页签不该再显示全局排队数
 *  4. 载荷瘦身 —— 列表只带 error_summary，详情才带完整 error
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { listMigrations } from '../lib/db.js';
import { registerErrorHandler } from '../lib/http-errors.js';
import { createJobsModule } from '../modules/jobs/index.js';

const LONG_ERROR = `${'x'.repeat(300)}TAIL_MARKER`;

/** 记录 prepare 次数的 db 包装：用来断言 SQL 条数不随行数增长。 */
function trackPrepare(db) {
  const counters = { prepare: 0, run: 0, get: 0, all: 0 };
  const wrapped = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === '__counters') return counters;
      if (prop === 'prepare') {
        return (sql) => {
          counters.prepare += 1;
          const stmt = target.prepare(sql);
          return new Proxy(stmt, {
            get(stmtTarget, stmtProp) {
              if (stmtProp === 'run' || stmtProp === 'get' || stmtProp === 'all') {
                return (...args) => {
                  counters[stmtProp] += 1;
                  return stmtTarget[stmtProp](...args);
                };
              }
              const value = stmtTarget[stmtProp];
              return typeof value === 'function' ? value.bind(stmtTarget) : value;
            },
          });
        };
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return wrapped;
}

function seed(db, rows = 5) {
  const now = new Date('2026-09-10T00:00:00.000Z').toISOString();
  db.prepare(
    `INSERT INTO accounts(id, email, pool, status, created_at, updated_at)
     VALUES(1, 'a@test.local', 'main', 'active', ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO proxies(id, url_enc, url_hash, display_url, protocol, status, created_at, updated_at)
     VALUES(1, 'enc', 'hash', 'http://proxy.test:8080', 'http', 'alive', ?, ?)`,
  ).run(now, now);

  const insert = db.prepare(
    `INSERT INTO jobs(id, account_id, type, status, stage, proxy_id, log_path, error, result_path, created_at, updated_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // 全部使用同一个 created_at：模拟批量建任务，验证 tiebreaker
  for (let i = 0; i < rows; i += 1) {
    insert.run(
      `job-${i}`,
      i % 2 === 0 ? 1 : null,
      i % 2 === 0 ? 'login' : 'balance',
      i < 2 ? 'queued' : i < 4 ? 'completed' : 'failed',
      'web_login',
      i % 2 === 0 ? 1 : null,
      `logs/job-${i}.log`,
      i === rows - 1 ? LONG_ERROR : i === 2 ? 'short error' : null,
      i === 2 ? `results/job-${i}.json` : null,
      now,
      now,
    );
  }
}

async function setup(t, { rows = 5 } = {}) {
  const raw = new Database(':memory:');
  raw.pragma('foreign_keys = ON');
  for (const migration of listMigrations()) raw.exec(migration.sql);
  seed(raw, rows);

  const db = trackPrepare(raw);
  const app = Fastify();
  app.decorate('db', db);
  app.decorate('config', { dataDir: process.cwd() });
  registerErrorHandler(app);
  await createJobsModule({ engine: {
    cancel: async () => {
      throw new Error('not used');
    },
    retry: () => ({}),
    cancelAll: async () => 0,
  } })(app);
  await app.ready();
  t.after(async () => {
    await app.close();
    raw.close();
  });
  return { app, raw, counters: db.__counters };
}

test('列表：SQL 条数固定，不随行数增长（回归 2N+1）', async (t) => {
  const small = await setup(t, { rows: 5 });
  const smallRes = await small.app.inject('/api/v1/jobs?page_size=50');
  assert.equal(smallRes.statusCode, 200);
  const smallPrepare = small.counters.prepare;

  const large = await setup(t, { rows: 40 });
  const largeRes = await large.app.inject('/api/v1/jobs?page_size=50');
  assert.equal(largeRes.statusCode, 200);

  assert.equal(largeRes.json().items.length, 40);
  assert.equal(
    large.counters.prepare,
    smallPrepare,
    `prepare 次数应与行数无关（5 行=${smallPrepare}，40 行=${large.counters.prepare}）`,
  );
  // 列表 = COUNT + 数据页 + stats GROUP BY
  assert.equal(smallPrepare, 3, '列表应只发 3 条 SQL');
});

test('列表：join 出邮箱与代理展示名，不再逐行查询', async (t) => {
  const { app } = await setup(t);
  const body = (await app.inject('/api/v1/jobs?page_size=50')).json();
  const linked = body.items.find((job) => job.account_id === 1);
  assert.equal(linked.email, 'a@test.local');
  assert.equal(linked.proxy_display, 'http://proxy.test:8080');

  const unlinked = body.items.find((job) => job.account_id === null);
  assert.equal(unlinked.email, null);
  assert.equal(unlinked.proxy_display, null);
});

test('列表：只带 error_summary，详情才带完整 error', async (t) => {
  const { app } = await setup(t);
  const body = (await app.inject('/api/v1/jobs?page_size=50')).json();
  const failed = body.items.find((job) => job.id === 'job-4');
  assert.equal(failed.has_error, true);
  assert.ok(failed.error_summary.length < LONG_ERROR.length);
  assert.ok(failed.error_summary.endsWith('…'));
  assert.ok(!('error' in failed), '列表不应返回完整 error 字段');
  assert.ok(!JSON.stringify(body).includes('TAIL_MARKER'), '列表响应体不应包含完整错误正文');

  const detail = await app.inject('/api/v1/jobs/job-4');
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().error, LONG_ERROR);
  assert.equal(detail.json().error_summary, failed.error_summary);
  assert.equal(detail.json().email, 'a@test.local');
});

test('排序：created_at 全部相同时用 id DESC 兜底，翻页不重不漏', async (t) => {
  const { app } = await setup(t, { rows: 10 });
  const pages = [];
  for (let page = 1; page <= 2; page += 1) {
    const body = (await app.inject(`/api/v1/jobs?page_size=5&page=${page}`)).json();
    assert.equal(body.total, 10);
    pages.push(...body.items.map((job) => job.id));
  }
  assert.equal(new Set(pages).size, 10, '两页合并后不应有重复 id');
  assert.deepEqual(pages, [
    'job-9', 'job-8', 'job-7', 'job-6', 'job-5',
    'job-4', 'job-3', 'job-2', 'job-1', 'job-0',
  ]);
});

test('stats：筛选感知，切到失败页签不再显示全局排队数', async (t) => {
  const { app } = await setup(t);
  const global = (await app.inject('/api/v1/jobs?page_size=50')).json().stats;
  assert.equal(global.queued, 2);
  assert.equal(global.running, 0);
  assert.equal(global.awaiting_input, 0);

  const failed = (await app.inject('/api/v1/jobs?status=failed')).json();
  assert.equal(failed.total, 1);
  assert.deepEqual(failed.stats, { queued: 0, running: 0, awaiting_input: 0 });

  const active = (await app.inject('/api/v1/jobs?status=active')).json();
  assert.equal(active.total, 2);
  assert.equal(active.stats.queued, 2);
});

test('筛选：q 走 join 的邮箱模糊匹配，type 精确匹配', async (t) => {
  const { app } = await setup(t);
  const byEmail = (await app.inject('/api/v1/jobs?q=test.local')).json();
  assert.equal(byEmail.total, 3, 'accounts 关联的 job：job-0 / job-2 / job-4');
  assert.ok(byEmail.items.every((job) => job.email === 'a@test.local'));

  const noMatch = (await app.inject('/api/v1/jobs?q=nobody@nowhere')).json();
  assert.equal(noMatch.total, 0);

  const byType = (await app.inject('/api/v1/jobs?type=balance')).json();
  assert.equal(byType.total, 2);
  assert.ok(byType.items.every((job) => job.type === 'balance'));
});

test('详情：不存在的任务返回 404 NOT_FOUND', async (t) => {
  const { app } = await setup(t);
  const response = await app.inject('/api/v1/jobs/nope');
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error.code, 'NOT_FOUND');
});
