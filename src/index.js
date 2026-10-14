import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Client,
  GatewayIntentBits, ThreadAutoArchiveDuration,
  EmbedBuilder, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder,
  TextInputStyle, PermissionFlagsBits, MessageFlags,
} from 'discord.js';
import { config } from './config.js';
import { t, LANG_NAMES } from './i18n.js';
import { userLang, noteAutoLang, noteLocale, languageTag } from './user-lang.js';
import { store, clearHarkletDatabase } from './db.js';
import { chatDsh, invalidateUserAgents, recordComputerOutcome, shutdownDsh } from './dsh-agent.js';
import { homePayload, geocodeCity, customCard } from './home.js';
import { listModels, modelChoices } from './llm.js';
import { parseWhen, fmtTs } from './schedule.js';
import { handleComputerInteraction, startComputerTask, computerIsBusy, computerMaxSteps, computerRunning } from './computer/controller.js';
import { startWebUi } from './web/server.js';
import { detachedProjectThreads } from './reset-plan.js';
import * as google from './connect/google.js';
import * as m365 from './connect/m365.js';
import { PROVIDERS, providerStatus, runOp } from './connect/index.js';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { learnCompletedWorkflow, specialtyDefinitionFromArg, specialtyTask } from './specialties.js';

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
const SKIP_MODEL = /embed|whisper|tts|image|audio|dall-e|moderation|transcrib/i;

// /model パネルで選択中(未適用)の値。決定ボタンで確定する。
const pendingModelSel = new Map(); // userId -> model
const pendingEffortSel = new Map(); // userId -> effort|'default'
const modelPages = new Map(); // userId -> page index
const modelQueries = new Map(); // userId -> search term
const pendingResets = new Map(); // guildId -> { userId, expires }
const resettingGuilds = new Set();
let webUi = null;
const webEvents = new Map();
function webNotice(userId, message) {
  const list = webEvents.get(userId) ?? [];
  list.push({ id: Date.now() + ':' + Math.random(), message, at: Date.now() });
  webEvents.set(userId, list.slice(-12));
}
// Google OAuth ループバック用 state → 誰の接続フローか (CSRF防止・モーダル検証)
const connectStates = new Map(); // state -> { userId, provider, expires }

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
  if (computerIsBusy()) throw new Error(t(userLang(i.user.id), 'reset.errBusy'));
  const { category, channels, threads } = await resetTargets(i.guild);
  // Deleting a parent channel also removes its threads. The bot has ManageChannels,
  // but may not have ManageThreads, so only delete threads outside managed channels.
  const detachedThreads = detachedProjectThreads(channels, threads);
  if (detachedThreads.length && !i.guild.members.me?.permissions.has(PermissionFlagsBits.ManageThreads)) {
    throw new Error(t(userLang(i.user.id), 'reset.errThreads'));
  }
  for (const thread of detachedThreads) await thread.delete('Harklet test reset');
  for (const channel of channels) await channel.delete('Harklet test reset');
  if (category) await category.delete('Harklet test reset');
  await shutdownDsh();
  const tables = clearHarkletDatabase();
  pendingModelSel.clear();
  pendingEffortSel.clear();
  return t(userLang(i.user.id), 'reset.done', { threads: threads.length, channels: channels.length + (category ? 1 : 0), tables: tables.length });
}

