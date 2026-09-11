import { api, download } from './client';
import type {
  AccountCredentialsView,
  DashboardSummary,
  DiscardUsageSyncResult,
  ImportResult,
  Job,
  MainAccount,
  MainBalanceEstimate,
  Paged,
  Pool,
  Proxy,
  ProxyImportResult,
  ReserveAccount,
  DiscardAccount,
  SessionInfo,
  SessionItem,
  SettingsView,
  Sub2ApiConfigView,
  Sub2ApiMonitorLog,
  Sub2ApiMonitorView,
  Sub2ApiProxyReplaceResult,
  Sub2ApiProxyView,
  Sub2ApiSyncResult,
  TeamCard,
  TeamCardImportResult,
  TeamConfigView,
  TeamSession,
  TeamUploadResult,
  TeamAccount,
  UploadOptions,
  UploadOrder,
} from './types';

/** 账号导出格式 */
export type AccountExportFormat = 'tosub2' | 'sub2api' | 'source';

// ---------- auth ----------
export const authApi = {
  session: () => api<SessionInfo>('/auth/session'),
  login: (body: { password?: string; new_password?: string }) =>
    api<{ ok: boolean; password_initialized?: boolean }>('/auth/login', { json: body }),
  logout: () => api<{ ok: boolean }>('/auth/logout', { json: {} }),
  logoutAll: () => api<{ ok: boolean; revoked: number }>('/auth/logout-all', { json: {} }),
  sessions: () => api<{ items: SessionItem[] }>('/auth/sessions'),
  changePassword: (body: { current_password: string; new_password: string }) =>
    api<{ ok: boolean }>('/auth/password', { json: body }),
};

// ---------- proxies ----------
export interface ProxyFilter {
  status?: string;
  q?: string;
  page?: number;
  page_size?: number;
}

export const proxiesApi = {
  list: (f: ProxyFilter = {}) =>
    api<Paged<Proxy> & { stats: Record<string, number> }>(`/proxies?${toQuery(f)}`),
  import: (text: string) => api<ProxyImportResult>('/proxies/import', { json: { text } }),
  test: (ids?: number[]) => api<{ started: number }>('/proxies/test', { json: ids?.length ? { ids } : {} }),
  updateLabel: (id: number, label: string) => api<Proxy>(`/proxies/${id}`, { method: 'PATCH', json: { label } }),
  remove: (id: number) => api<{ ok: boolean }>(`/proxies/${id}`, { method: 'DELETE' }),
  batchRemove: (ids: number[]) => api<{ deleted: number }>('/proxies/batch-delete', { json: { ids } }),
};

// ---------- accounts ----------
export interface AccountFilter {
  q?: string;
  status?: string;
  banned?: string;
  has_balance?: string;
  available?: string;
  reason?: string;
  uploaded?: string;
  remote_status?: string;
  discarded_from?: string;
  discarded_to?: string;
  page?: number;
  page_size?: number;
  sort?: string;
}

