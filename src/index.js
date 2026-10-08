import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Client,
  GatewayIntentBits, ThreadAutoArchiveDuration,
  EmbedBuilder, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder,
  TextInputStyle, PermissionFlagsBits, MessageFlags,
} from 'discord.js';
import { config } from './config.js';
import { store } from './db.js';
import { chatDsh, invalidateUserAgents } from './dsh-agent.js';
import { homePayload, geocodeCity } from './home.js';
import { listModels } from './llm.js';
import { parseWhen, fmtTs } from './schedule.js';

function makeClient(withContent) {
  const intents = [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
  ];
  if (withContent) intents.push(GatewayIntentBits.MessageContent);
  return new Client({ intents });
}

let client = makeClient(true);

// ---------- helpers ----------
const FALLBACK_MODELS = [
  'openai/gpt-4.1-mini', 'openai/gpt-4.1', 'openai/o4-mini',
  'anthropic/claude-sonnet-4-5', 'anthropic/claude-haiku-4-5',
  'google/gemini-2.5-flash', 'google/gemini-2.5-pro', 'x-ai/grok-code-fast-1',
];
const SKIP_MODEL = /embed|whisper|tts|image|audio|dall-e|moderation|transcrib/i;
const MODEL_RANK = /gpt|claude|gemini|grok|o4|deepseek|qwen|llama|mistral/i;

// /model パネルで選択中(未適用)の値。決定ボタンで確定する。
const pendingModelSel = new Map(); // userId -> model
const pendingEffortSel = new Map(); // userId -> effort|'default'

async function modelPanel(userId) {
  const s = store.getSettings(userId) ?? {};
  const current = s.model || config.llm.model;
  const stagedModel = pendingModelSel.get(userId);
  const stagedEffort = pendingEffortSel.get(userId);
  let models = await listModels();
  if (!models.length) models = FALLBACK_MODELS;
  models = models.filter(m => !SKIP_MODEL.test(m));
  const shown = stagedModel ?? current;
  const shownEffort = stagedEffort ?? s.effort ?? 'default';
  const choices = [shown, ...models.filter(m => m !== shown)
    .sort((a, b) => Number(MODEL_RANK.test(b)) - Number(MODEL_RANK.test(a)) || a.localeCompare(b))]
    .slice(0, 25);
  const embed = new EmbedBuilder()
    .setTitle('🧠 LLM 設定')
    .setColor(0x5865f2)
    .addFields(
      { name: 'model', value: '`' + shown + '`' + (stagedModel ? ' *(未適用)*' : ''), inline: true },
      { name: 'effort', value: shownEffort + (stagedEffort ? ' *(未適用)*' : ''), inline: true },
      { name: 'provider', value: config.llm.provider, inline: true },
    )
    .setFooter({ text: models.length + ' models from API / 選択はあなた個人の設定です' });
  const modelMenu = new StringSelectMenuBuilder()
    .setCustomId('model_sel')
    .setPlaceholder('モデルを選択 (' + choices.length + ')')
    .addOptions(choices.map(v => ({ label: v.slice(0, 100), value: v, default: v === shown })));
  const effortMenu = new StringSelectMenuBuilder()
    .setCustomId('effort_sel')
    .setPlaceholder('Reasoning effort')
    .addOptions(
      { label: 'default', value: 'default', default: shownEffort === 'default' },
      { label: 'low', value: 'low', default: shownEffort === 'low' },
      { label: 'medium', value: 'medium', default: shownEffort === 'medium' },
      { label: 'high', value: 'high', default: shownEffort === 'high' },
    );
  const applyBtn = new ButtonBuilder().setCustomId('model_apply').setLabel('決定').setStyle(ButtonStyle.Success);
  const customBtn = new ButtonBuilder().setCustomId('model_custom').setLabel('自由入力').setStyle(ButtonStyle.Secondary);
  const resetBtn = new ButtonBuilder().setCustomId('model_reset').setLabel('リセット').setStyle(ButtonStyle.Danger);
  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(modelMenu),
      new ActionRowBuilder().addComponents(effortMenu),
      new ActionRowBuilder().addComponents(applyBtn, customBtn, resetBtn),
    ],
  };
}

