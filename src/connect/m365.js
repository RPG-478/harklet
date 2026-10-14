// Microsoft 365 connector: device code flow (public client) + Graph read APIs.
// User opens microsoft.com/devicelogin on their phone, enters the code, done — no
// copy-paste needed, which suits mobile-first Discord use.
import { vault, vaultReady } from '../computer/vault.js';
import { t } from '../i18n.js';
import { userLang } from '../user-lang.js';

// OSS deployments can embed a default Entra app registration the maintainer
// created once (see docs/oauth-setup.md). .env values override the default.
const DEFAULT_CLIENT_ID = '';
const CID = () => process.env.M365_CLIENT_ID?.trim() || DEFAULT_CLIENT_ID;
const TENANT = () => process.env.M365_TENANT?.trim() || 'common';
const TOKEN_ORIGIN = 'https://login.microsoftonline.com';
const REFRESH_NAME = 'm365_refresh';
const PROFILE_NAME = 'm365_profile';
const SCOPE = 'offline_access User.Read Mail.Read Calendars.Read';

export function m365Configured() { return !!CID(); }
export function m365Connected(userId) {
  return vaultReady() && vault.listSecretNames(userId, TOKEN_ORIGIN).includes(REFRESH_NAME);
}
export function m365Profile(userId) {
  try { return JSON.parse(vault.getSecret(userId, PROFILE_NAME, TOKEN_ORIGIN) ?? 'null'); } catch { return null; }
}

const base = () => `https://login.microsoftonline.com/${TENANT()}/oauth2/v2.0`;

export async function startDeviceFlow() {
  const res = await fetch(base() + '/devicecode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CID(), scope: SCOPE }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.device_code) throw new Error('デバイスコード開始失敗: ' + (data.error_description || res.status));
  return data; // { device_code, user_code, verification_uri, message, interval, expires_in }
}

// Polls until the user approves. Returns { email } or null on timeout/deny.
// channel.send keeps the user informed without blocking the caller.
export async function pollDeviceFlow(userId, flow, channel) {
  const deadline = Date.now() + (flow.expires_in ?? 900) * 1000;
  let interval = Math.max(5, flow.interval ?? 5) * 1000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, interval));
    const res = await fetch(base() + '/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: CID(), device_code: flow.device_code,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.refresh_token) {
      vault.setSecret(userId, REFRESH_NAME, data.refresh_token, TOKEN_ORIGIN);
      let email = '';
      try {
        const me = await api(userId, 'https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,displayName');
        email = me?.mail ?? me?.userPrincipalName ?? '';
      } catch {}
      vault.setSecret(userId, PROFILE_NAME, JSON.stringify({ email }), TOKEN_ORIGIN);
      return { email };
    }
    const err = data.error;
    if (err === 'authorization_pending') continue;
    if (err === 'slow_down') { interval += 5000; continue; }
    return null; // declined / expired / other
  }
  return null;
}

async function accessToken(userId) {
  const refresh = vault.getSecret(userId, REFRESH_NAME, TOKEN_ORIGIN);
  if (!refresh) throw new Error('M365未接続');
  const res = await fetch(base() + '/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CID(), refresh_token: refresh,
      grant_type: 'refresh_token', scope: SCOPE,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('M365 token refresh failed: ' + (data.error_description || res.status));
  if (data.refresh_token) vault.setSecret(userId, REFRESH_NAME, data.refresh_token, TOKEN_ORIGIN);
  return data.access_token;
}

async function api(userId, url) {
  const token = await accessToken(userId);
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error('Graph ' + res.status + ': ' + JSON.stringify(data?.error?.message ?? data).slice(0, 200));
  return data;
}

export async function mailUnread(userId, n = 5) {
  const data = await api(userId, 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?'
    + '$top=25&$select=subject,from,receivedDateTime,isRead&$orderby=receivedDateTime desc');
  const msgs = (data.value ?? []).filter(m => m.isRead === false).slice(0, n);
  if (!msgs.length) return t(userLang(userId), 'm.none');
  const lines = msgs.map(m => '• ' + (m.subject ?? t(userLang(userId), 'g.noSubject')) + ' — ' + (m.from?.emailAddress?.name ?? m.from?.emailAddress?.address ?? '').slice(0, 40));
  return t(userLang(userId), 'm.list', { lines: lines.join('\n') });
}

export async function calendarToday(userId) {
  const now = new Date();
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setDate(end.getDate() + 1);
  const data = await api(userId, 'https://graph.microsoft.com/v1.0/me/calendarView?'
    + 'startDateTime=' + encodeURIComponent(start.toISOString())
    + '&endDateTime=' + encodeURIComponent(end.toISOString())
    + '&$top=10&$select=subject,start,end&$orderby=start/dateTime');
  const evs = data.value ?? [];
  if (!evs.length) return t(userLang(userId), 'g.calNone');
  const lines = evs.map(e => {
    const dt = e.start?.dateTime;
    const t = dt ? new Date(dt + 'Z').toTimeString().slice(0, 5) : t(userLang(userId), 'g.allDay');
    return '• ' + t + ' ' + (e.subject ?? t(userLang(userId), 'g.noSubject'));
  });
  return t(userLang(userId), 'm.calList', { lines: lines.join('\n') });
}

export function m365Disconnect(userId) {
  vault.deleteSecret(userId, REFRESH_NAME);
  vault.deleteSecret(userId, PROFILE_NAME);
}
