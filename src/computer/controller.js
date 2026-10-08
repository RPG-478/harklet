import { MessageFlags } from 'discord.js';
import { config } from '../config.js';
import { vault, vaultReady } from './vault.js';
import { browser } from './browser.js';
import { makeDecider } from './vision.js';
import { runComputerTask } from './loop.js';
import { secretRequestPayload, secretModal, viewerPayload } from './ui.js';
import { retrying, retryingSidecar } from './retry.js';

const IDLE_MS = 30 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const EPHEMERAL = MessageFlags.Ephemeral;

const sessions = new Map(); // userId -> { id, idleTimer }
const running = new Map(); // userId -> AbortController
const pending = new Map(); // reqId -> { userId, fields, timer, resolve }
let seq = 0;

function visionModel() {
  return process.env.HARKLET_CU_MODEL?.trim() || config.llm.model;
}

export async function handleComputerInteraction(interaction) {
  if (interaction.isChatInputCommand() && interaction.commandName === 'computer') {
    await guard(interaction, () => handleCommand(interaction));
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

async function handleCommand(interaction) {
  const sub = interaction.options.getSubcommand();
  if (sub === 'run') return startRun(interaction, interaction.options.getString('task', true));
  if (sub === 'view') return showViewer(interaction);
  if (sub === 'stop') return stopRun(interaction);
}

async function startRun(interaction, task) {
  const userId = interaction.user.id;
  if (!vaultReady()) throw new Error('HARKLET_SECRET_KEY を .env に設定してから再起動してください（16文字以上）');
  if (!config.llm.apiKey) throw new Error('LLMのAPIキーが未設定です');
  if (running.has(userId)) throw new Error('すでに作業中です。/computer stop で止められます');
  // Claim the slot before the first await so a second click cannot start a second run.
  const abort = new AbortController();
  running.set(userId, abort);
  let s;
  try {
    await interaction.deferReply({ flags: EPHEMERAL });
    s = await ensureSession(userId);
  } catch (err) {
    running.delete(userId);
    throw err;
  }
  const channel = interaction.channel;
  const post = text => channel?.send(text).catch(() => {});
  await post('🖥️ <@' + userId + '> の作業を開始します: ' + task.slice(0, 200));
  await interaction.editReply('作業を開始しました。進み具合はこのチャンネルに出します。');
  runTask(userId, s, task, abort, channel, post);
}

async function runTask(userId, s, task, abort, channel, post) {
  try {
    const result = await runComputerTask({
      userId,
      task,
      sessionId: s.id,
      sidecar: retryingSidecar(browser),
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
    await post(outcomeText(result));
  } catch (err) {
    await post('⚠️ 作業が止まりました: ' + err.message);
  } finally {
    running.delete(userId);
    bumpIdle(userId);
  }
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
    destroySession(userId);
  }, IDLE_MS);
  s.idleTimer.unref?.();
}

async function destroySession(userId) {
  const s = sessions.get(userId);
  if (!s) return;
  sessions.delete(userId);
  clearTimeout(s.idleTimer);
  await browser.destroySession(s.id).catch(() => {});
}

async function showViewer(interaction) {
  await interaction.deferReply({ flags: EPHEMERAL });
  const userId = interaction.user.id;
  const s = sessions.get(userId);
  if (!s) {
    await interaction.editReply('作業用の画面がありません。/computer run で開始してください');
    return;
  }
  const shot = await browser.screenshot(s.id);
  bumpIdle(userId);
  await interaction.editReply(viewerPayload(Buffer.from(shot.png_base64, 'base64')));
}

async function stopRun(interaction) {
  await interaction.deferReply({ flags: EPHEMERAL });
  const userId = interaction.user.id;
  running.get(userId)?.abort();
  const had = sessions.has(userId);
  await destroySession(userId);
  await interaction.editReply(had ? '画面を破棄しました' : '作業用の画面はありません');
}

function requestSecrets(userId, sessionId, channel, message, fields) {
  const reqId = Date.now().toString(36) + '-' + (++seq).toString(36);
  const origin = browser.origin(sessionId);
  if (!origin?.startsWith('https://')) return Promise.reject(new Error('ログイン情報はHTTPSのサイトにのみ保存できます'));
  return new Promise(resolve => {
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