function actionRows(userId, actions) {
  const rows = [];
  let row = new ActionRowBuilder();
  for (const a of actions) {
    if (!a?.label || !a?.kind) continue;
    const id = store.addAction(userId, a);
    const style = a.kind === 'remind' ? ButtonStyle.Primary : ButtonStyle.Secondary;
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`act:${id}`)
        .setLabel(String(a.label).slice(0, 80))
        .setStyle(style),
    );
    if (row.components.length === 5) { rows.push(row); row = new ActionRowBuilder(); }
  }
  if (row.components.length) rows.push(row);
  return rows.slice(0, 2);
}

async function runAction(interaction, action) {
  const userId = interaction.user.id;
  if (action.kind === 'remind') {
    const due = Date.parse(action.arg ?? '');
    if (Number.isNaN(due)) {
      return interaction.reply({ content: '日時を解釈できませんでした。/remind で直接指定してください。', flags: MessageFlags.Ephemeral });
    }
    const id = store.addReminder(userId, interaction.channelId, action.label, due);
    return interaction.reply({ content: `⏰ リマインダー #${id}: 「${action.label}」→ ${fmtTs(due)}`, flags: MessageFlags.Ephemeral });
  }
  if (action.kind === 'memory') {
    store.addMemory(userId, String(action.arg ?? action.label));
    return interaction.reply({ content: `🧠 記憶しました: ${action.arg ?? action.label}`, flags: MessageFlags.Ephemeral });
  }
  return interaction.reply({ content: '未対応のアクションです。', flags: MessageFlags.Ephemeral });
}

async function answer(interaction) {
  const question = interaction.options.getString('question', true);
  const ephemeral = interaction.options.getBoolean('private') ?? false;
  await interaction.reply({
    content: 'Harkletが返信中……',
    ...(ephemeral ? { flags: MessageFlags.Ephemeral } : {}),
  });
  try {
    const scope = 'u:' + interaction.user.id;
    const result = await chatDsh(interaction.user.id, scope, question);
    await interaction.editReply({
      content: result.reply,
      components: actionRows(interaction.user.id, result.actions),
    });
  } catch (e) {
    await interaction.editReply('⚠️ エラー: ' + e.message);
  }
}

// ---------- command handlers ----------

