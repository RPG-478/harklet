import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';

test('vision agent asks for login fields on the real Discord web login page',
  { skip: process.env.HARKLET_TEST_LOGIN_HANDOFF !== '1', timeout: 240000 }, async () => {
    process.env.HARKLET_BROWSER_PROVIDER = 'quicksand';
    const dataRoot = resolve(tmpdir());
    const dataDir = await mkdtemp(join(dataRoot, 'harklet-login-handoff-'));
    process.env.HARKLET_BROWSER_DATA_DIR = dataDir;
    const { browser } = await import('../src/computer/browser.js');
    const { runComputerTask } = await import('../src/computer/loop.js');
    const { makeDecider } = await import('../src/computer/vision.js');
    const { config } = await import('../src/config.js');
    let id, fields;
    try {
      ({ id } = await browser.createSession('login-probe'));
      await browser.act(id, { type: 'navigate', url: 'https://discord.com/login' });
      const result = await runComputerTask({
        userId: 'login-probe', task: 'Discordにログイン', sessionId: id, browser,
        vault: { listSecretNames: () => [], getSecret: () => null },
        decide: makeDecider({ provider: config.llm.provider, baseUrl: config.llm.baseUrl,
          apiKey: config.llm.apiKey, model: process.env.HARKLET_CU_MODEL || config.llm.model }),
        requestSecrets: async request => { fields = request.fields; return null; },
        maxSteps: 8, deadlineMs: 120000, settleMs: 500,
      });
      assert.equal(result.status, 'credentials_timeout');
      assert.ok(fields?.length >= 1);
    } finally {
      if (id) await browser.destroySession(id);
      const rel = relative(dataRoot, resolve(dataDir));
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('unsafe test cleanup path');
      await rm(dataDir, { recursive: true, force: true });
    }
  });
