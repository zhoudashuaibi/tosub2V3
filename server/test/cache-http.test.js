/**
 * HTTP 缓存契约测试：/api/v1 的 ETag/304，以及静态资源的 Cache-Control。
 *
 * 背景：前端按固定间隔轮询列表，未改动时应当变成空响应 304，而不是每 2s 重传整份 JSON。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import compress from '@fastify/compress';
import { createCacheHeaders, etagFor, etagMatches } from '../lib/cache-headers.js';
import { createStaticModule } from '../modules/static/index.js';

/** 造一个足够大的 JSON 响应（超过 MIN_ETAG_BYTES）。 */
function bigBody(seed = 0) {
  return { items: Array.from({ length: 60 }, (_, i) => ({ id: i, email: `user-${i}-${seed}@test.local` })), total: 60 };
}

async function setup(t) {
  const app = Fastify();
  let seed = 0;
  // 顺序关键：compress 通过 onRoute 逐个路由挂压缩钩子，
  // 必须在路由定义之前注册，否则后定义的路由不会压缩。
  await app.register(compress, { global: true, threshold: 1024 });
  // 直接调用而非 app.register：模块的 onSend 钩子需要挂在根实例上
  // （app.register 会新建封装作用域，同级路由看不到该钩子）
  await createCacheHeaders()(app);

  app.get('/api/v1/big', async () => bigBody(seed));
  app.get('/api/v1/small', async () => ({ ok: true }));
  app.get('/api/v1/change', async (request) => {
    seed = Number(request.query.seed ?? seed);
    return bigBody(seed);
  });
  app.get('/api/v1/download', async (request, reply) => {
    reply.header('content-disposition', 'attachment; filename="x.json"');
    return bigBody(0);
  });
  app.get('/api/v1/missing', async (request, reply) => reply.code(404).send({ error: { code: 'NOT_FOUND' } }));
  app.get('/other/big', async () => bigBody(0));
  await app.ready();
  t.after(() => app.close());
  return app;
}

test('大于阈值且内容未变：第二次带 If-None-Match 返回 304', async (t) => {
  const app = await setup(t);
  const first = await app.inject('/api/v1/big');
  assert.equal(first.statusCode, 200);
  const etag = first.headers.etag;
  assert.ok(etag, '应带 etag 头');
  assert.match(etag, /^W\/"[A-Za-z0-9_-]+"$/);
  assert.equal(first.headers.vary, 'accept-encoding');

  const second = await app.inject({ url: '/api/v1/big', headers: { 'if-none-match': etag } });
  assert.equal(second.statusCode, 304);
  assert.equal(second.body, '');
  assert.equal(second.headers.etag, etag);
});

test('内容变化 → ETag 变化 → 不返回 304', async (t) => {
  const app = await setup(t);
  const before = await app.inject('/api/v1/big');
  const changed = await app.inject('/api/v1/change?seed=1');
  assert.notEqual(changed.headers.etag, before.headers.etag);

  const conditional = await app.inject({
    url: '/api/v1/change?seed=1',
    headers: { 'if-none-match': before.headers.etag },
  });
  assert.equal(conditional.statusCode, 200);
  assert.equal(conditional.json().items[0].email, 'user-0-1@test.local');
});

test('小响应不参与 ETag（节省哈希开销）', async (t) => {
  const app = await setup(t);
  const response = await app.inject('/api/v1/small');
  assert.equal(response.headers.etag, undefined);
  assert.equal(response.statusCode, 200);
});

test('非 /api/v1 路径、非 200 响应、附件下载都不参与 ETag', async (t) => {
  const app = await setup(t);
  assert.equal((await app.inject('/other/big')).headers.etag, undefined);
  assert.equal((await app.inject('/api/v1/missing')).headers.etag, undefined);
  assert.equal((await app.inject('/api/v1/download')).headers.etag, undefined);
});

test('If-None-Match 支持列表与 * 与弱比较', () => {
  const etag = etagFor('payload');
  assert.ok(etagMatches(`"other", ${etag}`, etag));
  assert.ok(etagMatches(`W/"other",${etag}`, etag));
  assert.ok(etagMatches('*', etag));
  // 去掉弱前缀后仍应命中
  assert.ok(etagMatches(etag.replace(/^W\//, ''), etag));
  assert.ok(!etagMatches('W/"nope"', etag));
  assert.ok(!etagMatches('', etag));
  assert.ok(!etagMatches(undefined, etag));
});

test('大 JSON 响应启用压缩（br/gzip）', async (t) => {
  const app = await setup(t);
  const gzip = await app.inject({ url: '/api/v1/big', headers: { 'accept-encoding': 'gzip' } });
  assert.equal(gzip.headers['content-encoding'], 'gzip');

  const br = await app.inject({ url: '/api/v1/big', headers: { 'accept-encoding': 'br' } });
  assert.equal(br.headers['content-encoding'], 'br');

  // 304 路径不应被压缩器干扰：内容为空且状态正确
  const conditional = await app.inject({
    url: '/api/v1/big',
    headers: { 'accept-encoding': 'gzip', 'if-none-match': gzip.headers.etag },
  });
  assert.equal(conditional.statusCode, 304);
  assert.equal(conditional.body, '');
});

test('静态资源：哈希产物 immutable，index.html no-cache', async (t) => {
  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tosub2-web-'));
  fs.mkdirSync(path.join(distDir, 'assets'));
  fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><div id="root"></div>');
  fs.writeFileSync(path.join(distDir, 'assets', 'index-abc123.js'), 'console.log(1)');

  const app = Fastify();
  await createStaticModule({ config: { webDist: distDir }, logger: { warn() {} } })(app);
  await app.ready();
  t.after(async () => {
    await app.close();
    fs.rmSync(distDir, { recursive: true, force: true });
  });

  const asset = await app.inject('/assets/index-abc123.js');
  assert.equal(asset.statusCode, 200);
  assert.equal(asset.headers['cache-control'], 'public, max-age=31536000, immutable');

  const html = await app.inject('/');
  assert.equal(html.statusCode, 200);
  assert.equal(html.headers['cache-control'], 'no-cache');

  // SPA fallback 也要 no-cache，否则发版后仍加载旧产物
  const spa = await app.inject('/pools/main');
  assert.equal(spa.statusCode, 200);
  assert.equal(spa.headers['cache-control'], 'no-cache');

  const api404 = await app.inject('/api/v1/nope');
  assert.equal(api404.statusCode, 404);
  assert.equal(api404.headers['cache-control'], 'no-store');
});
