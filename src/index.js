import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Client,
  GatewayIntentBits, ThreadAutoArchiveDuration,
} from 'discord.js';
import { config } from './config.js';
import { store } from './db.js';
import { chat } from './llm.js';
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
      return interaction.reply({ content: '日時を解釈できませんでした。/remind で直接指定してください。', ephemeral: true });
    }
    const id = store.addReminder(userId, interaction.channelId, action.label, due);
    return interaction.reply({ content: `⏰ リマインダー #${id}: 「${action.label}」→ ${fmtTs(due)}`, ephemeral: true });
  }
  if (action.kind === 'memory') {
    store.addMemory(userId, String(action.arg ?? action.label));
    return interaction.reply({ content: `🧠 記憶しました: ${action.arg ?? action.label}`, ephemeral: true });
  }
  return interaction.reply({ content: '未対応のアクションです。', ephemeral: true });
}

async function answer(interaction) {
  const question = interaction.options.getString('question', true);
  const ephemeral = interaction.options.getBoolean('private') ?? false;
  await interaction.deferReply({ ephemeral });
  try {
    const scope = `u:${interaction.user.id}`;
    const result = await chat(interaction.user.id, scope, question);
    await interaction.editReply({
      content: result.reply,
      components: actionRows(interaction.user.id, result.actions),
    });
  } catch (e) {
    await interaction.editReply(`⚠️ エラー: ${e.message}`);
  }
}

// ---------- command handlers ----------

const handlers = {
  async ping(i) {
    await i.reply({ content: `🏓 pong — ${client.ws.ping}ms`, ephemeral: true });
  },

  ask: (i) => answer(i),

  async remember(i) {
    const text = i.options.getString('text', true);
    store.addMemory(i.user.id, text);
    await i.reply({ content: `🧠 記憶しました: ${text}`, ephemeral: true });
  },

  async memory(i) {
    const sub = i.options.getSubcommand();
    if (sub === 'list') {
      const ms = store.listMemories(i.user.id);
      const body = ms.length
        ? ms.map(m => `#${m.id} ${m.content}`).join('\n')
        : 'まだ記憶はありません。`/remember` か会話から自動で貯まります。';
      return i.reply({ content: body.slice(0, 1900), ephemeral: true });
    }
    if (sub === 'forget') {
      const ok = store.deleteMemory(i.user.id, i.options.getInteger('id', true));
      return i.reply({ content: ok ? '🗑️ 削除しました。' : 'そのIDの記憶は見つかりません。', ephemeral: true });
    }
    if (sub === 'clear') {
      for (const m of store.listMemories(i.user.id)) store.deleteMemory(i.user.id, m.id);
      return i.reply({ content: '🗑️ すべての記憶を削除しました。', ephemeral: true });
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
          ephemeral: true,
        });
      }
      const id = store.addReminder(i.user.id, i.channelId, text, due);
      return i.reply({ content: `⏰ リマインダー #${id}: 「${text}」→ ${fmtTs(due)}`, ephemeral: true });
    }
    if (sub === 'list') {
      const rs = store.listReminders(i.user.id);
      const body = rs.length
        ? rs.map(r => `#${r.id} ${r.text} — ${fmtTs(r.due_at)}`).join('\n')
        : '予定されているリマインダーはありません。';
      return i.reply({ content: body.slice(0, 1900), ephemeral: true });
    }
    if (sub === 'cancel') {
      const ok = store.cancelReminder(i.user.id, i.options.getInteger('id', true));
      return i.reply({ content: ok ? '🗑️ キャンセルしました。' : 'そのIDのリマインダーは見つかりません。', ephemeral: true });
    }
  },

  async panel(i) {
    const topic = i.options.getString('topic', true);
    if (!i.channel || i.channel.type !== ChannelType.GuildText) {
      return i.reply({ content: 'テキストチャンネルで実行してください。', ephemeral: true });
    }
    await i.reply(`🗂️ パネルを作成します: **${topic}**\nこのスレッド内はコマンド不要でそのまま会話できます。`);
    const starter = await i.fetchReply();
    const thread = await starter.startThread({
      name: `panel-${topic.slice(0, 90)}`,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
    });
    store.addPanel(thread.id, i.user.id, topic);
    await thread.send(`📌 トピック「${topic}」のパネルです。${i.user} との会話をここに記録します。はじめの一言をどうぞ。`);
  },

  async brief(i) {
    const sub = i.options.getSubcommand();
    if (sub === 'on') {
      const time = i.options.getString('time') ?? '08:00';
      if (!/^\d{1,2}:\d{2}$/.test(time)) {
        return i.reply({ content: '時刻は HH:MM 形式で。例: 08:00', ephemeral: true });
      }
      const ch = i.options.getChannel('channel')?.id ?? i.channelId;
      store.upsertSettings(i.user.id, 1, time, ch);
      return i.reply({ content: `☀️ モーニングブリーフを毎日 ${time} に <#${ch}> へ送ります。`, ephemeral: true });
    }
    if (sub === 'off') {
      store.upsertSettings(i.user.id, 0, '08:00', null);
      return i.reply({ content: 'モーニングブリーフを停止しました。', ephemeral: true });
    }
    if (sub === 'now') {
      await i.deferReply({ ephemeral: true });
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
  const result = await chat(userId, scope, prompt).catch(e => ({ reply: `ブリーフ生成に失敗: ${e.message}` }));
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

// ---------- events ----------

function attachEvents(client) {

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const h = handlers[interaction.commandName];
      if (h) await h(interaction);
    } else if (interaction.isButton() && interaction.customId.startsWith('act:')) {
      const a = store.getAction(Number(interaction.customId.slice(4)));
      if (!a) return interaction.reply({ content: 'このアクションは期限切れです。', ephemeral: true });
      await runAction(interaction, a.payload);
      store.delAction(Number(interaction.customId.slice(4)));
    }
  } catch (e) {
    console.error(e);
    const msg = { content: `⚠️ エラー: ${e.message}`, ephemeral: true };
    if (interaction.deferred || interaction.replied) await interaction.followUp(msg).catch(() => {});
    else await interaction.reply(msg).catch(() => {});
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.channel.isThread()) return;
  const panel = store.getPanel(message.channel.id);
  if (!panel || message.author.id !== panel.user_id) return;
  if (!message.content.trim()) return;
  await message.channel.sendTyping();
  try {
    const scope = `panel:${message.channel.id}`;
    const result = await chat(message.author.id, scope, message.content);
    const rows = actionRows(message.author.id, result.actions);
    // Discordの2000字制限対策で分割
    for (let i = 0; i < result.reply.length; i += 1900) {
      const last = i + 1900 >= result.reply.length;
      await message.reply({ content: result.reply.slice(i, i + 1900), components: last ? rows : [] });
    }
  } catch (e) {
    await message.reply(`⚠️ エラー: ${e.message}`);
  }
});

client.once('clientReady', () => {
  console.log(`Harklet logged in as ${client.user.tag}`);
  setInterval(deliverReminders, 15_000).unref();
  setInterval(sendBriefs, 30_000).unref();
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
