# toSub2 v2

ChatGPT 账号池管理系统（模块化重写版）：代理池 + 三级号池（备用/主/废弃）+ 任务引擎 + sub2api 管控，单容器部署。

> 设计文档见 `docs/v2/`（架构、数据库、协议、API、前端、安全、部署、迁移、路线图全套规范）。

## 功能总览

| 模块 | 能力 |
|---|---|
| 认证 | 首访设密 / HttpOnly Cookie 30 天滑动会话 / IP 限流（5 次锁 15 分钟，DB 持久）/ 改密全端登出 / CSRF 双保险 |
| 代理池 | 批量导入去重、一键测活（curl_cffi 过 CF 口径）、随机选路、失败降级本机直连 |
| 备用号池 | Outlook 四段导入（三重查重）、邮件初始化（初始余额 credits/25 + 封禁关键字）、单/批量加入主池 |
| 主号池 | 邮箱验证码自动登录（json-events 事件流驱动）、批量授权（refresh 优先失败转全登）、批量余额、批量上传 sub2api（串行+创建前二次校验的查重替换/最少绑定代理/---N 余额后缀） |
| 废弃号池 | 401/429/修复失败/登录封禁/手动废弃五类原因，支持移回主池；展示**加入备用池时间 / 加入主号池时间 / 已用额度 / 废弃时的代理 IP / 封号时的 Codex 指纹收敛**（见下） |
| 任务中心 | 队列/并发调度、人工内联输入（验证码/密码/手机号）、增量日志、取消/重试、代理风控自动重启、断点续跑、重启恢复 |
| sub2api | 连接配置加密存储、监控巡检（分类正则可配）、自动重登修复、自动补号 |
| 安全 | 凭据/token/代理 URL AES-256-GCM 入库、日志脱敏、敏感字段只写不读 |

## 废弃号池的「已用额度」

废弃号池的「已用额度」与「主号池预估剩余余额」**同源**：取 sub2api 管理端账号的累计用量
（`used_amount` / `consumed_amount` / `total_cost` / `usage.*` / `usage_stats.summary.total_cost`）。

- **账号被废弃的当下自动抓取一次并落库**——sub2api 只保留账号当前累计用量，不提供历史时点查询，
  错过此刻就只能拿到「当前值」。
- 事后可用工具栏的**「同步远端用量」**按当前筛选批量刷新（默认跳过 24 小时内已同步的账号，
  显式全量重算由前端 `force` 触发）。列上的 tooltip 会标注同步时间与取值来源。
- 远端账号已被删除时无法取数，界面会区分「未同步」（待办）与「sub2api 中已无此账号」（确定事实）。

「加入备用号池时间」取 `COALESCE(imported_at, created_at)`；「加入主号池时间」取首次
`join_succeeded` 审计事件时间，没有该事件的账号（直入主池/收编/手动添加）回退 `created_at`
——与「按加入号池时间排序」共用同一口径（`server/lib/upload-order.js`）。

## 废弃号池的「代理 IP」（封号归因）

废弃池列表的「代理 IP」列显示**废弃那一刻**这个号走的出口代理：代理名（sub2api 代理 name）
+ 认证账号（代理的 `username`）。同一个代理上接连死掉一批号，就是该 IP 被拉黑的信号。

- **只在废弃瞬间取一次**并落库（`accounts.discard_proxy_*`，迁移 `0011_discard_proxy.sql`）。
  远端绑定会被「一键更换代理 IP」改绑、旧代理随后被删除，号废弃后也可能被清理 ——
  事后再查只能得到「现在绑的是哪条」，与废弃当时的出口无关。
- 取值顺序：巡检手里的远端账号对象（废弃当时真实绑定）→ 单账号接口 → 有上限的邮箱查找；
  远端没有这个号时退回**本机 tosub2 代理**（该号最后一次任务的 `proxy_id` → 备注 + URL 里的认证账号）。
  登录类废弃的号多数没上过远端，这条兜底是唯一能拿到的出口线索。
