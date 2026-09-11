-- 废弃号池用量信息 + 列表热路径索引。
--
-- discard_used_amount / discard_used_amount_at：
--   废弃池要展示「已用额度」，取值与「主号池预估剩余余额」同源 ——
--   sub2api 管理端账号用量（accountUsedAmount：used_amount / consumed_amount /
--   total_cost / usage.* / usage_stats.summary.total_cost）。
--   sub2api 只保留账号当前累计用量，不提供历史时点查询，因此：
--     · 账号被废弃的当下抓取一次并写入本列（准确，之后永不失真）
--     · 事后手动「同步远端用量」时按当前累计更新，并记录同步时间供 UI 标注
ALTER TABLE accounts ADD COLUMN discard_used_amount REAL;
ALTER TABLE accounts ADD COLUMN discard_used_amount_at TEXT;
-- 记录取值来源（如 usage_stats.summary.total_cost），便于核对数字是怎么来的
ALTER TABLE accounts ADD COLUMN discard_used_amount_source TEXT;

-- 「加入主号池时间」不新增列：沿用既有口径（见 lib/upload-order.js）
--   COALESCE(MIN(account_events.created_at WHERE type='join_succeeded'), accounts.created_at)
-- 该口径已被「按加入号池时间排序」使用，新增列会制造第二套真相。
-- 事件表已有 (account_id, created_at DESC) 索引，但按 type 过滤后排序仍需回表排序，
-- 补一个覆盖三列的组合索引让两个用途（时间线派生 + 排序）都能走索引。
CREATE INDEX idx_account_events_join ON account_events(account_id, type, created_at);

-- 任务列表默认 ORDER BY created_at DESC, id DESC。
-- 既有 idx_jobs_status(status, created_at) 以 status 为前导列，未筛选时用不上，
-- 只能全表扫描后排序（该接口被前端 2s 轮询）。
CREATE INDEX idx_jobs_created ON jobs(created_at DESC, id DESC);