async function modelPanel(userId) {
  const s = store.getSettings(userId) ?? {};
  const current = s.model || config.llm.model;
  const stagedModel = pendingModelSel.get(userId);
  const stagedEffort = pendingEffortSel.get(userId);
  const catalog = await listModels();
  const models = catalog.ids.filter(m => !SKIP_MODEL.test(m));
  const shown = stagedModel ?? current;
  const shownEffort = stagedEffort ?? s.effort ?? 'default';
  const query = modelQueries.get(userId) ?? '';
  const { choices, page, pageCount } = modelChoices(models, shown, query, modelPages.get(userId) ?? 0);
  modelPages.set(userId, page);
  const embed = new EmbedBuilder()
    .setTitle(t(userLang(userId), 'panel.title'))
    .setColor(0x5865f2)
    .addFields(
      { name: 'model', value: '`' + shown + '`' + (stagedModel ? t(userLang(userId), 'panel.unapplied') : ''), inline: true },
      { name: 'effort', value: shownEffort + (stagedEffort ? t(userLang(userId), 'panel.unapplied') : ''), inline: true },
      { name: 'provider', value: config.llm.provider, inline: true },
    )
    .setFooter({ text: t(userLang(userId), 'panel.footer', { count: models.length, source: catalog.source, page: page + 1, pages: pageCount }) });
  if (catalog.error) embed.addFields({ name: t(userLang(userId), 'panel.modelList'), value: catalog.error });
  if (query) embed.addFields({ name: t(userLang(userId), 'panel.searchBtn'), value: query.slice(0, 100) });
  const modelMenu = new StringSelectMenuBuilder()
    .setCustomId('model_sel')
    .setPlaceholder(t(userLang(userId), 'panel.pickModel', { n: choices.length }))
    .addOptions(choices.map(v => ({ label: v.slice(0, 100), value: v, default: v === shown })));
  const effortMenu = new StringSelectMenuBuilder()
    .setCustomId('effort_sel')
    .setPlaceholder(t(userLang(userId), 'panel.effort'))
    .addOptions(
      { label: 'default', value: 'default', default: shownEffort === 'default' },
      { label: 'low', value: 'low', default: shownEffort === 'low' },
      { label: 'medium', value: 'medium', default: shownEffort === 'medium' },
      { label: 'high', value: 'high', default: shownEffort === 'high' },
    );
  const applyBtn = new ButtonBuilder().setCustomId('model_apply').setLabel(t(userLang(userId), 'panel.apply')).setStyle(ButtonStyle.Success);
  const customBtn = new ButtonBuilder().setCustomId('model_custom').setLabel(t(userLang(userId), 'panel.custom')).setStyle(ButtonStyle.Secondary);
  const resetBtn = new ButtonBuilder().setCustomId('model_reset').setLabel(t(userLang(userId), 'panel.reset')).setStyle(ButtonStyle.Danger);
  const prevBtn = new ButtonBuilder().setCustomId('model_prev').setLabel(t(userLang(userId), 'panel.prev')).setStyle(ButtonStyle.Secondary).setDisabled(page === 0);
  const nextBtn = new ButtonBuilder().setCustomId('model_next').setLabel(t(userLang(userId), 'panel.next')).setStyle(ButtonStyle.Secondary).setDisabled(page + 1 >= pageCount);
  const searchBtn = new ButtonBuilder().setCustomId('model_search').setLabel(t(userLang(userId), 'panel.searchBtn')).setStyle(ButtonStyle.Secondary);
  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(modelMenu),
      new ActionRowBuilder().addComponents(effortMenu),
      new ActionRowBuilder().addComponents(prevBtn, nextBtn, searchBtn),
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
    if (privateComputer && !computerChannel) return t(userLang(userId), 'x.dmFail');
    const target = computerChannel ?? channel;
    if (!target?.send) return t(userLang(userId), 'x.noChannel');
    return startComputerTask({
      userId, task, channel: target,
      onDone: async (outcome, result) => {
        if (scope) recordComputerOutcome(userId, scope, task, outcome);
        if (scope?.startsWith('web:')) webNotice(userId, outcome);
        const learned = learnCompletedWorkflow(store, userId, task, result);
        if (learned?.promoted) {
          try {
            const user = await client.users.fetch(userId);
            await user.send(t(userLang(userId), 'x.learned', { name: learned.candidate.name }));
          } catch {}
        }
      },
    });
  }

  if (a.kind === 'specialty_save') {
    const definition = specialtyDefinitionFromArg(store, userId, arg);
    if (!definition) return t(userLang(userId), 'x.specNeed');
    store.saveSpecialty(userId, definition.name, definition.instructions, definition.interval_days);
    await homeRefresh();
    return t(userLang(userId), 'x.specSaved', { name: definition.name, interval: definition.interval_days ? t(userLang(userId), 'x.specInterval', { days: definition.interval_days }) : '' });
  }
  if (a.kind === 'specialty_list') {
    const list = store.listSpecialties(userId);
    return list.length ? t(userLang(userId), 'x.specList', { list: '' }) + list.map(s => `#${s.id} ${s.name}${s.interval_days ? t(userLang(userId), 'x.specListInterval', { days: s.interval_days }) : ''}`).join('\n').slice(0, 1700)
      : t(userLang(userId), 'x.specNone');
  }
  if (a.kind === 'specialty_del') {
    const key = String(arg ?? '').trim();
    const hit = /^\d+$/.test(key) ? store.getSpecialty(userId, Number(key)) : store.findSpecialty(userId, key);
    if (!hit) return t(userLang(userId), 'x.specNotFound');
    store.deleteSpecialty(userId, hit.id);
    await homeRefresh();
    return t(userLang(userId), 'x.specDeleted', { name: hit.name });
  }
  if (a.kind === 'specialty_run') {
    const key = String(arg ?? '').trim();
    const hit = /^\d+$/.test(key) ? store.getSpecialty(userId, Number(key)) : store.findSpecialty(userId, key);
    if (!hit) return t(userLang(userId), 'x.specNotFound');
    if (privateComputer && !computerChannel) return t(userLang(userId), 'x.dmFail');
    const target = computerChannel ?? channel;
    if (!target?.send) return t(userLang(userId), 'x.noChannel');
    return startComputerTask({ userId, task: specialtyTask(hit), channel: target,
      onDone: (outcome, result) => {
        if (scope) recordComputerOutcome(userId, scope, hit.name, outcome);
        if (result?.status === 'done') store.markSpecialtyRun(userId, hit.id);
      },
    });
  }

  if (a.kind === "remind") {
    const due = parseWhen(String(arg ?? ""));
    if (!due) return t(userLang(userId), 'x.remindBadWhen');
    const id = store.addReminder(userId, channel?.id ?? null, a.label, due);
    return t(userLang(userId), 'x.remindSet', { id, label: a.label, when: fmtTs(due) });
  }
  if (a.kind === "remind_del") {
    if (!norm(arg)) return t(userLang(userId), 'x.remindNeed');
    const rs = store.listReminders(userId);
    const hit = rs.find(r => String(r.id) === String(arg ?? "").trim()) ?? rs.find(r => norm(r.text).includes(norm(arg)));
    if (!hit) return t(userLang(userId), 'x.remindNotFound', { arg });
    store.cancelReminder(userId, hit.id);
    return t(userLang(userId), 'x.remindDeleted', { text: hit.text });
  }
  if (a.kind === "memory") {
    store.addMemory(userId, String(arg ?? a.label));
    return t(userLang(userId), 'x.memorySaved', { text: arg ?? a.label });
  }
  if (a.kind === "memory_del") {
    if (!norm(arg)) return t(userLang(userId), 'x.memoryNeed');
    const ms = store.listMemories(userId);
    const hit = ms.find(m => String(m.id) === String(arg ?? "").trim()) ?? ms.find(m => norm(m.content).includes(norm(arg)));
    if (!hit) return t(userLang(userId), 'x.memoryNotFound', { arg });
    store.deleteMemory(userId, hit.id);
    return t(userLang(userId), 'x.memoryDeleted', { text: String(hit.content).slice(0, 60) });
  }
  if (a.kind === "home_card") {
    let c = {};
    try { c = JSON.parse(arg ?? "{}"); } catch {}
    if (!c.title || !c.prompt) return t(userLang(userId), 'x.cardBad');
    const ops = Array.isArray(c.ops) ? JSON.stringify(c.ops.filter(o => typeof o === 'string').slice(0, 4)) : null;
    const btns = Array.isArray(c.buttons)
      ? JSON.stringify(c.buttons.filter(b => b?.label && b?.prompt)
        .map(b => ({ label: String(b.label).slice(0, 40), prompt: String(b.prompt).slice(0, 300) })).slice(0, 5))
      : null;
    store.addHomeCard(userId, String(c.title).slice(0, 60), String(c.prompt).slice(0, 500), c.emoji ?? null, c.color ?? null, ops, btns);
    await homeRefresh();
    return t(userLang(userId), 'x.cardAdded', { title: c.title });
  }
  if (a.kind === "home_card_upd") {
    let c = {};
    try { c = JSON.parse(arg ?? "{}"); } catch {}
    const cards = store.listHomeCards(userId);
    if (!norm(c.target ?? c.title ?? "")) return t(userLang(userId), 'x.cardNeedTarget');
    const hit = cards.find(x => norm(x.title).includes(norm(c.target ?? c.title ?? "")));
    if (!hit) return t(userLang(userId), 'x.cardNotFound', { title: c.target ?? c.title });
    const upd = {
      title: c.new_title ? String(c.new_title).slice(0, 60) : hit.title,
      prompt: c.prompt ? String(c.prompt).slice(0, 500) : hit.prompt,
      emoji: c.emoji !== undefined ? c.emoji : hit.emoji,
      color: c.color !== undefined ? c.color : hit.color,
      ops: c.ops !== undefined
        ? (Array.isArray(c.ops) ? JSON.stringify(c.ops.filter(o => typeof o === 'string').slice(0, 4)) : null)
        : hit.ops,
      buttons: c.buttons !== undefined
        ? (Array.isArray(c.buttons)
          ? JSON.stringify(c.buttons.filter(b => b?.label && b?.prompt)
            .map(b => ({ label: String(b.label).slice(0, 40), prompt: String(b.prompt).slice(0, 300) })).slice(0, 5))
          : null)
        : hit.buttons,
    };
    store.updHomeCard(userId, hit.id, upd);
    await homeRefresh();
    return t(userLang(userId), 'x.cardUpdated', { title: upd.title });
  }
  if (a.kind === "home_card_del") {
    if (!norm(arg)) return t(userLang(userId), 'x.cardNeedArg');
    const cards = store.listHomeCards(userId);
    const hit = cards.find(c => norm(c.title).includes(norm(arg)));
    if (!hit) return t(userLang(userId), 'x.cardNotFound', { title: arg });
    store.delHomeCard(userId, hit.id);
    await homeRefresh();
    return t(userLang(userId), 'x.cardDeleted', { title: hit.title });
  }
  if (a.kind === "home_off") {
    store.clearHome(userId);
    return t(userLang(userId), 'x.homeOff');
  }
  if (a.kind === "project") {
    const topic = String(arg ?? a.label).slice(0, 90);
    if (!channel?.threads || channel.type !== ChannelType.GuildText) {
      return t(userLang(userId), 'x.noThread');
    }
    const thread = await channel.threads.create({ name: `pj-${topic}`, autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek });
    store.addPanel(thread.id, userId, topic);
    await thread.send(t(userLang(userId), 'x.projIntro', { topic, userId }));
    return t(userLang(userId), 'x.projCreated', { thread });
  }
  if (a.kind === "location") {
    const g = await geocodeCity(String(arg ?? ""), userLang(userId));
    if (!g) return t(userLang(userId), 'x.geoNotFound', { arg });
    const city = `${g.name}, ${g.country_code ?? ""}`;
    store.setHomeCity(userId, city, g.latitude, g.longitude);
    await homeRefresh();
    return t(userLang(userId), 'x.geoSet', { city });
  }
  if (a.kind === "brief") {
    let b = {};
    try { b = JSON.parse(arg ?? "{}"); } catch {}
    if (b.off) { store.upsertSettings(userId, 0, "08:00", null); return t(userLang(userId), 'x.briefOff'); }
    const time = String(b.time ?? "").trim();
    if (!/^\d{1,2}:\d{2}$/.test(time)) return t(userLang(userId), 'x.briefBadTime');
    store.upsertSettings(userId, 1, time, channel?.id ?? null);
    return t(userLang(userId), 'x.briefSet', { time });
  }
  if (a.kind === "model") {
    let m = {};
    try { m = JSON.parse(arg ?? "{}"); } catch { m = { model: arg }; }
    if (m.model) store.setModel(userId, String(m.model).slice(0, 100));
    if (m.effort) store.setEffort(userId, m.effort === "default" ? null : String(m.effort));
    if (m.model || m.effort) await invalidateUserAgents(userId);
    const s = store.getSettings(userId) ?? {};
    return t(userLang(userId), 'x.modelSet', { model: s.model ?? config.llm.model, effort: s.effort ?? 'default' });
  }
  if (a.kind === "connect") {
    const key = providerKey(arg ?? a.label);
    const p = PROVIDERS[key];
    if (!p) return t(userLang(userId), 'x.svcUnsupported', { list: Object.keys(PROVIDERS).join('/') });
    if (!p.configured()) return t(userLang(userId), 'x.svcNotConfigured', { name: p.name });
    if (p.connected(userId)) return t(userLang(userId), 'x.svcAlready', { name: p.name });
    if (key === 'google') {
      const state = randomBytes(8).toString('hex');
      connectStates.set(state, { userId, provider: 'google', expires: Date.now() + 10 * 60_000 });
      const url = google.authUrl(state);
      return {
        content: t(userLang(userId), 'x.connectGoogle', { name: p.name, url }),
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('concode:google').setLabel(t(userLang(userId), 'x.connectCode')).setEmoji('🔑').setStyle(ButtonStyle.Primary),
        )],
      };
    }
    if (key === 'm365') {
      const flow = await m365.startDeviceFlow();
      const msg = t(userLang(userId), 'x.connectM365', { name: p.name, message: flow.message ?? '', uri: flow.verification_uri ?? 'https://microsoft.com/devicelogin', code: flow.user_code });
      m365.pollDeviceFlow(userId, flow, channel)
        .then(res => channel?.send(res ? t(userLang(userId), 'x.connected', { name: p.name, email: res.email || '' }) : t(userLang(userId), 'x.connectTimeout', { name: p.name })).catch(() => {}))
        .catch(() => {});
      return msg;
    }
    return t(userLang(userId), 'x.connectBadFlow');
  }
  if (a.kind === "disconnect") {
    const key = providerKey(arg ?? a.label);
    const p = PROVIDERS[key];
    if (!p) return t(userLang(userId), 'x.svcUnsupported', { list: Object.keys(PROVIDERS).join('/') });
    p.disconnect(userId);
    return t(userLang(userId), 'x.disconnected', { name: p.name });
  }
  if (a.kind === "service") {
    return await runOp(userId, String(arg ?? a.label ?? ''));
  }
  return t(userLang(userId), 'act.unsupported');
}

