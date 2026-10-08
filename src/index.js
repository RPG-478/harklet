import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Client,
  GatewayIntentBits, ThreadAutoArchiveDuration,
  EmbedBuilder, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder,
  TextInputStyle, PermissionFlagsBits, MessageFlags,
} from 'discord.js';
import { config } from './config.js';
import { store, clearHarkletDatabase } from './db.js';
import { chatDsh, invalidateUserAgents, recordComputerOutcome, shutdownDsh } from './dsh-agent.js';
import { homePayload, geocodeCity } from './home.js';
import { listModels } from './llm.js';
import { parseWhen, fmtTs } from './schedule.js';
import { handleComputerInteraction, startComputerTask, computerIsBusy } from './computer/controller.js';
import { detachedProjectThreads } from './reset-plan.js';

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
const pendingResets = new Map(); // guildId -> { userId, expires }
const resettingGuilds = new Set();

function resetAllowed(i) {
  return process.env.HARKLET_ENABLE_RESET === '1' && config.guildId && i.guildId === config.guildId &&
    i.memberPermissions?.has(PermissionFlagsBits.Administrator);
}

async function resetTargets(guild) {
  const all = await guild.channels.fetch();
  const tracked = store.getManagedCategory(guild.id);
  const project = all.get(store.getProjectChannel(guild.id));
  const fallback = project?.parent?.name === 'Harklet' ? project.parentId : null;
  const category = all.get(tracked) || all.get(fallback);
  const channels = category?.type === ChannelType.GuildCategory
    ? [...all.values()].filter(ch => ch && ch.parentId === category.id)
    : [];
  const threads = [];
  for (const id of store.allPanels()) {
    const thread = await guild.channels.fetch(id).catch(() => null);
    if (thread?.guildId === guild.id && thread.isThread()) threads.push(thread);
  }
  return { category, channels, threads };
}

async function performReset(i) {
  if (computerIsBusy()) throw new Error('Computer Useの作業中です。/computer stop で停止してから再実行してください');
  const { category, channels, threads } = await resetTargets(i.guild);
  // Deleting a parent channel also removes its threads. The bot has ManageChannels,
  // but may not have ManageThreads, so only delete threads outside managed channels.
  const detachedThreads = detachedProjectThreads(channels, threads);
  if (detachedThreads.length && !i.guild.members.me?.permissions.has(PermissionFlagsBits.ManageThreads)) {
    throw new Error('管理カテゴリ外にプロジェクトスレッドがあります。Botに「スレッド管理」権限を付けてから再実行してください');
  }
  for (const thread of detachedThreads) await thread.delete('Harklet test reset');
  for (const channel of channels) await channel.delete('Harklet test reset');
  if (category) await category.delete('Harklet test reset');
  await shutdownDsh();
  const tables = clearHarkletDatabase();
  pendingModelSel.clear();
  pendingEffortSel.clear();
  return `リセット完了: スレッド${threads.length}件、チャンネル${channels.length + (category ? 1 : 0)}件、DB ${tables.length}テーブルのデータを消去しました。保存済みブラウザVMのCookieは残ります。`;
}

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

