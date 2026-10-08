import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';

test('Quicksand VM persists browser cookies across restarts',
  { skip: process.env.HARKLET_TEST_QUICKSAND !== '1' }, async () => {
    process.env.HARKLET_BROWSER_PROVIDER = 'quicksand';
    process.env.HARKLET_BROWSER_ALLOW_PRIVATE = '1';
    const dataRoot = resolve(process.env.HARKLET_TEST_DATA_ROOT || tmpdir());
    const dataDir = await mkdtemp(join(dataRoot, 'harklet-quicksand-test-'));
    process.env.HARKLET_BROWSER_DATA_DIR = dataDir;
    const { browser } = await import('../src/computer/browser.js');
    const server = createServer((req, res) => {
      if (req.url === '/set') res.setHeader('Set-Cookie', 'harklet_probe=kept; Path=/; SameSite=Lax');
      res.setHeader('Content-Type', 'text/html');
      res.end(`<title>${req.headers.cookie?.includes('harklet_probe=kept') ? 'Cookie kept' : 'No cookie'}</title>`);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://10.0.2.2:${server.address().port}`;
    let id;
    try {
      ({ id } = await browser.createSession('persistent-user'));
      const viewer = browser.viewerUrl(id);
      assert.match(viewer, /^http:\/\/127\.0\.0\.1:\d+\/vnc\.html\?/);
      const viewerResponse = await fetch(viewer, { signal: AbortSignal.timeout(5000) });
      assert.equal(viewerResponse.status, 200);
      await browser.act(id, { type: 'navigate', url: base + '/set' });
      await browser.act(id, { type: 'navigate', url: base + '/check' });
      assert.equal((await browser.elements(id)).window.title, 'Cookie kept');
      await browser.destroySession(id);
      id = null;
      ({ id } = await browser.createSession('persistent-user'));
      await browser.act(id, { type: 'navigate', url: base + '/check' });
      assert.equal((await browser.elements(id)).window.title, 'Cookie kept');
    } finally {
      if (id) await browser.destroySession(id);
      await new Promise(resolve => server.close(resolve));
      const rel = relative(dataRoot, resolve(dataDir));
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('unsafe test cleanup path');
      await rm(dataDir, { recursive: true, force: true });
    }
  });
