import { MessageFlags } from 'discord.js';
import { config } from '../config.js';
import { store } from '../db.js';
import { t } from '../i18n.js';
import { userLang, responseLanguage, noteLocale } from '../user-lang.js';
import { vault, vaultReady } from './vault.js';
import { browser } from './browser.js';
import { makeDecider } from './vision.js';
import { runComputerTask } from './loop.js';
import { secretRequestPayload, secretModal, authMethodPayload, authQrPayload, humanCheckPayload } from './ui.js';
import { retrying, retryingBrowser } from './retry.js';
import { SessionSecrets } from './session-secrets.js';

const IDLE_MS = 30 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const EPHEMERAL = MessageFlags.Ephemeral;

const sessions = new Map(); // userId -> { id, idleTimer }
const running = new Map(); // userId -> AbortController
const pending = new Map(); // reqId -> { userId, fields, timer, resolve }
let seq = 0;

export function computerIsBusy() { return running.size > 0 || pending.size > 0; }
export function computerRunning(userId) { return running.has(userId); }

function visionModel() {
  return process.env.HARKLET_CU_MODEL?.trim() || config.llm.model;
}

export function computerMaxSteps(userId) {
  const saved = store.getSettings(userId)?.computer_max_steps;
  if (Number.isSafeInteger(saved) && saved >= 0) return saved;
  const raw = process.env.HARKLET_CU_MAX_STEPS?.trim();
  const value = raw ? Number(raw) : NaN;
  return Number.isSafeInteger(value) && value >= 0 ? value : 80;
}

export async function handleComputerInteraction(interaction) {
  noteLocale(interaction.user.id, interaction.locale);
  if (interaction.isChatInputCommand() && interaction.commandName === 'stop') {
    await guard(interaction, () => stopRun(interaction));
    return true;
  }
  // Handle cached /computer interactions until Discord removes the old command.
  if (interaction.isChatInputCommand() && interaction.commandName === 'computer') {
    await guard(interaction, () => interaction.options.getSubcommand() === 'stop'
      ? stopRun(interaction)
      : interaction.reply({ content: t(userLang(interaction.user.id), 'cu.hint'), flags: EPHEMERAL }));
    return true;
  }
  if (interaction.isButton() && interaction.customId.startsWith('cu_secret:')) {
    await guard(interaction, () => handleSecretButton(interaction));
    return true;
  }
  if (interaction.isModalSubmit() && interaction.customId.startsWith('cu_secret_modal:')) {
    await guard(interaction, () => handleSecretModal(interaction));
    return true;
  }
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('cu_auth:')) {
    await guard(interaction, () => handleAuthSelection(interaction));
    return true;
  }
  if (interaction.isButton() && interaction.customId.startsWith('cu_qr:')) {
    await guard(interaction, () => handleQrContinue(interaction));
    return true;
  }
  if (interaction.isButton() && interaction.customId.startsWith('cu_human:')) {
    await guard(interaction, () => handleHumanDone(interaction));
    return true;
  }
  return false;
}

async function guard(interaction, fn) {
  try {
    await fn();
  } catch (err) {
    const content = t(userLang(interaction.user.id), 'generic.error', { msg: err.message });
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content, embeds: [], components: [] });
      } else {
        await interaction.reply({ content, flags: EPHEMERAL });
      }
    } catch {}
  }
}