// Agentが実行できる操作。ボタン(act:)と auto 即時実行の両方から呼ぶ。
async function execAction({ userId, channel, action, scope, computerChannel, privateComputer = false }) {
  const a = action ?? {};
  const arg = a.arg;
  const norm = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, "");
  const homeRefresh = async () => {
    const st = store.getSettings(userId);
    if (!st?.home_message_id) return;
    try {
      const ch = await client.channels.fetch(st.home_channel_id);
      const m = await ch.messages.fetch(st.home_message_id);
      await m.edit(await homePayload(userId, actionRows));
    } catch {}
  };

  if (a.kind === 'computer') {
    const task = String(arg ?? '').trim();
    if (privateComputer && !computerChannel) return 'DMを開けなかったため、非公開のブラウザ作業を開始できませんでした';
    const target = computerChannel ?? channel;
    if (!target?.send) return 'ブラウザ作業の結果を通知できるチャンネルがありません';
    return startComputerTask({
      userId, task, channel: target,
      onDone: outcome => { if (scope) recordComputerOutcome(userId, scope, task, outcome); },
    });
  }

  if (a.kind === "remind") {
    const due = Date.parse(arg ?? "");
    if (Number.isNaN(due)) return "日時を解釈できませんでした。日時を添えて言い直してください。";
    const id = store.addReminder(userId, channel?.id ?? null, a.label, due);
    return `⏰ リマインダー #${id}: 「${a.label}」→ ${fmtTs(due)}`;
  }
  if (a.kind === "remind_del") {
    const rs = store.listReminders(userId);
    const hit = rs.find(r => String(r.id) === String(arg ?? "").trim()) ?? rs.find(r => norm(r.text).includes(norm(arg)));
    if (!hit) return `リマインダー「${arg}」は見つかりませんでした`;
    store.cancelReminder(userId, hit.id);
    return `🗑️ リマインダー「${hit.text}」を取り消しました`;
  }
  if (a.kind === "memory") {
    store.addMemory(userId, String(arg ?? a.label));
    return `🧠 記憶しました: ${arg ?? a.label}`;
  }
  if (a.kind === "memory_del") {
    const ms = store.listMemories(userId);
    const hit = ms.find(m => String(m.id) === String(arg ?? "").trim()) ?? ms.find(m => norm(m.content).includes(norm(arg)));
    if (!hit) return `記憶「${arg}」は見つかりませんでした`;
    store.deleteMemory(userId, hit.id);
    return `🗑️ 記憶を削除しました: ${String(hit.content).slice(0, 60)}`;
  }
  if (a.kind === "home_card") {
    let c = {};
    try { c = JSON.parse(arg ?? "{}"); } catch {}
    if (!c.title || !c.prompt) return "カード定義が壊れています";
    store.addHomeCard(userId, String(c.title).slice(0, 60), String(c.prompt).slice(0, 500), c.emoji ?? null, c.color ?? null);
    await homeRefresh();
    return `🏠 Homeにカード「${c.title}」を追加しました`;
  }
  if (a.kind === "home_card_del") {
    const cards = store.listHomeCards(userId);
    const hit = cards.find(c => norm(c.title).includes(norm(arg)));
    if (!hit) return `カード「${arg}」は見つかりませんでした`;
    store.delHomeCard(userId, hit.id);
    await homeRefresh();
    return `🗑️ Homeからカード「${hit.title}」を削除しました`;
  }
  if (a.kind === "project") {
    const topic = String(arg ?? a.label).slice(0, 90);
    if (!channel?.threads || channel.type !== ChannelType.GuildText) {
      return "スレッドを作れません。サーバーのテキストチャンネルで実行してください";
    }
    const thread = await channel.threads.create({ name: `pj-${topic}`, autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek });
    store.addPanel(thread.id, userId, topic);
    await thread.send(`📁 プロジェクト「${topic}」。<@${userId}> との会話をここに記録します。はじめの一言をどうぞ。`);
    return `📁 プロジェクトを作成しました: ${thread}`;
  }
  if (a.kind === "location") {
    const g = await geocodeCity(String(arg ?? ""));
    if (!g) return `📍 「${arg}」が見つかりませんでした`;
    const city = `${g.name}, ${g.country_code ?? ""}`;
    store.setHomeCity(userId, city, g.latitude, g.longitude);
    await homeRefresh();
    return `📍 地域を「${city}」に設定しました`;
  }
  if (a.kind === "brief") {
    let b = {};
    try { b = JSON.parse(arg ?? "{}"); } catch {}
    if (b.off) { store.upsertSettings(userId, 0, "08:00", null); return "☀️ モーニングブリーフを停止しました"; }
    const time = String(b.time ?? "").trim();
    if (!/^\d{1,2}:\d{2}$/.test(time)) return "時刻は HH:MM 形式で指定してください";
    store.upsertSettings(userId, 1, time, channel?.id ?? null);
    return `☀️ モーニングブリーフを毎日 ${time} にこのチャンネルへ送ります`;
  }
  if (a.kind === "model") {
    let m = {};
    try { m = JSON.parse(arg ?? "{}"); } catch { m = { model: arg }; }
    if (m.model) store.setModel(userId, String(m.model).slice(0, 100));
    if (m.effort) store.setEffort(userId, m.effort === "default" ? null : String(m.effort));
    if (m.model || m.effort) await invalidateUserAgents(userId);
    const s = store.getSettings(userId) ?? {};
    return `⚙️ モデル設定を更新しました: ${s.model ?? config.llm.model} / effort=${s.effort ?? "default"}`;
  }
  return "未対応のアクションです。";
}

