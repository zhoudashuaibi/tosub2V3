/**
 * 废弃号池「已用额度」解析测试。
 *
 * 这里覆盖的是 classifyDiscardUsage（纯函数）与邮箱索引辅助函数。
 * 端到端行为（是否真的查了 /stats、是否回退邮箱）在 discard-pool.test.js 里用假客户端验证。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRemoteIndex,
  classifyDiscardUsage,
  resolveRemoteAccount,
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

/** 把「远端对象」按真实流程走一遍：先用账号对象取值，取不到再合并 stats 后取值。 */
function usedFrom(remote, stats) {
  const enriched = stats ? { ...remote, usage_stats: stats } : remote;
  return accountUsedAmount(enriched);
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

  const resolved = classifyDiscardUsage({
    row: { sub2api_account_id: 12, email: 'b@test.local' },
    remote,
    used: usedFrom(remote),
  });
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
  const resolved = classifyDiscardUsage({
    row: { sub2api_account_id: null, email: 'c@test.local' },
    remote: null,
    used: null,
  });
  assert.deepEqual(resolved, {
    used_amount: null,
    used_amount_source: null,
    remote_account_id: null,
    reason: 'not_linked',
    detail: null,
  });
});

test('曾关联但远端已无此号：reason=remote_account_not_found', () => {
  const resolved = classifyDiscardUsage({
    row: { sub2api_account_id: 5, email: 'd@test.local' },
    remote: null,
    used: null,
  });
  assert.equal(resolved.reason, 'remote_account_not_found');
  assert.equal(resolved.used_amount, null);
});

test('查询过程报错且查不到 → fetch_failed，并带上原始原因', () => {
  const resolved = classifyDiscardUsage({
    row: { sub2api_account_id: 5, email: 'd@test.local' },
    remote: null,
    used: null,
    lookupError: 'sub2api 请求超时（120s）',
  });
  assert.equal(resolved.reason, 'fetch_failed');
  assert.match(resolved.detail, /超时/);
});

test('远端存在但账号对象与统计都没有用量字段：reason=remote_used_amount_unknown', () => {
  const remote = { id: 8, credentials: { email: 'e@test.local' } };
  const resolved = classifyDiscardUsage({
    row: { sub2api_account_id: 8, email: 'e@test.local' },
    remote,
    used: usedFrom(remote, { summary: {} }),
  });
  assert.equal(resolved.reason, 'remote_used_amount_unknown');
  assert.equal(resolved.used_amount, null);
  // 仍然带回远端 id，便于排查
  assert.equal(resolved.remote_account_id, 8);
});

test('用量为 0 视为有效值（不是未知）', () => {
  const remote = { id: 9, credentials: { email: 'f@test.local' }, used_amount: 0 };
  const resolved = classifyDiscardUsage({
    row: { sub2api_account_id: 9, email: 'f@test.local' },
    remote,
    used: usedFrom(remote),
  });
  assert.equal(resolved.reason, null);
  assert.equal(resolved.used_amount, 0);
});

test('用量来自统计接口的 summary.total_cost（回归：账号对象本身没有费用字段）', () => {
  // 真实 sub2api 的账号对象不含累计消费，只有 /stats 的 summary.total_cost 才有；
  // 早期实现只读账号对象，导致所有账号都被判成「远端未提供用量字段」
  const remote = { id: 10, credentials: { email: 'g@test.local' } };
  assert.equal(usedFrom(remote), null, '账号对象单独取值应当为空');

  const used = usedFrom(remote, { summary: { total_cost: 12.5 } });
  assert.equal(used.amount, 12.5);
  assert.equal(used.source, 'usage_stats.summary.total_cost');

  const resolved = classifyDiscardUsage({
    row: { sub2api_account_id: 10, email: 'g@test.local' },
    remote,
    used,
  });
  assert.equal(resolved.used_amount, 12.5);
  assert.equal(resolved.used_amount_source, 'usage_stats.summary.total_cost');
  assert.equal(resolved.reason, null);
});

test('远端索引忽略无效 id，email 缺失时不入索引', () => {
  const index = indexOf({ id: 0, credentials: { email: 'h@test.local' } }, { id: 3, credentials: {} });
  assert.equal(index.byId.size, 1);
  assert.equal(index.byId.get(3).id, 3);
  assert.equal(index.byEmail.size, 1);
});