// The chat agent and /computer share one user slot, session and credential flow.
export async function startComputerTask({ userId, task, channel, post: customPost, onDone }) {
  task = String(task ?? '').trim();
  if (!task || task.length > 2000) throw new Error(t(userLang(userId), 'cu.taskLength'));
  if (!vaultReady()) throw new Error(t(userLang(userId), 'cu.noSecretKey'));
  if (!config.llm.apiKey) throw new Error(t(userLang(userId), 'cu.noLlmKey'));
  if (running.has(userId)) throw new Error(t(userLang(userId), 'cu.alreadyRunning'));
  // Claim the slot before the first await so a second click cannot start a second run.
  const abort = new AbortController();
  running.set(userId, abort);
  let s;
  try {
    s = await ensureSession(userId);
  } catch (err) {
    running.delete(userId);
    throw err;
  }
  const post = customPost ?? (text => channel?.send(text).catch(() => {}));
  await post(t(userLang(userId), 'cu.startPost', { userId, task: task.slice(0, 200) }));
  const viewer = browser.viewerUrl(s.id);
  const remoteViewer = browser.remoteViewer(s.id);
  let sentViewer = false;
  if (viewer) {
    // Never put the live screen link into a public guild channel.
    const notice = t(userLang(userId), 'cu.viewerNotice', { remote: t(userLang(userId), remoteViewer ? 'cu.viewerRemote' : 'cu.viewerLocal'), viewer });
    try {
      const user = await channel?.client?.users?.fetch(userId);
      if (user) { await user.send(notice); sentViewer = true; }
    } catch {}
  }
  void runTask(userId, s, task, abort, channel, post, onDone);
  return t(userLang(userId), 'cu.started') +
    (sentViewer ? t(userLang(userId), 'cu.viewerSent')
      : viewer ? t(userLang(userId), 'cu.viewerDmFail')
        : t(userLang(userId), 'cu.viewerNone'));
}

async function runTask(userId, s, task, abort, channel, post, onDone) {
  let outcome;
  let result;
  try {
    result = await runComputerTask({
      maxSteps: computerMaxSteps(userId),
      lang: responseLanguage(userId),
      userId,
      task,
      sessionId: s.id,
      browser: retryingBrowser(browser),
      vault: {
        listSecretNames: () => s.secrets.names(),
        getSecret: (_id, name) => s.secrets.get(name),
        takeSecret: (_id, name) => s.secrets.take(name),
      },
      decide: retrying(makeDecider({
        lang: responseLanguage(userId),
        provider: config.llm.provider,
        baseUrl: config.llm.baseUrl,
        apiKey: config.llm.apiKey,
        model: visionModel(),
        effort: process.env.HARKLET_CU_EFFORT?.trim() || undefined,
      })),
      requestSecrets: ({ message, fields }) => requestSecrets(userId, s.id, channel, message, fields),
      chooseAuthMethod: ({ message, options }) => chooseAuthMethod(userId, s.id, channel, message, options),
      shareAuthQr: ({ png, message }) => shareAuthQr(userId, channel, png, message),
      requestHuman: ({ message }) => requestHuman(userId, s.id, channel, message),
      progress: post,
      signal: abort.signal,
    });
    outcome = outcomeText(result, userLang(userId));
  } catch (err) {
    outcome = t(userLang(userId), 'cu.stoppedErr', { msg: err.message });
  } finally {
    running.delete(userId);
    bumpIdle(userId);
  }
  try { await onDone?.(outcome, result); } catch (err) { console.error('computer outcome callback failed:', err); }
  await post(outcome);
}

function outcomeText(r, lang) {
  switch (r.status) {
    case 'done': return t(lang, 'cu.done', { summary: r.summary });
    case 'failed': return t(lang, 'cu.failed', { reason: r.reason });
    case 'max_steps': return t(lang, 'cu.maxSteps');
    case 'timeout': return t(lang, 'cu.timeout');
    case 'stopped': return t(lang, 'cu.stopped');
    case 'credentials_timeout': return t(lang, 'cu.credentialsTimeout');
    default: return t(lang, 'cu.exited', { status: r.status });
  }
}

async function ensureSession(userId) {
  const existing = sessions.get(userId);
  if (existing) {
    bumpIdle(userId);
    return existing;
  }
  const created = await browser.createSession(userId);
  const s = { id: created.id, idleTimer: null };
  s.secrets = new SessionSecrets(vault, userId, () => browser.origin(s.id));
  sessions.set(userId, s);
  bumpIdle(userId);
  return s;
}

function bumpIdle(userId) {
  const s = sessions.get(userId);
  if (!s) return;
  clearTimeout(s.idleTimer);
  s.idleTimer = setTimeout(() => {
    if (running.has(userId)) {
      bumpIdle(userId);
      return;
    }
    destroySession(userId).catch(err => console.error('computer session save failed:', err));
  }, IDLE_MS);
  s.idleTimer.unref?.();
}