async function runAction(interaction, action) {
  if (action?.kind === 'computer') await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const result = await execAction({ userId: interaction.user.id, channel: interaction.channel, action, scope: 'u:' + interaction.user.id });
  if (interaction.deferred) return interaction.editReply({ content: result ?? '完了' });
  return interaction.reply({ content: result ?? '完了', flags: MessageFlags.Ephemeral });
}

async function answer(interaction) {
  const question = interaction.options.getString("question", true);
  const ephemeral = interaction.options.getBoolean("private") ?? false;
  await interaction.deferReply(ephemeral ? { flags: MessageFlags.Ephemeral } : {});
  try {
    const scope = "u:" + interaction.user.id;
    const result = await chatDsh(interaction.user.id, scope, question);
    const all = Array.isArray(result.actions) ? result.actions : [];
    const autos = all.filter(a => a?.auto === true || a?.kind === 'computer');
    await interaction.editReply({
      content: result.reply.slice(0, 1900),
      components: actionRows(interaction.user.id, all.filter(a => a?.auto !== true && a?.kind !== 'computer')),
    });
    for (const a of autos) {
      const computerChannel = a.kind === 'computer' && ephemeral ? await interaction.user.createDM().catch(() => null) : null;
      const r = await execAction({ userId: interaction.user.id, channel: interaction.channel, action: a, scope, computerChannel, privateComputer: a.kind === 'computer' && ephemeral }).catch(e => "⚠️ " + e.message);
      if (r) await interaction.followUp({ content: r, ...(ephemeral ? { flags: MessageFlags.Ephemeral } : {}) }).catch(() => {});
    }
  } catch (e) {
    await interaction.editReply("⚠️ エラー: " + e.message);
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

  async reset(i) {
    if (!resetAllowed(i)) return i.reply({ content: 'このテスト用コマンドは対象サーバーの管理者だけが使えます。', flags: MessageFlags.Ephemeral });
    if (computerIsBusy()) return i.reply({ content: 'Computer Useの作業を止めてから実行してください。', flags: MessageFlags.Ephemeral });
    const { category, channels, threads } = await resetTargets(i.guild);
    pendingResets.set(i.guildId, { userId: i.user.id, expires: Date.now() + 2 * 60_000 });
    const targets = category ? `カテゴリ「${category.name}」と配下${channels.length}チャンネル` : 'Harklet管理カテゴリは見つかりません';
    return i.reply({
      content: `⚠️ **テスト用リセット**\n削除対象: ${targets}、Harkletのプロジェクトスレッド${threads.length}件、**Harklet DBの全データ（全ユーザーの記憶・設定・ログイン情報を含む）**。ブラウザVMのCookieは残ります。\n2分以内に実行ボタンを押すと削除します。`,
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('reset_confirm:' + i.guildId).setLabel('リセットを実行').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('reset_cancel:' + i.guildId).setLabel('中止').setStyle(ButtonStyle.Secondary),
      )],
      flags: MessageFlags.Ephemeral,
    });
  },

  async main(i) {
    const sub = i.options.getSubcommand();
    if (!i.guildId) return i.reply({ content: 'サーバー内で実行してください。', flags: MessageFlags.Ephemeral });
    if (sub === 'set') {
      if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return i.reply({ content: 'メインチャンネルの設定には「サーバー管理」権限が必要です。', flags: MessageFlags.Ephemeral });
      }
      await i.deferReply();
      const me = i.guild?.members?.me;
      if (!me?.permissions?.has(PermissionFlagsBits.ManageChannels)) {
        return i.editReply('❌ Botに「チャンネル管理」権限が必要です。招待URLの permissions は 3197968 が必要です(README参照)。');
      }
      try {
        const cat = await i.guild.channels.create({ name: 'Harklet', type: ChannelType.GuildCategory });
        store.setManagedCategory(i.guildId, cat.id);
        let main = i.options.getChannel('channel');
        if (!main) main = await i.guild.channels.create({ name: 'chat', type: ChannelType.GuildText, parent: cat.id });
        const homeCh = await i.guild.channels.create({ name: 'home', type: ChannelType.GuildText, parent: cat.id });
        const projCh = await i.guild.channels.create({ name: 'projects', type: ChannelType.GuildText, parent: cat.id });
        store.setMain(i.guildId, main.id, i.user.id);
        store.setProjectChannel(i.guildId, projCh.id);
        const m = await homeCh.send(await homePayload(i.user.id, actionRows));
        store.setHome(i.user.id, homeCh.id, m.id);
        await projCh.send({
          content: '📁 **プロジェクト** — 話題ごとの会話スレッド。\n下のボタンか、チャットで頼んで新しいプロジェクトを作成します。',
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('proj_new').setLabel('新規プロジェクト').setEmoji('➕').setStyle(ButtonStyle.Primary),
          )],
        });
        return i.editReply(`📍 セットアップしました: 💬<#${main.id}> / 🏠<#${homeCh.id}> / 📁<#${projCh.id}>\nchat への書き込みはそのまま会話になります。home は30分ごとに自動更新。`);
      } catch (e) {
        return i.editReply('❌ チャンネル作成に失敗: ' + e.message);
      }
    }
    if (sub === 'off') {
      if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return i.reply({ content: '「サーバー管理」権限が必要です。', flags: MessageFlags.Ephemeral });
      }
      store.clearMain(i.guildId);
      store.clearProjectChannel(i.guildId);
      return i.reply({ content: '📍 メイン/プロジェクト設定を解除しました(チャンネル自体は残ります)' });
    }
    const ch = store.getMain(i.guildId);
    const pj = store.getProjectChannel(i.guildId);
    const parts = [`📍 メイン: ${ch ? `<#${ch}>` : '未設定'}`, `📁 プロジェクト: ${pj ? `<#${pj}>` : '未設定'}`];
    return i.reply({ content: parts.join(' / '), flags: MessageFlags.Ephemeral });
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
        : 'まだ記憶はありません。チャットで「これを覚えて」と頼むこともできます。';
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
    if (sub === 'cards') {
      const cards = store.listHomeCards(i.user.id);
      if (!cards.length) {
        return i.reply({ content: 'カスタムカードはまだありません。会話で提案された「ホームに追加」ボタンから増えます', flags: MessageFlags.Ephemeral });
      }
      const lines = cards.map(c => `#${c.id} ${c.emoji ?? ''} ${c.title}`);
      const rows = cards.slice(0, 5).map(c => new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`hcard_del:${c.id}`).setLabel(`削除: ${c.title.slice(0, 30)}`).setStyle(ButtonStyle.Danger),
      ));
      return i.reply({ content: '🏠 カスタムカード\n' + lines.join('\n'), components: rows, flags: MessageFlags.Ephemeral });
    }
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

