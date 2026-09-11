import fs from 'node:fs';
import path from 'node:path';
import { fastifyStatic } from '@fastify/static';

export function createStaticModule({ config, logger }) {
  return async function staticModule(app) {
    const distDir = config.webDist;
    if (!fs.existsSync(distDir)) {
      logger.warn(`前端构建产物不存在：${distDir}（开发模式请使用 vite dev server）`);
      app.setNotFoundHandler(async (_request, reply) => {
        return reply.header('cache-control', 'no-store').code(404).send({ error: { code: 'NOT_FOUND', message: '资源不存在' } });
      });
      return;
    }
    await app.register(fastifyStatic, {
      root: distDir,
      prefix: '/',
      index: 'index.html',
      // 交给 setHeaders 统一决定，避免 @fastify/send 的默认 `public, max-age=0`
      // 在 setHeaders 之后覆盖我们的响应头（@fastify/static 会先调 setHeaders 再 reply.headers）。
      cacheControl: false,
      // 生产语义：/assets/{name}-{hash}.js 内容寻址，可长期强缓存；其余（index.html 等）保持 no-cache。
      setHeaders(res, filePath) {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('cache-control', 'public, max-age=31536000, immutable');
        } else {
          res.setHeader('cache-control', 'no-cache');
        }
      },
    });
    // SPA fallback：非 /api 路径全部回 index.html
    app.setNotFoundHandler(async (request, reply) => {
      if (request.raw.url?.startsWith('/api/')) {
        return reply.header('cache-control', 'no-store').code(404).send({ error: { code: 'NOT_FOUND', message: '接口不存在' } });
      }
      // index.html 必须每次校验：它引用带哈希的产物名，强缓存会让发版后仍加载旧 JS
      return reply.header('cache-control', 'no-cache').sendFile('index.html', path.resolve(distDir));
    });
  };
}
