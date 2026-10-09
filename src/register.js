import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import { config } from './config.js';

const commands = [
  new SlashCommandBuilder().setName('ask')
    .setDescription('Harkletに質問・相談する')
    .addStringOption(o => o.setName('question').setDescription('質問や相談').setRequired(true))
    .addBooleanOption(o => o.setName('private').setDescription('自分だけに表示')),
  new SlashCommandBuilder().setName('model')
    .setDescription('LLMモデル・Reasoning effortの切替（Embed+プルダウン）'),
  new SlashCommandBuilder().setName('main')
    .setDescription('メインチャンネル設定: 書き込むだけで会話できる')
    .addSubcommand(s => s.setName('set').setDescription('このチャンネル/指定chをメインに')
      .addChannelOption(o => o.setName('channel').setDescription('メインにするチャンネル')
        .addChannelTypes(0))) // GuildText
    .addSubcommand(s => s.setName('off').setDescription('解除'))
    .addSubcommand(s => s.setName('show').setDescription('現在の設定')),
  new SlashCommandBuilder().setName('memory')
    .setDescription('長期記憶の管理')
    .addSubcommand(s => s.setName('list').setDescription('記憶の一覧'))
    .addSubcommand(s => s.setName('forget').setDescription('記憶を削除')
      .addIntegerOption(o => o.setName('id').setDescription('削除する記憶のID').setRequired(true)))
    .addSubcommand(s => s.setName('clear').setDescription('全記憶を削除')),
  new SlashCommandBuilder().setName('home')
    .setDescription('Harklet Home: 興味ある情報をカードで常駐表示(自動更新)')
    .addSubcommand(s => s.setName('open').setDescription('Homeを設置/更新'))
    .addSubcommand(s => s.setName('cards').setDescription('カスタムカードの一覧・削除'))
    .addSubcommand(s => s.setName('off').setDescription('Homeを解除(自動更新停止)')),
  new SlashCommandBuilder().setName('stop')
    .setDescription('Agentのブラウザ作業を止めて画面を保存する'),
  new SlashCommandBuilder().setName('service')
    .setDescription('外部サービス接続 (Google Workspace / Microsoft 365)')
    .addSubcommand(s => s.setName('list').setDescription('接続状況の一覧'))
    .addSubcommand(s => s.setName('connect').setDescription('サービスを接続')
      .addStringOption(o => o.setName('provider').setDescription('google または m365').setRequired(true)
        .addChoices({ name: 'Google Workspace (Gmail/Calendar)', value: 'google' },
          { name: 'Microsoft 365 (Outlook/Calendar)', value: 'm365' })))
    .addSubcommand(s => s.setName('disconnect').setDescription('サービスを切断')
      .addStringOption(o => o.setName('provider').setDescription('google または m365').setRequired(true)
        .addChoices({ name: 'Google Workspace', value: 'google' },
          { name: 'Microsoft 365', value: 'm365' }))),
];

// This command clears the entire Harklet database, so expose it only in an opted-in test guild.
if (process.env.HARKLET_ENABLE_RESET === '1' && config.guildId) {
  commands.push(new SlashCommandBuilder().setName('reset')
    .setDescription('テスト用: Harkletのチャンネルと全DBデータを消去')
    .setDefaultMemberPermissions('8'));
}
const payload = commands.map(c => c.toJSON());

const rest = new REST().setToken(config.discordToken);
const route = config.guildId
  ? Routes.applicationGuildCommands(config.clientId, config.guildId)
  : Routes.applicationCommands(config.clientId);

await rest.put(route, { body: payload });
console.log(`Registered ${commands.length} commands ${config.guildId ? `to guild ${config.guildId}` : 'globally'}`);
