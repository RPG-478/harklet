import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN = 'test-token';
process.env.DISCORD_CLIENT_ID = '1';
process.env.HARKLET_DB = ':memory:';
process.env.HARKLET_SECRET_KEY = 'unit-test-secret-key-0123456789';

const { parseAction } = await import('../src/computer/actions.js');
const { redact, isSecretName } = await import('../src/computer/names.js');
const { setSecret, getSecret, listSecretNames } = await import('../src/computer/vault.js');
const { runComputerTask } = await import('../src/computer/loop.js');
const { makeDecider, parseJsonObject, extractText } = await import('../src/computer/vision.js');
const { secretRequestPayload, secretModal, viewerPayload, authMethodPayload, authQrPayload } = await import('../src/computer/ui.js');

const SCREEN = { width: 800, height: 600 };

test('secret names are restricted', () => {
  assert.equal(isSecretName('site_password'), true);
  assert.equal(isSecretName('Site Password'), false);
  assert.equal(isSecretName('{{secret:x}}'), false);
});

test('vault round-trips and isolates users', () => {
  setSecret('u1', 'site_password', 'p@ss w0rd!', 'https://example.com');
  assert.equal(getSecret('u1', 'site_password', 'https://example.com'), 'p@ss w0rd!');
  assert.equal(getSecret('u1', 'site_password', 'https://other.example'), null);
  setSecret('u1', 'site_password', 'other password', 'https://other.example');
  assert.equal(getSecret('u1', 'site_password', 'https://example.com'), 'p@ss w0rd!');
  assert.equal(getSecret('u1', 'site_password', 'https://other.example'), 'other password');
  assert.equal(getSecret('u2', 'site_password', 'https://example.com'), null);
  assert.deepEqual(listSecretNames('u1', 'https://example.com'), ['site_password']);
  assert.throws(() => setSecret('u1', 'Bad Name', 'x', 'https://example.com'));
});

test('parseAction accepts valid replies and rejects bad ones', () => {
  assert.equal(parseAction({ action: 'click', x: 10, y: 20 }, SCREEN).ok, true);
  assert.equal(parseAction({ action: 'click', x: 800, y: 20 }, SCREEN).ok, false);
  assert.equal(parseAction({ action: 'click', x: '10', y: 20 }, SCREEN).ok, false);
  assert.equal(parseAction({ action: 'shell', cmd: 'rm -rf /' }, SCREEN).ok, false);
  assert.equal(parseAction({ action: 'type', text: 'a {{secret:site_password}}' }, SCREEN).ok, false);
  assert.equal(parseAction({ action: 'scroll', x: 1, y: 1, dy: 0 }, SCREEN).ok, false);
  assert.equal(parseAction(null, SCREEN).ok, false);
  const req = parseAction({ action: 'request_secrets', fields: [{ name: 'site_address', label: 'アドレス' }] }, SCREEN);
  assert.equal(req.ok, true);
  assert.equal(parseAction({ action: 'choose_auth_method', options: [{ id: 'totp', label: '認証アプリ' }, { id: 'email', label: 'メール' }] }, SCREEN).ok, true);
  assert.equal(parseAction({ action: 'choose_auth_method', options: [{ id: 'totp', label: 'A' }, { id: 'totp', label: 'B' }] }, SCREEN).ok, false);
  assert.equal(parseAction({ action: 'share_auth_qr' }, SCREEN).ok, true);
  assert.deepEqual(parseAction({ action: 'done', remember: true }, SCREEN).action, { action: 'done', summary: '', remember: true });
  assert.equal(parseAction({ action: 'done', remember: 'true' }, SCREEN).action.remember, false);
});

test('selected 2FA method reaches the agent and QR screenshot goes only to the handoff', async () => {
  const script = [
    { action: 'choose_auth_method', options: [{ id: 'totp', label: '認証アプリ' }, { id: 'email', label: 'メール' }] },
    { action: 'share_auth_qr', message: '認証アプリの設定QRです' },
    { action: 'done', summary: '続行' },
  ];
  const seen = [];
  const shared = [];
  const result = await runComputerTask({ userId: 'u', task: 'ログイン', sessionId: 's',
    browser: { screenshot: async () => ({ png_base64: Buffer.from('image').toString('base64'), width: 800, height: 600 }), elements: async () => ({ elements: [] }) },
    vault: { listSecretNames: () => [], getSecret: () => null },
    decide: async args => { seen.push(args); return script.shift(); },
    requestSecrets: async () => null,
    chooseAuthMethod: async ({ options }) => { assert.equal(options[1].id, 'email'); return 'email'; },
    shareAuthQr: async data => { shared.push(data); return true; },
    settleMs: 0, sleep: async () => {},
  });
  assert.equal(result.status, 'done');
  assert.ok(seen[1].history.some(line => line.includes('メール')));
  assert.equal(shared[0].png.toString(), 'image');
});

test('redact hides every known value', () => {
  const out = redact('typed hunter2-SECRET here', new Map([['site_password', 'hunter2-SECRET']]));
  assert.equal(out, 'typed [secret:site_password] here');
});

