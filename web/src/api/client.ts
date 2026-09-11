export class ApiError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const BASE = '/api/v1';

interface RequestOptions {
  method?: string;
  json?: unknown;
  headers?: Record<string, string>;
}

export async function api<T>(path: string, init?: RequestOptions): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: init?.method ?? (init?.json !== undefined ? 'POST' : 'GET'),
    headers: {
      'X-Requested-With': 'XMLHttpRequest',
      ...(init?.json !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
    body: init?.json !== undefined ? JSON.stringify(init.json) : undefined,
    credentials: 'same-origin',
  });
  if (res.status === 401 && !path.startsWith('/auth/')) {
    window.dispatchEvent(new CustomEvent('tosub2:unauthorized'));
    throw new ApiError('UNAUTHORIZED', '登录已过期');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(
      (body as { error?: { code?: string } })?.error?.code ?? 'UNKNOWN',
      (body as { error?: { message?: string } })?.error?.message ?? `HTTP ${res.status}`,
    );
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

/** 文件下载（导出/产物下载，GET 带 Cookie） */
export async function download(path: string, fallbackName: string): Promise<void> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
    credentials: 'same-origin',
  });
  if (!res.ok) throw new ApiError('DOWNLOAD_FAILED', '下载失败');
  const blob = await res.blob();
  const disposition = res.headers.get('content-disposition') || '';
  const match = /filename="?([^";]+)"?/.exec(disposition);
  const name = match?.[1] ?? fallbackName;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/**
 * 服务端错误码 → 中文文案。
 * 与 server/lib/http-errors.js 的 errors 工厂 + 各模块 ad-hoc 码保持同步；
 * 未列出的码回退到服务端 message，不吞掉细节。
 */
export const ERROR_LABELS: Record<string, string> = {
  UNAUTHORIZED: '登录已过期',
  FORBIDDEN: '操作不被允许',
  CSRF_REJECTED: '请求校验失败，请刷新页面重试',
  NOT_FOUND: '资源不存在',
  VALIDATION: '请求参数不合法',
  CONFLICT: '状态冲突，请刷新后重试',
  RATE_LIMITED: '操作过于频繁',
  BODY_TOO_LARGE: '内容过大，请分批提交',
  INTERNAL: '服务器内部错误',
  UPSTREAM_ERROR: '上游服务返回异常',
  SUB2API_NOT_CONFIGURED: '请先配置 sub2api',
  SUB2API_UNAVAILABLE: 'sub2api 连接失败',
  SUB2API_PROXY_CREATE_FAILED: 'sub2api 代理创建失败',
  ACCOUNT_STATE_INVALID: '账号状态已变化，请刷新',
  POOL_TRANSFER_CONFLICT: '号池状态已变化，请刷新',
  JOB_NOT_CANCELABLE: '任务已结束，无法取消',
  JOB_NOT_AWAITING_INPUT: '任务当前不在等待输入状态',
  JOB_NOT_RETRYABLE: '任务仍在进行，无法重试',
  NO_ALIVE_PROXY: '无可用代理（已开启禁止直连）',
  TEAM_SESSION_BUSY: '已有会话在执行，请等待完成',
  TEST_RUNNING: '已有测试在执行，请稍后',
  REDEEM_NOT_CONFIGURED: '请先配置卡密兑换地址',
  REDEEM_UNAVAILABLE: '卡密兑换服务不可达',
  REDEEM_API_ERROR: '卡密兑换接口返回错误',
  INVALID_PASSWORD: '密码不正确',
  DOWNLOAD_FAILED: '下载失败',
  UNKNOWN: '请求失败',
};

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return ERROR_LABELS[error.code] ?? error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}
