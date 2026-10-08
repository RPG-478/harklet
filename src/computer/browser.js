import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { startRemoteViewer } from './viewer-tunnel.js';

const root = resolve(process.env.HARKLET_BROWSER_DATA_DIR || 'browser-data');
const sessions = new Map();
const SELECTOR = 'a,button,input,textarea,select,[role="button"],[role="link"],[role="textbox"],[contenteditable="true"]';
const provider = process.env.HARKLET_BROWSER_PROVIDER || 'quicksand';

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function startVm(userHash, port, viewerPort) {
  return new Promise((resolveStart, rejectStart) => {
    const venvPython = resolve('sidecar', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    const python = process.env.HARKLET_PYTHON || (existsSync(venvPython) ? venvPython : (process.platform === 'win32' ? 'py' : 'python3'));
    const script = resolve('sidecar/quicksand_session.py');
    const child = spawn(python, ['-u', script, userHash, String(port), root, String(viewerPort)], {
      cwd: resolve(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    let settled = false;
    let stderr = '';
    const lines = createInterface({ input: child.stdout });
    const timer = setTimeout(() => fail(new Error('Quicksand VM の起動がタイムアウトしました')), 180000);
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
    function fail(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      rejectStart(err);
    }
    child.on('error', fail);
    child.on('exit', code => fail(new Error(`Quicksand が終了しました (${code}): ${stderr}`)));
    lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.error) { stderr = message.error + '\n' + stderr; return fail(new Error(message.error)); }
      if (!message.ready || settled) return;
      settled = true;
      clearTimeout(timer);
      resolveStart({ child, lines, listen: message.listen, viewerPort, viewerReady: message.viewer_ready === true, getError: () => stderr });
    });
  });
}

async function connectVm(port) {
  let last;
  for (let i = 0; i < 50; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
      if (!response.ok) throw new Error('CDP HTTP ' + response.status);
      const info = await response.json();
      const endpoint = new URL(info.webSocketDebuggerUrl);
      endpoint.hostname = '127.0.0.1';
      endpoint.port = String(port);
      return await chromium.connectOverCDP(endpoint.toString(), { timeout: 1500 });
    }
    catch (err) { last = err; await new Promise(resolve => setTimeout(resolve, 200)); }
  }
  throw new Error('VM内のChromiumに接続できません: ' + last?.message);
}

function session(id) {
  const s = sessions.get(id);
  if (!s) throw new Error('ブラウザセッションが終了しました');
  return s;
}

function page(s) {
  const pages = s.context.pages().filter(p => !p.isClosed());
  return pages.at(-1) || s.page;
}

function httpOrigin(url) {
  try {
    const u = new URL(url);
    return ['http:', 'https:'].includes(u.protocol) ? u.origin : null;
  } catch { return null; }
}

export function privateHost(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80:')) return true;
  const parts = h.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19));
}

async function createSession(userId) {
  const id = randomUUID();
  const userHash = createHash('sha256').update(String(userId)).digest('hex');
  const profile = join(root, userHash);
  await mkdir(profile, { recursive: true });
  let context, vm, remote;
  try {
    if (provider === 'quicksand') {
      const port = await freePort();
      const viewerPort = await freePort();
      vm = await startVm(userHash, port, viewerPort);
      try { remote = await connectVm(port); }
      catch (err) { throw new Error(err.message + ' (' + vm.listen + ')'); }
      context = remote.contexts()[0];
      if (!context) throw new Error('VMのブラウザコンテキストが見つかりません');
    } else if (provider === 'local') {
      context = await chromium.launchPersistentContext(profile, {
        headless: process.env.HARKLET_BROWSER_HEADLESS === '1',
        viewport: { width: 1280, height: 800 },
        acceptDownloads: true,
        downloadsPath: join(profile, 'downloads'),
        chromiumSandbox: true,
      });
    } else throw new Error('HARKLET_BROWSER_PROVIDER は quicksand または local を指定してください');
    if (process.env.HARKLET_BROWSER_ALLOW_PRIVATE !== '1') {
      await context.route('**/*', route => {
        try {
          const u = new URL(route.request().url());
          if (privateHost(u.hostname)) return route.abort('blockedbyclient');
        } catch {}
        return route.continue();
      });
    }
    const first = context.pages()[0] || await context.newPage();
    await first.setViewportSize({ width: 1280, height: 800 });
    let viewerTunnel = null;
    if (vm?.viewerReady && process.env.HARKLET_REMOTE_VIEWER !== '0') {
      try { viewerTunnel = await startRemoteViewer(vm.viewerPort); }
      catch (err) { console.warn('Remote viewer unavailable:', err.message); }
    }
    sessions.set(id, { context, page: first, elements: [], vm, remote, viewerTunnel });
    return { id, width: 1280, height: 800 };
  } catch (err) {
    await remote?.close().catch(() => {});
    if (vm) await stopVm(vm).catch(() => {});
    else await context?.close().catch(() => {});
    throw new Error('専用ブラウザを起動できません: ' + err.message +
      (provider === 'quicksand' ? '。Quicksandのセットアップを確認してください' : '。npm run browser:install を確認してください'));
  }
}

function stopVm(vm) {
  return new Promise((resolveStop, rejectStop) => {
    if (vm.child.exitCode !== null) return rejectStop(new Error('VMはすでに終了しています: ' + vm.getError()));
    const timer = setTimeout(() => { vm.child.kill(); rejectStop(new Error('VM保存がタイムアウトしました')); }, 60000);
    vm.child.once('exit', code => {
      clearTimeout(timer);
      if (code === 0) resolveStop();
      else rejectStop(new Error('VMの保存に失敗しました: ' + vm.getError()));
    });
    vm.child.stdin.end('\n');
  });
}

