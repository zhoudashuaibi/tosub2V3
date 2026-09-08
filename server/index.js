import fs from 'node:fs';
import Fastify from 'fastify';
import fp from 'fastify-plugin';
import { loadConfig } from './lib/config.js';
import { openDatabase } from './lib/db.js';
import { createCrypto } from './lib/crypto.js';
import { createLogger } from './lib/logger.js';
import { createSettingsService } from './lib/settings.js';
import { registerErrorHandler } from './lib/http-errors.js';
import { createAuthModule } from './modules/auth/index.js';
import { createProxiesModule } from './modules/proxies/index.js';
import { createJobsEngine } from './modules/jobs/engine.js';
import { createJobsModule as createJobsRoutesModule } from './modules/jobs/index.js';
import { createAccountsModule } from './modules/accounts/index.js';
import { createSub2apiModule } from './modules/sub2api/index.js';
import { createTeamModule } from './modules/team/index.js';
import { createSettingsModule } from './modules/settings/index.js';
import { createDashboardModule } from './modules/dashboard/index.js';
import { createStaticModule } from './modules/static/index.js';

const startedAt = Date.now();
const logger = createLogger(process.env.TOSUB2_LOG_LEVEL || 'info');
const config = loadConfig(process.env);

fs.mkdirSync(config.logsDir, { recursive: true });
fs.mkdirSync(config.checkpointsDir, { recursive: true });
fs.mkdirSync(config.resultsDir, { recursive: true });

const db = openDatabase(config.dataDir, { logger });
const crypto = createCrypto({ dataDir: config.dataDir, secretKeyEnv: config.secretKeyEnv, logger });
const settings = createSettingsService(db, crypto, { logger });
settings.ensureDefaults();

// ---- 任务引擎（在装饰器注册前创建，注入选路/凭据封面） ----
const engineConfig = {
  ...config,
  settingsGet: (key) => settings.get(key),
  cryptoTryDecryptJson: (envelope, field) => crypto.tryDecryptJson(envelope, field),
  cryptoEncryptJson: (value, field) => crypto.encryptJson(value, field),
  pickProxy: () => ({ id: null, url: null }), // proxies 模块注册后覆盖
  recordProxyFailure: () => {},
};
const jobsEngine = createJobsEngine({ config: engineConfig, db, logger });

const app = Fastify({
  loggerInstance: logger,
  trustProxy: true,
  bodyLimit: 2 * 1024 * 1024,
});

// 装饰根实例：所有模块共享（不进封装作用域）
app.decorate('config', config);
app.decorate('db', db);
app.decorate('crypto', crypto);
app.decorate('settings', settings);
app.decorate('jobsEngine', jobsEngine);

registerErrorHandler(app);

app.get('/api/v1/health', async () => ({
  ok: true,
  version: config.version,
  uptime_s: Math.floor((Date.now() - startedAt) / 1000),
}));

// proxies 模块注册后，把随机选路接入引擎
const proxiesRegister = fp(async (f) => {
  await createProxiesModule({ logger })(f);
  engineConfig.pickProxy = (excludeIds) => f.proxySelector.pickRandomAliveProxy(excludeIds);
  engineConfig.recordProxyFailure = (proxyId) => {
    const threshold = Number(settings.get('engine.config').proxy_fail_threshold) || 3;
    f.proxySelector.recordFailure(proxyId, threshold);
  };
}, { name: 'proxies' });

const accountsRegister = fp(async (f) => {
  await createAccountsModule({ engine: jobsEngine, logger })(f);
}, { name: 'accounts' });

const sub2apiRegister = fp(async (f) => {
  await createSub2apiModule({ engine: jobsEngine, logger })(f);
}, { name: 'sub2api' });

const teamRegister = fp(async (f) => {
  await createTeamModule({ logger })(f);
}, { name: 'team' });

await app.register(fp(createAuthModule({ config, logger }), { name: 'auth' }));
await app.register(proxiesRegister);
await app.register(fp(createJobsRoutesModule({ engine: jobsEngine }), { name: 'jobs' }));
await app.register(accountsRegister);
await app.register(sub2apiRegister);
await app.register(teamRegister);
await app.register(fp(createSettingsModule({ logger }), { name: 'settings' }));
await app.register(fp(createDashboardModule(), { name: 'dashboard' }));
await app.register(fp(createStaticModule({ config, logger }), { name: 'static' }));

// 启动任务引擎调度循环 + sub2api 监控（若启用）
jobsEngine.start();
app.sub2apiMonitor?.startIfEnabled?.();

// 优雅关闭：停调度 → 杀子进程 → running 任务回 queued → 停监控 → 关库
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  try {
    await jobsEngine.shutdown();
    app.sub2apiMonitor?.stop?.();
    await app.close();
  } catch (error) {
    logger.error({ err: error }, 'shutdown error');
  } finally {
    db.close();
    process.exit(0);
  }
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ port: config.port, host: config.host });
  logger.info(`tosub2 v${config.version} listening on http://${config.host}:${config.port} (data: ${config.dataDir})`);
} catch (error) {
  logger.error({ err: error }, 'failed to start');
  process.exit(1);
}
