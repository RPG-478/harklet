// Google Workspace connector: OAuth installed-app loopback + Gmail/Calendar read APIs.
// Flow: agent "connect" action → auth URL → user consents → browser lands on a dead
// http://127.0.0.1 page → user pastes the URL into a Discord modal → we exchange the code.
import { vault, vaultReady } from '../computer/vault.js';
import { t } from '../i18n.js';
import { userLang } from '../user-lang.js';

// OSS deployments can embed a default OAuth client the maintainer created once
// in Google Cloud (rclone-style). End users then only need to sign in. Values
// in .env override the embedded ones. See docs/oauth-setup.md.
const DEFAULT_CLIENT_ID = '';
const DEFAULT_CLIENT_SECRET = '';
const CID = () => process.env.GOOGLE_CLIENT_ID?.trim() || DEFAULT_CLIENT_ID;
const CSEC = () => process.env.GOOGLE_CLIENT_SECRET?.trim() || DEFAULT_CLIENT_SECRET;
const TOKEN_ORIGIN = 'https://oauth2.googleapis.com';
const REFRESH_NAME = 'gws_refresh';
const PROFILE_NAME = 'gws_profile';
const SCOPES = [
  'openid', 'email',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar.readonly',
].join(' ');
const REDIRECT = 'http://127.0.0.1';

export function googleConfigured() { return !!(CID() && CSEC()); }
export function googleConnected(userId) {
  return vaultReady() && vault.listSecretNames(userId, TOKEN_ORIGIN).includes(REFRESH_NAME);
}
export function googleProfile(userId) {
  try { return JSON.parse(vault.getSecret(userId, PROFILE_NAME, TOKEN_ORIGIN) ?? 'null'); } catch { return null; }
}

export function authUrl(state) {
  const p = new URLSearchParams({
    client_id: CID(), redirect_uri: REDIRECT, response_type: 'code',
    scope: SCOPES, access_type: 'offline', prompt: 'consent', state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

async function tokenRequest(fields) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('token request failed: ' + (data.error_description || data.error || res.status));
  return data;
}

// Accepts a pasted URL ("http://127.0.0.1/?code=..&state=..") or a bare code.
export function parseAuthInput(text) {
  const t = String(text ?? '').trim();
  const m = t.match(/[?&]code=([^&\s]+)/);
  const state = t.match(/[?&]state=([^&\s]+)/)?.[1];
  return { code: decodeURIComponent(m ? m[1] : t), state };
}

export async function exchangeCode(userId, code) {
  const data = await tokenRequest({
    code, client_id: CID(), client_secret: CSEC(),
    redirect_uri: REDIRECT, grant_type: 'authorization_code',
  });
  if (!data.refresh_token) throw new Error('refresh_token が返りませんでした。prompt=consent で再認証が必要です');
  vault.setSecret(userId, REFRESH_NAME, data.refresh_token, TOKEN_ORIGIN);
  let email = '';
  try {
    const me = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: 'Bearer ' + data.access_token },
    }).then(r => r.ok ? r.json() : null);
    email = me?.email ?? '';
  } catch {}
  vault.setSecret(userId, PROFILE_NAME, JSON.stringify({ email }), TOKEN_ORIGIN);
  return email;
}

async function accessToken(userId) {
  const refresh = vault.getSecret(userId, REFRESH_NAME, TOKEN_ORIGIN);
  if (!refresh) throw new Error('Google未接続');
  const data = await tokenRequest({
    refresh_token: refresh, client_id: CID(), client_secret: CSEC(),
    grant_type: 'refresh_token',
  });
  return data.access_token;
}

async function api(userId, url) {
  const token = await accessToken(userId);
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error('Google API ' + res.status + ': ' + JSON.stringify(data?.error?.message ?? data).slice(0, 200));
  return data;
}

export async function gmailUnread(userId, n = 5) {
  const list = await api(userId, 'https://gmail.googleapis.com/gmail/v1/users/me/messages?q='
    + encodeURIComponent('is:unread newer_than:3d') + '&maxResults=' + n);
  const msgs = list.messages ?? [];
  if (!msgs.length) return t(userLang(userId), 'g.none');
  const lines = [];
  for (const m of msgs) {
    const d = await api(userId, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/' + m.id
      + '?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date');
    const h = Object.fromEntries((d.payload?.headers ?? []).map(x => [x.name, x.value]));
    lines.push('• ' + (h.Subject ?? t(userLang(userId), 'g.noSubject')) + ' — ' + (h.From ?? '').slice(0, 60));
  }
  return t(userLang(userId), 'g.list', { n: list.resultSizeEstimate ?? msgs.length, lines: lines.join('\n') });
}

export async function calendarToday(userId) {
  const now = new Date();
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setDate(end.getDate() + 1);
  const data = await api(userId, 'https://www.googleapis.com/calendar/v3/calendars/primary/events?'
    + 'timeMin=' + encodeURIComponent(start.toISOString())
    + '&timeMax=' + encodeURIComponent(end.toISOString())
    + '&singleEvents=true&orderBy=startTime&maxResults=10');
  const evs = data.items ?? [];
  if (!evs.length) return t(userLang(userId), 'g.calNone');
  const lines = evs.map(e => {
    const t = e.start?.dateTime ? new Date(e.start.dateTime).toTimeString().slice(0, 5) : t(userLang(userId), 'g.allDay');
    return '• ' + t + ' ' + (e.summary ?? t(userLang(userId), 'g.noSubject'));
  });
  return t(userLang(userId), 'g.calList', { lines: lines.join('\n') });
}

// Move messages matching a Gmail search query to Trash. Caps at 100 per call;
// the agent can repeat with the same query when more remain.
export async function gmailTrash(userId, query) {
  const q = String(query ?? '').trim();
  if (!q) return t(userLang(userId), 'g.trashEmpty');
  const list = await api(userId, 'https://gmail.googleapis.com/gmail/v1/users/me/messages?q='
    + encodeURIComponent(q) + '&maxResults=100');
  const msgs = list.messages ?? [];
  if (!msgs.length) return t(userLang(userId), 'g.trashNone', { q });
  const token = await accessToken(userId);
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/batchModify', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: msgs.map(m => m.id), addLabelIds: ['TRASH'] }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error('Gmail API ' + res.status + ': ' + JSON.stringify(data?.error?.message ?? data).slice(0, 200));
  }
  const total = list.resultSizeEstimate ?? msgs.length;
  return t(userLang(userId), 'g.trashed', { n: msgs.length, q, rest: Math.max(0, total - msgs.length) });
}

export function googleDisconnect(userId) {
  vault.deleteSecret(userId, REFRESH_NAME);
  vault.deleteSecret(userId, PROFILE_NAME);
}
