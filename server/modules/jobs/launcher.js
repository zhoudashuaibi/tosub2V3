import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_REDEEM401_BASE_URL = 'https://redeem.lazmeow.com';

/**
 * spawn redeem401 登录子进程 + env 注入 + stdout 逐行 json-events 解析 + stderr 落日志文件。
 * 登录完全由 redeem 服务完成（run → 轮询 → export），本机不执行登录逻辑；
 * 产物为标准 sub2api JSON，路径经 result_saved 事件交引擎入库。
 */
export function createLauncher({ config, logger }) {
  function launch(job, { account, attempt }, callbacks) {
    const logPath = path.resolve(config.dataDir, job.log_path);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const logStream = fs.createWriteStream(logPath, { flags: 'a' });

    const redeem = config.settingsGet?.('login.redeem401') || {};
    // TOSUB2_REDEEM_SCRIPT: 测试时替换子进程脚本
    const script = process.env.TOSUB2_REDEEM_SCRIPT || 'core/redeem401-login.mjs';
    const resultPath = path.resolve(config.dataDir, 'results', `${job.id}.json`);
    const args = [script, '--json-events', '--verbose', '--email', account?.email || '', '--sub2api-out', resultPath];
    const env = {
      ...process.env,
      REDEEM401_BASE_URL: redeem.base_url || DEFAULT_REDEEM401_BASE_URL,
      REDEEM401_TIMEOUT_MINUTES: String(redeem.timeout_minutes ?? 15),
      TOSUB2_JOB_ATTEMPT: String(attempt),
    };

    logLine(logStream, `[engine] spawn attempt=${attempt} type=${job.type} provider=redeem401`);

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

function logLine(stream, line) {
  const ts = new Date().toISOString().slice(11, 19);
  stream.write(`[${ts}] ${line}\n`);
}
