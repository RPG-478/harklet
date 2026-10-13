import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';

// In-VM credential E2E against a LOCAL page served on the host. Proves the
// whole fill path: elements() finds the fields, session secrets resolve by
// origin, fill via element handle lands the value, and the submit reaches an
// authenticated page. One-time secrets are used because the persistent vault
// only stores https:// origins; SessionSecrets.get() resolves them through
// the same code path the modal-submit flow uses.
test('in-VM login: elements detect fields, secrets fill them, submit reaches the secure page',
  { skip: process.env.HARKLET_TEST_LOGIN_FILL !== '1', timeout: 180000 }, async () => {
    process.env.HARKLET_BROWSER_PROVIDER = 'quicksand';
    process.env.HARKLET_BROWSER_ALLOW_PRIVATE = '1';
    const dataRoot = resolve(tmpdir());
    const dataDir = await mkdtemp(join(dataRoot, 'harklet-login-fill-'));
    process.env.HARKLET_BROWSER_DATA_DIR = dataDir;
    const { browser } = await import('../src/computer/browser.js');
    const { SessionSecrets } = await import('../src/computer/session-secrets.js');
    const { vault } = await import('../src/computer/vault.js');

    const USER = 'tomsmith', PASS = 'SuperSecretPassword!';
    const server = createServer((req, res) => {
      const authed = req.headers.cookie?.includes('e2e_sess=ok');
      if (req.method === 'POST' && req.url === '/do-login') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
          const p = new URLSearchParams(body);
          if (p.get('username') === USER && p.get('password') === PASS) {
            res.setHeader('Set-Cookie', 'e2e_sess=ok; Path=/');
            res.statusCode = 302; res.setHeader('Location', '/secure'); res.end();
          } else { res.statusCode = 401; res.end('bad creds'); }
        });
        return;
      }
      res.setHeader('Content-Type', 'text/html');
      if (req.url === '/secure') return res.end(authed ? '<title>Secure Area</title>' : '<title>Denied</title>');
      res.end('<title>Login</title><form method="post" action="/do-login">' +
        '<input name="username" placeholder="Username">' +
        '<input name="password" type="password" placeholder="Password">' +
        '<button type="submit">Login</button></form>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://10.0.2.2:' + server.address().port;

    let id;
    try {
      ({ id } = await browser.createSession('login-fill-user'));
      const secrets = new SessionSecrets(vault, 'login-fill-user', () => browser.origin(id));
      await browser.act(id, { type: 'navigate', url: base + '/login' });
      let els;
      for (let i = 0; i < 8; i++) {
        await new Promise(r => setTimeout(r, 2500));
        els = await browser.elements(id);
        if (els.elements.length >= 3) break;
      }
      assert.ok(els.elements.length >= 3, 'login fields should be listed');
      const find = re => els.elements.find(e => re.test((e.label || '') + ' ' + e.role));
      const userEl = find(/user/i), passEl = find(/pass/i), submitEl = find(/login|submit|button/i);
      assert.ok(userEl && passEl && submitEl, 'username, password and submit must be detectable');

      const origin = browser.origin(id);
      secrets.setOneTime('demo_user', USER, origin);
      secrets.setOneTime('demo_pass', PASS, origin);
      assert.deepEqual(secrets.names().sort(), ['demo_pass', 'demo_user']);
      assert.equal(secrets.get('demo_user'), USER);

      await browser.act(id, { type: 'fill', index: userEl.index, text: secrets.get('demo_user') });
      await browser.act(id, { type: 'fill', index: passEl.index, text: secrets.get('demo_pass') });
      await browser.act(id, { type: 'click_element', index: submitEl.index });
      await new Promise(r => setTimeout(r, 4000));

      const after = await browser.elements(id);
      assert.ok(after.window.url.endsWith('/secure'), 'should reach the secure page, got ' + after.window.url);
      assert.match(after.window.title, /Secure/);
    } finally {
      if (id) await browser.destroySession(id);
      await new Promise(resolve => server.close(resolve));
      const rel = relative(dataRoot, resolve(dataDir));
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('unsafe test cleanup path');
      await rm(dataDir, { recursive: true, force: true });
    }
  });
