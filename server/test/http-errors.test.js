/**
 * 错误处理器契约测试。
 *
 * 重点覆盖回归：历史代码里 `Object.assign(new Error(msg), { status, code })` 不是 AppError，
 * 会一路落到 500 INTERNAL，导致前端写好的友好文案不可达（如 SUB2API_NOT_CONFIGURED）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { AppError, errors, registerErrorHandler } from '../lib/http-errors.js';

async function setup(t) {
  const app = Fastify();
  registerErrorHandler(app);

  const routes = {
    appError: () => {
      throw errors.sub2apiNotConfigured();
    },
    appErrorConflict: () => {
      throw errors.conflict('无可用代理（已开启禁止直连）', 'NO_ALIVE_PROXY');
    },
    // 旧的裸写法：必须被归一化，而不是 500
    legacyValidation: () => {
      throw Object.assign(new Error('不支持的接码平台'), { status: 422, code: 'VALIDATION' });
    },
    legacyNotConfigured: () => {
      throw Object.assign(new Error('请先配置 sub2api'), { status: 422, code: 'SUB2API_NOT_CONFIGURED' });
    },
    legacyStatusOnly: () => {
      throw Object.assign(new Error('自定义文案'), { statusCode: 409 });
    },
    // 5xx 与无状态错误仍然是内部错误，不能被误暴露
    legacyServerError: () => {
      throw Object.assign(new Error('上游炸了'), { status: 502, code: 'SUB2API_UNAVAILABLE' });
    },
    plainError: () => {
      throw new Error('内部细节不应外泄');
    },
    unknownReturn: () => {
      throw new Error('boom');
    },
    validation: () => {
      throw Object.assign(new Error('bad body'), {
        validation: [{ instancePath: '/email', message: 'must be string' }],
      });
    },
  };

  for (const [name, handler] of Object.entries(routes)) {
    app.get(`/${name}`, async (request, reply) => {
      try {
        handler();
      } catch (error) {
        // Fastify 的错误处理器只接管被 throw 到框架层的错误
        throw error;
      }
      return reply.code(200).send({ ok: true });
    });
  }

  await app.ready();
  t.after(() => app.close());
  return app;
}

test('AppError 按声明的状态与 code 暴露', async (t) => {
  const app = await setup(t);

  const notConfigured = await app.inject('/appError');
  assert.equal(notConfigured.statusCode, 422);
  assert.equal(notConfigured.json().error.code, 'SUB2API_NOT_CONFIGURED');
  assert.match(notConfigured.json().error.message, /sub2api/);

  const conflict = await app.inject('/appErrorConflict');
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().error.code, 'NO_ALIVE_PROXY');
});

test('非 AppError 的裸 4xx 错误被归一化（回归：不能变成 500）', async (t) => {
  const app = await setup(t);

  const validation = await app.inject('/legacyValidation');
  assert.equal(validation.statusCode, 422);
  assert.equal(validation.json().error.code, 'VALIDATION');
  assert.equal(validation.json().error.message, '不支持的接码平台');

  const notConfigured = await app.inject('/legacyNotConfigured');
  assert.equal(notConfigured.statusCode, 422);
  assert.equal(notConfigured.json().error.code, 'SUB2API_NOT_CONFIGURED');
});

test('只有 statusCode 没有 code 的裸 4xx：状态保留、code 回退 VALIDATION', async (t) => {
  const app = await setup(t);
  const response = await app.inject('/legacyStatusOnly');
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error.code, 'VALIDATION');
  assert.equal(response.json().error.message, '自定义文案');
});

test('5xx 与无状态错误仍然是 500 INTERNAL，不泄露内部信息', async (t) => {
  const app = await setup(t);

  const upstream = await app.inject('/legacyServerError');
  assert.equal(upstream.statusCode, 500);
  assert.equal(upstream.json().error.code, 'INTERNAL');
  assert.ok(!upstream.body.includes('上游炸了'));

  const plain = await app.inject('/plainError');
  assert.equal(plain.statusCode, 500);
  assert.equal(plain.json().error.code, 'INTERNAL');
  assert.equal(plain.json().error.message, '服务器内部错误');
  assert.ok(!plain.body.includes('内部细节不应外泄'));
});

test('schema 校验错误返回 422 VALIDATION 且带 details', async (t) => {
  const app = await setup(t);
  const response = await app.inject('/validation');
  assert.equal(response.statusCode, 422);
  const body = response.json();
  assert.equal(body.error.code, 'VALIDATION');
  assert.equal(body.error.details.length, 1);
  assert.equal(body.error.details[0].path, '/email');
});

test('错误工厂的默认值与 code 语义稳定', () => {
  assert.equal(errors.validation('x').status, 422);
  assert.equal(errors.validation('x').code, 'VALIDATION');
  assert.equal(errors.sub2apiNotConfigured().status, 422);
  assert.equal(errors.sub2apiNotConfigured().code, 'SUB2API_NOT_CONFIGURED');
  assert.equal(errors.sub2apiNotConfigured().message, '请先配置 sub2api 后端地址与管理员密钥');
  assert.ok(errors.notFound() instanceof AppError);
  assert.equal(errors.rateLimited(60).extra.retry_after_seconds, 60);
});
