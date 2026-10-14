import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), 'public');
const FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.css', ['app.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
]);
const SESSION_MS = 24 * 60 * 60 * 1000;
const TICKET_MS = 5 * 60 * 1000;
const LIMIT = 8192;

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    ...extra });
  res.end(body);
}

async function readJson(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('JSON required');
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > LIMIT) throw new Error('Request too large');
  }
  return JSON.parse(body);
}

export async function startWebUi({ state, chat, action, panel, port = 8787 }) {
  const tickets = new Map();
  const sessions = new Map();
  const busy = new Set();
  const busyActions = new Set();
  const server = createServer(async (req, res) => {
    const origin = `http://127.0.0.1:${server.address()?.port}`;
    if (req.headers.host !== `127.0.0.1:${server.address()?.port}`) return send(res, 403, 'Forbidden', 'text/plain');
    const url = new URL(req.url, origin);
    if (url.pathname === '/open' && req.method === 'GET') {
      const token = url.searchParams.get('ticket');
      const ticket = tickets.get(token);
      if (!ticket || ticket.expires < Date.now()) return send(res, 403, 'Link expired', 'text/plain');
      tickets.delete(token);
      const sid = randomBytes(32).toString('hex');
      sessions.set(sid, { userId: ticket.userId, expires: Date.now() + SESSION_MS });
      res.writeHead(303, { location: '/', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
        'set-cookie': `harklet_web=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400` });
      res.end();
      return;
    }
    const sid = /(?:^|;\s*)harklet_web=([0-9a-f]{64})(?:;|$)/.exec(req.headers.cookie ?? '')?.[1];
    const session = sessions.get(sid);
    if (!session || session.expires < Date.now()) {
      if (sid) sessions.delete(sid);
      return send(res, 401, 'Open /web in Discord to get your private link.', 'text/plain; charset=utf-8');
    }
    if (req.method === 'POST' && req.headers.origin !== origin) return send(res, 403, 'Forbidden', 'text/plain');
    const userId = session.userId;
    try {
      if (req.method === 'GET' && FILES.has(url.pathname)) {
        const [file, type] = FILES.get(url.pathname);
        return send(res, 200, await readFile(join(ROOT, file)), type);
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        return send(res, 200, JSON.stringify(await state(userId)));
      }
      if (req.method === 'POST' && url.pathname === '/api/chat') {
        const { text } = await readJson(req);
        if (typeof text !== 'string' || !text.trim() || text.length > 2000) return send(res, 400, '{"error":"Enter 1–2000 characters"}');
        if (busy.has(userId)) return send(res, 409, '{"error":"A response is already running"}');
        busy.add(userId);
        try { return send(res, 200, JSON.stringify(await chat(userId, text.trim()))); }
        finally { busy.delete(userId); }
      }
      if (req.method === 'POST' && url.pathname === '/api/action') {
        const { id } = await readJson(req);
        if (!Number.isSafeInteger(id) || id < 1) return send(res, 400, '{"error":"Invalid action"}');
        if (busyActions.has(id)) return send(res, 409, '{"error":"Action already running"}');
        busyActions.add(id);
        try { return send(res, 200, JSON.stringify(await action(userId, id))); }
        finally { busyActions.delete(id); }
      }
      if (req.method === 'POST' && url.pathname === '/api/panel') {
        const { id } = await readJson(req);
        if (!Number.isSafeInteger(id) || id < 1) return send(res, 400, '{"error":"Invalid panel"}');
        return send(res, 200, JSON.stringify(await panel(userId, id)));
      }
      return send(res, 404, 'Not found', 'text/plain');
    } catch (err) {
      console.error('[web]', err);
      return send(res, 500, JSON.stringify({ error: String(err.message ?? err) }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    port: server.address().port,
    issueLink(userId) {
      const ticket = randomBytes(32).toString('hex');
      tickets.set(ticket, { userId, expires: Date.now() + TICKET_MS });
      return `http://127.0.0.1:${server.address().port}/open?ticket=${ticket}`;
    },
    close: () => new Promise(resolve => server.close(resolve)),
  };
}