async function destroySession(id) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  s.viewerTunnel?.close();
  if (s.vm) {
    const cdp = await s.context.newCDPSession(page(s)).catch(() => null);
    await cdp?.send('Browser.close').catch(() => {});
    await s.remote.close().catch(() => {});
    await stopVm(s.vm);
  } else await s.context.close();
}

async function screenshot(id) {
  const p = page(session(id));
  const png = await p.screenshot({ type: 'png', animations: 'disabled', timeout: 15000 });
  const viewport = p.viewportSize();
  return { png_base64: png.toString('base64'), width: viewport?.width || png.readUInt32BE(16), height: viewport?.height || png.readUInt32BE(20) };
}

async function elements(id) {
  const s = session(id);
  const p = page(s);
  const all = p.locator(SELECTOR);
  const count = Math.min(await all.count(), 200);
  const items = [];
  await Promise.allSettled(s.elements.map(e => e.dispose()));
  s.elements = [];
  for (let i = 0; i < count && items.length < 60; i++) {
    const loc = all.nth(i);
    if (!await loc.isVisible().catch(() => false)) continue;
    const box = await loc.boundingBox().catch(() => null);
    if (!box) continue;
    const role = await loc.getAttribute('role').catch(() => null) || await loc.evaluate(el => el.tagName.toLowerCase()).catch(() => 'element');
    const label = (await loc.getAttribute('aria-label').catch(() => null)
      || await loc.getAttribute('placeholder').catch(() => null)
      || await loc.innerText({ timeout: 1000 }).catch(() => '')).trim().slice(0, 80);
    const index = items.length;
    const handle = await loc.elementHandle().catch(() => null);
    if (!handle) continue;
    s.elements.push(handle);
    items.push({ index, role, label, x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) });
  }
  return { window: { title: await p.title().catch(() => ''), url: p.url() }, elements: items };
}

const KEY = { ctrl: 'Control', control: 'Control', shift: 'Shift', meta: 'Meta', cmd: 'Meta',
  enter: 'Enter', return: 'Enter', tab: 'Tab', esc: 'Escape', escape: 'Escape', backspace: 'Backspace',
  delete: 'Delete', space: 'Space', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };
const ALLOWED_KEYS = new Set(['Enter', 'Tab', 'Shift+Tab', 'Escape', 'Backspace', 'Delete', 'Space',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Control+A', 'Meta+A']);

async function act(id, action) {
  const s = session(id);
  const p = page(s);
  switch (action.type) {
    case 'navigate': {
      if (typeof action.url !== 'string' || action.url.length > 2048 || !httpOrigin(action.url)) throw new Error('http(s) のURLが必要です');
      await p.goto(action.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      break;
    }
    case 'click': await p.mouse.click(action.x, action.y, { button: action.button || 'left' }); break;
    case 'double_click': await p.mouse.dblclick(action.x, action.y); break;
    case 'right_click': await p.mouse.click(action.x, action.y, { button: 'right' }); break;
    case 'move': await p.mouse.move(action.x, action.y); break;
    case 'click_element': {
      const handle = s.elements[action.index];
      if (!handle) throw new Error('要素番号が古くなりました');
      await handle.click({ timeout: 5000 });
      break;
    }
    case 'scroll': await p.mouse.wheel(0, action.dy * 100); break;
    case 'type': await p.keyboard.insertText(action.text); break;
    case 'key': {
      const chord = action.keys.map(k => KEY[k.toLowerCase()] || (k.length === 1 ? k.toUpperCase() : null));
      const combo = chord.join('+');
      if (chord.includes(null) || !ALLOWED_KEYS.has(combo)) throw new Error('未対応のキー操作です');
      await p.keyboard.press(combo);
      break;
    }
    default: throw new Error('未対応の操作です');
  }
}

function origin(id) { return httpOrigin(page(session(id)).url()); }

const DISCORD_NOTICE_ID = 'harklet-discord-login-notice';

async function showDiscordPrompt(id) {
  const target = page(session(id));
  await target.evaluate(noticeId => {
    document.getElementById(noticeId)?.remove();
    const overlay = document.createElement('div');
    overlay.id = noticeId;
    overlay.setAttribute('role', 'status');
    overlay.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;' +
      'display:flex;align-items:center;justify-content:center;background:rgba(8,12,24,.88);' +
      'color:white;font:700 30px system-ui,sans-serif;text-align:center;line-height:1.5;';
    const message = document.createElement('div');
    message.textContent = '🔐 Discordに戻ってログイン情報を入力してください\nReturn to Discord to enter login details';
    message.style.cssText = 'white-space:pre-line;max-width:80%;padding:32px;' +
      'background:#192641;border:2px solid #84b6ff;border-radius:16px;';
    overlay.append(message);
    (document.body || document.documentElement).append(overlay);
  }, DISCORD_NOTICE_ID);
  return async () => {
    await target.evaluate(noticeId => document.getElementById(noticeId)?.remove(), DISCORD_NOTICE_ID).catch(() => {});
  };
}

function viewerUrl(id) {
  const s = session(id);
  if (s.viewerTunnel) return s.viewerTunnel.url;
  const vm = s.vm;
  return vm?.viewerReady ? `http://127.0.0.1:${vm.viewerPort}/vnc.html?autoconnect=true&view_only=true&resize=scale` : null;
}

function remoteViewer(id) { return !!session(id).viewerTunnel; }

export const browser = { createSession, destroySession, screenshot, elements, act, origin, viewerUrl, remoteViewer, showDiscordPrompt };
