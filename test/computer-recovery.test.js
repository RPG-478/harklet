import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTransient, withRetry, retrying, retryingSidecar } from '../src/computer/retry.js';
import { runComputerTask } from '../src/computer/loop.js';
import { buildVisionRequest } from '../src/computer/vision.js';

const noSleep = async () => {};
const withStatus = (status, msg) => Object.assign(new Error(msg), { status });
const NO_VAULT = { listSecretNames: () => [], getSecret: () => null };
const okSidecar = (extra = {}) => ({
  screenshot: async () => ({ png_base64: "AAAA", width: 800, height: 600 }),
  act: async () => {},
  ...extra,
});
const runOpts = (overrides) => ({
  userId: "u", task: "t", sessionId: "s", sidecar: okSidecar(), vault: NO_VAULT,
  requestSecrets: async () => null, settleMs: 0, sleep: noSleep, ...overrides,
});

test('only rate limits, server errors and network failures are transient', () => {
  assert.equal(isTransient(withStatus(429, "x")), true);
  assert.equal(isTransient(withStatus(503, "x")), true);
  assert.equal(isTransient(new Error("socket hang up")), true);
  assert.equal(isTransient(withStatus(400, "x")), false);
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
});

test('the sidecar wrapper retries screenshots but never repeats actions', async () => {
  let shots = 0;
  let acts = 0;
  const sidecar = {
    screenshot: async () => { shots++; if (shots === 1) throw new Error("sidecar busy"); return { png_base64: "AAAA", width: 1, height: 1 }; },
    act: async () => { acts++; throw new Error("action failed"); },
  };
  const wrapped = retryingSidecar(sidecar, { sleep: noSleep });
  assert.equal((await wrapped.screenshot("s")).width, 1);
  assert.equal(shots, 2);
  await assert.rejects(wrapped.act("s", { type: "click", x: 0, y: 0 }), /action failed/);
  assert.equal(acts, 1);
});

test('a failed action is reported to the model in its next turn', async () => {
  const replies = [{ action: "click", x: 1, y: 1 }, { action: "done", summary: "ok" }];
  const seen = [];
  const sidecar = okSidecar({ act: async () => { throw new Error("action failed (RuntimeError)"); } });
  const result = await runComputerTask(runOpts({
    sidecar, decide: async args => { seen.push(args); return replies.shift(); },
  }));
  assert.equal(result.status, "done");
  assert.ok(seen[1].history.some(h => h.includes("失敗")));
});

test('a rejected image is dropped and the next turn is sent as text only', async () => {
  const seen = [];
  const replies = [null, { action: "done", summary: "ok" }];
  const result = await runComputerTask(runOpts({
    decide: async args => {
      seen.push(args);
      if (seen.length === 1) throw withStatus(400, "image input is not supported");
      return replies.shift();
    },
  }));
  assert.equal(result.status, "done");
  assert.equal(seen[0].pngBase64, "AAAA");
  assert.equal(seen[1].pngBase64, null);
  assert.ok(seen[1].history.some(h => h.includes("画像なしで続けます")));
});

test('repeated model failures inject notes and stop after three turns in a row', async () => {
  let calls = 0;
  const result = await runComputerTask(runOpts({
    decide: async () => { calls++; throw withStatus(500, "LLM 500: overloaded"); },
  }));
  assert.equal(result.status, 'failed');
  assert.equal(calls, 3);
  assert.match(result.reason, /LLM 500: overloaded/);
});

test('a failed screenshot is noted and the turn goes on without an image', async () => {
  let shots = 0;
  const seen = [];
  const sidecar = okSidecar({
    screenshot: async () => { shots++; if (shots === 1) throw new Error("sidecar busy"); return { png_base64: "AAAA", width: 800, height: 600 }; },
  });
  const replies = [{ action: "wait", seconds: 1 }, { action: "done", summary: "ok" }];
  const result = await runComputerTask(runOpts({
    sidecar, decide: async args => { seen.push(args); return replies.shift(); },
  }));
  assert.equal(result.status, 'done');
  assert.equal(seen[0].pngBase64, null);
  assert.ok(seen[1].history.some(h => h.includes("画面を取得できませんでした")));
});

test('the OpenAI-style request carries no image part when none is given', () => {
  const req = buildVisionRequest({ provider: 'openai', baseUrl: 'https://example.test/v1', apiKey: 'k', model: 'm', system: 's', text: 'hi', pngBase64: null });
  assert.equal(JSON.stringify(req.body).includes('image_url'), false);
});
