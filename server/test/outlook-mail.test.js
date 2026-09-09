import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAccountBannedFromMessages, extractBalanceFromMessages } from '../core/outlook-mail.mjs';
import { createBanMailCheck } from '../modules/accounts/ban-mail-check.js';

function message(subject, body, receivedDateTime = '2026-08-15T10:00:00Z') {
  return { subject, bodyPreview: '', body: { content: body }, receivedDateTime };
}

test('封禁邮件判定：英文关键字', () => {
  assert.equal(
    isAccountBannedFromMessages([message('Your account', 'Your account has been deactivated.')]).banned,
    true,
  );
  assert.equal(
    isAccountBannedFromMessages([message('Notice', 'account_deactivated by provider')]).banned,
    true,
  );
});

test('封禁邮件判定：中文关键字（账户已被停用等）', () => {
  assert.equal(
    isAccountBannedFromMessages([message('您的账户', '您的账户已被停用。如果您认为这是误判，请联系我们。')]).banned,
    true,
  );
  assert.equal(
    isAccountBannedFromMessages([message('通知', '经审查，帐号已被停用，立即生效。')]).banned,
    true,
  );
  assert.equal(
    isAccountBannedFromMessages([message('通知', '您的账号已被封禁。')]).banned,
    true,
  );
});

test('封禁邮件判定：正常邮件不误判', () => {
  assert.equal(
    isAccountBannedFromMessages([message('Your ChatGPT code', 'Your code is 123456')]).banned,
    false,
  );
  assert.equal(isAccountBannedFromMessages([]).banned, false);
});

test('余额邮件解析保持不变', () => {
  const result = extractBalanceFromMessages([message('Credits', "We've added 100 credits to your account")]);
  assert.equal(result.hasBalance, true);
  assert.equal(result.balance, 4);
});

test('余额邮件解析：中文「添加 X 额度」同样除以 25', () => {
  const result = extractBalanceFromMessages([message('额度通知', '已为每人的账户添加 1000 额度，感谢您的支持。')]);
  assert.equal(result.hasBalance, true);
  assert.equal(result.balance, 40);
});

test('余额邮件解析：中文变体（添加了/千分位/无空格）', () => {
  const withLe = extractBalanceFromMessages([message('额度', '我们已向您的账户添加了 1,250 额度。')]);
  assert.equal(withLe.hasBalance, true);
  assert.equal(withLe.balance, 50);

  const noSpace = extractBalanceFromMessages([message('额度', '您的账户已添加500额度')]);
  assert.equal(noSpace.hasBalance, true);
  assert.equal(noSpace.balance, 20);
});

test('余额邮件解析：日语、韩语、西班牙语和越南语获赠积分通知', () => {
  const cases = [
    ['日语', 'ご友人からの招待で ChatGPT デスクトップに参加し、初めてのメッセージを送信しました。お二人それぞれのアカウントに 500 クレジットを追加しました。', 20],
    ['韩语', '친구의 초대로 ChatGPT 데스크톱 앱에 가입하고 첫 메시지를 보냈습니다. 두 분의 계정에 각각 1000 크레딧을 추가했습니다.', 40],
    ['西班牙语', 'Te uniste a ChatGPT Escritorio con la invitación de tu amigo y enviaste tu primer mensaje. Agregamos 500 créditos a la cuenta de cada uno.', 20],
    ['越南语', 'Bạn đã tham gia ChatGPT Desktop qua lời mời của bạn bè và gửi tin nhắn đầu tiên. Chúng tôi đã cộng 250 credit vào mỗi tài khoản của hai bạn.', 10],
  ];

  for (const [language, body, balance] of cases) {
    const result = extractBalanceFromMessages([message('Credits', body)]);
    assert.equal(result.hasBalance, true, language);
    assert.equal(result.balance, balance, language);
  }
});

test('余额邮件解析：无关键字的中文邮件不误判', () => {
  const result = extractBalanceFromMessages([message('验证码', '您的验证码是 1000，请在 5 分钟内输入。')]);
  assert.equal(result.hasBalance, false);
});

function mockDb(row) {
  const events = [];
  const updates = [];
  const db = {
    prepare(sql) {
      return {
        get: () => row,
        run: (...args) => {
          if (sql.startsWith('INSERT INTO account_events')) events.push(JSON.parse(args[2]));
          if (sql.startsWith('UPDATE accounts SET banned')) updates.push(args);
        },
      };
    },
    _events: events,
    _updates: updates,
  };
  return db;
}

async function withFetchMock(messages, fn) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    ok: true,
    json: async () => String(url).includes('/token')
      ? { access_token: 'test-access-token' }
      : { value: messages.map((item) => ({
          Subject: item.subject,
          BodyPreview: item.bodyPreview,
          Body: { Content: item.body.content },
          ReceivedDateTime: item.receivedDateTime,
        })) },
  });
  try {
    await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('ban-mail-check：命中封禁邮件 → banned 标记 + confirmed 事件', async () => {
  const db = mockDb({ id: 1, email: 'a@b.com', credentials_enc: 'enc' });
  const banCheck = createBanMailCheck({
    db,
    decryptCredentials: () => ({ outlook: { client_id: 'x', refresh_token: 'y' } }),
    logger: null,
  });
  await withFetchMock(
    [message('您的账户', '您的账户已被停用。')],
    () => banCheck.check(1, { source: 'test' }),
  );
  assert.equal(db._events.length, 1);
  assert.equal(db._events[0].result, 'confirmed');
  assert.equal(db._updates.length, 1);
});

test('ban-mail-check：无封禁邮件 → not_found 事件，不改 banned', async () => {
  const db = mockDb({ id: 2, email: 'c@d.com', credentials_enc: 'enc' });
  const banCheck = createBanMailCheck({
    db,
    decryptCredentials: () => ({ outlook: { client_id: 'x', refresh_token: 'y' } }),
    logger: null,
  });
  await withFetchMock(
    [message('Your code', 'code 123456')],
    () => banCheck.check(2, { source: 'test' }),
  );
  assert.equal(db._events.length, 1);
  assert.equal(db._events[0].result, 'not_found');
  assert.equal(db._updates.length, 0);
});

test('ban-mail-check：缺少 Outlook 凭据 → skipped 事件', async () => {
  const db = mockDb({ id: 3, email: 'e@f.com', credentials_enc: 'enc' });
  const banCheck = createBanMailCheck({
    db,
    decryptCredentials: () => ({}),
    logger: null,
  });
  await banCheck.check(3, { source: 'test' });
  assert.equal(db._events.length, 1);
  assert.equal(db._events[0].result, 'skipped');
});
