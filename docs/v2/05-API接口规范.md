# 05 API 接口规范

## 0. 通用约定

- 前缀 `/api/v1`；JSON 请求/响应（`Content-Type: application/json`）。
- **认证**：`tosub2_session` HttpOnly Cookie（登录后自动携带）。除 `POST /auth/login`、`GET /auth/session`、`GET /health` 外全部需要会话，未认证返回：

  ```json
  HTTP 401
  { "error": { "code": "UNAUTHORIZED", "message": "未登录或会话已过期" } }
  ```

- **CSRF**：写方法（POST/PUT/PATCH/DELETE）必须带 `X-Requested-With: XMLHttpRequest` 头且 Origin 同源，否则 `403 CSRF_REJECTED`。
- **错误格式**统一：

  ```json
  { "error": { "code": "ACCOUNT_STATE_INVALID", "message": "账号不在可执行该操作的状态", "details": {} } }
  ```

- **时间**：ISO 8601 UTC 字符串。**金额**：美元浮点。
- **脱敏**：代理 URL、sub2api admin_key、账号凭据在任何响应中不出现明文（代理回 `display_url`，key 回掩码）。
- 分页约定：`?page=1&page_size=50`（≤200），响应 `{ items, total, page, page_size }`。

---

## 1. 认证（auth）

### POST /api/v1/auth/login

```jsonc
// 请求（密码已初始化）
{ "password": "your-password" }
// 请求（系统从未设置过密码时，首访引导）
{ "new_password": "set-your-password" }

// 200 成功（Set-Cookie: tosub2_session=...; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000）
{ "ok": true }
// 401 密码错误（剩余次数）
{ "error": { "code": "INVALID_PASSWORD", "message": "密码错误", "remaining_attempts": 3 } }
// 429 锁定
{ "error": { "code": "RATE_LIMITED", "message": "尝试次数过多，已锁定", "retry_after_seconds": 843 } }
```

### GET /api/v1/auth/session

```jsonc
// 200（无需认证）
{ "authenticated": true, "password_initialized": true, "expires_at": "2026-09-14T00:00:00Z" }
{ "authenticated": false, "password_initialized": false }
```

### POST /api/v1/auth/logout → `{ "ok": true }`（清 Cookie）
### POST /api/v1/auth/logout-all → `{ "ok": true, "revoked": 3 }`
### GET /api/v1/auth/sessions → 活跃会话列表（不含 token）

```jsonc
{ "items": [ { "created_at": "...", "last_seen_at": "...", "ip": "1.2.3.4", "user_agent": "Mozilla/5.0 ...", "current": true } ] }
```

### POST /api/v1/auth/password

```jsonc
// 请求 { "current_password": "...", "new_password": "..." }（≥8 位）
// 200 { "ok": true }（其余会话全部失效，当前会话换新 Cookie）
// 401 INVALID_PASSWORD | 422 VALIDATION（密码太短）
```

## 2. 代理（proxies）

### GET /api/v1/proxies

`?status=alive|dead|cf_challenge|unknown&q=&page=&page_size=&sort=last_checked_at:desc`

```jsonc
{
  "items": [{
    "id": 1, "display_url": "http://user:***@1.2.3.4:8080", "label": "标签A",
    "protocol": "http", "status": "alive", "last_latency_ms": 812,
    "last_checked_at": "2026-08-15T02:00:00Z", "fail_count": 0,
    "rotatable": true, "last_error": null, "created_at": "..."
  }],
  "total": 42,
  "stats": { "alive": 30, "dead": 8, "cf_challenge": 2, "unknown": 2 }
}
```

### POST /api/v1/proxies/import

```jsonc
// 请求 { "text": "http://u:p@1.2.3.4:8080----标签A\nsocks5h://u:p@h:1080\n" }
// 201
{ "created": 2, "duplicates": ["http://u:***@h:1080"],
  "invalid_lines": [{ "line": 3, "reason": "不支持的协议 ftp" }] }
```

### POST /api/v1/proxies/test

```jsonc
// 请求 { "ids": [1,2] }   // 省略 ids = 测全部非 alive
// 202 { "started": 2 }    // 结果通过 GET /proxies 轮询；进行中条目 status="testing"
// 409 CONFLICT 已有测活批次进行中
```

### PATCH /api/v1/proxies/:id — `{ "label": "新备注" }` → 200 更新后行
### DELETE /api/v1/proxies/:id → `{ "ok": true }`
### POST /api/v1/proxies/batch-delete — `{ "ids": [1,2] }` → `{ "deleted": 2 }`

## 3. 号池（accounts）

### GET /api/v1/accounts

`?pool=reserve|main|discard&q=&status=&banned=&has_balance=&available=&page=&page_size=&sort=`（pool 必填；`available=true` 仅备用池 = 未封禁且非加入中）

