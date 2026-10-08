import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTransient, withRetry, retrying, retryingSidecar } from '../src/computer/retry.js';
import { runComputerTask } from '../src/computer/loop.js';

const noSleep = async () => {};
const withStatus = (status, msg) => Object.assign(new Error(msg), { status });

test('only rate limits, server errors and network failures are transient', () => {
  assert.equal(isTransient(withStatus(429, "x")), true);
  assert.equal(isTransient(withStatus(503, "x")), true);
  assert.equal(isTransient(new Error("socket hang up")), true);
  assert.equal(isTransient(withStatus(400, "x")), false);
  assert.equal(isTransient(withStatus(401, "x")), false);
});

test('withRetry retries transient failures and gives up after the last attempt', async () => {
  let calls = 0;
  const ok = await withRetry(async () => {
    calls++;
    if (calls < 3) throw withStatus(500, "boom");
    return "fine";
  }, { sleep: noSleep });
  assert.equal(ok, "fine");
  assert.equal(calls, 3);

  let tries = 0;
  await assert.rejects(withRetry(async () => { tries++; throw withStatus(503, "down"); }, { sleep: noSleep }), /down/);
  assert.equal(tries, 3);
});

test('a rejected request is not retried', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => { calls++; throw withStatus(400, "image input is not supported"); }, { sleep: noSleep }),
    /image input is not supported/,
  );
  assert.equal(calls, 1);
});

test('the sidecar wrapper retries screenshots but never repeats actions', async () => {
  let shots = 0;
  let acts = 0;
  const sidecar = {
    screenshot: async () => { shots++; if (shots === 1) throw new Error("sidecar busy"); return { png_base64: "AAAA", width: 1, height: 1 }; },
    act: async () => { acts++; throw new Error("action failed"); },
  };
  const wrapped = retryingSidecar(sidecar, { sleep: noSleep });
  const shot = await wrapped.screenshot("s");
  assert.equal(shot.width, 1);
  assert.equal(shots, 2);
  await assert.rejects(wrapped.act("s", { type: "click", x: 0, y: 0 }), /action failed/);
  assert.equal(acts, 1);
});

test('a failed action is reported to the model in its next turn', async () => {
  const replies = [{ action: "click", x: 1, y: 1 }, { action: "done", summary: "ok" }];
  const seen = [];
  const sidecar = {
    screenshot: async () => ({ png_base64: "AAAA", width: 800, height: 600 }),
    act: async () => { throw new Error("action failed (RuntimeError)"); },
  };
  const result = await runComputerTask({
    userId: "u", task: "t", sessionId: "s", sidecar,
    vault: { listSecretNames: () => [], getSecret: () => null },
    decide: async args => { seen.push(args); return replies.shift(); },
    requestSecrets: async () => null, settleMs: 0, sleep: noSleep,
  });
  assert.equal(result.status, "done");
  assert.ok(seen[1].history.some(h => h.includes("失敗")));
});

test('a rejected model request stops the run with the provider message', async () => {
  const sidecar = { screenshot: async () => ({ png_base64: "AAAA", width: 800, height: 600 }), act: async () => {} };
  await assert.rejects(runComputerTask({
    userId: "u", task: "t", sessionId: "s", sidecar,
    vault: { listSecretNames: () => [], getSecret: () => null },
    decide: retrying(async () => { throw withStatus(400, "LLM 400: image input is not supported"); }, { sleep: noSleep }),
    requestSecrets: async () => null, settleMs: 0, sleep: noSleep,
  }), /image input is not supported/);
});
