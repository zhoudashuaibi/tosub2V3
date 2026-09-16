import { maskSecret } from '../../lib/sanitize.js';
import { errors } from '../../lib/http-errors.js';

export function createSettingsModule({ logger }) {
  return async function settingsModule(app) {
    const db = app.db;

    function view() {
      const redeem = app.settings.get('login.redeem401') || {};
      const engineConfig = app.settings.get('engine.config');
      const sub2api = app.settings.get('sub2api.config') || {};
      return {
        redeem401_base_url: redeem.base_url || 'https://redeem.lazmeow.com',
        redeem401_timeout_minutes: redeem.timeout_minutes ?? 15,
        outlook_fetch_mode: 'microsoft_direct',
        max_concurrent_jobs: engineConfig.max_concurrent_jobs,
        job_timeout_minutes: engineConfig.job_timeout_minutes,
        proxy_fail_threshold: engineConfig.proxy_fail_threshold,
        strict_proxy: engineConfig.strict_proxy !== false,
        join_auto_upload: Boolean(sub2api.join_auto_upload),
      };
    }

    app.get('/api/v1/settings', async () => view());

    app.put('/api/v1/settings', async (request) => {
      const body = request.body || {};
      if (body.outlook_fetch_endpoint !== undefined) {
        throw errors.validation('Outlook 已改为微软官方直连，不再支持自定义取件地址');
      }
      if (body.redeem401_base_url !== undefined || body.redeem401_timeout_minutes !== undefined) {
        const current = app.settings.get('login.redeem401');
        const baseUrlInput =
          body.redeem401_base_url !== undefined ? String(body.redeem401_base_url || '').trim() : current.base_url;
        if (baseUrlInput) {
          try {
            const parsed = new URL(baseUrlInput);
            if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('bad');
          } catch {
            throw errors.validation('redeem 服务地址必须是有效的 HTTP/HTTPS 地址');
          }
        }
        app.settings.set('login.redeem401', {
          base_url: baseUrlInput || 'https://redeem.lazmeow.com',
          timeout_minutes: clampInt(
            body.redeem401_timeout_minutes !== undefined ? body.redeem401_timeout_minutes : current.timeout_minutes,
            current.timeout_minutes ?? 15,
            1,
            120,
          ),
        });
      }
      if (
        body.max_concurrent_jobs !== undefined ||
        body.job_timeout_minutes !== undefined ||
        body.proxy_fail_threshold !== undefined ||
        body.strict_proxy !== undefined
      ) {
        const current = app.settings.get('engine.config');
        const next = {
          max_concurrent_jobs: clampInt(body.max_concurrent_jobs, current.max_concurrent_jobs, 1, 100),
          job_timeout_minutes: clampInt(body.job_timeout_minutes, current.job_timeout_minutes, 1, 24 * 60),
          proxy_fail_threshold: clampInt(body.proxy_fail_threshold, current.proxy_fail_threshold, 1, 20),
          strict_proxy:
            body.strict_proxy !== undefined ? Boolean(body.strict_proxy) : current.strict_proxy !== false,
        };
        app.settings.set('engine.config', next);
      }
      if (body.join_auto_upload !== undefined) {
        const current = app.settings.get('sub2api.config');
        app.settings.set('sub2api.config', { ...current, join_auto_upload: Boolean(body.join_auto_upload) });
      }
      return view();
    });
  };
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