export const accountsApi = {
  list: <T extends ReserveAccount | MainAccount | DiscardAccount>(pool: Pool, f: AccountFilter = {}) =>
    api<Paged<T> & { stats: Record<string, number> }>(`/accounts?pool=${pool}&${toQuery(f)}`),
  mainBalanceEstimate: () => api<MainBalanceEstimate>('/accounts/main-balance-estimate'),
  import: (
    text: string,
    opts: { force_discard?: boolean; force_remote?: boolean; adopt_remote?: boolean } = {},
  ) => api<ImportResult>('/accounts/import', { json: { text, ...opts } }),
  create: (body: Record<string, unknown>) =>
    api<{ account: MainAccount; job_id: string }>('/accounts', { json: body }),
  refreshMail: (id: number) => api<{ ok: boolean }>(`/accounts/${id}/refresh-mail`, { json: {} }),
  credentials: (id: number) =>
    api<{ credentials: AccountCredentialsView }>(`/accounts/${id}/credentials`),
  updateCredentials: (id: number, body: Record<string, string>) =>
    api<{ account: ReserveAccount; credentials: AccountCredentialsView }>(`/accounts/${id}/credentials`, {
      method: 'PATCH',
      json: body,
    }),
  joinMain: (ids: number[], order?: UploadOrder, force = false) =>
    api<{ started: number[]; skipped: { id: number; reason: string }[] }>('/accounts/join-main', {
      json: { ids, order, force },
    }),
  batchAuthorize: (ids: number[]) =>
    api<{ started: number; skipped: { id: number; reason: string }[] }>('/accounts/batch-authorize', { json: { ids } }),
  batchRefreshBalance: (ids: number[]) => api<{ started: number }>('/accounts/batch-refresh-balance', { json: { ids } }),
  batchUpload: (ids: number[], options?: UploadOptions, order?: UploadOrder) =>
    api<{ created: number; updated: number; failed: { id: number; email: string | null; error: string }[]; updated_account_ids: number[] }>(
      '/accounts/batch-upload-sub2api',
      { json: { ids, options, order } },
    ),
  batchDiscard: (ids: number[]) => api<{ discarded: number }>('/accounts/batch-discard', { json: { ids } }),
  restore: (id: number) => api<{ ok: boolean; status: string }>(`/accounts/${id}/restore`, { json: {} }),
  /** 批量移回主号池：替代 N 次串行单条 restore */
  batchRestore: (ids: number[]) =>
    api<{ restored: number; skipped: number }>('/accounts/batch-restore', { json: { ids } }),
  batchDelete: (ids: number[]) => api<{ deleted: number }>('/accounts/batch-delete', { json: { ids } }),
  events: (id: number) =>
    api<{ items: { type: string; detail: Record<string, unknown> | null; created_at: string }[] }>(`/accounts/${id}/events`),

  // ---------- 废弃池「已用额度」 ----------
  /**
   * 从 sub2api 拉取废弃号的累计已用额度并落库。
   *  - 给了 ids：只同步这些账号（选中项）；
   *  - 只给 filters：同步当前筛选下待同步的账号（与按钮上的「待同步 N」同一口径）；
   *  - 都不给：全池待同步。
   * force=true 时忽略快照新旧全量重算。
   */
  syncDiscardUsage: (
    body: { ids?: number[]; force?: boolean; filters?: Pick<AccountFilter, 'q' | 'reason' | 'discarded_from' | 'discarded_to'> } = {},
  ) => api<DiscardUsageSyncResult>('/accounts/discard-usage-sync', { json: body }),

  /** 导出（GET 下载，带 Cookie） */
  exportUrl: (params: { ids?: number[]; pool?: Pool; format: AccountExportFormat }) =>
    `/accounts/export?${toQuery({
      ids: params.ids?.length ? params.ids.join(',') : undefined,
      pool: params.pool,
      format: params.format,
    })}`,
  /**
   * 按当前筛选取出全部 id（「选中全部 N 条」用）。
   * 批量接口只收 id 列表，因此由服务端按与列表相同的口径解析，前端再按 maxItems 分片。
   */
  idsByFilter: (filter: AccountFilter & { pool: Pool; limit?: number }) =>
    api<{ ids: number[]; total: number; truncated: boolean }>(`/accounts/ids?${toQuery(filter)}`),
  /**
   * 按当前筛选导出。
   * 勾选「全部 N 条」时 ids 可能有几千个，塞进 query string 会超长，
   * 因此改为把筛选条件传给服务端，由它用与列表完全相同的口径解析行集合。
   */
  exportByFilterUrl: (filter: AccountFilter & { pool: Pool; format: AccountExportFormat }) =>
    `/accounts/export-by-filter?${toQuery(filter)}`,
};

// ---------- jobs ----------
export interface JobFilter {
  status?: string;
  type?: string;
  q?: string;
  page?: number;
  page_size?: number;
  /** 只取计数：全局待输入提醒用，避免拉回整页任务行 */
  stats_only?: string;
  /** 只取任务行：不重算 stats */
  items_only?: string;
}

export const jobsApi = {
  list: (f: JobFilter = {}) =>
    api<Paged<Job> & { stats: { queued: number; running: number; awaiting_input: number } }>(`/jobs?${toQuery(f)}`),
  /** 轻量计数：全局提醒轮询用（不返回任务行） */
  stats: () =>
    api<{ total: number; stats: { queued: number; running: number; awaiting_input: number } }>(
      '/jobs?stats_only=1&page_size=1',
    ),
  get: (id: string) => api<Job & { can_download?: boolean }>(`/jobs/${id}`),
  logs: (id: string, after: number, limit = 65536) =>
    api<{ chunk: string; next_offset: number; eof: boolean }>(`/jobs/${id}/logs?after=${after}&limit=${limit}`),
  input: (id: string, action: string, value?: string) =>
    api<{ ok: boolean }>(`/jobs/${id}/input`, { json: { action, value } }),
  cancel: (id: string) => api<{ job: Job }>(`/jobs/${id}/cancel`, { json: {} }),
  retry: (id: string, proxy_id?: number) => api<{ job: Job }>(`/jobs/${id}/retry`, { json: { proxy_id } }),
  cancelAll: () => api<{ canceled: number }>('/jobs/cancel-all', { json: {} }),
  cleanup: (days: number) => api<{ deleted: number }>('/jobs/cleanup', { json: { days } }),
};

