import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import { config } from './config.js';

const commands = [
  new SlashCommandBuilder().setName('ping').setDescription('生存確認'),
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
  new SlashCommandBuilder().setName('project')
    .setDescription('プロジェクト(話題別スレッド)を作成 — チャットを分割したい時に')
    .addStringOption(o => o.setName('topic').setDescription('トピック').setRequired(true)),
  new SlashCommandBuilder().setName('panel')
    .setDescription('(互換) /project と同じ')
    .addStringOption(o => o.setName('topic').setDescription('トピック').setRequired(true)),
  new SlashCommandBuilder().setName('home')
    .setDescription('Harklet Home: 興味ある情報をカードで常駐表示(自動更新)')
    .addSubcommand(s => s.setName('open').setDescription('Homeを設置/更新'))
    .addSubcommand(s => s.setName('cards').setDescription('カスタムカードの一覧・削除'))
    .addSubcommand(s => s.setName('off').setDescription('Homeを解除(自動更新停止)')),
  new SlashCommandBuilder().setName('brief')
    .setDescription('モーニングブリーフ')
    .addSubcommand(s => s.setName('on').setDescription('毎日送信を有効化')
      .addStringOption(o => o.setName('time').setDescription('HH:MM (デフォルト 08:00)'))
      .addChannelOption(o => o.setName('channel').setDescription('送信先チャンネル')))
    .addSubcommand(s => s.setName('off').setDescription('停止'))
    .addSubcommand(s => s.setName('now').setDescription('今すぐ試す')),
  new SlashCommandBuilder().setName('computer')
    .setDescription('Agent専用ブラウザでWebの作業をする')
    .addSubcommand(s => s.setName('run').setDescription('作業を依頼する')
      .addStringOption(o => o.setName('task').setDescription('やってほしいこと').setRequired(true)))
    .addSubcommand(s => s.setName('view').setDescription('作業中の画面を見る（本人だけに表示）'))
    .addSubcommand(s => s.setName('stop').setDescription('作業を止めて画面を破棄')),
].map(c => c.toJSON());

const rest = new REST().setToken(config.discordToken);
const route = config.guildId
  ? Routes.applicationGuildCommands(config.clientId, config.guildId)
  : Routes.applicationCommands(config.clientId);

await rest.put(route, { body: commands });
console.log(`Registered ${commands.length} commands ${config.guildId ? `to guild ${config.guildId}` : 'globally'}`);