async function sendAgentReply(message, scope, text = message.content) {
  // typing indicator: expires in ~10s, resend every 8s until reply completes
  const typing = setInterval(() => message.channel.sendTyping().catch(() => {}), 8000);
  message.channel.sendTyping().catch(() => {});
  try {
    const result = await chatDsh(message.author.id, scope, text);
    const all = Array.isArray(result.actions) ? result.actions : [];
    const autos = all.filter(a => a?.auto === true || a?.kind === 'computer');
    const rows = actionRows(message.author.id, all.filter(a => a?.auto !== true && a?.kind !== 'computer'));
    await message.reply({
      content: result.reply.slice(0, 1900),
      components: result.reply.length <= 1900 ? rows : [],
    });
    for (let i = 1900; i < result.reply.length; i += 1900) {
      const last = i + 1900 >= result.reply.length;
      await message.reply({ content: result.reply.slice(i, i + 1900), components: last ? rows : [] });
    }
    for (const a of autos) {
      const r = await execAction({ userId: message.author.id, channel: message.channel, action: a, scope }).catch(e => "⚠️ " + e.message);
      if (r) await message.reply(r).catch(() => {});
    }
  } catch (e) {
    await message.reply('⚠️ エラー: ' + e.message).catch(() => {});
  } finally {
    clearInterval(typing);
  }
}
function attachEvents(client) {

client.on('interactionCreate', async (interaction) => {
  if (await handleComputerInteraction(interaction)) return;
  try {
    if (interaction.isChatInputCommand()) {
      const h = handlers[interaction.commandName];
      if (h) await h(interaction);
    } else if (interaction.isButton() && /^reset_(confirm|cancel):/.test(interaction.customId)) {
      if (!resetAllowed(interaction)) return interaction.reply({ content: '管理者のみ実行できます。', flags: MessageFlags.Ephemeral });
      const [kind, guildId] = interaction.customId.split(':');
      const pending = pendingResets.get(guildId);
      if (!pending || pending.userId !== interaction.user.id || pending.expires < Date.now()) {
        return interaction.reply({ content: '確認の有効期限が切れました。/reset からやり直してください。', flags: MessageFlags.Ephemeral });
      }
      pendingResets.delete(guildId);
      if (kind === 'reset_cancel') return interaction.update({ content: 'リセットを中止しました。', components: [] });
      if (resettingGuilds.has(guildId)) return interaction.reply({ content: 'リセットはすでに実行中です。', flags: MessageFlags.Ephemeral });
      resettingGuilds.add(guildId);
      await interaction.update({ content: 'HarkletのチャンネルとDBを削除しています…', components: [] });
      try {
        const result = await performReset(interaction);
        await interaction.editReply({ content: result }).catch(() => interaction.user.send(result).catch(() => {}));
      } finally { resettingGuilds.delete(guildId); }
    } else if (interaction.isButton() && interaction.customId.startsWith('act:')) {
      const a = store.getAction(Number(interaction.customId.slice(4)));
      if (!a) return interaction.reply({ content: 'このアクションは期限切れです。', flags: MessageFlags.Ephemeral });
      if (a.userId !== interaction.user.id) return interaction.reply({ content: 'このボタンは依頼した本人だけが使えます。', flags: MessageFlags.Ephemeral });
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
    } else if (interaction.isButton() && interaction.customId.startsWith('hcard_del:')) {
      const id = Number(interaction.customId.slice(10));
      const ok = store.delHomeCard(interaction.user.id, id);
      await interaction.update({ content: ok ? `🗑️ カード #${id} を削除しました` : "見つかりません", components: [] });
      const st = store.getSettings(interaction.user.id);
      if (st?.home_message_id) {
        try {
          const ch = await client.channels.fetch(st.home_channel_id);
          const m = await ch.messages.fetch(st.home_message_id);
          await m.edit(await homePayload(interaction.user.id, actionRows));
        } catch {}
      }
    } else if (interaction.isButton() && interaction.customId === 'proj_new') {
      const modal = new ModalBuilder().setCustomId('proj_modal').setTitle('プロジェクト作成');
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('proj_topic')
          .setLabel('トピック(例: C2Bサイト改善)')
          .setStyle(TextInputStyle.Short).setRequired(true),
      ));
      await interaction.showModal(modal);
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
    } else if (interaction.isModalSubmit() && interaction.customId === 'proj_modal') {
      const topic = interaction.fields.getTextInputValue('proj_topic').trim();
      const ch = interaction.channel;
      if (!ch || ch.type !== ChannelType.GuildText) {
        return interaction.reply({ content: 'テキストチャンネルで実行してください', flags: MessageFlags.Ephemeral });
      }
      const thread = await ch.threads.create({ name: `pj-${topic.slice(0, 90)}`, autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek });
      store.addPanel(thread.id, interaction.user.id, topic);
      await thread.send(`📁 プロジェクト「${topic}」。${interaction.user} との会話をここに記録します。はじめの一言をどうぞ。`);
      await interaction.reply({ content: `📁 プロジェクトを作成しました: ${thread}`, flags: MessageFlags.Ephemeral });
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
  if (message.guildId && resettingGuilds.has(message.guildId)) return;
  if (!message.content.trim()) return;
  if (message.author.bot) return;

  // メインチャンネル: 書き込むだけで会話
  if (message.guildId && message.channel.id === store.getMain(message.guildId)) {
    await sendAgentReply(message, 'main:' + message.channel.id);
    return;
  }

  // パネルスレッド
  // DM: MessageContent Intent なしでも本文が届く
  if (!message.guildId) {
    await sendAgentReply(message, 'dm:' + message.author.id);
    return;
  }

  // メンション: Intent なしでもBot宛メンションの本文は届く
  if (client.user && message.mentions?.has(client.user)) {
    const text = (message.cleanContent || message.content).trim();
    if (text) await sendAgentReply(message, 'mention:' + message.channelId, text);
    return;
  }

  if (!message.channel.isThread()) return;
  const panel = store.getPanel(message.channel.id);
  if (!panel || message.author.id !== panel.user_id) return;
  await sendAgentReply(message, 'panel:' + message.channel.id);
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
