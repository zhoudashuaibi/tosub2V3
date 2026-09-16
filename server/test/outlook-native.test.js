import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {
  OUTLOOK_TOKEN_URL, OUTLOOK_MESSAGES_URL, OUTLOOK_SCOPE,
  fetchOutlookMessages, fetchReserveAccountMessages,
} from '../core/outlook-mail.mjs';
import { createSettingsModule } from '../modules/settings/index.js';
import { DEFAULT_SETTINGS } from '../lib/settings.js';
import { registerErrorHandler } from '../lib/http-errors.js';

const credentials = {
  email: 'mailbox@example.test', clientId: 'test-client', refreshToken: 'refresh-secret',
  password: 'unused-password', endpoint: 'https://retired-relay.example.test',
};

function nativeMessage(code, receivedAt, sender = 'noreply@openai.com') {
  return {
    Id: `message-${code}`, Subject: `Your ChatGPT code is ${code}`, BodyPreview: 'verification',
    Body: { Content: `<p>Your verification code is ${code}</p>`, ContentType: 'HTML' },
    From: { EmailAddress: { Name: 'OpenAI', Address: sender } },
    ReceivedDateTime: receivedAt, IsRead: false,
  };
}

function nativeFetch(messages = []) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url === OUTLOOK_TOKEN_URL) return Response.json({ access_token: 'access-secret' });
    assert.equal(new URL(url).origin + new URL(url).pathname, OUTLOOK_MESSAGES_URL);
    return Response.json({ value: messages });
  };
  return { calls, fetchImpl };
}

test('原生取件：仅请求微软，密码和旧中转地址不发送，邮件字段归一', async () => {
  const message = nativeMessage('123456', '2026-09-09T10:00:00Z');
  const { calls, fetchImpl } = nativeFetch([message]);
  const result = await fetchReserveAccountMessages(credentials, { fetchImpl });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[0].init.body)), {
    grant_type: 'refresh_token', client_id: credentials.clientId,
    refresh_token: credentials.refreshToken, scope: OUTLOOK_SCOPE,
  });
  assert.equal(calls[1].init.method, 'GET');
  assert.equal(calls[1].init.headers.authorization, 'Bearer access-secret');
  assert.equal(new URL(calls[1].url).searchParams.get('$top'), '10');
  assert.equal(new URL(calls[1].url).searchParams.get('$orderby'), 'ReceivedDateTime desc');
  assert.ok(!JSON.stringify(calls).includes(credentials.password));
  assert.ok(!JSON.stringify(calls).includes(credentials.endpoint));
  assert.ok(!calls[1].url.includes(credentials.refreshToken));
  assert.ok(calls.every(({ init }) => init.redirect === 'error'));
  assert.deepEqual(result[0], {
    id: message.Id, subject: message.Subject, bodyPreview: message.BodyPreview,
    isRead: false, receivedDateTime: message.ReceivedDateTime,
    from: { emailAddress: { name: 'OpenAI', address: 'noreply@openai.com' } },
    body: { content: message.Body.Content, contentType: 'html' },
  });
});

test('原生取件：数量限制和空邮箱正常返回', async () => {
  for (const [maxMessages, expected] of [[200, '50'], [-1, '10'], [3.8, '3']]) {
    const { calls, fetchImpl } = nativeFetch();
    assert.deepEqual(await fetchOutlookMessages(credentials, { fetchImpl, maxMessages }), []);
    assert.equal(new URL(calls[1].url).searchParams.get('$top'), expected);
  }
});

test('原生取件：凭据缺失时不发送网络请求', async () => {
  for (const field of ['email', 'clientId', 'refreshToken']) {
    await assert.rejects(fetchOutlookMessages({ ...credentials, [field]: '' }, {
      fetchImpl: () => assert.fail('不应发送请求'),
    }), /缺少/);
  }
});

test('原生取件：授权失败和异常响应明确报错，不回显令牌或响应正文', async () => {
  const cases = [
    [Response.json({ error: 'invalid_grant', error_description: 'refresh-secret' }, { status: 400 }), /invalid_grant/],
    [Response.json({}), /缺少 access_token/],
    [new Response('refresh-secret'), /有效 JSON/],
    [Response.json({ error: 'refresh-secret' }, { status: 401 }), /HTTP 401/],
  ];
  for (const [response, pattern] of cases) {
    await assert.rejects(fetchOutlookMessages(credentials, {
      fetchImpl: async (url) => {
        assert.equal(url, OUTLOOK_TOKEN_URL);
        return response;
      },
    }), (error) => pattern.test(error.message) && !error.message.includes('refresh-secret'));
  }
});

test('原生取件：邮件端点失败不伪装为空邮箱，也不回退第三方', async () => {
  for (const [response, pattern] of [
    [new Response('access-secret', { status: 401 }), /Outlook 邮件读取失败：HTTP 401/],
    [Response.json({ error: 'access-secret' }), /缺少邮件列表/],
    [new Response('access-secret'), /有效 JSON/],
  ]) {
    const calls = [];
    await assert.rejects(fetchOutlookMessages(credentials, { fetchImpl: async (url) => {
      calls.push(url);
      return url === OUTLOOK_TOKEN_URL ? Response.json({ access_token: 'access-secret' }) : response;
    } }), (error) => pattern.test(error.message) && !error.message.includes('access-secret'));
    assert.equal(calls.length, 2);
  }
});

test('原生取件：超时覆盖授权请求及邮件请求', async () => {
  for (const failStage of ['token', 'mail']) {
    await assert.rejects(fetchOutlookMessages(credentials, { timeoutMs: 5, fetchImpl: (url, { signal }) => {
      if (failStage === 'mail' && url === OUTLOOK_TOKEN_URL) return Response.json({ access_token: 'test' });
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } }), failStage === 'token' ? /微软授权请求超时/ : /Outlook 邮件读取请求超时/);
  }
});

test('设置：旧中转配置不再暴露或修改，其他参数仍可保存', async (t) => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings['outlook.fetch'] = { endpoint: credentials.endpoint };
  const app = Fastify();
  app.decorate('settings', { get: (key) => settings[key], set: (key, value) => { settings[key] = value; } });
  registerErrorHandler(app);
  await createSettingsModule({})(app);
  t.after(() => app.close());
  const response = await app.inject('/api/v1/settings');
  assert.equal(response.json().outlook_fetch_mode, 'microsoft_direct');
  assert.ok(!response.body.includes(credentials.endpoint));
  assert.ok(!('outlook.fetch' in DEFAULT_SETTINGS));
  const rejected = await app.inject({ method: 'PUT', url: '/api/v1/settings', payload: { outlook_fetch_endpoint: credentials.endpoint } });
  assert.equal(rejected.statusCode, 422);
  const saved = await app.inject({ method: 'PUT', url: '/api/v1/settings', payload: { max_concurrent_jobs: 3 } });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().max_concurrent_jobs, 3);
});