function providerKey(v) {
  const s = String(v ?? '').toLowerCase();
  if (/google|gmail|workspace|カレンダ|グーグル/.test(s)) return 'google';
  if (/m365|microsoft|outlook|office|マイクロソフト/.test(s)) return 'm365';
  return s.replace(/[^a-z0-9]/g, '');
}

// execAction の結果を reply/editReply/followUp/send 可能な形に正規化
function asReply(result, ephemeral = false) {
  const base = { ...(typeof result === 'object' && result !== null ? result : { content: result ?? '完了' }) };
  if (ephemeral) base.flags = MessageFlags.Ephemeral;
  return base;
}

async function runAction(interaction, action) {
  if (['computer', 'specialty_run'].includes(action?.kind)) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const result = await execAction({ userId: interaction.user.id, channel: interaction.channel, action, scope: 'u:' + interaction.user.id });
  if (interaction.deferred) return interaction.editReply(asReply(result));
  return interaction.reply(asReply(result, true));
}

// ---------- command handlers ----------

function webState(userId) {
  const settings = store.getSettings(userId) ?? {};
  return {
    history: store.recentHistory('web:' + userId, 30),
    cards: store.listHomeCards(userId).map(({ id, title, prompt, emoji, color, buttons }) => ({ id, title, prompt, emoji, color, buttons: buttons ? JSON.parse(buttons) : [] })),
    reminders: store.listReminders(userId),
    memories: store.listMemories(userId).slice(0, 8),
    projects: store.listPanels(userId),
    specialties: store.listSpecialties(userId).slice(0, 8),
    events: webEvents.get(userId) ?? [],
    computerRunning: computerRunning(userId),
    steps: computerMaxSteps(userId),
    name: client.users.cache.get(userId)?.displayName || 'You',
    city: settings.home_city ?? null,
  };
}

