#!/usr/bin/env node
/**
 * mock 登录子进程：按 TOSUB2_MOCK_SCRIPT 环境变量给的剧本输出 json-events，
 * 用于任务引擎集成测试（替换真实 redeem401-login 子进程，TOSUB2_REDEEM_SCRIPT 注入）。
 *
 * 剧本协议（TOSUB2_MOCK_SCRIPT env，JSON）：
 *   { events: [ {type,...}... ] }
 * __sleep 事件用于取消测试；result_saved 事件在 TOSUB2_MOCK_RESULT_PATH 设置时
 * 写出真实结构的 sub2api 导出文件；error 事件后以退出码 1 结束。
 */
const scriptPath = process.env.TOSUB2_MOCK_SCRIPT;

import fs from 'node:fs';
import path from 'node:path';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  if (!scriptPath) {
    console.error('mock-login-child: missing TOSUB2_MOCK_SCRIPT');
    process.exit(2);
  }
  const script = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
  const attempt = Math.max(1, Number.parseInt(process.env.TOSUB2_JOB_ATTEMPT || '1', 10) || 1);
  const emit = (type, fields = {}) => {
    process.stdout.write(`${JSON.stringify({ type, ts: new Date().toISOString(), attempt, ...fields })}\n`);
  };

  emit('starting', { mode: 'redeem401', email: process.env.TOSUB2_MOCK_EMAIL || 'mock@test.local' });
  let failed = false;
  for (const event of script.events || []) {
    if (event.type === '__sleep') {
      await delay(event.ms || 500);
      continue;
    }
    if (event.type === 'result_saved' && process.env.TOSUB2_MOCK_RESULT_PATH) {
      // 测试钩子：按事件携带的 path 写出真实结构的 sub2api 导出文件
      const exportData = {
        type: 'sub2api-data',
        version: 1,
        exported_at: new Date().toISOString(),
        proxies: [],
        accounts: [
          {
            name: 'oauth---mock@test.local',
            platform: 'openai',
            type: 'oauth',
            credentials: {
              access_token: 'mock-access-token',
              refresh_token: 'mock-refresh-token',
              id_token: 'mock-id-token',
              chatgpt_account_id: 'us_mock',
              email: process.env.TOSUB2_MOCK_EMAIL || 'mock@test.local',
            },
            extra: {
              account_id: 'us_mock',
              chatgpt_account_id: 'us_mock',
              chatgpt_user_id: 'user_mock',
              client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
              email: process.env.TOSUB2_MOCK_EMAIL || 'mock@test.local',
            },
          },
        ],
      };
      fs.mkdirSync(path.dirname(event.path), { recursive: true });
      fs.writeFileSync(event.path, JSON.stringify(exportData, null, 2));
    }
    if (event.type === 'error') failed = true;
    emit(event.type, event);
  }
  emit('exit', { ok: !failed });
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`mock-login-child crashed: ${error.stack}\n`);
  process.exit(1);
});
