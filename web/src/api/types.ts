/** 与 05-API接口规范 一一对应的 TS 类型 */

export type Pool = 'reserve' | 'main' | 'discard';
export type JobStatus = 'queued' | 'running' | 'awaiting_input' | 'completed' | 'failed' | 'canceled';
export type JobType = 'login' | 'refresh' | 'balance' | 'totp_setup';
export type ProxyStatus = 'unknown' | 'alive' | 'cf_challenge' | 'dead' | 'testing';
export type PromptKind = 'password' | 'email_otp' | 'mfa_otp' | 'totp_setup_otp' | 'phone' | 'phone_otp';

export interface ApiErrorBody {
  error: { code: string; message: string; [k: string]: unknown };
}

export interface SessionInfo {
  authenticated: boolean;
  password_initialized: boolean;
  expires_at: string | null;
  sessions_count?: number;
}

export interface SessionItem {
  created_at: string;
  expires_at: string;
  last_seen_at: string;
  ip: string | null;
  user_agent: string | null;
  current: boolean;
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
  stats?: Record<string, number>;
}

export interface Proxy {
  id: number;
  display_url: string;
  label: string | null;
  protocol: string;
  status: ProxyStatus;
  last_latency_ms: number | null;
  last_checked_at: string | null;
  fail_count: number;
  rotatable: boolean;
  last_error: string | null;
  created_at: string;
}

export interface ReserveAccount {
  id: number;
  email: string;
  pool: 'reserve';
  status: string;
  initial_balance: number | null;
  has_balance: boolean;
  banned: boolean;
  banned_reason: string | null;
  mail_status: 'pending' | 'checking' | 'ok' | 'fetch_failed' | null;
  mail_error: string | null;
  imported_at: string | null;
  last_checked_at: string | null;
  has_2fa: boolean;
  has_password: boolean;
}

export interface MainBalanceEstimateItem {
  id: number;
  email: string;
  initial_balance: number | null;
  initial_balance_source: 'local' | 'sub2api_name_suffix' | null;
  sub2api_account_id: number | null;
  used_amount: number | null;
  used_amount_source: string | null;
  estimated_remaining: number | null;
  reason: 'not_uploaded' | 'remote_account_not_found' | 'initial_balance_unknown' | 'remote_used_amount_unknown' | null;
}

export interface MainBalanceEstimate {
  scope: 'main';
  estimate: true;
  source: string;
  queried_at: string;
  account_count: number;
  calculable_count: number;
  unknown_count: number;
  total_estimated_remaining: number;
  items: MainBalanceEstimateItem[];
}

export interface MainAccount {
  id: number;
  email: string;
  pool: 'main';
  status: 'active' | 'authorizing' | 'needs_reauth' | string;
  balance: number | null;
  balance_checked_at: string | null;
  balance_error: string | null;
  last_login_at: string | null;
  sub2api_account_id: number | null;
  sub2api_uploaded_at: string | null;
  remote_status: string | null;
  has_refresh_token: boolean;
  has_password: boolean;
  has_totp: boolean;
  has_2fa: boolean;
  auto_repair_blocked: boolean;
}

export interface DiscardAccount {
  id: number;
  email: string;
  pool: 'discard';
  status: string;
  discard_reason: 'banned_401' | 'rate_limited_429' | 'repair_failed' | 'login_failed' | 'manual' | null;
  discard_detail: string | null;
  balance: number | null;
  banned: boolean;
  discarded_at: string | null;
}

export type Account = ReserveAccount | MainAccount | DiscardAccount;

/** 备用池账号凭据的脱敏视图（当前值掩码显示） */
export interface AccountCredentialsView {
  password: string | null;
  totp_pickup_code: string | null;
  totp_secret: string | null;
  outlook: {
    password: string | null;
    client_id: string | null;
    refresh_token: string | null;
  };
}

export interface ImportResult {
  created: number;
  /** 其中从 tosubV2 导出文件直入主号池（带 OAuth tokens）的数量 */
  main_created?: number;
  accounts?: { id: number; email: string; status: string; pool?: string }[];
  duplicates_in_batch: string[];
  duplicates_in_reserve: string[];
  duplicates_in_main: string[];
  duplicates_in_discard: { email: string; reason: string }[];
  duplicates_remote: string[];
  invalid_lines: { line: number; reason: string }[];
  twofa_bound?: number;
  twofa_unmatched?: string[];
  twofa_invalid_lines?: { line: number; reason: string }[];
  passwords_bound?: number;
  passwords_unmatched?: string[];
  passwords_error?: string | null;
}

export interface ProxyImportResult {
  created: number;
  duplicates: string[];
  invalid_lines: { line: number; reason: string }[];
}

export interface Job {
  id: string;
  account_id: number | null;
  email: string | null;
  type: JobType;
  status: JobStatus;
  stage: string | null;
  prompt_kind: PromptKind | null;
  attempt: number;
  proxy_id: number | null;
  proxy_display: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  has_result?: boolean;
  can_cancel: boolean;
  can_retry: boolean;
  can_input: boolean;
}

