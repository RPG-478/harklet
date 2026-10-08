import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sidecarDir = join(here, '..', '..', 'sidecar');
const port = Number(process.env.HARKLET_CUA_PORT) || 7791;
const base = 'http://127.0.0.1:' + port;

let proc = null;
let token = null;
let starting = null;
let stderrTail = '';

function pythonBin() {
  const explicit = process.env.HARKLET_CUA_PYTHON?.trim();
  if (explicit) return explicit;
  const win = process.platform === 'win32';
  const venv = join(sidecarDir, '.venv', win ? 'Scripts' : 'bin', win ? 'python.exe' : 'python');
  if (existsSync(venv)) return venv;
  return win ? 'python' : 'python3';
}

async function healthy() {
  try {
    const r = await fetch(base + '/health', { signal: AbortSignal.timeout(1000) });
    return r.ok;
  } catch {
    return false;
  }
}

async function ensureSidecar() {
  if (proc && token) return;
  if (starting) return starting;
  starting = (async () => {
    if (await healthy()) {
      throw new Error('ポート ' + port + ' は既に使われています。HARKLET_CUA_PORT を変えてください');
    }
    token = randomBytes(24).toString('hex');
    stderrTail = '';
    const child = spawn(pythonBin(), [join(sidecarDir, 'server.py')], {
      cwd: sidecarDir,
      env: { ...process.env, HARKLET_CUA_TOKEN: token, HARKLET_CUA_PORT: String(port) },
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    child.stderr.on('data', d => { stderrTail = (stderrTail + d.toString()).slice(-2000); });
    child.on('exit', () => { if (proc === child) { proc = null; token = null; } });
    proc = child;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) break;
      if (await healthy()) return;
      await new Promise(r => setTimeout(r, 300));
    }
    try { child.kill(); } catch {}
    proc = null;
    token = null;
    throw new Error('Cuaサイドカーが起動しませんでした: ' + stderrTail.trim().slice(-200));
  })().finally(() => { starting = null; });
  return starting;
}

async function call(method, path, body, timeoutMs = 120000) {
  await ensureSidecar();
  const headers = { 'X-Harklet-Token': token ?? '' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('サイドカー: ' + (data.error ?? res.status));
  return data;
}

// Thin client for the Python bridge. Action bodies are never logged.
export const sidecar = {
  createSession: () => call('POST', '/sessions', undefined, 15 * 60 * 1000),
  destroySession: id => call('DELETE', '/sessions/' + id),
  screenshot: id => call('GET', '/sessions/' + id + '/screenshot'),
  elements: id => call('GET', '/sessions/' + id + '/elements'),
  act: (id, action) => call('POST', '/sessions/' + id + '/actions', action),
  viewerUrl: async id => (await call('POST', '/sessions/' + id + '/viewer')).url,
  stop() {
    if (proc) { try { proc.kill(); } catch {} }
    proc = null;
    token = null;
  },
};
