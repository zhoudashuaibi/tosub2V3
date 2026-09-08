import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { listMigrations } from '../lib/db.js';
import { createCrypto } from '../lib/crypto.js';
import { createProxiesModule } from '../modules/proxies/index.js';
import { TlsFingerprintTransport } from '../core/tls-transport.mjs';

async function setup(t) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const migration of listMigrations()) db.exec(migration.sql);
  const app = Fastify();
  app.decorate('db', db);
  app.decorate('crypto', createCrypto({ secretKeyEnv: 'local-proxy-test' }));
  // 不提供 settings 或 sub2api 服务，验证本机代理模块可独立运行。
  await createProxiesModule({ logger: { error() {} } })(app);
  await app.ready();
  t.after(async () => {
    await app.close();
    db.close();
  });
  return { app, db };
}

test('本机代理：独立导入、去重、筛选、备注、测活、选路和删除', async (t) => {
  const { app, db } = await setup(t);
  t.mock.method(TlsFingerprintTransport.prototype, 'configure', async () => {});
  t.mock.method(TlsFingerprintTransport.prototype, 'request', async () => new Response('ok'));
  t.mock.method(TlsFingerprintTransport.prototype, 'close', async () => {});
  const url = 'socks5h://local-user:local-secret@127.0.0.1:1080';
  const imported = await app.inject({ method: 'POST', url: '/api/v1/proxies/import', payload: {
    text: `${url}----first\n${url}----updated\nftp://127.0.0.1:21`,
  } });
  assert.equal(imported.statusCode, 201);
  assert.equal(imported.json().created, 1);
  assert.equal(imported.json().duplicates.length, 1);
  assert.equal(imported.json().invalid_lines.length, 1);
  assert.ok(!imported.body.includes('local-secret'));

  const listed = await app.inject('/api/v1/proxies?q=updated&status=unknown');
  assert.equal(listed.json().total, 1);
  assert.ok(!listed.body.includes('local-secret'));
  const id = listed.json().items[0].id;
  const edited = await app.inject({ method: 'PATCH', url: `/api/v1/proxies/${id}`, payload: { label: 'login' } });
  assert.equal(edited.json().label, 'login');
  const tested = await app.inject({ method: 'POST', url: '/api/v1/proxies/test', payload: { ids: [id] } });
  assert.equal(tested.statusCode, 202);
  assert.equal(tested.json().started, 1);
  for (let attempt = 0; attempt < 20; attempt++) {
    if (db.prepare('SELECT status FROM proxies WHERE id=?').get(id).status !== 'testing') break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(db.prepare('SELECT status FROM proxies WHERE id=?').get(id).status, 'alive');
  assert.deepEqual(app.proxySelector.pickRandomAliveProxy(), { id, url });
  const removed = await app.inject({ method: 'POST', url: '/api/v1/proxies/batch-delete', payload: { ids: [id] } });
  assert.equal(removed.json().deleted, 1);
  assert.equal((await app.inject('/api/v1/proxies')).json().total, 0);
  assert.deepEqual(app.proxySelector.pickRandomAliveProxy(), { id: null, url: null });
});

test('本机代理：不注册合并换 IP、巡检接口或巡检服务', async (t) => {
  const { app } = await setup(t);
  for (const [method, url] of [
    ['POST', '/api/v1/proxies/replace'],
    ['GET', '/api/v1/proxies/patrol'],
    ['POST', '/api/v1/proxies/patrol'],
    ['POST', '/api/v1/proxies/patrol/check'],
  ]) {
    const response = await app.inject({ method, url });
    assert.equal(response.statusCode, 404, `${method} ${url}`);
  }
  assert.equal(app.hasDecorator('proxyPatrol'), false);
});