export interface UploadOptions {
  group_ids?: number[];
  concurrency?: number | null;
  load_factor?: number | null;
  priority?: number | null;
  model_whitelist?: string[];
  disable_auto_pause_5h?: boolean;
  disable_auto_pause_7d?: boolean;
  enable_long_context_billing?: boolean;
  auto_select_proxy?: boolean;
  proxy_id?: number | null;
}

/** 批量「加入主号池 / 上传 sub2api」顺序：按金额或加入号池时间，空 = 按勾选顺序 */
export type UploadOrder = 'balance_desc' | 'balance_asc' | 'time_desc' | 'time_asc';

export interface Sub2ApiMonitorConfig {
  enabled: boolean;
  interval_minutes: number;
  cooldown_minutes: number;
  auto_repair: boolean;
  max_repair_attempts: number;
  auto_replenish: boolean;
  /** 巡检时顺带刷新已上传号的余额（默认关，需显式开启） */
  refresh_balance?: boolean;
  /** 巡检查余额最小间隔（分钟），0=每轮都查（默认 60） */
  balance_refresh_interval_minutes?: number;
  reserve_threshold: number;
  /** 主池库存保底（备用池 → 主池登录补入水位）：null=沿用 reserve_threshold，0=不从备用池自动补入 */
  main_stock_threshold?: number | null;
  /** 补号触发口径：count=按账号数量（默认）；resource=按在架号总并发 + 初始总余额 */
  replenish_mode?: 'count' | 'resource';
  /** resource 口径：sub2api 在架号总并发保底 */
  concurrency_target?: number;
  /** resource 口径：初始总余额保底（USD） */
  initial_balance_target?: number;
  /** 自动补号挑号顺序：主池库存上传（默认 balance_asc 余额小优先） */
  replenish_upload_order?: UploadOrder;
  /** 自动补号挑号顺序：备用池登录补入（默认 balance_desc 金额大优先） */
  replenish_join_order?: UploadOrder;
  pause_on_discard?: boolean;
  rate_limit_reset_threshold_hours?: number;
  banned_patterns: string[];
  rate_limit_patterns: string[];
}

export interface Sub2ApiMonitorLogItem {
  email: string | null;
  remote_id: number | null;
  action: 'discarded' | 'repairing' | 'ban_unconfirmed' | 'rate_limited_waiting' | 'uploaded' | 'upload_failed' | 'ignored' | string;
  reason: string;
  detail: string;
}

export interface Sub2ApiMonitorLog {
  id: number;
  source: string;
  started_at: string;
  finished_at: string | null;
  status: 'running' | 'done' | 'failed' | string;
  error: string | null;
  summary: {
    scanned?: number;
    error_accounts?: number;
    rate_limited?: number;
    discarded?: number;
    ban_unconfirmed?: number;
    repairing?: number;
    uploaded?: number;
    replenished?: number;
    available_count?: number | null;
    stock_count?: number | null;
    balance_queued?: number;
    balance_skipped_fresh?: number;
    fleet_concurrency?: number;
    fleet_initial_balance?: number;
  };
  items: Sub2ApiMonitorLogItem[];
}

export interface Sub2ApiConfigView {
  base_url: string;
  admin_key_masked: string;
  has_admin_key: boolean;
  group_ids: number[];
  upload_defaults: UploadOptions;
  join_auto_upload?: boolean;
  monitor: Sub2ApiMonitorConfig;
}

export interface Sub2ApiProxyView {
  id: number;
  name: string;
  protocol: string;
  host: string;
  port: number;
  ip_address: string | null;
  status: string;
  account_count: number;
}

export interface Sub2ApiProxyReplaceResult {
  created: { id: number; name: string; host: string; port: number }[];
  reused: { id: number; name: string; host: string; port: number }[];
  create_failed: { proxy: string; reason: string }[];
  invalid_lines: { line: number; reason: string }[];
  duplicates_in_input: number;
  name_start: number;
  rebound: {
    total: number;
    groups: { proxy_id: number; name: string; count: number }[];
    failed_groups: { proxy_id: number; name: string; count: number; reason: string }[];
  };
  old_proxies: {
    deleted: number;
    skipped: { id: number; name: string; reason: string }[];
  };
}

export interface Sub2ApiMonitorView {
  enabled: boolean;
  running: boolean;
  interval_minutes: number;
  auto_repair: boolean;
  max_repair_attempts: number;
  auto_replenish: boolean;
  refresh_balance?: boolean;
  reserve_threshold: number;
  main_stock_threshold?: number | null;
  last_check_at: string | null;
  next_check_at: string | null;
  last_error: string | null;
  last_result: {
    scanned?: number;
    error_accounts: number;
    rate_limited?: number;
    discarded: number;
    ban_unconfirmed?: number;
    repairing: number;
    uploaded?: number;
    replenished: number;
    available_count?: number | null;
    stock_count?: number | null;
    balance_queued?: number;
    balance_skipped_fresh?: number;
    fleet_concurrency?: number;
    fleet_initial_balance?: number;
    remote_sync?: { scanned?: number; linked?: number; unlinked?: number; status_updated?: number };
  } | null;
}