```jsonc
// pool=reserve
{ "items": [{
    "id": 101, "email": "a@b.com", "pool": "reserve", "status": "mail_pending",
    "initial_balance": 5.0, "has_balance": true, "banned": false, "banned_reason": null,
    "mail_status": "ok", "mail_error": null,
    "imported_at": "...", "last_checked_at": "..."
  }],
  "total": 25,
  "stats": { "mail_pending": 3, "mail_failed": 1, "joining": 2, "banned": 0, "available": 22, "with_balance": 10, "no_balance": 15, "total_balance": 50.0 } }

// pool=main
{ "items": [{
    "id": 201, "email": "x@b.com", "pool": "main", "status": "active",
    "balance": 4.96, "balance_checked_at": "...", "balance_error": null,
    "last_login_at": "...", "sub2api_account_id": 55, "sub2api_uploaded_at": "...",
    "has_refresh_token": true, "remote_status": "active"   // 有 sub2api_account_id 时附带
  }],
  "total": 80,
  "stats": { "active": 70, "authorizing": 5, "needs_reauth": 5, "uploaded": 60, "total_balance": 312.4 } }

// pool=discard
{ "items": [{
    "id": 301, "email": "y@b.com", "pool": "discard", "status": "discarded",
    "discard_reason": "rate_limited_429", "discard_detail": "upstream 429 too many requests ...",
    "balance": 0.2, "discarded_at": "..."
  }],
  "total": 12, "stats": { "banned_401": 8, "rate_limited_429": 2, "repair_failed": 1, "manual": 1 } }
```

### POST /api/v1/accounts/import（备用池导入，弹窗数据一次返回）

```jsonc
// 请求 { "text": "<sub2api 账号导出 JSON：accounts[].notes 携带 mailbox 四段/gpt 密码/two_factor 密钥；",
//        "       credentials 里的 access/refresh token 忽略，条目全部进备用号池，加入主号池走 join-main>",
//        "force_discard": false, "force_remote": false }
//      text 也兼容 tosubV2 跨实例导出（type: tosub2-accounts，带 tokens 依旧直入主号池）
//      与 v1 四段行格式；twofa_text / passwords_text 为旧版增量补录参数，保留兼容（前端已并入 text）
//      本路由单独放宽 bodyLimit 至 32MB（全局 2MB），单次约支持 2500 个账号；超限返回 413 BODY_TOO_LARGE
// 201
{ "created": 25, "main_created": 0,
  "duplicates_in_main": ["e@b.com", "f@b.com"],
  "duplicates_in_reserve": ["d@b.com"],
  "duplicates_in_discard": [{ "email": "g@b.com", "reason": "rate_limited_429" }],
  "duplicates_remote": ["h@b.com"],
  "duplicates_in_batch": ["c@b.com"],
  "invalid_lines": [{ "line": 9, "reason": "clientId 不是 UUID" }] }
```

### POST /api/v1/accounts/:id/refresh-mail → `{ "ok": true }`（重拉邮件初始化）

### POST /api/v1/accounts/join-main

```jsonc
// 请求 { "ids": [101, 102], "order": "balance_desc" }
//       order 可选：balance_desc|balance_asc 按金额（初始余额优先，回退实时余额），
//                   time_desc|time_asc 按加入号池时间（导入时间）；省略 = 按传入顺序
// 202 { "started": [101], "skipped": [{ "id": 102, "reason": "banned" }] }
```

### POST /api/v1/accounts/batch-authorize

```jsonc
// 请求 { "ids": [201, 202] }    // refresh 优先, 失败自动转完整登录
// 202 { "started": 2, "skipped": [{ "id": 203, "reason": "凭据不全" }] }
```

### GET /api/v1/accounts/main-balance-estimate

使用 Sub2API 管理端 `admin_key` 读取远端账号统计接口 `/api/v1/admin/accounts/{id}/stats?days=90` 返回的 `summary.total_cost`，再与初始化余额做差。初始化余额优先使用本地 `accounts.initial_balance`；本地值缺失时，才使用远端账号名末尾严格匹配的 `---N` 非负整数美元后缀（上传时写入的邮件余额整数）。该接口只读，不调用 OpenAI `wham/usage`，不使用 OAuth token，不创建余额任务，也不写入数据库。

```jsonc
// 200
{
  "scope": "main",
  "estimate": true,
  "source": "sub2api_admin_usage_minus_initial_balance",
  "queried_at": "2026-09-05T00:00:00.000Z",
  "account_count": 10,
  "calculable_count": 8,
  "unknown_count": 2,
  "total_estimated_remaining": 123.45,
  "items": [{
    "id": 201, "email": "a@example.com", "initial_balance": 20,
    "initial_balance_source": "local",
    "sub2api_account_id": 31, "used_amount": 4.2,
    "used_amount_source": "used_amount", "estimated_remaining": 15.8,
    "reason": null
  }]
}
```

