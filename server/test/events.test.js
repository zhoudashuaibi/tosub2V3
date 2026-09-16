import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent, isPermanentAccountFailure, isUserQuit } from '../modules/jobs/events.js';

const baseJob = () => ({
  id: 'job-1',
  status: 'queued',
  stage: null,
  prompt_kind: null,
  proxy_attempts: 0,
  attempt: 1,
  finished_at: null,
  result_path: null,
});

test('starting → running + started_at', () => {
  const t = applyEvent(baseJob(), { type: 'starting', ts: '2026-08-15T00:00:00Z' });
  assert.equal(t.jobPatch.status, 'running');
  assert.equal(t.jobPatch.started_at, '2026-08-15T00:00:00Z');
});

test('stage 事件更新 stage（合法枚举）', () => {
  const t = applyEvent(baseJob(), { type: 'stage', stage: 'email_otp' });
  assert.equal(t.jobPatch.stage, 'email_otp');
  const unknown = applyEvent(baseJob(), { type: 'stage', stage: 'hacker_stage' });
  assert.deepEqual(unknown, {});
});

test('result_saved → save_tokens 动作', () => {
  const t = applyEvent(baseJob(), {
    type: 'result_saved',
    path: 'results/1.json',
    account: { email: 'a@b.com' },
  });
  assert.equal(t.jobPatch.result_path, 'results/1.json');
  assert.equal(t.actions[0].kind, 'save_tokens');
});

test('balance 事件更新账号余额', () => {
  const t = applyEvent(baseJob(), { type: 'balance', value: 4.96 });
  assert.equal(t.accountPatch.balance, 4.96);
  const invalid = applyEvent(baseJob(), { type: 'balance', value: 'abc' });
  assert.deepEqual(invalid, {});
});

test('error → failed + classify_error；用户 quit → canceled', () => {
  const t = applyEvent({ ...baseJob(), status: 'running' }, {
    type: 'error',
    code: 'PROXY_RISK_CONTROL',
    message: 'blocked',
    retry_proxy: true,
  });
  assert.equal(t.jobPatch.status, 'failed');
  assert.equal(t.actions[0].kind, 'classify_error');

  const quit = applyEvent({ ...baseJob(), status: 'awaiting_input' }, {
    type: 'error',
    code: 'EMAIL_OTP_INVALID',
    message: 'Stopped before email OTP validation',
  });
  assert.equal(quit.jobPatch.status, 'canceled');
});

test('exit ok → completed（未终态时）', () => {
  const t = applyEvent({ ...baseJob(), status: 'running' }, { type: 'exit', ok: true });
  assert.equal(t.jobPatch.status, 'completed');
  // error 已先行置 failed，exit 不覆盖
  const t2 = applyEvent({ ...baseJob(), status: 'failed', finished_at: 'x' }, { type: 'exit', ok: true });
  assert.equal(t2.jobPatch?.status, undefined);
});

test('未知事件类型不崩溃', () => {
  assert.deepEqual(applyEvent(baseJob(), { type: 'mystery' }), {});
  assert.deepEqual(applyEvent(baseJob(), null), {});
});

test('永久失败与用户放弃判定', () => {
  assert.equal(isPermanentAccountFailure('account_deactivated by provider'), true);
  assert.equal(isPermanentAccountFailure('network timeout'), false);
  assert.equal(isUserQuit('Stopped before phone OTP validation'), true);
  assert.equal(isUserQuit('PROXY_RISK_CONTROL: blocked'), false);
});
