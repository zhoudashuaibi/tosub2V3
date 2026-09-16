import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSub2apiAccountsExport, credentialsForImport } from '../modules/accounts/import.js';

const UUID = '9e5f94bc-e8a4-4e73-b8be-63364c29d753';
const RT = 'M.C550_BL2.' + 'x'.repeat(120);
const SECRET = 'BRPYNJJCVO27O4LQOIMD57BERTMJHLQC';

/** 构造 example.json 同构的 sub2api 账号导出条目 */
function sub2apiAccount(overrides = {}) {
  return {
    name: 'a@b.com----1tS2leMD7gdy792qhgOVVEBr----AO35bAvvGcgghqYcA1!',
    notes: JSON.stringify({
      mailbox: {
        bind_email: 'a@b.com',
        password: 'cwbzea24279',
        client_id: UUID,
        refresh_token: RT,
        pickup_password: '1tS2leMD7gdy792qhgOVVEBr',
      },
      gpt: { password: 'AO35bAvvGcgghqYcA1!' },
      two_factor: { enabled_by_config: true, enabled: true, status: 'enabled', secret: SECRET },
    }),
    platform: 'openai',
    type: 'oauth',
    credentials: {
      access_token: 'at-123',
      refresh_token: 'rt-456',
      email: 'a@b.com',
      client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
    },
    extra: { email: 'a@b.com', two_factor_enabled: true },
    ...overrides,
  };
}

