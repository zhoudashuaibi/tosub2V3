import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAutoInput } from '../modules/jobs/auto-input.js';

const SECRET = 'JBSWY3DPEHPK3PXP';

test('mfa 自动作答次数上限：5 次后停止自动答转人工', async () => {
  const autoInput = createAutoInput({ config: { settingsGet: () => ({}) }, logger: null });
  const job = { id: 'job-cap' };
  const account = { email: 'a@test.local', credentials: { totp_secret: SECRET } };

  let submits = 0;
  let waited = false;
  for (let i = 0; i < 10; i++) {
    const result = await autoInput.attempt(job, account, { kind: 'mfa_otp' });
    if (result.submit) {
      submits += 1;
      assert.equal(result.submit.action, 'input');
      assert.match(result.submit.value, /^\d{6}$/);
    } else {
      waited = true;
      break;
    }
  }
  assert.equal(submits, 5);
  assert.ok(waited, '超限后应返回 wait 转人工');
});

test('无 2FA 凭据时 mfa 不自动作答', async () => {
  const autoInput = createAutoInput({ config: { settingsGet: () => ({}) }, logger: null });
  const result = await autoInput.attempt({ id: 'job-none' }, { email: 'a@test.local', credentials: {} }, { kind: 'mfa_otp' });
  assert.deepEqual(result, { wait: true });
});
