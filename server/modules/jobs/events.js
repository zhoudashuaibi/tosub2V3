/**
 * json-events 事件 → 状态迁移（纯函数表，重点单测对象）。
 * 输入 (job 视图, event) → 输出 { jobPatch, accountPatch, accountEvents[], actions[] }
 * 不做任何 IO；副作用（落库 / 产物解析）由 engine 执行。
 *
 * 登录由 redeem401 子进程完成（无人工交互），事件面收敛为：
 * starting / stage / log / balance / result_saved / error / exit。
 */

const TERMINAL = new Set(['completed', 'failed', 'canceled']);

/** 永久性账号失败关键字（03 §9）：账号标记 auto_repair_blocked，监控永不自动修复。 */
const PERMANENT_FAILURE_PATTERN =
  /account_deactivated|account_deleted|account_suspended|deactivated|permanently\s+deleted/i;

export function isPermanentAccountFailure(errorMessage) {
  return PERMANENT_FAILURE_PATTERN.test(String(errorMessage || ''));
}

/** 用户主动放弃（quit 指令 → "Stopped before ..." 错误）。 */
export function isUserQuit(errorMessage) {
  return /^Stopped before /i.test(String(errorMessage || ''));
}

const STAGES = new Set([
  'web_login',
  'email_otp',
  'finalizing',
]);

export const HANDLERS = {
  starting: (job, event) => ({
    jobPatch: { status: 'running', started_at: event.ts ?? nowIso(), stage: null },
  }),

  stage: (job, event) => (STAGES.has(event.stage) ? { jobPatch: { stage: event.stage } } : {}),

  log: () => ({}),

  balance: (job, event) =>
    Number.isFinite(Number(event.value))
      ? { accountPatch: { balance: Number(event.value), balance_checked_at: nowIso() } }
      : {},

  result_saved: (job, event) => ({
    jobPatch: { result_path: event.path || job.result_path },
    actions: [{ kind: 'save_tokens', event }],
  }),

  error: (job, event) => ({
    jobPatch: {
      status: isUserQuit(event.message) ? 'canceled' : 'failed',
      error: String(event.message || event.code || 'unknown').slice(0, 2000),
      finished_at: nowIso(),
    },
    actions: [{ kind: 'classify_error', event }],
  }),

  exit: (job, event) => {
    if (event.ok && !TERMINAL.has(job.status)) {
      return { jobPatch: { status: 'completed', finished_at: nowIso(), prompt_kind: null } };
    }
    // 已有终态（error 先行）时 exit 只补 finished_at
    if (!job.finished_at) return { jobPatch: { finished_at: nowIso() } };
    return {};
  },
};

/** 单条事件迁移。未知事件类型返回空迁移（不崩溃）。 */
export function applyEvent(job, event) {
  if (!event || typeof event.type !== 'string') return {};
  const handler = HANDLERS[event.type];
  if (!handler) return {};
  return handler(job, event);
}

export function nowIso() {
  return new Date().toISOString();
}