const handlers = {
  async ping(i) {
    await i.reply({ content: `🏓 pong — ${client.ws.ping}ms`, flags: MessageFlags.Ephemeral });
  },

  ask: (i) => answer(i),

  async model(i) {
    await i.reply({ ...(await modelPanel(i.user.id)), flags: MessageFlags.Ephemeral });
  },

  async main(i) {
    const sub = i.options.getSubcommand();
    if (!i.guildId) return i.reply({ content: 'サーバー内で実行してください。', flags: MessageFlags.Ephemeral });
    if (sub === 'set') {
      if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return i.reply({ content: 'メインチャンネルの設定には「サーバー管理」権限が必要です。', flags: MessageFlags.Ephemeral });
      }
      const ch = i.options.getChannel('channel') ?? i.channel;
      store.setMain(i.guildId, ch.id, i.user.id);
      return i.reply({ content: `📍 メインチャンネルを <#${ch.id}> に設定しました。このチャンネルへの書き込みはそのまま会話になります。` });
    }
    if (sub === 'off') {
      if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return i.reply({ content: '「サーバー管理」権限が必要です。', flags: MessageFlags.Ephemeral });
      }
      store.clearMain(i.guildId);
      return i.reply({ content: '📍 メインチャンネル設定を解除しました。' });
    }
    const ch = store.getMain(i.guildId);
    return i.reply({ content: ch ? `📍 メインチャンネル: <#${ch}>` : 'メインチャンネルは未設定です。', flags: MessageFlags.Ephemeral });
  },

  async remember(i) {
    const text = i.options.getString('text', true);
    store.addMemory(i.user.id, text);
    await i.reply({ content: `🧠 記憶しました: ${text}`, flags: MessageFlags.Ephemeral });
  },

  async memory(i) {
    const sub = i.options.getSubcommand();
    if (sub === 'list') {
      const ms = store.listMemories(i.user.id);
      const body = ms.length
        ? ms.map(m => `#${m.id} ${m.content}`).join('\n')
        : 'まだ記憶はありません。`/remember` か会話から自動で貯まります。';
      return i.reply({ content: body.slice(0, 1900), flags: MessageFlags.Ephemeral });
    }
    if (sub === 'forget') {
      const ok = store.deleteMemory(i.user.id, i.options.getInteger('id', true));
      return i.reply({ content: ok ? '🗑️ 削除しました。' : 'そのIDの記憶は見つかりません。', flags: MessageFlags.Ephemeral });
    }
    if (sub === 'clear') {
      for (const m of store.listMemories(i.user.id)) store.deleteMemory(i.user.id, m.id);
      return i.reply({ content: '🗑️ すべての記憶を削除しました。', flags: MessageFlags.Ephemeral });
    }
  },

  async remind(i) {
    const sub = i.options.getSubcommand();
    if (sub === 'add') {
      const when = i.options.getString('when', true);
      const text = i.options.getString('text', true);
      const due = parseWhen(when);
      if (!due || due <= Date.now()) {
        return i.reply({
          content: `「${when}」を解釈できません。例: 10分後 / 明日9時 / 18:30 / 2026-10-09 09:00`,
          flags: MessageFlags.Ephemeral,
        });
      }
      const id = store.addReminder(i.user.id, i.channelId, text, due);
      return i.reply({ content: `⏰ リマインダー #${id}: 「${text}」→ ${fmtTs(due)}`, flags: MessageFlags.Ephemeral });
    }
    if (sub === 'list') {
      const rs = store.listReminders(i.user.id);
      const body = rs.length
        ? rs.map(r => `#${r.id} ${r.text} — ${fmtTs(r.due_at)}`).join('\n')
        : '予定されているリマインダーはありません。';
      return i.reply({ content: body.slice(0, 1900), flags: MessageFlags.Ephemeral });
    }
    if (sub === 'cancel') {
      const ok = store.cancelReminder(i.user.id, i.options.getInteger('id', true));
      return i.reply({ content: ok ? '🗑️ キャンセルしました。' : 'そのIDのリマインダーは見つかりません。', flags: MessageFlags.Ephemeral });
    }
  },

  async project(i) {
    const topic = i.options.getString('topic', true);
    if (!i.channel || i.channel.type !== ChannelType.GuildText) {
      return i.reply({ content: 'テキストチャンネルで実行してください。', flags: MessageFlags.Ephemeral });
    }
    await i.reply(`🗂️ パネルを作成します: **${topic}**\nこのスレッド内はコマンド不要でそのまま会話できます。`);
    const starter = await i.fetchReply();
    const thread = await starter.startThread({
      name: `pj-${topic.slice(0, 90)}`,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
    });
    store.addPanel(thread.id, i.user.id, topic);
    await thread.send(`📁 プロジェクト「${topic}」。${i.user} との会話をここに記録します。はじめの一言をどうぞ。`);
  },

  panel: (i) => handlers.project(i),

  async home(i) {
    const sub = i.options.getSubcommand();
    if (sub === 'off') {
      store.clearHome(i.user.id);
      return i.reply({ content: '🏠 Homeを解除しました(自動更新を停止)', flags: MessageFlags.Ephemeral });
    }
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const payload = await homePayload(i.user.id, actionRows);
    const prev = store.getSettings(i.user.id);
    if (prev?.home_message_id) {
      try {
        const ch = await client.channels.fetch(prev.home_channel_id);
        const m = await ch.messages.fetch(prev.home_message_id);
        await m.edit(payload);
        return i.editReply('🏠 Homeを更新しました');
      } catch { /* 消えていた等→新規投稿へ */ }
    }
    const msg = await i.channel.send(payload);
    store.setHome(i.user.id, i.channelId, msg.id);
    return i.editReply('🏠 Homeを設置しました。30分ごとに自動更新・「更新」ボタンで即時更新できます');
  },

  async brief(i) {
    const sub = i.options.getSubcommand();
    if (sub === 'on') {
      const time = i.options.getString('time') ?? '08:00';
      if (!/^\d{1,2}:\d{2}$/.test(time)) {
        return i.reply({ content: '時刻は HH:MM 形式で。例: 08:00', flags: MessageFlags.Ephemeral });
      }
      const ch = i.options.getChannel('channel')?.id ?? i.channelId;
      store.upsertSettings(i.user.id, 1, time, ch);
      return i.reply({ content: `☀️ モーニングブリーフを毎日 ${time} に <#${ch}> へ送ります。`, flags: MessageFlags.Ephemeral });
    }
    if (sub === 'off') {
      store.upsertSettings(i.user.id, 0, '08:00', null);
      return i.reply({ content: 'モーニングブリーフを停止しました。', flags: MessageFlags.Ephemeral });
    }
    if (sub === 'now') {
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const text = await buildBrief(i.user.id);
      return i.editReply(text);
    }
  },
};