async function webChannel(userId, kind) {
  if (kind === 'project' && config.guildId) {
    const id = store.getProjectChannel(config.guildId);
    if (id) return client.channels.fetch(id);
  }
  return (await client.users.fetch(userId)).createDM();
}

function webResult(result) {
  return typeof result === 'string' ? result : String(result?.content ?? '完了');
}

async function webExecute(userId, action) {
  const channel = await webChannel(userId, action.kind);
  return webResult(await execAction({ userId, channel, action, scope: 'web:' + userId }));
}

async function webChat(userId, text) {
  noteAutoLang(userId, text);
  const result = await chatDsh(userId, 'web:' + userId, text);
  const buttons = [];
  const events = [];
  for (const action of result.actions ?? []) {
    if (action?.auto === true || action?.kind === 'computer') {
      try { events.push(await webExecute(userId, action)); }
      catch (err) { events.push('⚠️ ' + err.message); }
    } else if (action?.kind && action?.label) {
      buttons.push({ id: store.addAction(userId, action), label: String(action.label).slice(0, 80) });
    }
  }
  return { reply: result.reply, buttons, events };
}

async function webAction(userId, id) {
  const saved = store.getAction(id);
  if (!saved || saved.userId !== userId) return { error: 'Action unavailable' };
  const message = await webExecute(userId, saved.payload);
  store.delAction(id);
  webNotice(userId, message);
  return { message };
}

async function webPanel(userId, id) {
  const card = store.listHomeCards(userId).find(item => item.id === id);
  if (!card) return { error: 'Panel unavailable' };
  const result = await customCard(userId, card);
  return { content: result?.embed?.toJSON().description ?? 'Could not update this panel.' };
}