- 取不到就显示 `—`，**不反推成「直连」**；老数据（本列上线前废弃的号）一律为空。
- 搜索框在废弃池同时匹配邮箱 / 代理名 / 认证账号，可直接按 IP 反查；表头「代理 IP」可排序（空值沉底）。

## 废弃号池的「Codex 指纹收敛」（封号归因）

废弃池列表的「Codex 指纹收敛」列显示**被封禁那一刻**这个号在 sub2api 侧的收敛档位
（远端账号 `extra.codex_fingerprint_mode`）：`关闭（透传）` / `仅设备` / `设备+会话` / `完全收敛`。
和「代理 IP」同一个用途 —— 同一档收敛下接连死掉一批号，就是该档位可疑的信号。

- **只在废弃瞬间取一次**并落库（`accounts.discard_codex_fingerprint_mode / _at`，迁移 `0012_discard_codex_fingerprint.sql`）。
  档位在 sub2api 账号编辑页随时能改，号废弃后远端记录也可能被清理 —— 事后再查得到的是「现在是什么」，
  与封号当时无关。
- 档位只存在远端，本地库没有第二份：巡检手里的远端账号对象 → 单账号接口 → 有上限的邮箱查找。
  与出口代理**共用同一次远端解析**（两者在同一个账号对象上），不会把同一个号查两遍；
  巡检路径（401/429 封禁）本来就有远端对象，零额外请求。
- 远端没开收敛是**确定**的结论（sub2api 契约里 `off` 就是不写这个键），所以照实显示「关闭（透传）」；
  只有压根读不到（从未上传过远端 / 远端账号已删除 / 远端对象不带 `extra`）才显示 `—`，**不代填成 off**。
- 表头可排序，且**按收敛强度**排（透传 → 仅设备 → 设备+会话 → 完全收敛；倒排即把最可疑的完全收敛放最前），
  不是字典序；读不到档位的号两个方向都沉底。老数据（本列上线前废弃的号）一律为空。

## 列表页交互约定

- **筛选/排序/分页写入 URL**：刷新、后退、复制链接都能还原当前视图。
- **跨页选择**：勾选在翻页后保留；表头勾选框支持半选态；「选中全部 N 条」会从后端取回全部
  id 再按各接口的 `maxItems` 自动分片提交（上限集中在 `web/src/lib/batch.ts`）。
- **批量结果汇总**：成功/跳过/失败分区展示，可从结果里只重试失败项。
- **搜索框**统一 250ms 防抖，按 `/` 聚焦；`Alt+1..9` 跳转页面，`g` 后接字母走序列跳转。
- 列表按需轮询，**仅首次加载显示骨架**，后台刷新只在右上角转圈，不再整表闪烁。


## Outlook 原生取件

邮箱验证码、备用号池余额初始化和封禁邮件检查均直接访问微软官方接口：先通过 `login.microsoftonline.com/consumers/oauth2/v2.0/token` 换取访问令牌，再从 `outlook.office.com/api/v2.0/me/messages` 读取邮件。

沿用已导入的 Outlook `client_id` 和 `refresh_token`，邮箱密码不参与取件请求。授权范围与参考取件项目一致，为 Outlook `IMAP.AccessAsUser.All`、`Mail.ReadWrite` 和 `offline_access`。登录收码读取最近 5 封，余额和封禁检查默认读取最近 10 封。

设置页取件方式固定为“微软官方直连”。旧 `outlook.fetch` 中转地址不再生效，提交 `outlook_fetch_endpoint` 会返回 422；已有账号无须重新导入。授权失效或微软接口失败会明确报错，不回退第三方取件。2FA 取码模板属于独立功能，保持原有行为。

## 快速开始

### Docker（推荐）

```bash
mkdir -p data && sudo chown 1000:1000 data   # volume 属主与容器内 node 用户一致
echo 'TOSUB2_SECRET_KEY='"$(openssl rand -base64 32)" > .env
docker compose up -d
# 打开 http://127.0.0.1:1999 → 首访设置密码 → 登录
```

