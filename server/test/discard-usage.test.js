/**
 * 废弃号池「已用额度」解析测试。
 *
 * 用例来源：与「主号池预估剩余余额」同源（client.accountUsedAmount 的字段候选表），
 * 以及远端账号可能被删除 / 从未上传的现实边界。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRemoteIndex,
  resolveRemoteAccount,
  resolveDiscardUsage,
} from '../modules/accounts/discard-usage.js';

/** 与 modules/sub2api/client.js accountUsedAmount 同语义的最小实现（测试替身）。 */
const accountEmail = (account) => account?.credentials?.email || account?.extra?.email || null;
function accountUsedAmount(account) {
  const candidates = [
    ['used_amount', account?.used_amount],
    ['usage.total_cost', account?.usage?.total_cost],
    ['usage_stats.summary.total_cost', account?.usage_stats?.summary?.total_cost],
  ];
  for (const [source, value] of candidates) {
    const amount = Number(value);
    if (value !== null && value !== undefined && value !== '' && Number.isFinite(amount) && amount >= 0) {
      return { amount, source };
    }
  }
  return null;
}

function indexOf(...accounts) {
  return buildRemoteIndex(accounts, accountEmail);
}

test('双路回退：sub2api_account_id 命中优先于 email', () => {
  const index = indexOf(
    { id: 7, credentials: { email: 'a@test.local' }, used_amount: 1 },
    { id: 42, credentials: { email: 'a@test.local' }, used_amount: 9 },
  );
  const remote = resolveRemoteAccount({ sub2api_account_id: 42, email: 'a@test.local' }, index);
  assert.equal(remote.id, 42);
});

test('sub2api_account_id 陈旧时回退 email 命中（废弃后不再参与远端同步）', () => {
  // 远端账号被删除重建过：本地记录的 id 已不存在，但邮箱仍能命中
  const index = indexOf({ id: 99, credentials: { email: 'b@test.local' }, used_amount: 3.5 });
  const remote = resolveRemoteAccount({ sub2api_account_id: 12, email: 'b@test.local' }, index);
  assert.equal(remote.id, 99);
  const resolved = resolveDiscardUsage({ sub2api_account_id: 12, email: 'b@test.local' }, remote, accountUsedAmount);
  assert.equal(resolved.used_amount, 3.5);
  assert.equal(resolved.remote_account_id, 99);
  assert.equal(resolved.reason, null);
});

test('email 匹配大小写不敏感', () => {
  const index = indexOf({ id: 1, credentials: { email: 'Mixed@Test.Local' }, used_amount: 2 });
  const remote = resolveRemoteAccount({ sub2api_account_id: null, email: 'mixed@test.local' }, index);
  assert.equal(remote?.id, 1);
});

test('从未上传：reason=not_linked，不写数值', () => {
  const resolved = resolveDiscardUsage({ sub2api_account_id: null, email: 'c@test.local' }, null, accountUsedAmount);
  assert.deepEqual(resolved, {
    used_amount: null,
    used_amount_source: null,
    remote_account_id: null,
    reason: 'not_linked',
  });
});

test('曾关联但远端已无此号：reason=remote_account_not_found', () => {
  const resolved = resolveDiscardUsage({ sub2api_account_id: 5, email: 'd@test.local' }, null, accountUsedAmount);
  assert.equal(resolved.reason, 'remote_account_not_found');
  assert.equal(resolved.used_amount, null);
});

test('远端存在但没有明确用量字段：reason=remote_used_amount_unknown', () => {
  const remote = { id: 8, credentials: { email: 'e@test.local' } };
  const resolved = resolveDiscardUsage({ sub2api_account_id: 8, email: 'e@test.local' }, remote, accountUsedAmount);
  assert.equal(resolved.reason, 'remote_used_amount_unknown');
  assert.equal(resolved.used_amount, null);
  // 仍然带回远端 id，便于排查
  assert.equal(resolved.remote_account_id, 8);
});

test('用量为 0 视为有效值（不是未知）', () => {
  const remote = { id: 9, credentials: { email: 'f@test.local' }, used_amount: 0 };
  const resolved = resolveDiscardUsage({ sub2api_account_id: 9, email: 'f@test.local' }, remote, accountUsedAmount);
  assert.equal(resolved.reason, null);
  assert.equal(resolved.used_amount, 0);
});

test('统计口径字段优先取 account.usage_stats.summary.total_cost（与主池预估一致）', () => {
  const remote = { id: 10, credentials: { email: 'g@test.local' }, usage_stats: { summary: { total_cost: 12.5 } } };
  const resolved = resolveDiscardUsage({ sub2api_account_id: 10, email: 'g@test.local' }, remote, accountUsedAmount);
  assert.equal(resolved.used_amount, 12.5);
  assert.equal(resolved.used_amount_source, 'usage_stats.summary.total_cost');
});

test('远端索引忽略无效 id，email 缺失时不入索引', () => {
  const index = indexOf({ id: 0, credentials: { email: 'h@test.local' } }, { id: 3, credentials: {} });
  assert.equal(index.byId.size, 1);
  assert.equal(index.byId.get(3).id, 3);
  assert.equal(index.byEmail.size, 1);
});