const handlers = {
  async web(i) {
    const lang = userLang(i.user.id);
    if (!webUi) return i.reply({ content: t(lang, 'web.unavailable'), flags: MessageFlags.Ephemeral });
    return i.reply({ content: t(lang, 'web.link', { url: webUi.issueLink(i.user.id) }), flags: MessageFlags.Ephemeral });
  },
  async steps(i) {
    const count = i.options.getInteger('count');
    if (count !== null) store.setComputerMaxSteps(i.user.id, count);
    const current = computerMaxSteps(i.user.id);
    const lang = userLang(i.user.id);
    return i.reply({
      content: t(lang, count === null ? 'steps.current' : 'steps.set', {
        count: current === 0 ? t(lang, 'steps.unlimited') : String(current),
      }),
      flags: MessageFlags.Ephemeral,
    });
  },
  async language(i) {
    const value = i.options.getString('code')?.trim();
    if (value) {
      const tag = value.toLowerCase() === 'auto' ? null : languageTag(value);
      if (!tag && value.toLowerCase() !== 'auto') return i.reply({ content: t(userLang(i.user.id, { locale: i.locale }), 'generic.languageTag'), flags: MessageFlags.Ephemeral });
      store.setLang(i.user.id, tag);
      if (!tag) noteLocale(i.user.id, i.locale);
      await invalidateUserAgents(i.user.id);
    }
    const lang = userLang(i.user.id, { locale: i.locale });
    const tag = store.getSettings(i.user.id)?.lang;
    return i.reply({ content: t(lang, value ? (tag ? 'lang.done' : 'lang.auto') : 'lang.current', { name: LANG_NAMES[tag || lang] || tag }), flags: MessageFlags.Ephemeral });
  },
  async model(i) {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    await i.editReply(await modelPanel(i.user.id));
  },

  async reset(i) {
    if (!resetAllowed(i)) return i.reply({ content: t(userLang(i.user.id), 'reset.denied'), flags: MessageFlags.Ephemeral });
    if (computerIsBusy()) return i.reply({ content: t(userLang(i.user.id), 'reset.busy'), flags: MessageFlags.Ephemeral });
    const { category, channels, threads } = await resetTargets(i.guild);
    pendingResets.set(i.guildId, { userId: i.user.id, expires: Date.now() + 2 * 60_000 });
    const targets = category ? t(userLang(i.user.id), 'reset.targets', { name: category.name, count: channels.length }) : t(userLang(i.user.id), 'reset.noCategory');
    return i.reply({
      content: t(userLang(i.user.id), 'reset.confirm', { targets, threads: threads.length }),
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('reset_confirm:' + i.guildId).setLabel(t(userLang(i.user.id), 'reset.go')).setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('reset_cancel:' + i.guildId).setLabel(t(userLang(i.user.id), 'reset.cancel')).setStyle(ButtonStyle.Secondary),
      )],
      flags: MessageFlags.Ephemeral,
    });
  },

  async start(i) {
    if (!i.guildId) return i.reply({ content: t(userLang(i.user.id), 'generic.inGuild'), flags: MessageFlags.Ephemeral });
    if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return i.reply({ content: t(userLang(i.user.id), 'generic.manageGuild'), flags: MessageFlags.Ephemeral });
    }
    await i.deferReply();
    try {
      const botMember = i.guild.members.me ?? await i.guild.members.fetchMe();
      if (!botMember.permissions.has(PermissionFlagsBits.ManageChannels)) {
        return i.editReply(t(userLang(i.user.id), 'start.needManageChannels'));
      }
      const categoryId = store.getManagedCategory(i.guildId);
      let cat = categoryId ? await i.guild.channels.fetch(categoryId).catch(() => null) : null;
      if (!cat || cat.type !== ChannelType.GuildCategory) {
        cat = await i.guild.channels.create({ name: 'Harklet', type: ChannelType.GuildCategory });
        store.setManagedCategory(i.guildId, cat.id);
      }
      const children = await i.guild.channels.fetch();
      const ensureChannel = async name => children.find(ch => ch?.parentId === cat.id && ch.type === ChannelType.GuildText && ch.name === name)
        ?? i.guild.channels.create({ name, type: ChannelType.GuildText, parent: cat.id });
      const main = await ensureChannel('chat');
      const homeCh = await ensureChannel('home');
      const projCh = await ensureChannel('projects');
      store.setMain(i.guildId, main.id, i.user.id);
      store.setProjectChannel(i.guildId, projCh.id);
      const previousHome = store.homeTargets().find(h => h.user_id === i.user.id && h.home_channel_id === homeCh.id);
      if (!previousHome) {
        const m = await homeCh.send(await homePayload(i.user.id, actionRows));
        store.setHome(i.user.id, homeCh.id, m.id);
      }
      if (projCh.lastMessageId == null) await projCh.send({
        content: t(userLang(i.user.id), 'start.projBody'),
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('proj_new').setLabel(t(userLang(i.user.id), 'start.projNew')).setEmoji('➕').setStyle(ButtonStyle.Primary),
        )],
      });
      return i.editReply(t(userLang(i.user.id), 'start.done', { main: main.id, home: homeCh.id, proj: projCh.id }));
    } catch (e) {
      return i.editReply(t(userLang(i.user.id), 'start.fail', { msg: e.message }));
    }
  },

  async main(i) {
    const sub = i.options.getSubcommand();
    if (!i.guildId) return i.reply({ content: t(userLang(i.user.id), 'generic.inGuild'), flags: MessageFlags.Ephemeral });
    if (sub === 'set') {
      if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return i.reply({ content: t(userLang(i.user.id), 'generic.manageGuild'), flags: MessageFlags.Ephemeral });
      }
      const main = i.options.getChannel('channel') ?? i.channel;
      if (main?.type !== ChannelType.GuildText) return i.reply({ content: t(userLang(i.user.id), 'main.needText'), flags: MessageFlags.Ephemeral });
      const botMember = i.guild.members.me ?? await i.guild.members.fetchMe();
      const botPermissions = main.permissionsFor(botMember);
      if (!botPermissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory])) {
        return i.reply({ content: t(userLang(i.user.id), 'main.needPerms'), flags: MessageFlags.Ephemeral });
      }
      store.setMain(i.guildId, main.id, i.user.id);
      return i.reply({ content: t(userLang(i.user.id), 'main.setDone', { id: main.id }) });
    }
    if (sub === 'off') {
      if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return i.reply({ content: t(userLang(i.user.id), 'generic.manageGuild'), flags: MessageFlags.Ephemeral });
      }
      store.clearMain(i.guildId);
      return i.reply({ content: t(userLang(i.user.id), 'main.offDone') });
    }
    const ch = store.getMain(i.guildId);
    const pj = store.getProjectChannel(i.guildId);
    const parts = [t(userLang(i.user.id), 'main.show', { main: ch ? `<#${ch}>` : t(userLang(i.user.id), 'main.unset'), proj: pj ? `<#${pj}>` : t(userLang(i.user.id), 'main.unset') })];
    return i.reply({ content: parts.join(' / '), flags: MessageFlags.Ephemeral });
  },

  async memory(i) {
    const sub = i.options.getSubcommand();
    if (sub === 'list') {
      const ms = store.listMemories(i.user.id);
      const body = ms.length
        ? ms.map(m => `#${m.id} ${m.content}`).join('\n')
        : t(userLang(i.user.id), 'mem.none');
      return i.reply({ content: body.slice(0, 1900), flags: MessageFlags.Ephemeral });
    }
    if (sub === 'forget') {
      const ok = store.deleteMemory(i.user.id, i.options.getInteger('id', true));
      return i.reply({ content: ok ? t(userLang(i.user.id), 'mem.deleted') : t(userLang(i.user.id), 'mem.notFound'), flags: MessageFlags.Ephemeral });
    }
    if (sub === 'clear') {
      for (const m of store.listMemories(i.user.id)) store.deleteMemory(i.user.id, m.id);
      return i.reply({ content: t(userLang(i.user.id), 'mem.cleared'), flags: MessageFlags.Ephemeral });
    }
  },

  async service(i) {
    const sub = i.options.getSubcommand();
    if (sub === 'list') {
      const lines = providerStatus(i.user.id);
      const txt = lines.length ? t(userLang(i.user.id), 'svc.status') + '\n' + lines.map(l => '- ' + l).join('\n')
        : t(userLang(i.user.id), 'svc.none');
      return i.reply({ content: txt, flags: MessageFlags.Ephemeral });
    }
    const provider = i.options.getString('provider', true);
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const kind = sub === 'connect' ? 'connect' : 'disconnect';
    const r = await execAction({ userId: i.user.id, channel: i.channel, action: { kind, arg: provider }, scope: 'u:' + i.user.id })
      .catch(e => '⚠️ ' + e.message);
    await i.editReply(asReply(r));
  },

};

