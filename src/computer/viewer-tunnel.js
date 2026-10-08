import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';

const COOKIE = 'harklet_view';

function equalSecret(a, b) {
  if (!a || !b) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function startViewerGateway(viewerPort) {
  const token = randomBytes(32).toString('base64url');
  const sockets = new Set();
  const authorized = req => {
    const cookie = req.headers.cookie?.split(';').map(x => x.trim())
      .find(x => x.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
    return equalSecret(cookie, token);
  };
  const forward = (req, res) => {
    const headers = { ...req.headers, host: `127.0.0.1:${viewerPort}` };
    delete headers.cookie;
    let attempt = 0;
    const send = () => {
      attempt++;
      const upstream = httpRequest({ hostname: '127.0.0.1', port: viewerPort,
        path: req.url, method: req.method, headers }, response => {
        res.writeHead(response.statusCode, {
          ...response.headers, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
          'x-frame-options': 'DENY',
        });
        response.pipe(res);
      });
      upstream.on('error', () => {
        if (['GET', 'HEAD'].includes(req.method) && attempt < 4 && !res.headersSent && !res.writableEnded) {
          setTimeout(send, 120 * attempt);
          return;
        }
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      if (['GET', 'HEAD'].includes(req.method)) upstream.end();
      else req.pipe(upstream);
    };
    send();
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/open' && equalSecret(url.searchParams.get('key'), token)) {
      res.writeHead(302, {
        location: '/vnc.html?autoconnect=true&view_only=true&resize=scale',
        'set-cookie': `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/`,
        'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
      });
      res.end();
      return;
    }
    if (!authorized(req)) { res.writeHead(403, { 'cache-control': 'no-store' }); res.end(); return; }
    forward(req, res);
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (req, socket, head) => {
    if (!authorized(req)) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    const headers = { ...req.headers, host: `127.0.0.1:${viewerPort}` };
    delete headers.cookie;
    let upstream, attempt = 0;
    socket.on('error', () => upstream?.destroy());
    const connect = () => {
      if (socket.destroyed) return;
      attempt++;
      upstream = httpRequest({ hostname: '127.0.0.1', port: viewerPort,
        path: req.url, method: req.method, headers });
      upstream.on('upgrade', (response, upstreamSocket, upstreamHead) => {
        socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers)
          .map(([name, value]) => `${name}: ${value}`).join('\r\n')}\r\n\r\n`);
        if (upstreamHead.length) socket.write(upstreamHead);
        if (head.length) upstreamSocket.write(head);
        socket.pipe(upstreamSocket).pipe(socket);
      });
      upstream.on('error', () => {
        if (attempt < 4 && !socket.destroyed) setTimeout(connect, 120 * attempt);
        else socket.destroy();
      });
      upstream.end();
    };
    connect();
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  } catch (err) { server.close(); throw err; }
  return {
    port: server.address().port,
    token,
    close: () => { for (const socket of sockets) socket.destroy(); server.close(); },
  };
}

export async function startRemoteViewer(viewerPort) {
  const gateway = await startViewerGateway(viewerPort);
  const command = process.env.HARKLET_CLOUDFLARED || 'cloudflared';
  const child = spawn(command, ['--no-autoupdate', 'tunnel', '--url', `http://127.0.0.1:${gateway.port}`],
    { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  try {
    const origin = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('公開URLの取得がタイムアウトしました')), 45000);
      const fail = err => { clearTimeout(timer); reject(err); };
      child.on('error', fail);
      child.on('exit', code => fail(new Error(`cloudflared が終了しました (${code})`)));
      child.stderr.on('data', chunk => {
        output = (output + chunk.toString()).slice(-10000);
        const found = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i);
        if (found) { clearTimeout(timer); resolve(found[0]); }
      });
    });
    const url = `${origin}/open?key=${gateway.token}`;
    let ready = false;
    for (let attempt = 0; attempt < 20 && child.exitCode === null; attempt++) {
      try {
        const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
        if (response.status === 302) { ready = true; break; }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (!ready) throw new Error('公開ビューアへ接続できません');
    return {
      url,
      close: () => { child.kill(); gateway.close(); },
    };
  } catch (err) {
    child.kill();
    gateway.close();
    throw err;
  }
}