// ---------- schedulers ----------

async function deliverReminders() {
  for (const r of store.dueReminders(Date.now())) {
    try {
      const msg = `⏰ <@${r.user_id}> リマインダー: **${r.text}**`;
      if (r.channel_id) {
        const ch = await client.channels.fetch(r.channel_id).catch(() => null);
        if (ch?.isSendable()) { await ch.send(msg); store.markDelivered(r.id); continue; }
      }
      const user = await client.users.fetch(r.user_id);
      await user.send(msg);
      store.markDelivered(r.id);
    } catch (e) {
      console.error(`reminder #${r.id} failed:`, e.message);
      store.markDelivered(r.id); // 429等でのリトライループを避けるため一旦配信済み扱い
    }
  }
}

async function buildBrief(userId) {
  const rs = store.listReminders(userId);
  const lines = rs.slice(0, 10).map(r => `- ${r.text} (${fmtTs(r.due_at)})`);
  const prompt = `今日のモーニングブリーフを書いて。ユーザーの予定・記憶を踏まえて短く励ます一文と、今日のリマインダー一覧(あれば)を含める。リマインダー: ${rs.length ? rs.map(r => `${r.text}@${new Date(r.due_at).toISOString()}`).join(', ') : 'なし'}`;
  const scope = `u:${userId}`;
  const result = await chatDsh(userId, scope, prompt).catch(e => ({ reply: `ブリーフ生成に失敗: ${e.message}` }));
  return result.reply + (lines.length ? '\n\n**今日のリマインダー**\n' + lines.join('\n') : '');
}

async function sendBriefs() {
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const today = now.toISOString().slice(0, 10);
  for (const s of store.briefTargets()) {
    if (s.brief_time !== hhmm || s.brief_last_sent === today) continue;
    try {
      const text = await buildBrief(s.user_id);
      if (s.brief_channel) {
        const ch = await client.channels.fetch(s.brief_channel).catch(() => null);
        if (ch?.isSendable()) { await ch.send(`☀️ <@${s.user_id}> ${text}`); store.markBriefSent(s.user_id, today); continue; }
      }
      const user = await client.users.fetch(s.user_id);
      await user.send(`☀️ ${text}`);
      store.markBriefSent(s.user_id, today);
    } catch (e) {
      console.error(`brief for ${s.user_id} failed:`, e.message);
    }
  }
}

async function refreshHomes() {
  for (const t of store.homeTargets()) {
    try {
      const ch = await client.channels.fetch(t.home_channel_id).catch(() => null);
      const m = await ch?.messages?.fetch(t.home_message_id).catch(() => null);
      if (!m) { store.clearHome(t.user_id); continue; }
      await m.edit(await homePayload(t.user_id, actionRows));
    } catch (e) {
      console.error(`home refresh ${t.user_id} failed:`, e.message);
    }
  }
}

// ---------- events ----------