test('loop keeps secret values away from the model and the progress log', async () => {
  const userId = 'u-loop';
  const store = new Map();
  const vault = {
    setSecret: (u, n, v) => store.set(u + ':' + n, v),
    getSecret: (u, n) => store.get(u + ':' + n) ?? null,
    listSecretNames: u => [...store.keys()].filter(k => k.startsWith(u + ':')).map(k => k.slice(u.length + 1)),
  };
  const script = [
    { action: 'request_secrets', message: 'ログイン', fields: [{ name: 'site_password', label: 'パスワード' }] },
    { action: 'click', x: 100, y: 200 },
    { action: 'type_secret', name: 'site_password' },
    { action: 'done', summary: 'ログインしました' },
  ];
  const seenArgs = [];
  const acts = [];
  const progress = [];
  const browser = {
    screenshot: async () => ({ png_base64: 'AAAA', width: 800, height: 600 }),
    act: async (id, a) => { acts.push(a); },
  };
  const result = await runComputerTask({
    userId, task: 'ログインして', sessionId: 's1', browser, vault,
    decide: async args => { seenArgs.push(args); return script.shift(); },
    requestSecrets: async ({ fields }) => {
      vault.setSecret(userId, 'site_password', 'hunter2-SECRET');
      return fields.map(f => f.name);
    },
    progress: async text => progress.push(text),
    settleMs: 0,
    sleep: async () => {},
  });
  assert.equal(result.status, 'done');
  assert.deepEqual(acts, [{ type: 'click', x: 100, y: 200 }, { type: 'type', text: 'hunter2-SECRET' }]);
  const everythingModelSaw = JSON.stringify(seenArgs);
  assert.equal(everythingModelSaw.includes('hunter2-SECRET'), false);
  assert.equal(everythingModelSaw.includes('site_password'), true);
  assert.equal(JSON.stringify(progress).includes('hunter2-SECRET'), false);
});

test('loop stops on limits and cancellation', async () => {
  const vault = { listSecretNames: () => [], getSecret: () => null };
  const browser = { screenshot: async () => ({ png_base64: 'AAAA', width: 800, height: 600 }), act: async () => {} };
  const bogus = await runComputerTask({ userId: 'x', task: 't', sessionId: 's', browser, vault,
    decide: async () => ({ action: 'nope' }), requestSecrets: async () => null, settleMs: 0, sleep: async () => {}, maxSteps: 3 });
  assert.equal(bogus.status, 'max_steps');
  const ac = new AbortController();
  ac.abort();
  const stopped = await runComputerTask({ userId: 'x', task: 't', sessionId: 's', browser, vault,
    decide: async () => ({ action: 'click', x: 1, y: 1 }), requestSecrets: async () => null, signal: ac.signal, settleMs: 0, sleep: async () => {} });
  assert.equal(stopped.status, 'stopped');
});

test('vision decider sends only text, screenshot and names', async () => {
  let sent = null;
  const fetchImpl = async (url, init) => {
    sent = { url, body: init.body };
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'Sure: {"action": "done", "summary": "ok"}' } }] }) };
  };
  const decide = makeDecider({ provider: 'openai', baseUrl: 'https://example.test/v1', apiKey: 'k', model: 'm', fetchImpl });
  const reply = await decide({ task: 't', history: ['1. click (1,1)'], pngBase64: 'PNGDATA', width: 800, height: 600, secretNames: ['site_password'] });
  assert.deepEqual(reply, { action: 'done', summary: 'ok' });
  assert.equal(sent.url, 'https://example.test/v1/chat/completions');
  assert.ok(sent.body.includes('data:image/png;base64,PNGDATA'));
  assert.ok(sent.body.includes('site_password'));
});

test('response helpers handle prose around JSON and each provider', () => {
  assert.deepEqual(parseJsonObject('here you go {"action":"wait"} thanks'), { action: 'wait' });
  assert.equal(parseJsonObject('no json here'), null);
  assert.equal(extractText('anthropic', { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'ab');
  assert.equal(extractText('google', { candidates: [{ content: { parts: [{ text: 'g' }] } }] }), 'g');
});

test('Discord payloads build without a client', () => {
  const req = secretRequestPayload('r1', 'ログイン', [{ name: 'site_address', label: 'アドレス' }]).components[0].toJSON();
  assert.equal(req.components[0].custom_id, 'cu_secret:r1');
  const modal = secretModal('r1', [{ name: 'site_password', label: 'パスワード' }]).toJSON();
  assert.equal(modal.custom_id, 'cu_secret_modal:r1');
  const view = viewerPayload(Buffer.from('PNGDATA'));
  assert.equal(view.files[0].name, 'harklet-browser.png');
  const methods = authMethodPayload('r2', '選択', [{ id: 'totp', label: '認証アプリ' }, { id: 'email', label: 'メール' }]);
  assert.equal(methods.components[0].toJSON().components[0].custom_id, 'cu_auth:r2');
  const qr = authQrPayload('r3', Buffer.from('PNGDATA'), 'QR');
  assert.equal(qr.files[0].name, 'harklet-auth.png');
  assert.equal(qr.components[0].toJSON().components[0].custom_id, 'cu_qr:r3');
});
