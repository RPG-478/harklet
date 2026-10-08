import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

// Run explicitly after `npm run browser:install`.
test('dedicated browser can navigate, see, click, type and keep its own origin',
  { skip: !existsSync(chromium.executablePath()) && 'Install Chromium with npm run browser:install' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'harklet-browser-test-'));
  process.env.HARKLET_BROWSER_DATA_DIR = root;
  process.env.HARKLET_BROWSER_HEADLESS = '1';
  process.env.HARKLET_BROWSER_ALLOW_PRIVATE = '1';
  const { browser, privateHost } = await import('../src/computer/browser.js');
  assert.equal(privateHost('127.0.0.1'), true);
  assert.equal(privateHost('example.com'), false);
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<title>Harklet test</title><button id="go" onclick="this.textContent=\'Opened\'">Open</button><input id="input" placeholder="Name">');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let id;
  let blockedId;
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    ({ id } = await browser.createSession('test-user'));
    await browser.act(id, { type: 'navigate', url: origin });
    assert.equal(browser.origin(id), origin);
    const shot = await browser.screenshot(id);
    assert.ok(shot.png_base64.length > 100);
    const listed = await browser.elements(id);
    const button = listed.elements.find(e => e.label === 'Open');
    const input = listed.elements.find(e => e.label === 'Name');
    assert.ok(button);
    assert.ok(input);
    await browser.act(id, { type: 'click_element', index: button.index });
    assert.ok((await browser.elements(id)).elements.some(e => e.label === 'Opened'));
    const listedAgain = await browser.elements(id);
    const newInput = listedAgain.elements.find(e => e.label === 'Name');
    await browser.act(id, { type: 'click_element', index: newInput.index });
    await browser.act(id, { type: 'type', text: 'Alice' });
    const page = await browser.elements(id);
    assert.ok(page.elements.length >= 2);
    assert.equal(page.window.title, 'Harklet test');
    await assert.rejects(browser.act(id, { type: 'navigate', url: 'file:///etc/passwd' }));
    await assert.rejects(browser.act(id, { type: 'key', keys: ['ctrl', 'l'] }));
    delete process.env.HARKLET_BROWSER_ALLOW_PRIVATE;
    ({ id: blockedId } = await browser.createSession('blocked-user'));
    await assert.rejects(browser.act(blockedId, { type: 'navigate', url: origin }));
  } finally {
    if (blockedId) await browser.destroySession(blockedId);
    if (id) await browser.destroySession(id);
    await new Promise(resolve => server.close(resolve));
    const target = resolve(root);
    if (!target.startsWith(resolve(tmpdir()) + sep)) throw new Error('unsafe test cleanup path');
    await rm(target, { recursive: true, force: true });
  }
});
