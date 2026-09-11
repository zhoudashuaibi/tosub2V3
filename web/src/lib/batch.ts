/**
 * 批量操作分片。
 *
 * 背景：后端各批量接口的 maxItems 并不一致（join-main / batch-authorize /
 * batch-upload-sub2api / batch-discard / batch-delete 都是 500，batch-refresh-balance
 * 是 1000，代理侧是 2000）。前端一旦「全选筛选结果」就可能超过上限，
 * 直接被 422 VALIDATION 拒绝且看不出原因。
 *
 * 这里把上限集中声明，调用方统一走 runChunked 自动分片并聚合结果。
 */

/** 各批量接口的 ids 上限（与服务端 JSON Schema 的 maxItems 一一对应）。 */
export const BATCH_LIMITS = {
  'accounts.joinMain': 500,
  'accounts.batchAuthorize': 500,
  'accounts.batchRefreshBalance': 1000,
  'accounts.batchUpload': 500,
  'accounts.batchDiscard': 500,
  'accounts.batchDelete': 500,
  'accounts.batchRestore': 500,
  'accounts.discardUsageSync': 500,
  'proxies.test': 2000,
  'proxies.batchRemove': 2000,
  'team.healthCheck': 1000,
  'team.reclaim': 1000,
  'team.upload': 1000,
  'team.deleteCards': 1000,
} as const;

export type BatchOperation = keyof typeof BATCH_LIMITS;

export function chunkIds(ids: number[], limit: number): number[][] {
  if (limit <= 0) throw new Error('limit 必须为正整数');
  const chunks: number[][] = [];
  for (let start = 0; start < ids.length; start += limit) {
    chunks.push(ids.slice(start, start + limit));
  }
  return chunks;
}

/**
 * 按接口上限自动分片执行，并把多次调用的结果合并。
 *
 * @param ids 全部 id
 * @param operation 接口标识（决定分片大小）
 * @param run 单批执行函数
 * @param merge 结果合并函数（默认把数字型结果相加、数组型结果拼接）
 */
export async function runChunked<Id, R>(
  ids: Id[],
  operation: BatchOperation,
  run: (chunk: Id[]) => Promise<R>,
  merge?: (acc: R, next: R) => R,
): Promise<R> {
  const limit = BATCH_LIMITS[operation];
  const chunks = chunkIds(ids as unknown as number[], limit) as unknown as Id[][];
  let acc: R | undefined;
  for (const chunk of chunks) {
    const result: R = await run(chunk);
    if (acc === undefined) acc = result;
    else if (merge) acc = merge(acc, result);
    else acc = defaultMerge(acc, result) as R;
  }
  // ids 为空时仍然调用一次，让「0 条」的语义由后端决定
  if (acc === undefined) return run([]);
  return acc;
}

function defaultMerge<R>(acc: R, next: R): R {
  if (typeof acc === 'number' && typeof next === 'number') return ((acc as number) + (next as number)) as R;
  if (Array.isArray(acc) && Array.isArray(next)) return [...acc, ...next] as R;
  if (acc && next && typeof acc === 'object' && typeof next === 'object') {
    const out: Record<string, unknown> = { ...(acc as Record<string, unknown>) };
    for (const [key, value] of Object.entries(next as Record<string, unknown>)) {
      const current = out[key];
      if (typeof current === 'number' && typeof value === 'number') out[key] = current + value;
      else if (Array.isArray(current) && Array.isArray(value)) out[key] = [...current, ...value];
      else if (value !== undefined) out[key] = value;
    }
    return out as R;
  }
  return next;
}

/** 超过上限时该分成几批（用于提交前的提示文案）。 */
export function batchCount(ids: number[], operation: BatchOperation): number {
  return Math.max(1, Math.ceil(ids.length / BATCH_LIMITS[operation]));
}