test('sub2api 导出解析：notes 四段 / GPT 密码 / 两步验证全量映射，OAuth tokens 随账号入主号池', () => {
  const parsed = parseSub2apiAccountsExport(JSON.stringify({ exported_at: 'x', proxies: [], accounts: [sub2apiAccount()] }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.entries.length, 1);
  const [entry] = parsed.entries;
  assert.equal(entry.email, 'a@b.com');
  // mailbox.password 是邮箱密码（四段第 2 段），gpt.password 才是 ChatGPT 密码
  assert.equal(entry.password, 'cwbzea24279');
  assert.equal(entry.clientId, UUID);
  assert.equal(entry.refreshToken, RT);
  assert.equal(entry.chatgptPassword, 'AO35bAvvGcgghqYcA1!');
  assert.equal(entry.totpSecret, SECRET);
  // 两步验证密钥同时作为在线取件码（模板 URL 拼接取码）
  assert.equal(entry.pickupCode, SECRET);
  // credentials 里的 OAuth tokens 随账号直入主号池（active）
  assert.equal(entry.tokens.access_token, 'at-123');
  assert.equal(entry.tokens.refresh_token, 'rt-456');
  assert.equal(entry.tokens.email, 'a@b.com');
  assert.equal(entry.mainStatus, 'active');
  assert.equal(entry.hasBalance, false);

  const credentials = credentialsForImport(entry);
  assert.deepEqual(credentials, {
    outlook: { password: 'cwbzea24279', client_id: UUID, refresh_token: RT },
    totp_pickup_code: SECRET,
    totp_secret: SECRET,
    password: 'AO35bAvvGcgghqYcA1!',
  });
});

test('sub2api 导出解析：无 tokens 的条目按备用池四段导入', () => {
  const account = sub2apiAccount({ credentials: {}, name: 'c@d.com----pick----GptPass9!' });
  account.notes = JSON.stringify({
    mailbox: { bind_email: 'c@d.com', password: 'mail-pw', client_id: UUID, refresh_token: RT },
  });
  const parsed = parseSub2apiAccountsExport(JSON.stringify({ accounts: [account] }));
  assert.equal(parsed.ok, true);
  const [entry] = parsed.entries;
  assert.equal(entry.tokens, null);
  assert.equal(entry.email, 'c@d.com');
  assert.equal(entry.password, 'mail-pw');
  // notes 缺 gpt 段时回退 name 第 3 段
  assert.equal(entry.chatgptPassword, 'GptPass9!');
  assert.equal(entry.totpSecret, '');
  assert.equal(entry.pickupCode, '');
});

test('sub2api 导出解析：two_factor 未开启时忽略 secret', () => {
  const account = sub2apiAccount();
  account.notes = JSON.stringify({
    mailbox: { bind_email: 'a@b.com', password: 'p', client_id: UUID, refresh_token: RT },
    two_factor: { enabled: false, status: 'disabled', secret: SECRET },
  });
  const parsed = parseSub2apiAccountsExport(JSON.stringify({ accounts: [account] }));
  const [entry] = parsed.entries;
  assert.equal(entry.totpSecret, '');
  assert.equal(entry.pickupCode, '');
});

test('sub2api 导出解析：notes 缺失时按 name/credentials.email 兜底（tokens 一并提取）', () => {
  const parsed = parseSub2apiAccountsExport(
    JSON.stringify({
      accounts: [
        {
          name: 'e@f.com----token----GptPw1!',
          credentials: { refresh_token: 'rt-only', access_token: 'at', email: 'e@f.com' },
        },
      ],
    }),
  );
  assert.equal(parsed.ok, true);
  const [entry] = parsed.entries;
  assert.equal(entry.email, 'e@f.com');
  assert.equal(entry.chatgptPassword, 'GptPw1!');
  assert.equal(entry.password, '');
  assert.equal(entry.tokens.access_token, 'at');
  assert.equal(entry.tokens.refresh_token, 'rt-only');
  // credentials.email 大写时归一到小写
  const [upper] = parseSub2apiAccountsExport(
    JSON.stringify({ accounts: [{ name: 'G@H.com----x----p', credentials: { refresh_token: 'rt', email: 'G@H.com' } }] }),
  ).entries;
  assert.equal(upper.email, 'g@h.com');
});

test('sub2api 导出解析：redeem 导出（纯 OAuth 凭据，无 notes）整批直入主号池', () => {
  const parsed = parseSub2apiAccountsExport(
    JSON.stringify({
      type: 'sub2api-data',
      accounts: [
        { name: 'x@duck.com', credentials: { email: 'x@duck.com', access_token: 'at-1', refresh_token: 'rt-1', chatgpt_account_id: 'us-1' } },
        { name: 'y@duck.com', extra: { email: 'y@duck.com' }, credentials: { access_token: 'at-2', refresh_token: 'rt-2' } },
      ],
    }),
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.entries.length, 2);
  const [first, second] = parsed.entries;
  assert.equal(first.email, 'x@duck.com');
  assert.equal(first.tokens.refresh_token, 'rt-1');
  assert.equal(first.tokens.chatgpt_account_id, 'us-1');
  assert.equal(first.mainStatus, 'active');
  assert.equal(second.email, 'y@duck.com');
  assert.equal(second.tokens.access_token, 'at-2');
});

test('sub2api 导出解析：allowBareEmail（redeem401 模式）放行纯邮箱账号', () => {
  const payload = JSON.stringify({
    accounts: [
      { name: 'bare@duck.com', credentials: {} },
      { name: 'cred@duck.com', credentials: {}, notes: JSON.stringify({ mailbox: { bind_email: 'cred@duck.com', password: 'p', client_id: UUID, refresh_token: RT } }) },
    ],
  });
  // 不开 allowBareEmail：纯邮箱条目被拒（保持旧校验语义）
  const strict = parseSub2apiAccountsExport(payload);
  assert.equal(strict.entries.length, 1);
  assert.equal(strict.entries[0].email, 'cred@duck.com');
  assert.match(strict.invalid[0].reason, /没有任何凭据字段/);
  // 开 allowBareEmail：纯邮箱进备用池（tokens 为空，走 join-main 远程登录）
  const relaxed = parseSub2apiAccountsExport(payload, { allowBareEmail: true });
  assert.equal(relaxed.entries.length, 2);
  assert.equal(relaxed.entries[0].email, 'bare@duck.com');
  assert.equal(relaxed.entries[0].tokens, null);
  assert.equal(relaxed.entries[0].mainStatus, undefined);
});

test('sub2api 导出解析：裸数组与密钥归一化', () => {
  const parsed = parseSub2apiAccountsExport(
    JSON.stringify([
      sub2apiAccount({ status: 'expired', name: 'i@j.com----x----p' }),
      sub2apiAccount({
        name: 'k@l.com----x----p',
        notes: JSON.stringify({
          mailbox: { bind_email: 'k@l.com', password: 'p', client_id: UUID, refresh_token: RT },
          two_factor: { enabled: true, secret: 'jbsw y3dp ehpk 3pxp=' },
        }),
        credentials: {},
      }),
    ]),
  );
  assert.equal(parsed.ok, true);
  const [expired, normalized] = parsed.entries;
  assert.equal(expired.tokens.access_token, 'at-123');
  assert.equal(normalized.totpSecret, 'JBSWY3DPEHPK3PXP');
  assert.equal(normalized.pickupCode, 'JBSWY3DPEHPK3PXP');
});

test('sub2api 导出解析：非法文件与非法条目逐条报错', () => {
  assert.equal(parseSub2apiAccountsExport('').ok, false);
  assert.equal(parseSub2apiAccountsExport('not json').ok, false);
  assert.equal(parseSub2apiAccountsExport('{"foo":1}').ok, false);

  const parsed = parseSub2apiAccountsExport(
    JSON.stringify({
      accounts: [
        { name: 'bad-email----x----p', credentials: { refresh_token: 'rt' } },
        sub2apiAccount(),
        sub2apiAccount({ name: 'A@B.com----x----p' }), // 批内重复（大小写不敏感）
        {
          name: 'm@n.com----x----p',
          credentials: {},
          notes: JSON.stringify({ mailbox: { bind_email: 'm@n.com', password: 'p', client_id: 'not-uuid', refresh_token: RT } }),
        },
        {
          name: 'o@p.com----x----p',
          credentials: {},
          notes: JSON.stringify({
            mailbox: { bind_email: 'o@p.com', password: 'p', client_id: UUID, refresh_token: 'short' },
          }),
        },
        {
          name: 's@t.com----x----p',
          credentials: {},
          notes: JSON.stringify({
            mailbox: { bind_email: 's@t.com', password: 'p', client_id: UUID, refresh_token: RT },
            two_factor: { enabled: true, secret: 'not-base32!' },
          }),
        },
        { name: 'q@r.com----p' }, // 无任何凭据
      ],
    }),
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.entries.length, 1);
  const reasons = parsed.invalid.map((i) => i.reason).join('\n');
  assert.match(reasons, /邮箱格式错误/);
  assert.match(reasons, /重复/);
  assert.match(reasons, /clientId 不是 UUID/);
  assert.match(reasons, /refresh_token 长度不足/);
  assert.match(reasons, /Base32/);
  assert.match(reasons, /没有任何凭据字段/);
});