`initial_balance_source` 为 `local`、`sub2api_name_suffix` 或 `null`。`reason` 可能是 `not_uploaded`、`remote_account_not_found`、`initial_balance_unknown` 或 `remote_used_amount_unknown`。账号名后缀只用于补充缺失的初始化余额；如果统计接口不可用或返回中没有 `summary.total_cost`，仍不会使用账号列表中的 `balance` 或 OpenAI 余额接口替代。

### POST /api/v1/accounts/batch-refresh-balance

```jsonc
// 请求 { "ids": [] }   // 空 = 全部主号池
// 202（异步） { "started": 80 }
// 完成后各账号 balance / balance_error 更新（前端轮询列表）
```

### POST /api/v1/accounts/batch-upload-sub2api

```jsonc
// 请求 { "ids": [201, 202],
//        "order": "time_asc",   // 可选，同 join-main：金额/加入主号池时间升降序；省略 = 按传入顺序
//        "options": { "disable_auto_pause_5h": true, "disable_auto_pause_7d": false,
//                      "group_ids": [1], "concurrency": 10, "load_factor": 1, "priority": 1,
//                      "auto_select_proxy": true, "proxy_id": null,
//                      "model_whitelist": ["gpt-5"] } }   // options 整体可省 = 用存储的默认值
// 200
{ "created": 1, "updated": 1,
  "failed": [{ "id": 202, "email": "x2@b.com", "error": "上游超时" }],
  "updated_account_ids": [201] }
```

### POST /api/v1/accounts/batch-discard — `{ "ids": [...], "detail": "手动废弃" }` → `{ "discarded": 3 }`
### POST /api/v1/accounts/:id/restore → `{ "ok": true, "status": "needs_reauth" }`（废弃→主池）
### POST /api/v1/accounts/batch-delete — `{ "ids": [...] }` → `{ "deleted": 3 }`（连带凭据/checkpoint/产物文件）

### POST /api/v1/accounts（手动添加单账号进主号池，v1 兼容）

```jsonc
// 请求 { "email": "a@b.com", "password": "...", "mail_api_url": "...", "totp_secret": "...",
//        "outlook": { "password": "...", "client_id": "...", "refresh_token": "..." } }  // 凭据至少一项
// 201 { "account": { ...主池视图 }, "job_id": "uuid" }   // 自动创建 login 任务
```

### GET /api/v1/accounts/export

`?ids=1,2&format=sub2api|source`（**GET 下载**，带 Cookie；sub2api=合并导入 JSON 附件，source=txt 附件 `邮箱----密码----API----2FA`）。

### GET /api/v1/accounts/:id/events — 流转审计

```jsonc
{ "items": [ { "type": "imported", "detail": {...}, "created_at": "..." }, ... ] }
```

## 4. 任务（jobs）

### GET /api/v1/jobs

`?status=&account_id=&type=&page=&page_size=`

```jsonc
{ "items": [{
    "id": "0b9f...", "account_id": 201, "email": "a@b.com",   // email 冗余便于展示
    "type": "login", "status": "awaiting_input", "stage": "email_otp",
    "prompt_kind": "email_otp", "attempt": 2, "proxy_display": "http://u:***@1.2.3.4:8080",
    "error": null, "created_at": "...", "started_at": "...", "finished_at": null,
    "can_cancel": true, "can_retry": false, "can_input": true
  }],
  "total": 7,
  "stats": { "queued": 2, "running": 3, "awaiting_input": 2 } }
```

### GET /api/v1/jobs/:id → 上条结构单体（含 `has_result / can_download`）
### GET /api/v1/jobs/:id/logs

`?after=<byteOffset>&limit=65536` → `{ "chunk": "...", "next_offset": 10240, "eof": false }`

### POST /api/v1/jobs/:id/input

```jsonc
// 请求 { "action": "input", "value": "123456" }
//      { "action": "resend" } | { "action": "quit" }
// 200 { "ok": true }   // 409 JOB_NOT_AWAITING_INPUT / value 与 prompt_kind 不匹配 → 422
```

### POST /api/v1/jobs/:id/cancel → `{ "job": {...} }`（终态任务 409）
### POST /api/v1/jobs/:id/retry — `{ "proxy_id": 5 }` 可选 → `202 { "job": {...} }`
### POST /api/v1/jobs/cancel-all → `{ "canceled": 5 }`
### POST /api/v1/jobs/cleanup — `{ "days": 30 }` → `{ "deleted": 120 }`

手动清理 N 天前结束的终态任务（连日志/产物文件）；任务默认全量保留，不做自动清理。`days` 取值 0-3650。`GET /api/v1/jobs` 的 `status=active` 为聚合页签（= queued/running/awaiting_input）。

