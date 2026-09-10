-- 收编标记：adopt_remote 导入的主号池账号（无本地 tokens，直接关联远端 sub2api）。
-- 语义：远端健康时巡检零动作（修复本就只对 error 号触发，此列再加一道保险门）；
-- 远端 401/error 时正常走自动修复（无 tokens → 完整登录重授权）。
ALTER TABLE accounts ADD COLUMN adopted_remote INTEGER NOT NULL DEFAULT 0;

-- 存量回填：收编签名 = 主号池 + 无 tokens + 已关联远端（手动添加的号在登录/上传前
-- 没有 sub2api_account_id，登录成功后有 tokens，均不会命中）
UPDATE accounts SET adopted_remote = 1
 WHERE pool = 'main' AND tokens_enc IS NULL AND sub2api_account_id IS NOT NULL;

-- 解除旧版收编时一刀切置上的 auto_repair_blocked（repair_fail_count=0 表示不是
-- 连败后 parkForReauth 暂停的号，那些保持人工介入语义不动）
UPDATE accounts SET auto_repair_blocked = 0
 WHERE adopted_remote = 1 AND auto_repair_blocked = 1 AND repair_fail_count = 0;
