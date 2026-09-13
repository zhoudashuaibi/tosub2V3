-- 废弃号池「废弃时的代理 IP」快照。
--
-- 为什么要落库而不是打开列表时现查：
--   这一列要回答的是「这个号是死在哪个出口 IP 上的」，也就是封号归因的取证。
--   而远端绑定是可以被改掉、也会随号一起消失的：
--     · 一键更换代理 IP 会把号改绑到新代理并删掉旧代理（proxy-replace）
--     · 账号废弃后会暂停远端调度，远端记录也可能被清理
--   一旦错过废弃那一刻，事后再查只能拿到「现在绑的是哪条」，与废弃当时的出口无关。
--   所以与「已用额度」同一手法：废弃当下抓一次写入快照列，之后不再改写。
--
-- 取值口径（sub2api 远端账号 → 代理）：
--   discard_proxy_name  sub2api 代理的 name（如 23）
--   discard_proxy_user  代理的认证账号（proxy 的 username）
--   discard_proxy_id    远端代理 ID；若号根本没绑代理，回退记本机 tosub2 代理 id
--   discard_proxy_at    快照时间
ALTER TABLE accounts ADD COLUMN discard_proxy_name TEXT;
ALTER TABLE accounts ADD COLUMN discard_proxy_user TEXT;
ALTER TABLE accounts ADD COLUMN discard_proxy_id INTEGER;
ALTER TABLE accounts ADD COLUMN discard_proxy_at TEXT;

-- 「按代理 IP 看废弃号」是这个列的主用途（同一个 IP 死了一批号 = 该 IP 被拉黑的信号），
-- 因此补一个组合索引：废弃池按代理名分组/排序都不必回表全扫。
CREATE INDEX idx_accounts_discard_proxy ON accounts(discard_proxy_name) WHERE pool = 'discard';
