-- 巡检日志的「修复中」补终态回执：
-- 401 会话过期只写一条「已发起修复」的明细，修复任务可能要跑两三分钟（登录链路），
-- 期间每轮巡检都会因为「同账号已有活跃任务」而跳过，日志于是一直停在「修复中 / 未处理」，
-- 看不出到底修好了还是修废了。这里给明细行加回执字段，由 noteRepairOutcome 在任务终态写回：
--   outcome = ok       修复成功（新凭据已回推远端并恢复调度）
--           = failed   本次修复链路失败（repair_fail_count 已 +1，下轮会重试）
--           = parked   连败达上限，已暂停保留待重授（needs_reauth + 停自动修复）
--           = followup refresh 失败已自动转完整登录，等派生任务终态（仍算在途）
ALTER TABLE monitor_log_items ADD COLUMN outcome TEXT;
ALTER TABLE monitor_log_items ADD COLUMN outcome_at TEXT;
ALTER TABLE monitor_log_items ADD COLUMN outcome_detail TEXT;

CREATE INDEX idx_monitor_log_items_outcome ON monitor_log_items(outcome_at);
