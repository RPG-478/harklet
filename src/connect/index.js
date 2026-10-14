// Connector registry: OAuth'd external services the agent can read from.
// Each provider: configured (env), connected (refresh token in vault), ops.
import * as g from './google.js';
import { t } from '../i18n.js';
import { userLang } from '../user-lang.js';
import * as m from './m365.js';

export const PROVIDERS = {
  google: {
    name: 'Google Workspace',
    configured: g.googleConfigured,
    connected: g.googleConnected,
    profile: g.googleProfile,
    disconnect: g.googleDisconnect,
    ops: {
      gmail_unread: { desc: 'Gmail未読メール(3日以内)上位5件', run: g.gmailUnread },
      gmail_trash: { write: true, desc: 'Gmail検索条件に一致するメールをゴミ箱へ(例 "google:gmail_trash from:reddit.com")。要gmail.modify', run: (u, arg) => g.gmailTrash(u, arg), takesArg: true },
      calendar_today: { desc: 'Googleカレンダーの今日の予定', run: g.calendarToday },
    },
  },
  m365: {
    name: 'Microsoft 365',
    configured: m.m365Configured,
    connected: m.m365Connected,
    profile: m.m365Profile,
    disconnect: m.m365Disconnect,
    ops: {
      mail_unread: { desc: 'Outlook未読メール上位5件', run: m.mailUnread },
      calendar_today: { desc: 'M365カレンダーの今日の予定', run: m.calendarToday },
    },
  },
};

export function providerStatus(userId) {
  const lines = [];
  for (const [key, p] of Object.entries(PROVIDERS)) {
    if (!p.configured()) continue;
    const prof = p.connected(userId) ? p.profile(userId) : null;
    lines.push(p.name + (prof ? t(userLang(userId), 'conn.connected', { email: prof.email || t(userLang(userId), 'conn.connectedNoEmail') }) : t(userLang(userId), 'conn.notConn')));
  }
  return lines;
}

export function opsCatalog(userId) {
  const out = [];
  for (const [pk, p] of Object.entries(PROVIDERS)) {
    if (!p.configured() || !p.connected(userId)) continue;
    for (const [ok, o] of Object.entries(p.ops)) out.push(pk + ':' + ok + ' = ' + o.desc);
  }
  return out;
}

// "provider:op" → result text. Throws with a human-readable message.
// A ref may carry one argument after a space: "google:gmail_trash from:reddit".
export async function runOp(userId, ref) {
  const raw = String(ref ?? '').trim();
  const space = raw.indexOf(' ');
  const base = space < 0 ? raw : raw.slice(0, space);
  const arg = space < 0 ? '' : raw.slice(space + 1).trim();
  const [pk, ok] = base.split(':');
  const p = PROVIDERS[pk];
  if (!p) throw new Error(t(userLang(userId), 'conn.unknown', { name: pk, list: Object.keys(PROVIDERS).join('/') }));
  if (!p.configured()) return t(userLang(userId), 'conn.notConfigured', { name: p.name });
  if (!p.connected(userId)) return t(userLang(userId), 'conn.notConnected', { name: p.name });
  const op = p.ops[ok];
  if (!op) return t(userLang(userId), 'conn.noOp', { name: p.name, list: Object.keys(p.ops).join(', ') });
  if (op.takesArg && !arg) return op.desc;
  return op.run(userId, arg || undefined);
}

// For panels: fetch several ops, tolerate per-op failure.
export async function fetchOps(userId, refs) {
  const parts = [];
  for (const ref of refs ?? []) {
    const [pk, ok] = String(ref).split(' ')[0].split(':');
    if (PROVIDERS[pk]?.ops?.[ok]?.write) {
      parts.push(t(userLang(userId), 'conn.skipWrite', { ref }));
      continue;
    }
    try { parts.push('[' + ref + ']\n' + await runOp(userId, ref)); }
    catch (e) { parts.push(t(userLang(userId), 'conn.fetchFail', { ref, msg: e.message })); }
  }
  return parts.join('\n\n');
}
