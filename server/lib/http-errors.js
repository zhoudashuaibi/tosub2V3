export class AppError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.expose = status < 500;
    this.extra = extra;
  }
}

export const errors = {
  unauthorized: (message = '未登录或会话已过期') => new AppError(401, 'UNAUTHORIZED', message),
  forbidden: (message = '操作不被允许', code = 'FORBIDDEN', extra = {}) => new AppError(403, code, message, extra),
  csrf: () => new AppError(403, 'CSRF_REJECTED', '请求缺少必要的 CSRF 校验头'),
  notFound: (message = '资源不存在') => new AppError(404, 'NOT_FOUND', message),
  validation: (message = '请求参数校验失败', details = {}) => new AppError(422, 'VALIDATION', message, { details }),
  conflict: (message, code = 'CONFLICT', extra = {}) => new AppError(409, code, message, extra),
  rateLimited: (retryAfterSeconds) =>
    new AppError(429, 'RATE_LIMITED', '尝试次数过多，已锁定', { retry_after_seconds: retryAfterSeconds }),
  upstream: (message, code = 'UPSTREAM_ERROR') => new AppError(502, code, message),
  sub2apiUnavailable: (message) => new AppError(502, 'SUB2API_UNAVAILABLE', message),
  sub2apiNotConfigured: (message = '请先配置 sub2api 后端地址与管理员密钥') =>
    new AppError(422, 'SUB2API_NOT_CONFIGURED', message),
  accountState: (message) => new AppError(409, 'ACCOUNT_STATE_INVALID', message),
  jobNotCancelable: () => new AppError(409, 'JOB_NOT_CANCELABLE', '任务已结束，无法取消'),
  jobNotAwaitingInput: () => new AppError(409, 'JOB_NOT_AWAITING_INPUT', '任务当前不在等待输入状态'),
  poolTransferConflict: (message = '账号状态已变化，操作冲突') => new AppError(409, 'POOL_TRANSFER_CONFLICT', message),
};

/**
 * 归一化「非 AppError 但自带 4xx 状态」的错误。
 *
 * 历史代码里有 `throw Object.assign(new Error(msg), { status: 422, code: 'X' })` 的写法，
 * 它既不是 AppError，也不会被 Fastify 特殊处理，最终统一落到 500 INTERNAL ——
 * 前端据此写的友好文案（如 SUB2API_NOT_CONFIGURED）永远不可达。
 * 这里把它按声明的 4xx 状态原样暴露；5xx 与无状态错误仍然视为内部错误。
 */
function normalizeHttpError(error) {
  if (error instanceof AppError) return error;
  const status = Number(error?.status ?? error?.statusCode);
  if (!Number.isInteger(status) || status < 400 || status >= 500) return null;
  const code = typeof error.code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(error.code) ? error.code : 'VALIDATION';
  return new AppError(status, code, error.message || '请求失败', error.extra ?? {});
}

export function registerErrorHandler(app) {
  app.setErrorHandler((error, request, reply) => {
    if (error?.validation) {
      const details = error.validation.map((item) => ({
        path: item.instancePath || item.params?.missingProperty || '',
        message: item.message || '',
      }));
      return reply.status(422).send({
        error: { code: 'VALIDATION', message: '请求参数校验失败', details },
      });
    }
    // Fastify 内容解析阶段的超限（如导入文件过大）：转成可读的 413 而不是 500
    if (error?.statusCode === 413 || error?.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.status(413).send({
        error: { code: 'BODY_TOO_LARGE', message: '请求内容过大，超出大小限制，请分批导入' },
      });
    }
    const normalized = normalizeHttpError(error);
    if (normalized) {
      return reply.status(normalized.status).send({
        error: { code: normalized.code, message: normalized.message, ...normalized.extra },
      });
    }
    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send({
      error: { code: 'INTERNAL', message: '服务器内部错误' },
    });
  });
}