async function replyWithPlaceholder(message, scope, text = message.content) {
  const placeholder = await message.reply('Harkletが返信中……');
  try {
    const result = await chatDsh(message.author.id, scope, text);
    const rows = actionRows(message.author.id, result.actions);
    await placeholder.edit({
      content: result.reply.slice(0, 1900),
      components: result.reply.length <= 1900 ? rows : [],
    });
    for (let i = 1900; i < result.reply.length; i += 1900) {
      const last = i + 1900 >= result.reply.length;
      await message.reply({ content: result.reply.slice(i, i + 1900), components: last ? rows : [] });
    }
  } catch (e) {
    const errMsg = '⚠️ エラー: ' + e.message;
    await placeholder.edit(errMsg).catch(() => message.reply(errMsg).catch(() => {}));
  }
}
function attachEvents(client) {

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const h = handlers[interaction.commandName];
      if (h) await h(interaction);
    } else if (interaction.isButton() && interaction.customId.startsWith('act:')) {
      const a = store.getAction(Number(interaction.customId.slice(4)));
      if (!a) return interaction.reply({ content: 'このアクションは期限切れです。', flags: MessageFlags.Ephemeral });
      await runAction(interaction, a.payload);
      store.delAction(Number(interaction.customId.slice(4)));
    } else if (interaction.isButton() && interaction.customId === 'model_custom') {
      const modal = new ModalBuilder().setCustomId('model_modal').setTitle('モデルを自由入力');
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('model_name')
          .setLabel('モデル名 (例: openai/gpt-5, anthropic/claude-sonnet-4-5)')
          .setStyle(TextInputStyle.Short).setRequired(true),
      ));
      await interaction.showModal(modal);
    } else if (interaction.isButton() && interaction.customId === 'model_apply') {
      const uid = interaction.user.id;
      const m = pendingModelSel.get(uid);
      const e = pendingEffortSel.get(uid);
      if (m) store.setModel(uid, m);
      if (e) store.setEffort(uid, e === 'default' ? null : e);
      pendingModelSel.delete(uid);
      pendingEffortSel.delete(uid);
      if (m || e) await invalidateUserAgents(uid);
      await interaction.update(await modelPanel(uid));
    } else if (interaction.isButton() && interaction.customId === 'model_reset') {
      const uid = interaction.user.id;
      pendingModelSel.delete(uid);
      pendingEffortSel.delete(uid);
      store.setModel(uid, null);
      store.setEffort(uid, null);
      await invalidateUserAgents(uid);
      await interaction.update(await modelPanel(uid));
    } else if (interaction.isButton() && interaction.customId === 'home_refresh') {
      await interaction.deferUpdate();
      try { await interaction.message.edit(await homePayload(interaction.user.id, actionRows)); } catch {}
    } else if (interaction.isButton() && interaction.customId === 'home_region') {
      const modal = new ModalBuilder().setCustomId('home_region_modal').setTitle('地域を設定');
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('region_city')
          .setLabel('地名(例: 浦和 / Urawa / さいたま市)')
          .setStyle(TextInputStyle.Short).setRequired(true),
      ));
      await interaction.showModal(modal);
    } else if (interaction.isButton() && interaction.customId === 'home_newproj') {
      const modal = new ModalBuilder().setCustomId('home_proj_modal').setTitle('プロジェクト作成');
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('proj_topic')
          .setLabel('トピック(例: C2Bサイト改善)')
          .setStyle(TextInputStyle.Short).setRequired(true),
      ));
      await interaction.showModal(modal);
    } else if (interaction.isModalSubmit() && interaction.customId === 'model_modal') {
      const name = interaction.fields.getTextInputValue('model_name').trim();
      pendingModelSel.set(interaction.user.id, name);
      await interaction.update(await modelPanel(interaction.user.id));
    } else if (interaction.isModalSubmit() && interaction.customId === 'home_region_modal') {
      const name = interaction.fields.getTextInputValue('region_city').trim();
      await interaction.deferUpdate();
      const p = await geocodeCity(name);
      if (!p) {
        await interaction.followUp({ content: `📍 「${name}」が見つかりませんでした。別の表記で試してください`, flags: MessageFlags.Ephemeral });
      } else {
        const city = `${p.name}, ${p.country_code ?? ''}`;
        store.setHomeCity(interaction.user.id, city, p.latitude, p.longitude);
        await interaction.followUp({ content: `📍 地域を「${city}」に設定しました`, flags: MessageFlags.Ephemeral });
      }
      try { await interaction.message.edit(await homePayload(interaction.user.id, actionRows)); } catch {}
    } else if (interaction.isModalSubmit() && interaction.customId === 'home_proj_modal') {
      const topic = interaction.fields.getTextInputValue('proj_topic').trim();
      const base = interaction.message;
      if (!base?.channel || base.channel.type !== ChannelType.GuildText) {
        return interaction.reply({ content: 'ギルドのテキストチャンネルにあるHomeメッセージから実行してください', flags: MessageFlags.Ephemeral });
      }
      const thread = await base.startThread({ name: `pj-${topic.slice(0, 90)}`, autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek });
      store.addPanel(thread.id, interaction.user.id, topic);
      await thread.send(`📁 プロジェクト「${topic}」。${interaction.user} との会話をここに記録します。はじめの一言をどうぞ。`);
      await interaction.reply({ content: `📁 プロジェクトを作成しました: ${thread}`, flags: MessageFlags.Ephemeral });
    } else if (interaction.isStringSelectMenu()) {
      if (interaction.customId === 'model_sel') {
        pendingModelSel.set(interaction.user.id, interaction.values[0]);
      } else if (interaction.customId === 'effort_sel') {
        pendingEffortSel.set(interaction.user.id, interaction.values[0]);
      }
      await interaction.update(await modelPanel(interaction.user.id));
    }
  } catch (e) {
    console.error(e);
    const msg = { content: `⚠️ エラー: ${e.message}`, flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) await interaction.followUp(msg).catch(() => {});
    else await interaction.reply(msg).catch(() => {});
  }
});