// ---------- schedulers ----------

async function deliverReminders() {
  for (const r of store.dueReminders(Date.now())) {
    try {
      const msg = t(userLang(r.user_id), 'sched.reminder', { userId: r.user_id, text: r.text });
      if (r.channel_id) {
        const ch = await client.channels.fetch(r.channel_id).catch(() => null);
        if (ch?.isSendable()) { await ch.send(msg); store.markDelivered(r.id); continue; }
      }
      const user = await client.users.fetch(r.user_id);
      await user.send(msg);
      store.markDelivered(r.id);
    } catch (e) {
      console.error(`reminder #${r.id} failed:`, e.message);
      store.bumpReminderAttempt(r.id);
      if ((r.attempts ?? 0) + 1 >= 5) store.markDelivered(r.id); // 5回失敗したら諦める
    }
  }
}

async function buildBrief(userId) {
  const rs = store.listReminders(userId);
  const lines = rs.slice(0, 10).map(r => `- ${r.text} (${fmtTs(r.due_at)})`);
  const prompt = `今日のモーニングブリーフを書いて。ユーザーの予定・記憶を踏まえて短く励ます一文と、今日のリマインダー一覧(あれば)を含める。リマインダー: ${rs.length ? rs.map(r => `${r.text}@${new Date(r.due_at).toISOString()}`).join(', ') : 'なし'}`;
  const scope = `brief:${userId}`;
  const result = await chatDsh(userId, scope, prompt).catch(e => ({ reply: t(userLang(userId), 'sched.briefFail', { msg: e.message }) }));
  return result.reply + (lines.length ? '\n\n' + t(userLang(userId), 'sched.briefToday') + '\n' + lines.join('\n') : '');
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

let specialtySuggestionsRunning = false;
async function sendDueSpecialties() {
  if (specialtySuggestionsRunning) return;
  specialtySuggestionsRunning = true;
  try {
    for (const specialty of store.dueSpecialties()) {
      try {
        const user = await client.users.fetch(specialty.user_id);
        await user.send({
          content: t(userLang(specialty.user_id), 'sched.specDue', { name: specialty.name }),
          components: actionRows(specialty.user_id, [{ kind: 'specialty_run', arg: String(specialty.id), label: t(userLang(specialty.user_id), 'sched.specRun') }]),
        });
        store.markSpecialtySuggested(specialty.user_id, specialty.id);
      } catch (err) { console.warn('specialty suggestion unavailable:', err.message); }
    }
  } finally { specialtySuggestionsRunning = false; }
}

// ---------- events ----------

async function sendAgentReply(message, scope, text = message.content) {
  noteAutoLang(message.author.id, message.content);
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
      if (r) await message.reply(asReply(r)).catch(() => {});
    }
  } catch (e) {
    await message.reply(t(userLang(message.author.id), 'generic.error', { msg: e.message })).catch(() => {});
  } finally {
    clearInterval(typing);
  }
}
function attachEvents(client) {

client.on('interactionCreate', async (interaction) => {
  noteLocale(interaction.user.id, interaction.locale);
  if (await handleComputerInteraction(interaction)) return;
  try {
    if (interaction.isChatInputCommand()) {
      const h = handlers[interaction.commandName];
      if (h) await h(interaction);
    } else if (interaction.isButton() && /^reset_(confirm|cancel):/.test(interaction.customId)) {
      if (!resetAllowed(interaction)) return interaction.reply({ content: t(userLang(interaction.user.id), 'reset.adminOnly'), flags: MessageFlags.Ephemeral });
      const [kind, guildId] = interaction.customId.split(':');
      const pending = pendingResets.get(guildId);
      if (!pending || pending.userId !== interaction.user.id || pending.expires < Date.now()) {
        return interaction.reply({ content: t(userLang(interaction.user.id), 'reset.expired'), flags: MessageFlags.Ephemeral });
      }
      pendingResets.delete(guildId);
      if (kind === 'reset_cancel') return interaction.update({ content: t(userLang(interaction.user.id), 'reset.cancelled'), components: [] });
      if (resettingGuilds.has(guildId)) return interaction.reply({ content: t(userLang(interaction.user.id), 'reset.running'), flags: MessageFlags.Ephemeral });
      resettingGuilds.add(guildId);
      await interaction.update({ content: t(userLang(interaction.user.id), 'reset.deleting'), components: [] });
      try {
        const result = await performReset(interaction);
        await interaction.editReply({ content: result }).catch(() => interaction.user.send(result).catch(() => {}));
      } finally { resettingGuilds.delete(guildId); }
    } else if (interaction.isButton() && interaction.customId.startsWith('act:')) {
      const a = store.getAction(Number(interaction.customId.slice(4)));
      if (!a) return interaction.reply({ content: t(userLang(interaction.user.id), 'act.expired'), flags: MessageFlags.Ephemeral });
      if (a.userId !== interaction.user.id) return interaction.reply({ content: t(userLang(interaction.user.id), 'act.notYours'), flags: MessageFlags.Ephemeral });
      await runAction(interaction, a.payload);
      store.delAction(Number(interaction.customId.slice(4)));
    } else if (interaction.isButton() && interaction.customId === 'model_custom') {
      const modal = new ModalBuilder().setCustomId('model_modal').setTitle(t(userLang(interaction.user.id), 'modal.modelTitle'));
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('model_name')
          .setLabel(t(userLang(interaction.user.id), 'modal.modelLabel'))
          .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100),
      ));
      await interaction.showModal(modal);
    } else if (interaction.isButton() && interaction.customId === 'model_search') {
      const modal = new ModalBuilder().setCustomId('model_search_modal').setTitle(t(userLang(interaction.user.id), 'modal.searchTitle'));
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('model_query').setLabel(t(userLang(interaction.user.id), 'modal.searchLabel'))
          .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(100)
          .setValue(modelQueries.get(interaction.user.id) ?? ''),
      ));
      await interaction.showModal(modal);
    } else if (interaction.isButton() && ['model_prev', 'model_next'].includes(interaction.customId)) {
      const uid = interaction.user.id;
      modelPages.set(uid, Math.max(0, (modelPages.get(uid) ?? 0) + (interaction.customId === 'model_next' ? 1 : -1)));
      await interaction.deferUpdate();
      await interaction.editReply(await modelPanel(uid));
    } else if (interaction.isButton() && interaction.customId === 'model_apply') {
      const uid = interaction.user.id;
      await interaction.deferUpdate();
      const m = pendingModelSel.get(uid);
      const e = pendingEffortSel.get(uid);
      if (m) store.setModel(uid, m);
      if (e) store.setEffort(uid, e === 'default' ? null : e);
      pendingModelSel.delete(uid);
      pendingEffortSel.delete(uid);
      if (m || e) await invalidateUserAgents(uid);
      await interaction.editReply(await modelPanel(uid));
    } else if (interaction.isButton() && interaction.customId === 'model_reset') {
      const uid = interaction.user.id;
      await interaction.deferUpdate();
      pendingModelSel.delete(uid);
      pendingEffortSel.delete(uid);
      modelPages.delete(uid);
      modelQueries.delete(uid);
      store.setModel(uid, null);
      store.setEffort(uid, null);
      await invalidateUserAgents(uid);
      await interaction.editReply(await modelPanel(uid));
    } else if (interaction.isButton() && interaction.customId === 'home_refresh') {
      await interaction.deferUpdate();
      try { await interaction.message.edit(await homePayload(interaction.user.id, actionRows)); } catch {}
    } else if (interaction.isButton() && interaction.customId === 'proj_new') {
      const modal = new ModalBuilder().setCustomId('proj_modal').setTitle(t(userLang(interaction.user.id), 'home.newProj'));
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('proj_topic')
          .setLabel(t(userLang(interaction.user.id), 'modal.projLabel'))
          .setStyle(TextInputStyle.Short).setRequired(true),
      ));
      await interaction.showModal(modal);
    } else if (interaction.isButton() && interaction.customId === 'concode:google') {
      const modal = new ModalBuilder().setCustomId('conmodal:google').setTitle(t(userLang(interaction.user.id), 'modal.googleTitle'));
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('auth_input')
          .setLabel(t(userLang(interaction.user.id), 'modal.googleLabel'))
          .setStyle(TextInputStyle.Short).setRequired(true)
          .setPlaceholder('http://127.0.0.1/?code=...&state=...'),
      ));
      await interaction.showModal(modal);
    } else if (interaction.isButton() && interaction.customId.startsWith('hcbtn:')) {
      const [, cardId, idx] = interaction.customId.split(':');
      const card = store.getHomeCard(Number(cardId));
      if (!card || card.user_id !== interaction.user.id) {
        return interaction.reply({ content: t(userLang(interaction.user.id), 'card.notFound'), flags: MessageFlags.Ephemeral });
      }
      let btns = [];
      try { btns = JSON.parse(card.buttons ?? '[]'); } catch {}
      const btn = btns[Number(idx)];
      if (!btn?.prompt) {
        return interaction.reply({ content: t(userLang(interaction.user.id), 'btn.dead'), flags: MessageFlags.Ephemeral });
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const result = await chatDsh(interaction.user.id, 'cardbtn:' + cardId, btn.prompt);
        const all = Array.isArray(result.actions) ? result.actions : [];
        const autos = all.filter(a => a?.auto === true);
        await interaction.editReply({
          content: result.reply.slice(0, 1900),
          components: actionRows(interaction.user.id, all.filter(a => a?.auto !== true)),
        });
        for (const a of autos) {
          const r = await execAction({ userId: interaction.user.id, channel: interaction.channel, action: a, scope: 'cardbtn:' + cardId }).catch(e => '⚠️ ' + e.message);
          if (r) await interaction.followUp(asReply(r, true)).catch(() => {});
        }
      } catch (e) {
        await interaction.editReply(t(userLang(interaction.user.id), 'generic.error', { msg: e.message })).catch(() => {});
      }
   } else if (interaction.isButton() && interaction.customId === 'home_region') {
      const modal = new ModalBuilder().setCustomId('home_region_modal').setTitle(t(userLang(interaction.user.id), 'modal.regionTitle'));
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('region_city')
          .setLabel(t(userLang(interaction.user.id), 'modal.regionLabel'))
          .setStyle(TextInputStyle.Short).setRequired(true),
      ));
      await interaction.showModal(modal);
    } else if (interaction.isButton() && interaction.customId === 'home_newproj') {
      const modal = new ModalBuilder().setCustomId('home_proj_modal').setTitle(t(userLang(interaction.user.id), 'home.newProj'));
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('proj_topic')
          .setLabel(t(userLang(interaction.user.id), 'modal.projLabel'))
          .setStyle(TextInputStyle.Short).setRequired(true),
      ));
      await interaction.showModal(modal);
    } else if (interaction.isModalSubmit() && interaction.customId === 'conmodal:google') {
      const input = interaction.fields.getTextInputValue('auth_input').trim();
      const { code, state } = google.parseAuthInput(input);
      let st = connectStates.get(state ?? '');
      let stKey = state;
      // URL全体を貼らずコードだけの場合: このユーザーの進行中Google接続stateにフォールバック
      if (!st && !state) {
        const found = [...connectStates.entries()].find(([, v]) => v.userId === interaction.user.id && v.provider === 'google' && v.expires > Date.now());
        if (found) { stKey = found[0]; st = found[1]; }
      }
      if (st && (st.userId !== interaction.user.id || st.expires < Date.now())) st = null;
      if (stKey) connectStates.delete(stKey);
      if (!st && state) {
        return interaction.reply({ content: t(userLang(interaction.user.id), 'x.oauthExpired'), flags: MessageFlags.Ephemeral });
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const email = await google.exchangeCode(interaction.user.id, code);
        await interaction.editReply(t(userLang(interaction.user.id), 'x.connected', { name: 'Google Workspace', email: email || '' }));
        const st2 = store.getSettings(interaction.user.id);
        if (st2?.home_message_id) {
          try {
            const ch = await client.channels.fetch(st2.home_channel_id);
            const m = await ch.messages.fetch(st2.home_message_id);
            await m.edit(await homePayload(interaction.user.id, actionRows));
          } catch {}
        }
      } catch (e) {
        await interaction.editReply('⚠️ 接続失敗: ' + e.message).catch(() => {});
      }
   } else if (interaction.isModalSubmit() && interaction.customId === 'model_search_modal') {
      const uid = interaction.user.id;
      const query = interaction.fields.getTextInputValue('model_query').trim();
      if (query) modelQueries.set(uid, query);
      else modelQueries.delete(uid);
      modelPages.set(uid, 0);
      await interaction.deferUpdate();
      await interaction.editReply(await modelPanel(uid));
   } else if (interaction.isModalSubmit() && interaction.customId === 'model_modal') {
      const name = interaction.fields.getTextInputValue('model_name').trim();
      pendingModelSel.set(interaction.user.id, name);
      await interaction.deferUpdate();
      await interaction.editReply(await modelPanel(interaction.user.id));
    } else if (interaction.isModalSubmit() && interaction.customId === 'proj_modal') {
      const topic = interaction.fields.getTextInputValue('proj_topic').trim();
      const ch = interaction.channel;
      if (!ch || ch.type !== ChannelType.GuildText) {
        return interaction.reply({ content: t(userLang(interaction.user.id), 'proj.needGuildText'), flags: MessageFlags.Ephemeral });
      }
      const thread = await ch.threads.create({ name: `pj-${topic.slice(0, 90)}`, autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek });
      store.addPanel(thread.id, interaction.user.id, topic);
      await thread.send(t(userLang(interaction.user.id), 'x.projIntro', { topic, userId: interaction.user.id }));
      await interaction.reply({ content: t(userLang(interaction.user.id), 'x.projCreated', { thread }), flags: MessageFlags.Ephemeral });
    } else if (interaction.isModalSubmit() && interaction.customId === 'home_region_modal') {
      const name = interaction.fields.getTextInputValue('region_city').trim();
      await interaction.deferUpdate();
      const p = await geocodeCity(name, userLang(interaction.user.id));
      if (!p) {
        await interaction.followUp({ content: t(userLang(interaction.user.id), 'geo.retry', { name }), flags: MessageFlags.Ephemeral });
      } else {
        const city = `${p.name}, ${p.country_code ?? ''}`;
        store.setHomeCity(interaction.user.id, city, p.latitude, p.longitude);
        await interaction.followUp({ content: t(userLang(interaction.user.id), 'x.geoSet', { city }), flags: MessageFlags.Ephemeral });
      }
      try { await interaction.message.edit(await homePayload(interaction.user.id, actionRows)); } catch {}
    } else if (interaction.isModalSubmit() && interaction.customId === 'home_proj_modal') {
      const topic = interaction.fields.getTextInputValue('proj_topic').trim();
      const base = interaction.message;
      if (!base?.channel || base.channel.type !== ChannelType.GuildText) {
        return interaction.reply({ content: t(userLang(interaction.user.id), 'proj.fromHome'), flags: MessageFlags.Ephemeral });
      }
      const thread = await base.startThread({ name: `pj-${topic.slice(0, 90)}`, autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek });
      store.addPanel(thread.id, interaction.user.id, topic);
      await thread.send(t(userLang(interaction.user.id), 'x.projIntro', { topic, userId: interaction.user.id }));
      await interaction.reply({ content: t(userLang(interaction.user.id), 'x.projCreated', { thread }), flags: MessageFlags.Ephemeral });
    } else if (interaction.isStringSelectMenu()) {
      await interaction.deferUpdate();
      if (interaction.customId === 'model_sel') {
        pendingModelSel.set(interaction.user.id, interaction.values[0]);
      } else if (interaction.customId === 'effort_sel') {
        pendingEffortSel.set(interaction.user.id, interaction.values[0]);
      }
      await interaction.editReply(await modelPanel(interaction.user.id));
    }
  } catch (e) {
    console.error(e);
    const msg = { content: t(userLang(interaction.user.id), 'generic.error', { msg: e.message }), flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) await interaction.followUp(msg).catch(() => {});
    else await interaction.reply(msg).catch(() => {});
  }
});