async function destroySession(userId) {
  const s = sessions.get(userId);
  if (!s) return;
  sessions.delete(userId);
  clearTimeout(s.idleTimer);
  s.secrets.clear();
  await browser.destroySession(s.id);
}

async function stopRun(interaction) {
  await interaction.deferReply({ flags: EPHEMERAL });
  const userId = interaction.user.id;
  running.get(userId)?.abort();
  for (const [reqId, req] of pending) {
    if (req.userId !== userId) continue;
    clearTimeout(req.timer);
    pending.delete(reqId);
    req.resolve(null);
  }
  const had = sessions.has(userId);
  await destroySession(userId);
  await interaction.editReply(had ? t(userLang(interaction.user.id), 'cu.closed') : t(userLang(interaction.user.id), 'cu.noScreen'));
}

async function requestSecrets(userId, sessionId, channel, message, fields) {
  const reqId = Date.now().toString(36) + '-' + (++seq).toString(36);
  const origin = browser.origin(sessionId);
  if (!origin?.startsWith('https://')) throw new Error(t(userLang(userId), 'cu.httpsOnly'));
  const dismiss = await browser.showDiscordPrompt(sessionId).catch(() => null);
  try {
    return await new Promise(resolve => {
      if (!channel) {
        resolve(null);
        return;
      }
      const timer = setTimeout(() => {
        pending.delete(reqId);
        resolve(null);
      }, REQUEST_TIMEOUT_MS);
      pending.set(reqId, { userId, fields, origin, timer, resolve, kind: 'secret' });
      Promise.resolve(channel.send(secretRequestPayload(reqId, message, fields, origin, userLang(userId)))).catch(() => {
        clearTimeout(timer);
        pending.delete(reqId);
        resolve(null);
      });
    });
  } finally {
    await dismiss?.();
  }
}

async function chooseAuthMethod(userId, sessionId, channel, message, options) {
  const reqId = Date.now().toString(36) + '-' + (++seq).toString(36);
  const dismiss = await browser.showDiscordPrompt(sessionId).catch(() => null);
  try {
    return await new Promise(resolve => {
      if (!channel) { resolve(null); return; }
      const timer = setTimeout(() => { pending.delete(reqId); resolve(null); }, REQUEST_TIMEOUT_MS);
      pending.set(reqId, { userId, options, timer, resolve, kind: 'auth' });
      Promise.resolve(channel.send(authMethodPayload(reqId, message, options, userLang(userId)))).catch(() => {
        clearTimeout(timer); pending.delete(reqId); resolve(null);
      });
    });
  } finally { await dismiss?.(); }
}

async function shareAuthQr(userId, channel, png, message) {
  const reqId = Date.now().toString(36) + '-' + (++seq).toString(36);
  try {
    const user = await channel?.client?.users?.fetch(userId);
    if (!user) return false;
    return await new Promise(resolve => {
      const timer = setTimeout(() => { pending.delete(reqId); resolve(false); }, REQUEST_TIMEOUT_MS);
      pending.set(reqId, { userId, timer, resolve, kind: 'qr' });
      Promise.resolve(user.send(authQrPayload(reqId, png, message, userLang(userId)))).catch(() => {
        clearTimeout(timer); pending.delete(reqId); resolve(false);
      });
    });
  } catch { return false; }
}

async function handleQrContinue(interaction) {
  const reqId = interaction.customId.slice('cu_qr:'.length);
  const req = pending.get(reqId);
  if (!req || req.kind !== 'qr') throw new Error(t(userLang(interaction.user.id), 'cu.confirmExpired'));
  if (req.userId !== interaction.user.id) throw new Error('この確認は依頼した本人だけができます');
  clearTimeout(req.timer);
  pending.delete(reqId);
  req.resolve(true);
  await interaction.reply({ content: t(userLang(interaction.user.id), 'act.confirmOk'), flags: EPHEMERAL });
}

