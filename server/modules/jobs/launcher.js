import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { resolveTotpPickupUrl, DEFAULT_TWOFA_FETCH_TEMPLATE } from '../../lib/totp-pickup.js';

/**
 * spawn protocol-login 子进程 + env 注入 + stdout 逐行 json-events 解析 + stderr 落日志文件。
 * 凭据全部走环境变量，不进 argv、不写日志。
 */
export function createLauncher({ config, logger }) {
  function loginProvider() {
    return config.settingsGet?.('login.provider') || {};
  }

  function launch(job, { account, proxyUrl, attempt }, callbacks) {
    const logPath = path.resolve(config.dataDir, job.log_path);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const logStream = fs.createWriteStream(logPath, { flags: 'a' });

    const provider = loginProvider();
    // 与引擎 redeemLoginEnabled 同口径：mode 显式为 protocol 才走本地协议登录，缺省视为 redeem401
    const redeemLogin = job.type === 'login' && provider.mode !== 'protocol';
    const args = buildArgs(job, account, config.dataDir, { redeemLogin });
    const env = {
      ...process.env,
      CHATGPT_PROXY_URL: proxyUrl ?? '',
      CHATGPT_PROXY_MAX_ATTEMPTS: String(Math.max(1, 10 - (job.proxy_attempts || 0))),
      CHATGPT_LOGIN_PASSWORD: account?.credentials?.password ?? '',
      CHATGPT_TOTP_SECRET: account?.credentials?.totp_secret ?? '',
      // 2FA 在线取件：模板 + 账号取件码在此解析成完整 URL，子进程直接 GET
      CHATGPT_TOTP_PICKUP_URL: resolveTotpPickupUrl(
        config.settingsGet?.('twofa.fetch')?.template || DEFAULT_TWOFA_FETCH_TEMPLATE,
        account?.credentials?.totp_pickup_code,
      ),
      TOSUB2_JOB_ATTEMPT: String(attempt),
      TOSUB2_TLS_PROFILE: '',
      ...(redeemLogin
        ? {
            REDEEM401_BASE_URL: provider.redeem401_base_url || 'https://redeem.lazmeow.com',
            REDEEM401_TIMEOUT_MINUTES: String(provider.redeem401_timeout_minutes ?? 15),
          }
        : {}),
    };

    logLine(
      logStream,
      `[engine] spawn attempt=${attempt} proxy=${proxyUrl ? 'yes' : 'direct'} type=${job.type}${redeemLogin ? ' provider=redeem401' : ''}`,
    );

    const child = spawn(process.execPath, args, {
      cwd: config.serverRoot,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdoutBuffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk;
      let newline;
      while ((newline = stdoutBuffer.indexOf('\n')) >= 0) {
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (!line) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          logLine(logStream, `[stdout-non-json] ${line.slice(0, 500)}`);
          continue;
        }
        logLine(logStream, `[event] ${line.slice(0, 1000)}`);
        callbacks.onEvent?.(event);
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line.trim()) logLine(logStream, line);
      }
    });

    child.on('error', (error) => {
      logLine(logStream, `[engine] spawn error: ${error.message}`);
      callbacks.onExited?.(-1, null, new Error(`spawn failed: ${error.message}`));
    });

    child.on('close', (code, signal) => {
      logLine(logStream, `[engine] child exited code=${code} signal=${signal ?? ''}`);
      logStream.end();
      callbacks.onExited?.(code, signal, null);
    });

    return {
      child,
      sendCommand(command) {
        return new Promise((resolve, reject) => {
          if (child.exitCode !== null || child.signalCode) {
            reject(new Error('JOB_NOT_AWAITING_INPUT'));
            return;
          }
          child.stdin.write(`${JSON.stringify(command)}\n`, (error) => (error ? reject(error) : resolve()));
        });
      },
      kill() {
        return new Promise((resolve) => {
          if (child.exitCode !== null || child.signalCode) {
            resolve();
            return;
          }
          const forceTimer = setTimeout(() => {
            try {
              child.kill('SIGKILL');
            } catch {}
          }, 3000);
          child.once('close', () => {
            clearTimeout(forceTimer);
            resolve();
          });
          try {
            child.kill('SIGTERM');
          } catch {
            clearTimeout(forceTimer);
            resolve();
          }
        });
      },
    };
  }

  return { launch };
}

function buildArgs(job, account, dataDir, { redeemLogin = false } = {}) {
  // TOSUB2_PROTOCOL_SCRIPT / TOSUB2_REDEEM_SCRIPT: 测试时替换对应子进程脚本
  const script = redeemLogin
    ? process.env.TOSUB2_REDEEM_SCRIPT || 'core/redeem401-login.mjs'
    : process.env.TOSUB2_PROTOCOL_SCRIPT || 'core/protocol-login.mjs';
  const args = [script, '--json-events', '--verbose'];
  const resultPath = (name) => path.resolve(dataDir, 'results', name);
  if (redeemLogin) {
    // redeem401 远程登录：无交互输入、无 checkpoint，产物同为 sub2api JSON
    args.push(
      '--email',
      account?.email || '',
      '--sub2api-out',
      resultPath(`${job.id}.json`),
    );
    return args;
  }
  if (job.type === 'refresh') {
    // refresh 源 = 账号当前导出文件（tokens 入库时同步维护），产物写到本 job 专属文件
    const source = job.account_id
      ? resultPath(`account-${job.account_id}.json`)
      : path.resolve(job.result_path || resultPath(`${job.id}.json`));
    args.push(
      '--refresh-sub2api',
      source,
      '--sub2api-out',
      resultPath(`${job.id}.json`),
    );
    return args;
  }
  if (job.type === 'totp_setup') {
    args.push(
      '--email',
      account?.email || '',
      '--setup-totp',
      '--totp-result',
      job.totp_result_path || resultPath(`${job.id}-totp.json`),
    );
    return args;
  }
  // login
  args.push(
    '--email',
    account?.email || '',
    '--output-mode',
    'sub2api',
    '--sub2api-out',
    resultPath(`${job.id}.json`),
  );
  if (job.account_id) {
    const checkpoint = path.resolve(dataDir, 'checkpoints', String(job.account_id), 'login.json');
    args.push('--checkpoint', checkpoint, '--resume-checkpoint', checkpoint);
  }
  return args;
}

function logLine(stream, line) {
  const ts = new Date().toISOString().slice(11, 19);
  stream.write(`[${ts}] ${line}\n`);
}