client.on('messageCreate', async (message) => {
  if (message.guildId && resettingGuilds.has(message.guildId)) return;
  if (!message.content.trim()) return;
 if (message.author.bot) return;

  // Homeメッセージへの返信 = パネル(Home/カード)の会話的編集
  const refId = message.reference?.messageId;
  if (refId) {
    const homeTarget = store.homeTargets().find(t => t.home_message_id === refId);
    if (homeTarget) {
      if (message.author.id !== homeTarget.user_id) return;
      const text = '[この返信はHome画面(パネル)への編集要求です。home_card_upd で既存カード更新、home_card で新規カード追加、home_card_del で削除してください。auto: true で即実行されます]\n' + message.content;
      await sendAgentReply(message, 'homeedit:' + homeTarget.user_id, text);
      return;
    }
  }

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
  const port = Number(process.env.HARKLET_WEB_PORT || 8787);
  if (Number.isInteger(port) && port >= 1 && port <= 65535) {
    void startWebUi({ state: webState, chat: webChat, action: webAction, panel: webPanel, port })
      .then(server => { webUi = server; console.log(`[web] http://127.0.0.1:${server.port}`); })
      .catch(err => console.error('[web] could not start:', err.message));
  }
  setInterval(deliverReminders, 15_000).unref();
  setInterval(sendBriefs, 30_000).unref();
  setInterval(refreshHomes, 1_800_000).unref();
  void sendDueSpecialties();
  setInterval(sendDueSpecialties, 3_600_000).unref();
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

export { handlers, modelPanel, execAction };
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await login(true);