// The agent hit a human-only check (hCaptcha etc.). The owner solves it in the
// interactive viewer, then presses the button so the run can continue.
async function requestHuman(userId, sessionId, channel, message) {
  let viewer = null;
  try { viewer = browser.viewerUrl(sessionId); } catch { return 'unavailable'; }
  const interactive = browser.viewerIsInteractive(sessionId);
  if (!interactive) {
    await channel?.send(t(userLang(userId), 'cu.viewerReadonly')).catch(() => {});
    return 'unavailable';
  }
  if (viewer) {
    try {
      const user = await channel?.client?.users?.fetch(userId);
      const link = browser.humanUrl(sessionId) ?? viewer;
      await user?.send(t(userLang(userId), 'cu.humanDm', { link }));
    } catch {}
  }
  const reqId = Date.now().toString(36) + '-' + (++seq).toString(36);
  try {
    return await new Promise(resolve => {
      if (!channel) { resolve(null); return; }
      const timer = setTimeout(() => { pending.delete(reqId); resolve(null); }, REQUEST_TIMEOUT_MS);
      pending.set(reqId, { userId, timer, resolve, kind: 'human' });
      Promise.resolve(channel.send(humanCheckPayload(reqId, message, !!viewer, userLang(userId)))).catch(() => {
        clearTimeout(timer); pending.delete(reqId); resolve(null);
      });
    });
  } finally {
    // session may have ended while waiting; ignore
  }
}

async function handleHumanDone(interaction) {
  const reqId = interaction.customId.slice('cu_human:'.length);
  const req = pending.get(reqId);
  if (!req || req.kind !== 'human') throw new Error(t(userLang(interaction.user.id), 'cu.confirmExpired'));
  if (req.userId !== interaction.user.id) throw new Error('この確認は依頼した本人だけができます');
  clearTimeout(req.timer);
  pending.delete(reqId);
  req.resolve(true);
  await interaction.reply({ content: t(userLang(interaction.user.id), 'act.confirmOk'), flags: EPHEMERAL });
}

async function handleAuthSelection(interaction) {
  const reqId = interaction.customId.slice('cu_auth:'.length);
  const req = pending.get(reqId);
  if (!req || req.kind !== 'auth') throw new Error(t(userLang(interaction.user.id), 'cu.chooseExpired'));
  if (req.userId !== interaction.user.id) throw new Error('この選択は依頼した本人だけができます');
  const selected = interaction.values[0];
  const chosen = req.options.find(o => o.id === selected);
  if (!chosen) throw new Error(t(userLang(interaction.user.id), 'cu.authRetry'));
  clearTimeout(req.timer);
  pending.delete(reqId);
  req.resolve(selected);
  await interaction.reply({ content: t(userLang(interaction.user.id), 'cu.chose', { label: chosen.label }), flags: EPHEMERAL });
}

async function handleSecretButton(interaction) {
  const reqId = interaction.customId.slice('cu_secret:'.length);
  const req = pending.get(reqId);
  if (!req || req.kind !== 'secret') throw new Error(t(userLang(interaction.user.id), 'cu.inputExpired'));
  if (req.userId !== interaction.user.id) throw new Error('この入力は依頼した本人だけができます');
  await interaction.showModal(secretModal(reqId, req.fields, userLang(interaction.user.id)));
}

async function handleSecretModal(interaction) {
  const reqId = interaction.customId.slice('cu_secret_modal:'.length);
  const req = pending.get(reqId);
  if (!req || req.kind !== 'secret' || req.userId !== interaction.user.id) throw new Error(t(userLang(interaction.user.id), 'cu.secretInvalid'));
  const values = req.fields.map(f => ({ name: f.name, value: interaction.fields.getTextInputValue(f.name) }));
  if (values.some(v => !v.value)) throw new Error(t(userLang(interaction.user.id), 'cu.secretBlank'));
  const s = sessions.get(req.userId);
  if (!s) throw new Error(t(userLang(interaction.user.id), 'cu.sessionGone'));
  for (const v of values) {
    const field = req.fields.find(f => f.name === v.name);
    if (field?.one_time) s.secrets.setOneTime(v.name, v.value, req.origin);
    else vault.setSecret(req.userId, v.name, v.value, req.origin);
  }
  clearTimeout(req.timer);
  pending.delete(reqId);
  req.resolve(values.map(v => v.name));
  await interaction.reply({ content: t(userLang(interaction.user.id), 'cu.secretSaved'), flags: EPHEMERAL });
}
