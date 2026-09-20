import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseImportLines, credentialsForImport } from '../modules/accounts/import.js';
import { createCrypto } from '../lib/crypto.js';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const UUID = '9e5f94bc-e8a4-4e73-b8be-63364c29d753';
const RT = 'M.C509_BL2.' + 'x'.repeat(120);
const TOTP = 'JBSWY3DPEHPK3PXP';

test('合法行解析出四段凭据', () => {
  const [entry] = parseImportLines(`a@b.com----pass1----${UUID}----${RT}`);
  assert.equal(entry.ok, true);
  assert.equal(entry.email, 'a@b.com');
  assert.equal(entry.password, 'pass1');
  assert.equal(entry.clientId, UUID);
  assert.equal(entry.refreshToken.length >= 100, true);
});

test('非法行逐条返回原因且不中断', () => {
  const results = parseImportLines([
    'bad-email----p----not-uuid----short',
    'ok@b.com----p----' + UUID + '----' + RT,
    'x@b.com----p----123',
    '# 注释与空行',
    '',
  ].join('\n'));
  assert.equal(results.length, 3);
  assert.equal(results[0].ok, false);
  assert.match(results[0].reason, /邮箱|clientId|refresh_token|格式/);
  assert.equal(results[1].ok, true);
  assert.equal(results[2].ok, false);
});

test('批内重复只保留首行', () => {
  const results = parseImportLines(`a@b.com----p----${UUID}----${RT}\na@b.com----p2----${UUID}----${RT}`);
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, false);
  assert.equal(results[1].duplicateInBatch, true);
});

test('refresh_token 含 ---- 时重新拼接', () => {
  const rtWithDashes = RT + '----tail';
  const [entry] = parseImportLines(`a@b.com----p----${UUID}----${rtWithDashes}`);
  assert.equal(entry.refreshToken, rtWithDashes);
});

test('六段式分别保存邮箱凭据、ChatGPT 密码和规范化后的 2FA', () => {
  const [entry] = parseImportLines(` A@B.COM ----mail-pass----${UUID}----${RT}----GPT#Pass!---- jbsw y3dp ehpk 3pxp== `);
  assert.equal(entry.ok, true);
  assert.equal(entry.email, 'a@b.com');
  assert.deepEqual(credentialsForImport(entry), {
    outlook: { password: 'mail-pass', client_id: UUID, refresh_token: RT },
    password: 'GPT#Pass!',
    totp_secret: TOTP,
    totp_pickup_code: TOTP,
  });
});

test('六段式从末尾提取登录凭据，保留 refresh_token 内的分隔符', () => {
  const refreshToken = `${RT}----middle----tail`;
  const [entry] = parseImportLines(`a@b.com----mail-pass----${UUID}----${refreshToken}----gpt-pass----${TOTP}`);
  assert.equal(entry.ok, true);
  assert.equal(entry.refreshToken, refreshToken);
  assert.equal(entry.chatgptPassword, 'gpt-pass');
  assert.equal(entry.totpSecret, TOTP);
});

test('六段式尾部凭据可单独留空且不生成空凭据字段', () => {
  for (const [password, secret] of [['gpt-pass', ''], ['', TOTP], ['', '']]) {
    const [entry] = parseImportLines(`a@b.com----mail-pass----${UUID}----${RT}----${password}----${secret}`);
    assert.equal(entry.ok, true);
    const credentials = credentialsForImport(entry);
    assert.equal(credentials.outlook.refresh_token, RT);
    assert.equal(credentials.password, password || undefined);
    assert.equal(credentials.totp_secret, secret || undefined);
    assert.equal(credentials.totp_pickup_code, secret || undefined);
  }
});

test('六段式错误逐行返回，不泄露凭据或吞掉后续合法行', () => {
  for (const secret of ['INVALID_0189_SECRET', 'ABC', 'A'.repeat(129)]) {
    const [invalid, valid] = parseImportLines([
      `a@b.com----mail-pass----${UUID}----${RT}----gpt-pass----${secret}`,
      `a@b.com----mail-pass----${UUID}----${RT}----gpt-pass----${TOTP}`,
    ].join('\n'));
    assert.equal(invalid.ok, false);
    assert.match(invalid.reason, /2FA.*Base32/);
    assert.equal(JSON.stringify(invalid).includes(secret), false);
    assert.equal(valid.ok, true);
  }
  const [shortToken] = parseImportLines(`a@b.com----mail-pass----${UUID}----short----${'p'.repeat(150)}----${TOTP}`);
  assert.equal(shortToken.ok, false);
  assert.match(shortToken.reason, /refresh_token/);
});

test('四段、六段和纯邮箱可混合导入，统一按邮箱查重并保留行号', () => {
  const results = parseImportLines([
    '# 注释',
    `a@b.com----mail-pass----${UUID}----${RT}`,
    '',
    `b@b.com----mail-pass----${UUID}----${RT}----gpt-pass----${TOTP}`,
    `A@B.COM----mail-pass----${UUID}----${RT}----gpt-pass----${TOTP}`,
    'c@b.com',
  ].join('\r\n'), { allowBareEmail: true });
  assert.deepEqual(results.map(({ line, ok }) => ({ line, ok })), [
    { line: 2, ok: true }, { line: 4, ok: true }, { line: 5, ok: false }, { line: 6, ok: true },
  ]);
  assert.equal(results[2].duplicateInBatch, true);
  assert.equal(results[2].email, 'a@b.com');
  assert.deepEqual(credentialsForImport(results[3]), {});
});

test('crypto 信封加解密往返 + AAD 绑定', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tosub2-crypto-'));
  try {
    const crypto = createCrypto({ dataDir: dir, secretKeyEnv: 'test-secret' });
    const envelope = crypto.encrypt('hello 世界', 'accounts.tokens_enc');
    assert.match(envelope, /^v1:/);
    assert.equal(crypto.decrypt(envelope, 'accounts.tokens_enc'), 'hello 世界');
    // AAD 不匹配 → 解密失败
    assert.throws(() => crypto.decrypt(envelope, 'settings.sub2api.config'), /DECRYPT_FAILED/);
    // JSON 封面
    const json = { a: 1, b: 'x' };
    assert.deepEqual(crypto.decryptJson(crypto.encryptJson(json, 'f'), 'f'), json);
    // 口令哈希
    const record = crypto.hashPassword('p@ssw0rd8');
    assert.equal(crypto.verifyPassword('p@ssw0rd8', record), true);
    assert.equal(crypto.verifyPassword('wrong', record), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('密钥轮换后旧密文解密失败（tryDecrypt 返回 null）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tosub2-crypto2-'));
  try {
    const c1 = createCrypto({ dataDir: dir, secretKeyEnv: 'secret-one' });
    const envelope = c1.encrypt('data', 'f');
    const c2 = createCrypto({ dataDir: path.join(dir, 'sub'), secretKeyEnv: 'secret-two' });
    assert.equal(c2.tryDecrypt(envelope, 'f'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