client.on('messageCreate', async (message) => {
  if (!message.content.trim()) return;
  if (message.author.bot) return;

  // メインチャンネル: 書き込むだけで会話
  if (message.guildId && message.channel.id === store.getMain(message.guildId)) {
    await replyWithPlaceholder(message, 'main:' + message.channel.id);
    return;
  }

  // パネルスレッド
  // DM: MessageContent Intent なしでも本文が届く
  if (!message.guildId) {
    await replyWithPlaceholder(message, 'dm:' + message.author.id);
    return;
  }

  // メンション: Intent なしでもBot宛メンションの本文は届く
  if (client.user && message.mentions?.has(client.user)) {
    const text = (message.cleanContent || message.content).trim();
    if (text) await replyWithPlaceholder(message, 'mention:' + message.channelId, text);
    return;
  }

  if (!message.channel.isThread()) return;
  const panel = store.getPanel(message.channel.id);
  if (!panel || message.author.id !== panel.user_id) return;
  await replyWithPlaceholder(message, 'panel:' + message.channel.id);
});

client.once('clientReady', () => {
  console.log(`Harklet logged in as ${client.user.tag}`);
  setInterval(deliverReminders, 15_000).unref();
  setInterval(sendBriefs, 30_000).unref();
  setInterval(refreshHomes, 1_800_000).unref();
});

}

attachEvents(client);

// MessageContent Intent がPortalで未許可なら、パネル会話なしモードで再起動する
async function login(withContent) {
  try {
    await client.login(config.discordToken);
  } catch (e) {
    if (withContent && String(e).includes('disallowed intents')) {
      console.error('[Harklet] Message Content Intent not allowed -> retrying without it. Panel free-chat will be disabled. To enable: Developer Portal -> Bot -> Privileged Gateway Intents -> MESSAGE CONTENT INTENT.');
      client = makeClient(false);
      attachEvents(client);
      return login(false);
    }
    console.error(e);
    process.exitCode = 1;
  }
}

await login(true);
