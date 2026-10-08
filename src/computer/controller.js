import { MessageFlags } from 'discord.js';
import { config } from '../config.js';
import { vault, vaultReady } from './vault.js';
import { browser } from './browser.js';
import { makeDecider } from './vision.js';
import { runComputerTask } from './loop.js';
import { secretRequestPayload, secretModal } from './ui.js';
import { retrying, retryingBrowser } from './retry.js';

const IDLE_MS = 30 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const EPHEMERAL = MessageFlags.Ephemeral;

const sessions = new Map(); // userId -> { id, idleTimer }
const running = new Map(); // userId -> AbortController
const pending = new Map(); // reqId -> { userId, fields, timer, resolve }
let seq = 0;

export function computerIsBusy() { return running.size > 0 || pending.size > 0; }

function visionModel() {
  return process.env.HARKLET_CU_MODEL?.trim() || config.llm.model;
}

export async function handleComputerInteraction(interaction) {
  if (interaction.isChatInputCommand() && interaction.commandName === 'stop') {
    await guard(interaction, () => stopRun(interaction));
    return true;
  }
  // Handle cached /computer interactions until Discord removes the old command.
  if (interaction.isChatInputCommand() && interaction.commandName === 'computer') {
    await guard(interaction, () => interaction.options.getSubcommand() === 'stop'
      ? stopRun(interaction)
      : interaction.reply({ content: 'Web作業はチャットで依頼できます。停止は /stop を使ってください。', flags: EPHEMERAL }));
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
  return false;
}

async function guard(interaction, fn) {
  try {
    await fn();
  } catch (err) {
    const content = '⚠️ ' + err.message;
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
  if (!task || task.length > 2000) throw new Error('作業内容を1〜2000文字で指定してください');
  if (!vaultReady()) throw new Error('HARKLET_SECRET_KEY を .env に設定してから再起動してください（16文字以上）');
  if (!config.llm.apiKey) throw new Error('LLMのAPIキーが未設定です');
  if (running.has(userId)) throw new Error('すでに作業中です。/stop で止められます');
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
  await post('🖥️ <@' + userId + '> の作業を開始します: ' + task.slice(0, 200));
  const viewer = browser.viewerUrl(s.id);
  const remoteViewer = browser.remoteViewer(s.id);
  let sentViewer = false;
  if (viewer) {
    // Never put the live screen link into a public guild channel.
    const notice = `🖥️ 作業中の画面を見る${remoteViewer ? '（スマホ・別ネットワークからも可）' : '（Botと同じPCのみ）'}: ${viewer}\n閲覧専用です。URLを知る人は画面を見られるため、共有しないでください。停止は /stop。`;
    try {
      const user = await channel?.client?.users?.fetch(userId);
      if (user) { await user.send(notice); sentViewer = true; }
    } catch {}
  }
  void runTask(userId, s, task, abort, channel, post, onDone);
  return '🖥️ ブラウザ作業を開始しました。完了したら結果をお知らせします。' +
    (sentViewer ? '\n画面URLをDMへ送りました。停止は /stop。'
      : viewer ? '\n画面URLを送れませんでした。BotからのDMを許可してください。停止は /stop。'
        : '\n画面のライブ表示は利用できません。停止は /stop。');
}

async function runTask(userId, s, task, abort, channel, post, onDone) {
  let outcome;
  try {
    const result = await runComputerTask({
      userId,
      task,
      sessionId: s.id,
      browser: retryingBrowser(browser),
      vault: {
        listSecretNames: id => vault.listSecretNames(id, browser.origin(s.id)),
        getSecret: (id, name) => vault.getSecret(id, name, browser.origin(s.id)),
      },
      decide: retrying(makeDecider({
        provider: config.llm.provider,
        baseUrl: config.llm.baseUrl,
        apiKey: config.llm.apiKey,
        model: visionModel(),
      })),
      requestSecrets: ({ message, fields }) => requestSecrets(userId, s.id, channel, message, fields),
      progress: post,
      signal: abort.signal,
    });
    outcome = outcomeText(result);
  } catch (err) {
    outcome = '⚠️ 作業が止まりました: ' + err.message;
  } finally {
    running.delete(userId);
    bumpIdle(userId);
  }
  try { await onDone?.(outcome); } catch (err) { console.error('computer outcome callback failed:', err); }
  await post(outcome);
}

function outcomeText(r) {
  switch (r.status) {
    case 'done': return '✅ 完了: ' + r.summary;
    case 'failed': return '❌ 続けられませんでした: ' + r.reason;
    case 'max_steps': return '⏹️ 操作の上限に達したので止めました';
    case 'timeout': return '⏹️ 制限時間を超えたので止めました';
    case 'stopped': return '⏹️ 停止しました';
    case 'credentials_timeout': return '⌛ ログイン情報の入力がなかったので止めました';
    default: return '終了: ' + r.status;
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
  await interaction.editReply(had ? '画面を閉じて状態を保存しました' : '作業用の画面はありません');
}

async function requestSecrets(userId, sessionId, channel, message, fields) {
  const reqId = Date.now().toString(36) + '-' + (++seq).toString(36);
  const origin = browser.origin(sessionId);
  if (!origin?.startsWith('https://')) throw new Error('ログイン情報はHTTPSのサイトにのみ保存できます');
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
      pending.set(reqId, { userId, fields, origin, timer, resolve });
      Promise.resolve(channel.send(secretRequestPayload(reqId, message, fields, origin))).catch(() => {
        clearTimeout(timer);
        pending.delete(reqId);
        resolve(null);
      });
    });
  } finally {
    await dismiss?.();
  }
}

async function handleSecretButton(interaction) {
  const reqId = interaction.customId.slice('cu_secret:'.length);
  const req = pending.get(reqId);
  if (!req) throw new Error('この依頼は期限切れか、すでに完了しています');
  if (req.userId !== interaction.user.id) throw new Error('この入力は依頼した本人だけができます');
  await interaction.showModal(secretModal(reqId, req.fields));
}

async function handleSecretModal(interaction) {
  const reqId = interaction.customId.slice('cu_secret_modal:'.length);
  const req = pending.get(reqId);
  if (!req || req.userId !== interaction.user.id) throw new Error('この入力依頼は無効です');
  const values = req.fields.map(f => ({ name: f.name, value: interaction.fields.getTextInputValue(f.name) }));
  if (values.some(v => !v.value)) throw new Error('空欄があります。もう一度入力してください');
  for (const v of values) vault.setSecret(req.userId, v.name, v.value, req.origin);
  clearTimeout(req.timer);
  pending.delete(reqId);
  req.resolve(values.map(v => v.name));
  await interaction.reply({ content: '🔐 保存しました。値は表示しません。作業を再開します。', flags: EPHEMERAL });
}
