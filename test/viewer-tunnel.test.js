import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { startViewerGateway } from '../src/computer/viewer-tunnel.js';

test('viewer gateway requires the private link for HTTP and WebSocket', { timeout: 10000 }, async () => {
  const upstream = createServer((_req, res) => res.end('viewer page'));
  const upgraded = new Set();
  upstream.on('upgrade', (_req, socket) => {
    upgraded.add(socket);
    socket.on('close', () => upgraded.delete(socket));
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const gateway = await startViewerGateway(upstream.address().port);
  const base = `http://127.0.0.1:${gateway.port}`;
  try {
    assert.equal((await fetch(base + '/vnc.html')).status, 403);
    assert.equal((await fetch(base + '/open?key=wrong', { redirect: 'manual' })).status, 403);
    const opened = await fetch(base + '/open?key=' + gateway.token, { redirect: 'manual' });
    assert.equal(opened.status, 302);
    assert.equal(opened.headers.get('location'), '/vnc.html?autoconnect=true&view_only=true&resize=scale');
    const cookie = opened.headers.get('set-cookie').split(';')[0];
    assert.match(opened.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Lax/);
    assert.equal((await fetch(base + '/vnc.html', { headers: { cookie } })).status, 200);
    assert.equal(await (await fetch(base + '/vnc.html', { headers: { cookie } })).text(), 'viewer page');
    assert.match(await upgrade(gateway.port), /403 Forbidden/);
    assert.match(await upgrade(gateway.port, cookie), /101 Switching Protocols/);
  } finally {
    gateway.close();
    for (const socket of upgraded) socket.destroy();
    await new Promise(resolve => upstream.close(resolve));
  }
});

function upgrade(port, cookie = '') {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    socket.setTimeout(3000, () => { socket.destroy(); reject(new Error('WebSocket probe timed out')); });
    socket.on('error', reject);
    socket.on('connect', () => socket.write(
      'GET /websockify HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n' +
      'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
      (cookie ? `Cookie: ${cookie}\r\n` : '') + '\r\n'));
    socket.on('data', chunk => { resolve(chunk.toString()); socket.destroy(); });
  });
}

test('viewer gateway retries transient noVNC asset connection failures', { timeout: 10000 }, async () => {
  let attempts = 0;
  const upstream = createServer((_req, res) => {
    attempts++;
    if (attempts < 3) { res.destroy(); return; }
    res.end('loaded');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const gateway = await startViewerGateway(upstream.address().port);
  try {
    const base = `http://127.0.0.1:${gateway.port}`;
    const opened = await fetch(base + '/open?key=' + gateway.token, { redirect: 'manual' });
    const cookie = opened.headers.get('set-cookie').split(';')[0];
    const asset = await fetch(base + '/core/rfb.js', { headers: { cookie } });
    assert.equal(asset.status, 200);
    assert.equal(await asset.text(), 'loaded');
    assert.equal(attempts, 3);
  } finally {
    gateway.close();
    await new Promise(resolve => upstream.close(resolve));
  }
});
