import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runComputerTask } from '../src/computer/loop.js';
import { buildUserText } from '../src/computer/vision.js';

const noSleep = async () => {};
const NO_VAULT = { listSecretNames: () => [], getSecret: () => null };
const badRequest = () => Object.assign(new Error('LLM 400: image input is not supported'), { status: 400 });

test('after an image is rejected, coordinate clicks are refused and element clicks go through', async () => {
  const acts = [];
  const seen = [];
  const replies = [{ action: "click", x: 5, y: 5 }, { action: "click_element", index: 0 }, { action: "done", summary: "ok" }];
  let first = true;
  const browser = {
    screenshot: async () => ({ png_base64: "AAAA", width: 800, height: 600 }),
    elements: async () => ({ elements: [{ index: 0, role: "AXButton", label: "Sign in" }] }),
    act: async (id, a) => { acts.push(a); },
  };
  const result = await runComputerTask({
    userId: "u", task: "t", sessionId: "s", browser, vault: NO_VAULT,
    decide: async args => {
      seen.push(args);
      if (first) { first = false; throw badRequest(); }
      return replies.shift();
    },
    requestSecrets: async () => null, settleMs: 0, sleep: noSleep,
  });
  assert.equal(result.status, 'done');
  assert.deepEqual(acts, [{ type: 'click_element', index: 0 }]);
  assert.equal(seen[1].pngBase64, null);
  assert.ok(seen[2].history.some(h => h.includes('座標操作は使えません')));
});

test('with no image and no element list the run stops with a reason', async () => {
  const browser = {
    screenshot: async () => ({ png_base64: "AAAA", width: 800, height: 600 }),
    act: async () => {},
    elements: async () => { throw new Error("no driver"); },
  };
  const result = await runComputerTask({
    userId: "u", task: "t", sessionId: "s", browser, vault: NO_VAULT,
    decide: async () => { throw badRequest(); },
    requestSecrets: async () => null, settleMs: 0, sleep: noSleep,
  });
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /操作できませんでした/);
});

test('the prompt says whether a screenshot is attached', () => {
  const base = { task: 't', history: [], width: 800, height: 600, secretNames: [], elements: null };
  assert.ok(buildUserText({ ...base, pngBase64: 'AAAA' }).includes('画面画像: あり'));
  assert.ok(buildUserText({ ...base, pngBase64: null }).includes('画面画像: なし'));
});
