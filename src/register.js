import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import { config } from './config.js';

const commands = [
  new SlashCommandBuilder().setName('ping').setDescription('生存確認'),
  new SlashCommandBuilder().setName('ask')
    .setDescription('Harkletに質問・相談する')
    .addStringOption(o => o.setName('question').setDescription('質問や相談').setRequired(true))
    .addBooleanOption(o => o.setName('private').setDescription('自分だけに表示')),
  new SlashCommandBuilder().setName('remember')
    .setDescription('事実を長期記憶に保存')
    .addStringOption(o => o.setName('text').setDescription('覚えてほしいこと').setRequired(true)),
  new SlashCommandBuilder().setName('memory')
    .setDescription('長期記憶の管理')
    .addSubcommand(s => s.setName('list').setDescription('記憶の一覧'))
    .addSubcommand(s => s.setName('forget').setDescription('記憶を削除')
      .addIntegerOption(o => o.setName('id').setDescription('削除する記憶のID').setRequired(true)))
    .addSubcommand(s => s.setName('clear').setDescription('全記憶を削除')),
  new SlashCommandBuilder().setName('remind')
    .setDescription('リマインダー')
    .addSubcommand(s => s.setName('add').setDescription('リマインダー追加')
      .addStringOption(o => o.setName('when').setDescription('例: 10分後 / 明日9時 / 18:30 / 2026-10-09 09:00').setRequired(true))
      .addStringOption(o => o.setName('text').setDescription('内容').setRequired(true)))
    .addSubcommand(s => s.setName('list').setDescription('一覧'))
    .addSubcommand(s => s.setName('cancel').setDescription('キャンセル')
      .addIntegerOption(o => o.setName('id').setDescription('リマインダーID').setRequired(true))),
  new SlashCommandBuilder().setName('panel')
    .setDescription('会話パネル(スレッド)を作成')
    .addStringOption(o => o.setName('topic').setDescription('トピック').setRequired(true)),
  new SlashCommandBuilder().setName('brief')
    .setDescription('モーニングブリーフ')
    .addSubcommand(s => s.setName('on').setDescription('毎日送信を有効化')
      .addStringOption(o => o.setName('time').setDescription('HH:MM (デフォルト 08:00)'))
      .addChannelOption(o => o.setName('channel').setDescription('送信先チャンネル')))
    .addSubcommand(s => s.setName('off').setDescription('停止'))
    .addSubcommand(s => s.setName('now').setDescription('今すぐ試す')),
].map(c => c.toJSON());

const rest = new REST().setToken(config.discordToken);
const route = config.guildId
  ? Routes.applicationGuildCommands(config.clientId, config.guildId)
  : Routes.applicationCommands(config.clientId);

await rest.put(route, { body: commands });
console.log(`Registered ${commands.length} commands ${config.guildId ? `to guild ${config.guildId}` : 'globally'}`);

