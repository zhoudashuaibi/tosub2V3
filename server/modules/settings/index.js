import { maskSecret } from '../../lib/sanitize.js';
import { errors } from '../../lib/http-errors.js';

export function createSettingsModule({ logger }) {
  return async function settingsModule(app) {
    const db = app.db;

    function view() {
      const twofa = app.settings.get('twofa.fetch') || {};
      const engineConfig = app.settings.get('engine.config');
      const sms = app.settings.get('sms.providers') || {};
      const sub2api = app.settings.get('sub2api.config') || {};
      return {
        outlook_fetch_mode: 'microsoft_direct',
        twofa_fetch_template: twofa.template || 'https://2fa.show/2fa/{code}',
        max_concurrent_jobs: engineConfig.max_concurrent_jobs,
        job_timeout_minutes: engineConfig.job_timeout_minutes,
        proxy_fail_threshold: engineConfig.proxy_fail_threshold,
        strict_proxy: engineConfig.strict_proxy !== false,
        join_auto_upload: Boolean(sub2api.join_auto_upload),
        sms: {
          active: sms.active || 'custom',
          providers: {
            luban: { configured: Boolean(sms.luban?.apiKey), service_id: sms.luban?.serviceId ?? '' },
            smsbower: {
              configured: Boolean(sms.smsbower?.apiKey),
              country: sms.smsbower?.country ?? '',
              country_label: sms.smsbower?.countryLabel ?? '',
            },
            custom: { configured: Boolean(sms.custom?.entries), count: countCustomEntries(sms.custom?.entries) },
          },
        },
      };
    }

    function countCustomEntries(text) {
      return String(text || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean).length;
    }

    app.get('/api/v1/settings', async () => view());

    app.put('/api/v1/settings', async (request) => {
      const body = request.body || {};
      if (body.outlook_fetch_endpoint !== undefined) {
        throw errors.validation('Outlook 已改为微软官方直连，不再支持自定义取件地址');
      }
      if (body.twofa_fetch_template !== undefined) {
        const template = String(body.twofa_fetch_template || '').trim();
        if (template) {
          // 校验占位符替换后的完整 URL 合法（{code} / 结尾 xxx 均为占位写法）
          const probe = template.includes('{code}') ? template.replaceAll('{code}', 'A1B2C3D4') : template.replace(/xxx$/i, 'A1B2C3D4');
          try {
            const parsed = new URL(probe);
            if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('bad');
          } catch {
            throw errors.validation('2FA 取码地址模板必须是有效的 HTTP/HTTPS 地址（含 {code} 占位符）');
          }
        }
        app.settings.set('twofa.fetch', { template: template || 'https://2fa.show/2fa/{code}' });
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
      if (body.sms_active !== undefined) {
        const current = app.settings.get('sms.providers');
        app.settings.set('sms.providers', { ...current, active: String(body.sms_active) });
        app.jobsEngine?.autoInput?.invalidateSmsProvider?.();
      }
      return view();
    });

    app.post('/api/v1/settings/sms-provider', async (request) => {
      const body = request.body || {};
      const providerId = String(body.id || '').trim();
      if (!['luban', 'smsbower', 'custom'].includes(providerId)) {
        throw Object.assign(new Error('不支持的接码平台'), { status: 422, code: 'VALIDATION' });
      }
      const current = app.settings.get('sms.providers') || {};
      const next = { ...current, active: body.active !== undefined ? String(body.active) : current.active };
      const config = { ...(current[providerId] || {}) };
      if (providerId === 'custom') {
        if (body.entries !== undefined) config.entries = String(body.entries || '');
      } else {
        const apiKeyInput = String(body.api_key ?? '').trim();
        if (apiKeyInput && apiKeyInput !== '****') config.apiKey = apiKeyInput;
        if (providerId === 'luban' && body.service_id !== undefined) config.serviceId = String(body.service_id);
        if (providerId === 'smsbower') {
          if (body.country !== undefined) config.country = String(body.country);
          if (body.country_label !== undefined) config.countryLabel = String(body.country_label);
          if (body.max_price !== undefined) config.maxPrice = String(body.max_price);
        }
      }
      next[providerId] = config;
      app.settings.set('sms.providers', next);
      app.jobsEngine?.autoInput?.invalidateSmsProvider?.();
      return view();
    });

    app.get('/api/v1/settings/sms-providers', async () => {
      const { publicSmsProviderDefinitions } = await import('../../core/sms-providers.mjs');
      return { items: publicSmsProviderDefinitions() };
    });
  };
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