## 5. sub2api

### GET /api/v1/sub2api/config

```jsonc
{ "base_url": "http://127.0.0.1:8080", "admin_key_masked": "sk-****abcd", "has_admin_key": true,
  "group_ids": [1], "upload_defaults": { ...同 02 §3.3... },
  "monitor": { "enabled": true, "interval_minutes": 5, "...": "..." } }
```

### PUT /api/v1/sub2api/config

```jsonc
// 请求同上结构；admin_key 传 "" 或 "****" = 保持不变
// 200 { "config": <脱敏视图> }
// 422 base_url 非 http(s)
```

### POST /api/v1/sub2api/test — `{ "base_url"?, "admin_key"? }`（可用请求体临时配置测试，不落库）
→ `200 { "ok": true, "groups": 4, "latency_ms": 230 }` / `502 SUB2API_UNAVAILABLE`

### GET /api/v1/sub2api/groups → `{ "items": [{ "id": 1, "name": "主力池", "status": "active" }] }`
### GET /api/v1/sub2api/proxies → `{ "items": [{ "id", "name", "protocol", "host", "port", "ip_address", "status" }] }`
### GET /api/v1/sub2api/remote-accounts?email=a@b.com

```jsonc
{ "found": true, "account": { "id": 55, "name": "oauth---a@b.com---5", "status": "active",
  "error_message": null, "group_ids": [1], "proxy_id": 2 } }
```

### GET /api/v1/sub2api/monitor

```jsonc
{ "enabled": true, "running": false, "interval_minutes": 5,
  "last_check_at": "...", "next_check_at": "...", "last_error": null,
  "last_result": { "error_accounts": 4, "discarded": 1, "repairing": 2, "replenished": 0 } }
```

### POST /api/v1/sub2api/monitor — `{ "enabled": true, ...可同时改 monitor 配置字段 }` → 监控视图

```jsonc
// 自动补号挑号顺序（monitor 字段，取值同 accounts 接口的 order 枚举）：
//   replenish_upload_order：主池库存上传 sub2api 的挑号顺序，默认 balance_asc（余额小优先）
//   replenish_join_order：备用池登录补入主号池的挑号顺序，默认 balance_desc（有余额、金额大优先）
```
### POST /api/v1/sub2api/monitor/check → `202 { "ok": true }`（手动触发一轮，结果轮询 monitor 视图）

## 6. 设置（settings）

### GET /api/v1/settings

```jsonc
{ "outlook_fetch_mode": "microsoft_direct",
  "max_concurrent_jobs": 20, "job_timeout_minutes": 30, "proxy_fail_threshold": 3,
  "sms": { "active": "smsbower",
           "providers": { "luban": { "configured": true }, "smsbower": { "configured": true },
                          "custom": { "configured": false, "count": 0 } } } }
```

### PUT /api/v1/settings — 同结构请求（未包含的键不动）→ `200` 脱敏视图

`outlook_fetch_mode` 为只读固定值。旧 `outlook_fetch_endpoint` 已移除，提交该字段返回 `422 VALIDATION`；数据库中遗留的 `outlook.fetch` 配置不会用于取件。

### POST /api/v1/settings/sms-provider — 保存接码平台配置（api_key 服务端加密，响应回 masked）

## 7. 概览与健康

### GET /api/v1/dashboard/summary

```jsonc
{ "pools": { "reserve": 25, "main": 80, "discard": 12 },
  "reserve_available": 22,                      // 非 banned 非 joining
  "main_active": 70, "main_total_balance": 312.4,
  "proxies": { "alive": 30, "dead": 8, "cf_challenge": 2, "unknown": 2 },
  "jobs": { "queued": 2, "running": 3, "awaiting_input": 2 },
  "monitor": { "enabled": true, "last_check_at": "...", "last_error": null },
  "recent_events": [ { "email": "a@b.com", "type": "moved_to_discard",
                       "detail": { "reason": "rate_limited_429" }, "created_at": "..." } ] }
```

### GET /api/v1/health（免认证）→ `{ "ok": true, "version": "2.0.0", "uptime_s": 12345 }`

## 8. HTTP 状态码使用约定

| 状态 | 场景 |
|---|---|
| 200/201/202 | 成功 / 创建 / 异步受理（轮询获取结果） |
| 401 | 未认证 |
| 403 | CSRF 校验失败 / 操作不被允许 |
| 404 | 资源不存在（或远端 sub2api 404 透传语义） |
| 409 | 状态冲突（重复测活批次、终态任务取消、账号被并发占用） |
| 422 | 请求体校验失败（Fastify validation 错误转 `VALIDATION` + details） |
| 429 | 登录限流 |
| 502 | 上游（sub2api / Outlook 取件 / OpenAI）失败，message 已脱敏 |