export interface Sub2ApiSyncResult {
  ok: boolean;
  scanned: number;
  linked: number;
  unlinked: number;
  status_updated: number;
}

export interface DashboardSummary {
  pools: { reserve: number; main: number; discard: number };
  reserve_available: number;
  main_active: number;
  main_total_balance: number;
  proxies: { alive: number; dead: number; cf_challenge: number; unknown: number };
  jobs: { queued: number; running: number; awaiting_input: number };
  monitor: { enabled: boolean; last_check_at: string | null; last_error: string | null; last_result: Record<string, number> | null };
  recent_events: { email: string; type: string; detail: Record<string, unknown> | null; created_at: string }[];
}

// ---------- team 号池 ----------
export type TeamCardStatus = 'unextracted' | 'healthy' | 'need_reclaim' | 'cannot_reclaim' | 'mixed';

export interface TeamCard {
  id: number;
  card_code: string;
  status: TeamCardStatus | string;
  health: { summary: Record<string, number> | null; checked_at?: string; aggregate_only?: boolean } | null;
  note: string | null;
  last_extracted_at: string | null;
  last_reclaim_at: string | null;
  created_at: string;
  updated_at: string;
  account_count: number;
  uploaded_count: number;
}

export interface TeamAccount {
  id: number;
  card_id: number;
  card_code: string;
  email: string;
  short_name: string | null;
  name: string | null;
  health_status: 'healthy' | 'need_reclaim' | 'cannot_reclaim' | 'unknown' | null;
  sub2api_account_id: number | null;
  sub2api_uploaded_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TeamCardImportResult {
  imported: number;
  /** 本次新导入卡密的 ID（供导入后立即自动提取） */
  imported_ids: number[];
  duplicates_in_batch: string[];
  duplicates_existing: string[];
  invalid: { line: number; value: string }[];
}

export interface TeamSession {
  running: boolean;
  kind: 'health_check' | 'reclaim' | null;
  phase: string | null;
  message: string;
  progress: {
    done?: number;
    total?: number;
    batch?: number;
    batches?: number;
    tasks_done?: number;
    tasks_total?: number;
    pending?: number;
    downloaded?: number;
    download_total?: number;
  } | null;
  result: Record<string, unknown> | null;
  error: string | null;
  started_at: string | null;
  updated_at: string | null;
}

export interface TeamUploadResult {
  created: number;
  updated: number;
  failed: { id: number; email: string | null; error: string }[];
  updated_account_ids?: number[];
}

export interface TeamConfigView {
  redeem_base_url: string;
  auto_upload_after_reclaim: boolean;
  group_ids: number[];
  upload_defaults: UploadOptions;
}

export interface SettingsView {
  outlook_fetch_endpoint: string;
  twofa_fetch_template: string;
  max_concurrent_jobs: number;
  job_timeout_minutes: number;
  proxy_fail_threshold: number;
  strict_proxy: boolean;
  join_auto_upload: boolean;
  sms: {
    active: string;
    providers: {
      luban: { configured: boolean; service_id: string };
      smsbower: { configured: boolean; country: string; country_label: string };
      custom: { configured: boolean; count: number };
    };
  };
}

export const STAGE_LABELS: Record<string, string> = {
  web_login: '进入登录',
  email_otp: '邮箱验证码',
  password: '密码验证',
  mfa_otp: '两步验证',
  totp_setup_otp: '2FA 设置',
  about_you: '补充资料',
  add_phone: '绑定手机',
  phone_otp: '短信验证码',
  oauth: 'OAuth 授权',
  workspace: '选择工作区',
  finalizing: '生成导入文件',
  refreshing: '刷新令牌',
};

export const PROMPT_LABELS: Record<string, string> = {
  password: '登录密码',
  email_otp: '邮箱验证码',
  mfa_otp: '两步验证码',
  totp_setup_otp: '2FA 设置验证码',
  phone: '手机号',
  phone_otp: '短信验证码',
};

/** 与服务端永久失败判定保持一致（含中文封禁文案），用于失败任务的封禁标注。 */
const BANNED_ERROR_PATTERN =
  /account_deactivated|account_deleted|account_suspended|deactivated|permanently\s+deleted|suspended|(?:账户|帐号|账号)(?:已|现已)?(?:被)?(?:停用|禁用|封禁)|【账号已停用\/封禁】/i;

export function isBannedJobError(message?: string | null): boolean {
  return BANNED_ERROR_PATTERN.test(String(message || ''));
}
