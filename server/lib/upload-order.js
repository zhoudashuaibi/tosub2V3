/**
 * 手动批量「加入主号池 / 上传 sub2api」与监控自动补号共用的选号顺序（docs 04-04）：
 * balance_* 按金额（备用池=初始余额，主号池=实时余额，互为回退，单位美元）；
 * time_* 按加入号池时间（备用池=导入时间；主号池=首次 join_succeeded 事件时间，直入/导入的回退 created_at）。
 */
export const UPLOAD_ORDERS = ['balance_desc', 'balance_asc', 'time_desc', 'time_asc'];

/**
 * 「加入主号池时间」的唯一口径（账号列表的时间线列与按时间排序共用，避免两套真相）：
 * 首次 join_succeeded 审计事件时间；直入主池/收编/手动添加的号没有该事件 → 回退 created_at。
 *
 * @param {string} accountRef 账号表引用，如 `a` 或 `accounts`
 */
export function joinedMainPoolAtExpr(accountRef = 'accounts') {
  return `COALESCE((SELECT MIN(e.created_at) FROM account_events e WHERE e.account_id = ${accountRef}.id AND e.type = 'join_succeeded'), ${accountRef}.created_at)`;
}

/** 生成 ORDER BY 排序表达式（不含 tiebreak，调用方自行追加 a.id 保证稳定）。 */
export function uploadOrderExpr(order, pool) {
  const direction = String(order || '').endsWith('_desc') ? 'DESC' : 'ASC';
  if (String(order || '').startsWith('time')) {
    const timeField = pool === 'main' ? joinedMainPoolAtExpr('a') : 'COALESCE(a.imported_at, a.created_at)';
    return `${timeField} ${direction}`;
  }
  return `COALESCE(a.balance, a.initial_balance, 0) ${direction}`;
}
