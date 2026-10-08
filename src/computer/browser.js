import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(process.env.HARKLET_BROWSER_DATA_DIR || 'browser-data');
const sessions = new Map();
const SELECTOR = 'a,button,input,textarea,select,[role="button"],[role="link"],[role="textbox"],[contenteditable="true"]';

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
  const profile = join(root, createHash('sha256').update(String(userId)).digest('hex'));
  await mkdir(profile, { recursive: true });
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      headless: process.env.HARKLET_BROWSER_HEADLESS === '1',
      viewport: { width: 1280, height: 800 },
      acceptDownloads: true,
      downloadsPath: join(profile, 'downloads'),
      chromiumSandbox: true,
    });
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
    sessions.set(id, { context, page: first, elements: [] });
    return { id, width: 1280, height: 800 };
  } catch (err) {
    await context?.close().catch(() => {});
    throw new Error('専用ブラウザを起動できません: ' + err.message + '。npm run browser:install を確認してください');
  }
}

async function destroySession(id) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  await s.context.close();
}

async function screenshot(id) {
  const png = await page(session(id)).screenshot({ type: 'png', animations: 'disabled', timeout: 15000 });
  return { png_base64: png.toString('base64'), width: 1280, height: 800 };
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

const KEY = { ctrl: 'Control', control: 'Control', alt: 'Alt', shift: 'Shift', meta: 'Meta', cmd: 'Meta',
  enter: 'Enter', return: 'Enter', tab: 'Tab', esc: 'Escape', escape: 'Escape', backspace: 'Backspace',
  delete: 'Delete', space: 'Space', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };

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
      if (chord.includes(null)) throw new Error('未対応のキーです');
      await p.keyboard.press(chord.join('+'));
      break;
    }
    default: throw new Error('未対応の操作です');
  }
}

function origin(id) { return httpOrigin(page(session(id)).url()); }

export const browser = { createSession, destroySession, screenshot, elements, act, origin };
