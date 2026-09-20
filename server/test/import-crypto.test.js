import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseImportLines } from '../modules/accounts/import.js';
import { createCrypto } from '../lib/crypto.js';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const UUID = '9e5f94bc-e8a4-4e73-b8be-63364c29d753';
const RT = 'M.C509_BL2.' + 'x'.repeat(120);

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
