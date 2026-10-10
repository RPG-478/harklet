import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startViewerGateway } from '../src/computer/viewer-tunnel.js';
import { humanRoutes } from '../src/computer/human-page.js';

function upstreamViewer() {
  return createServer((_req, res) => res.end('viewer page'));
}

test('gateway serves /open?next=/human and routes human endpoints', { timeout: 10000 }, async () => {
  const upstream = upstreamViewer();
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const clicks = [];
  const routes = humanRoutes({
    shot: async () => ({ png_base64: Buffer.from('jpeg-bytes').toString('base64'), width: 10, height: 10 }),
    click: async (x, y) => { clicks.push([x, y]); },
    box: async () => ({ w: 1280, h: 800, box: { x: 10, y: 20, w: 300, h: 200 } }),
    interactive: true,
  });
  const gateway = await startViewerGateway(upstream.address().port, false, routes);
  const base = `http://127.0.0.1:${gateway.port}`;
  try {
    const opened = await fetch(base + '/open?key=' + gateway.token + '&next=/human', { redirect: 'manual' });
    assert.equal(opened.status, 302);
    assert.equal(opened.headers.get('location'), '/human');
    const cookie = opened.headers.get('set-cookie').split(';')[0];
    // unknown next falls back to the noVNC page
    const back = await fetch(base + '/open?key=' + gateway.token + '&next=/etc/passwd', { redirect: 'manual' });
    assert.match(back.headers.get('location'), /^\/vnc\.html/);
    assert.equal((await fetch(base + '/human')).status, 403);
    const page = await fetch(base + '/human', { headers: { cookie } });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /human\/shot/);
    const shot = await fetch(base + '/human/shot', { headers: { cookie } });
    assert.equal(shot.headers.get('content-type'), 'image/jpeg');
    assert.equal(await shot.text(), 'jpeg-bytes');
    const box = await (await fetch(base + '/human/box', { headers: { cookie } })).json();
    assert.equal(box.box.w, 300);
    const click = await fetch(base + '/human/click', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ x: 42, y: 99 }),
    });
    assert.equal(click.status, 204);
    assert.deepEqual(clicks, [[42, 99]]);
  } finally {
    gateway.close();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test('human click is rejected in view-only mode', { timeout: 10000 }, async () => {
  const routes = humanRoutes({
    shot: async () => ({ png_base64: 'eA==', width: 1, height: 1 }),
    click: async () => { throw new Error('must not be called'); },
    box: async () => ({}),
    interactive: false,
  });
  const res = { code: 0, body: '', writeHead(c) { this.code = c; }, end(b) { this.body = String(b ?? ''); } };
  const req = { method: 'POST', url: '/human/click', headers: {}, on() {} };
  // call the route handler directly with a stub req lacking a body stream
  try { await routes(req, res, new URL('http://x/human/click')); } catch { /* readBody never fires on stub */ }
  assert.equal(res.code, 403);
});
