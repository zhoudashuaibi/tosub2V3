/**
 * /api/v1 响应缓存（ETag / 304）。
 *
 * 背景：前端以固定间隔轮询列表（任务 2s、号池 10s、代理 30s）。绝大多数轮询结果与上一轮
 * 完全相同，没有条件请求时每个请求都要重新序列化并全量传输；有了 ETag 后可以变成空响应 304。
 *
 * 只处理 GET：写请求的响应不值得缓存，且 304 语义会误导调用方。
 */
import { createHash } from 'node:crypto';

/** 参与 ETag 的最小响应体长度：太短的响应省不下什么，反而多一次哈希。 */
const MIN_ETAG_BYTES = 512;
const API_PREFIX = '/api/v1';

/** 「本次请求带了 If-None-Match」的标记位。 */
const kConditional = Symbol('tosub2.conditional');

/** 弱 ETag：内容语义不变即可复用，与压缩编码无关。 */
export function etagFor(body) {
  const digest = createHash('sha1').update(body, 'utf8').digest('base64url').slice(0, 22);
  return `W/"${digest}"`;
}

/**
 * If-None-Match 可能是逗号分隔的列表，也可能是 `*`。
 * 弱比较：忽略 W/ 前缀（RFC 9110 §8.8.3.2）。
 */
export function etagMatches(ifNoneMatch, etag) {
  const header = String(ifNoneMatch ?? '').trim();
  if (!header) return false;
  if (header === '*') return true;
  const normalize = (value) => String(value).trim().replace(/^W\//, '').replace(/^"|"$/g, '');
  const target = normalize(etag);
  return header.split(',').some((candidate) => candidate.trim() !== '' && normalize(candidate) === target);
}

export function createCacheHeaders({ logger = null } = {}) {
  return async function cacheHeaders(app) {
    app.addHook('onRequest', async (request) => {
      if (request.method !== 'GET') return;
      if (!request.raw.url?.startsWith(API_PREFIX)) return;
      const inm = request.headers['if-none-match'];
      // 记下条件头：响应体生成后才知道是否值得算 ETag
      if (inm) request[kConditional] = inm;
    });

    app.addHook('onSend', async (request, reply, payload) => {
      if (request.method !== 'GET') return payload;
      if (!request.raw.url?.startsWith(API_PREFIX)) return payload;
      if (reply.statusCode !== 200) return payload;
      // 文件下载（流/附件）与显式免缓存响应不参与
      if (reply.getHeader('content-disposition')) return payload;
      if (reply.getHeader('cache-control') === 'no-store') return payload;

      const body = serializeForEtag(payload);
      if (body === null || body.length < MIN_ETAG_BYTES) return payload;

      const etag = etagFor(body);
      reply.header('etag', etag);
      // 让中间层按编码分别缓存，避免 gzip 与 br 互相串味
      reply.header('vary', 'accept-encoding');

      const inm = request[kConditional];
      if (inm && etagMatches(inm, etag)) {
        reply.code(304);
        reply.removeHeader('content-type');
        reply.removeHeader('content-length');
        return '';
      }
      return payload;
    });

    logger?.debug?.('api cache headers enabled (etag/304)');
  };
}

function serializeForEtag(payload) {
  if (typeof payload === 'string') return payload;
  if (Buffer.isBuffer(payload)) return payload.toString('utf8');
  // 流式响应（下载/SSE）不参与 ETag
  return null;
}
