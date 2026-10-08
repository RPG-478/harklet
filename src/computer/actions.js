import { isSecretName, isOneTimeSecretField } from './names.js';

const KEY_RE = /^[a-zA-Z0-9_+]{1,20}$/;
const TYPES = new Set(['click', 'double_click', 'right_click', 'move', 'scroll', 'type', 'type_secret',
  'click_element', 'navigate', 'key', 'wait', 'request_secrets', 'choose_auth_method', 'share_auth_qr', 'done', 'fail']);

const bad = error => ({ ok: false, error });
const good = action => ({ ok: true, action });

function point(raw, width, height) {
  const { x, y } = raw;
  if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
  if (x < 0 || y < 0 || x >= width || y >= height) return null;
  return { x, y };
}

// Validate one model reply. Returns { ok, action } or { ok: false, error }.
// Nothing here touches the sandbox or the vault.
export function parseAction(raw, { width, height, elementCount = 0 }) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('reply is not a JSON object');
  const t = raw.action;
  if (!TYPES.has(t)) return bad('unknown action: ' + String(t));
  switch (t) {
    case 'navigate': {
      if (typeof raw.url !== 'string' || raw.url.length > 2048) return bad('navigate needs an http(s) URL');
      try {
        const u = new URL(raw.url);
        if (!['http:', 'https:'].includes(u.protocol)) return bad('navigate needs an http(s) URL');
        return good({ action: t, url: u.href });
      } catch { return bad('navigate needs an http(s) URL'); }
    }
    case 'click':
    case 'double_click':
    case 'right_click':
    case 'move': {
      const p = point(raw, width, height);
      if (!p) return bad('x and y must be integers inside the screen');
      return good({ action: t, x: p.x, y: p.y });
    }
    case 'scroll': {
      const p = point(raw, width, height);
      const dy = Number.isInteger(raw.dy) && Math.abs(raw.dy) <= 20 && raw.dy !== 0 ? raw.dy : null;
      if (!p || dy === null) return bad('scroll needs x, y and dy (-20..20, not 0)');
      return good({ action: t, x: p.x, y: p.y, dy });
    }
    case 'click_element': {
      const ok = Number.isInteger(raw.index) && raw.index >= 0 && raw.index < elementCount;
      return ok ? good({ action: t, index: raw.index }) : bad('click_element needs an index from the element list');
    }
    case 'type': {
      if (typeof raw.text !== 'string' || !raw.text || raw.text.length > 300) return bad('type needs text of 1-300 chars');
      if (raw.text.includes('{{secret:')) return bad('use type_secret for saved values');
      return good({ action: t, text: raw.text });
    }
    case 'type_secret':
      return isSecretName(raw.name) ? good({ action: t, name: raw.name }) : bad('type_secret needs a valid saved name');
    case 'key': {
      const keys = typeof raw.keys === 'string' ? [raw.keys] : raw.keys;
      const ok = Array.isArray(keys) && keys.length >= 1 && keys.length <= 4
        && keys.every(k => typeof k === 'string' && KEY_RE.test(k));
      return ok ? good({ action: t, keys }) : bad('key needs keys: 1-4 names such as ["ctrl", "a"]');
    }
    case 'wait': {
      const s = typeof raw.seconds === 'number' ? Math.min(Math.max(raw.seconds, 0.5), 10) : 1;
      return good({ action: t, seconds: s });
    }
    case 'request_secrets': {
      const fields = Array.isArray(raw.fields) ? raw.fields : [];
      const ok = fields.length >= 1 && fields.length <= 4
        && fields.every(f => f && isSecretName(f.name) && typeof f.label === 'string' && f.label.length >= 1 && f.label.length <= 40);
      if (!ok) return bad('request_secrets needs 1-4 fields, each with name and label');
      const message = typeof raw.message === 'string' ? raw.message.slice(0, 300) : 'ログイン情報を入力してください';
      return good({ action: t, message, fields: fields.map(f => ({
        name: f.name,
        label: f.label,
        one_time: isOneTimeSecretField(f),
      })) });
    }
    case 'choose_auth_method': {
      const options = Array.isArray(raw.options) ? raw.options : [];
      if (options.length < 2 || options.length > 10 ||
          !options.every(o => o && isSecretName(o.id) && typeof o.label === 'string' && o.label.length >= 1 && o.label.length <= 100) ||
          new Set(options.map(o => o.id)).size !== options.length) return bad('choose_auth_method needs 2-10 distinct options');
      return good({ action: t, message: String(raw.message ?? '認証方法を選んでください').slice(0, 300),
        options: options.map(o => ({ id: o.id, label: o.label })) });
    }
    case 'share_auth_qr':
      return good({ action: t, message: String(raw.message ?? '認証用QRコードを確認してください').slice(0, 300) });
    case 'done':
      return good({ action: t, summary: String(raw.summary ?? '').slice(0, 500) });
    case 'fail':
      return good({ action: t, reason: String(raw.reason ?? '').slice(0, 500) });
    default:
      return bad('unhandled action');
  }
}
