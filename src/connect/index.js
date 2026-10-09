// Connector registry: OAuth'd external services the agent can read from.
// Each provider: configured (env), connected (refresh token in vault), ops.
import * as g from './google.js';
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
    lines.push(p.name + (prof ? ' ✓接続済み(' + (prof.email || 'アカウント確認済み') + ')' : ' 未接続'));
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
export async function runOp(userId, ref) {
  const [pk, ok] = String(ref ?? '').split(':');
  const p = PROVIDERS[pk];
  if (!p) throw new Error('不明なサービス: ' + pk + '（' + Object.keys(PROVIDERS).join('/') + '）');
  if (!p.configured()) return p.name + ' はこのBotで未設定です（管理者が .env にクライアントIDを入れる必要があります）';
  if (!p.connected(userId)) return p.name + ' が未接続です。先に connect で接続してください';
  const op = p.ops[ok];
  if (!op) return p.name + ' にその操作はありません。可能: ' + Object.keys(p.ops).join(', ');
  return op.run(userId);
}

// For panels: fetch several ops, tolerate per-op failure.
export async function fetchOps(userId, refs) {
  const parts = [];
  for (const ref of refs ?? []) {
    try { parts.push('[' + ref + ']\n' + await runOp(userId, ref)); }
    catch (e) { parts.push('[' + ref + '] 取得失敗: ' + e.message); }
  }
  return parts.join('\n\n');
}