公网部署**必须**前置 Nginx/Caddy 做 HTTPS（反代示例见 docs/v2/08 §4）；compose 默认只绑 127.0.0.1。

### 服务器部署（GitHub Actions 构建的镜像）

推送到 `main` 分支后，CI 自动构建镜像并发布到 GHCR（私有仓库，拉取需先登录）：

```bash
# 一次性：用 PAT（需 read:packages 权限）登录 GHCR
echo <YOUR_GITHUB_PAT> | docker login ghcr.io -u zhoudashuaibi --password-stdin

mkdir -p data && sudo chown 1000:1000 data
echo 'TOSUB2_SECRET_KEY='"$(openssl rand -base64 32)" > .env
docker pull ghcr.io/zhoudashuaibi/tosubv2:latest
docker run -d --name tosub2 --restart unless-stopped \
  -p 127.0.0.1:1999:1999 -v ./data:/app/data --env-file .env \
  ghcr.io/zhoudashuaibi/tosubv2:latest
# 或把 docker-compose.yml 里的 image 注释打开，docker compose up -d
```

镜像标签：`latest`（main 最新）、`main`、`vX.Y.Z`（打 tag 发布）、短 SHA。

### 裸机开发

```bash
npm install
python3 -m pip install -r requirements.txt   # curl_cffi（TLS 指纹）
npm run build                                # 前端 → server/web-dist
npm start                                    # http://127.0.0.1:1999

# 前后端分离开发
npm run dev:web                              # vite :5173，/api 代理到 :1999
```

Windows 下 `better-sqlite3` 需预编译产物（npm 自动下载）；源码编译需 VS Build Tools。

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `TOSUB2_DATA_DIR` | `./data` | SQLite/密钥/日志/断点/产物根目录 |
| `TOSUB2_PORT` / `TOSUB2_HOST` | 1999 / 127.0.0.1 | 监听 |
| `TOSUB2_CONSOLE_PASSWORD` | - | 首次密码种子（入库后不再生效） |
| `TOSUB2_SECRET_KEY` | 自动生成 `data/secret.key` | 加密主密钥（建议显式提供） |
| `TOSUB2_FORCE_SECURE_COOKIE` | - | `1` 强制 Cookie Secure |
| `TOSUB2_PYTHON` / `TOSUB2_TLS_PROFILE` / `TOSUB2_LOG_LEVEL` | 自动 / - / info | 调试用 |

## 从 v1 迁移

```bash
node scripts/migrate-v1.mjs --v1-root /path/to/v1/tmp/chatgpt-onboarding-console --dry-run
node scripts/migrate-v1.mjs --v1-root ...   # 实际执行（幂等）
```

带入：sub2api 配置（加密）、Outlook 取件端点、备用池、已完成任务的 OAuth token（主号池）；凭据（DPAPI/Keychain）默认不迁移，见 docs/v2/09 §4。

## 备份与恢复

```bash
node scripts/backup.mjs /path/to/backup-dir --with-secret
# 恢复：停容器 → data/ 换回备份内容 → 起容器
```

## 测试

```bash
npm test          # server 单测 + 引擎集成测试（mock 子进程）
npm run check     # 语法检查
```

## 目录结构

```
tosubV2/
├── server/               # Fastify 后端
│   ├── core/             # v1 协议复用（登录/Sentinel/TLS 指纹/取件/接码，含 --json-events 改造）
│   ├── lib/              # db/crypto/config/settings/sanitize/totp
│   ├── migrations/       # SQLite 迁移（PRAGMA user_version）
│   └── modules/          # auth proxies accounts jobs sub2api settings dashboard static
├── web/                  # React 19 + Vite + TanStack Router/Query + Tailwind4 前端
├── scripts/              # migrate-v1 / backup
├── data/                 # 运行数据（DB/密钥/日志/断点/产物）
└── docs/v2/              # 设计文档
```

## 许可

MIT
