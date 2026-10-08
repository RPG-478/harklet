import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { startRemoteViewer } from '../src/computer/viewer-tunnel.js';

test('Cloudflare Quick Tunnel serves the authenticated viewer over HTTPS',
  { skip: process.env.HARKLET_TEST_REMOTE_VIEWER !== '1', timeout: 90000 }, async () => {
    const upstream = createServer((_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end('<script>const ws=new WebSocket(`wss://${location.host}/websockify`);ws.onopen=()=>document.body.textContent="connected";ws.onerror=()=>document.body.textContent="failed"</script>');
    });
    const upgraded = new Set();
    upstream.on('upgrade', (req, socket) => {
      upgraded.add(socket);
      socket.on('close', () => upgraded.delete(socket));
      const accept = createHash('sha1').update(req.headers['sec-websocket-key'] +
        '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
      socket.on('error', () => {});
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    let tunnel, browser;
    try {
      tunnel = await startRemoteViewer(upstream.address().port);
      const origin = new URL(tunnel.url).origin;
      let opened;
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          opened = await fetch(tunnel.url, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
          if (opened.status === 302) break;
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      assert.equal(opened?.status, 302);
      const cookie = opened.headers.get('set-cookie').split(';')[0];
      const page = await fetch(origin + '/vnc.html', { headers: { cookie }, signal: AbortSignal.timeout(10000) });
      assert.equal(page.status, 200);
      assert.match(await page.text(), /new WebSocket/);
      assert.equal((await fetch(origin + '/vnc.html', { signal: AbortSignal.timeout(10000) })).status, 403);
      browser = await chromium.launch({ headless: true });
      const tab = await browser.newPage();
      await tab.goto(tunnel.url, { timeout: 30000 });
      await tab.waitForFunction(() => ['connected', 'failed'].includes(document.body.textContent), null, { timeout: 15000 });
      assert.equal(await tab.locator('body').innerText(), 'connected');
    } finally {
      await browser?.close();
      tunnel?.close();
      for (const socket of upgraded) socket.destroy();
      upstream.closeAllConnections();
      await new Promise(resolve => upstream.close(resolve));
    }
  });
