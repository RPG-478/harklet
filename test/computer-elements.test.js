import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAction } from '../src/computer/actions.js';
import { runComputerTask } from '../src/computer/loop.js';
import { buildUserText } from '../src/computer/vision.js';

const SCREEN = { width: 800, height: 600 };
const NO_VAULT = { listSecretNames: () => [], getSecret: () => null };

test('click_element needs an index that is in the current list', () => {
  assert.equal(parseAction({ action: 'click_element', index: 1 }, { ...SCREEN, elementCount: 2 }).ok, true);
  assert.equal(parseAction({ action: 'click_element', index: 2 }, { ...SCREEN, elementCount: 2 }).ok, false);
  assert.equal(parseAction({ action: 'click_element', index: 0 }, SCREEN).ok, false);
});

test('loop clicks by element when the list is available', async () => {
  const sent = [];
  const browser = {
    screenshot: async () => ({ png_base64: 'AAAA', width: 800, height: 600 }),
    elements: async () => ({ window: { app: 'Editor', title: 'Login' }, elements: [{ index: 0, role: 'AXButton', label: 'Sign in', x: 1, y: 2 }] }),
    act: async (id, a) => { sent.push(a); },
  };
  const replies = [{ action: 'click_element', index: 0 }, { action: 'done', summary: 'ok' }];
  const seen = [];
  const result = await runComputerTask({
    userId: 'u', task: 't', sessionId: 's', browser, vault: NO_VAULT,
    decide: async args => { seen.push(args); return replies.shift(); },
    requestSecrets: async () => null, settleMs: 0, sleep: async () => {},
  });
  assert.equal(result.status, 'done');
  assert.deepEqual(sent, [{ type: 'click_element', index: 0 }]);
  assert.equal(seen[0].elements.length, 1);
});

test('loop falls back to coordinates when elements cannot be read', async () => {
  const sent = [];
  const browser = {
    screenshot: async () => ({ png_base64: 'AAAA', width: 800, height: 600 }),
    elements: async () => { throw new Error('element access unavailable'); },
    act: async (id, a) => { sent.push(a); },
  };
  const replies = [{ action: 'click_element', index: 0 }, { action: 'click', x: 5, y: 6 }, { action: 'done', summary: 'ok' }];
  const seen = [];
  const result = await runComputerTask({
    userId: 'u', task: 't', sessionId: 's', browser, vault: NO_VAULT,
    decide: async args => { seen.push(args); return replies.shift(); },
    requestSecrets: async () => null, settleMs: 0, sleep: async () => {},
  });
  assert.equal(result.status, 'done');
  assert.equal(seen[0].elements, null);
  assert.deepEqual(sent, [{ type: 'click', x: 5, y: 6 }]);
});

test('the model sees the element list or a note that none exists', () => {
  const withList = buildUserText({ task: 't', history: [], width: 800, height: 600, secretNames: [],
    elements: [{ index: 0, role: 'AXButton', label: 'Sign in', x: 1, y: 2 }] });
  assert.ok(withList.includes('0: AXButton Sign in (1,2)'));
  const none = buildUserText({ task: 't', history: [], width: 800, height: 600, secretNames: [], elements: null });
  assert.ok(none.includes('座標で操作'));
});