// ---------- sub2api ----------
export const sub2apiApi = {
  config: () => api<Sub2ApiConfigView>('/sub2api/config'),
  updateConfig: (body: Record<string, unknown>) => api<{ config: Sub2ApiConfigView }>('/sub2api/config', {
    method: 'PUT',
    json: body,
  }),
  test: (body: { base_url?: string; admin_key?: string } = {}) =>
    api<{ ok: boolean; groups: number; latency_ms: number }>('/sub2api/test', { json: body }),
  groups: () => api<{ items: { id: number; name: string; status: string }[] }>('/sub2api/groups'),
  proxies: () => api<{ items: Sub2ApiProxyView[] }>('/sub2api/proxies'),
  replaceProxies: (body: { text: string; protocol: string; delete_old: boolean }) =>
    api<Sub2ApiProxyReplaceResult>('/sub2api/proxies/replace', { json: body }),
  remoteAccount: (email: string) =>
    api<{ found: boolean; account: { id: number; name: string; status: string; error_message: string | null } | null }>(
      `/sub2api/remote-accounts?email=${encodeURIComponent(email)}`,
    ),
  monitor: () => api<Sub2ApiMonitorView>('/sub2api/monitor'),
  monitorLogs: (limit = 20) => api<{ items: Sub2ApiMonitorLog[] }>(`/sub2api/monitor/logs?limit=${limit}`),
  updateMonitor: (body: Record<string, unknown>) => api<Sub2ApiMonitorView>('/sub2api/monitor', { json: body }),
  checkNow: () => api<{ ok: boolean; monitor: Sub2ApiMonitorView }>('/sub2api/monitor/check', { json: {} }),
  syncRemote: () => api<Sub2ApiSyncResult>('/sub2api/sync-remote', { method: 'POST', json: {} }),
};

// ---------- settings / dashboard ----------
export const settingsApi = {
  get: () => api<SettingsView>('/settings'),
  update: (body: Record<string, unknown>) => api<SettingsView>('/settings', { method: 'PUT', json: body }),
  saveSmsProvider: (body: Record<string, unknown>) => api<SettingsView>('/settings/sms-provider', { json: body }),
};

export const dashboardApi = {
  summary: () => api<DashboardSummary>('/dashboard/summary'),
};

// ---------- team 号池 ----------
export interface TeamCardFilter {
  status?: string;
  q?: string;
  page?: number;
  page_size?: number;
}

export interface TeamAccountFilter {
  status?: string;
  uploaded?: string;
  card_id?: number;
  q?: string;
  page?: number;
  page_size?: number;
}

export const teamApi = {
  cards: (f: TeamCardFilter = {}) =>
    api<Paged<TeamCard> & { stats: Record<string, number> }>(`/team/cards?${toQuery(f)}`),
  importCards: (text: string) => api<TeamCardImportResult>('/team/cards/import', { json: { text } }),
  deleteCards: (ids: number[]) => api<{ deleted: number }>('/team/cards/batch-delete', { json: { ids } }),
  accounts: (f: TeamAccountFilter = {}) =>
    api<Paged<TeamAccount> & { stats: Record<string, number> }>(`/team/accounts?${toQuery(f)}`),
  stats: () =>
    api<{ cards: Record<string, number>; accounts: Record<string, number> }>('/team/stats'),
  healthCheck: (ids: number[]) => api<{ session: TeamSession }>('/team/health-check', { json: { ids } }),
  reclaim: (ids: number[], mode: '401' | 'all') =>
    api<{ session: TeamSession }>('/team/reclaim', { json: { ids, mode } }),
  session: () => api<TeamSession>('/team/session'),
  upload: (accountIds: number[]) => api<TeamUploadResult>('/team/upload', { json: { account_ids: accountIds } }),
  config: () => api<TeamConfigView>('/team/config'),
  updateConfig: (body: Record<string, unknown>) => api<{ config: TeamConfigView }>('/team/config', {
    method: 'PUT',
    json: body,
  }),
};

function toQuery(obj: object): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  return params.toString();
}
