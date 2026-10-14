import { SlashCommandBuilder } from 'discord.js';
import { config } from './config.js';
const commands = [
  new SlashCommandBuilder().setName('language')
    .setDescription('Set response language (auto or a language tag)')
    .setDescriptionLocalizations({ ja: '応答言語を設定（auto または言語コード）', 'zh-CN': '设置回复语言（auto 或语言代码）' })
    .addStringOption(o => o.setName('code').setDescription('auto, en, ja, zh, ko, es, fr, de…')),
  new SlashCommandBuilder().setName('start')
    .setDescription("Set up Harklet chat, home and projects").setDescriptionLocalizations({"ja":"Harkletのchat/home/projectsを設置する","zh-CN":"设置Harklet聊天、主页和项目","zh-TW":"设置Harklet聊天、主页和项目"}),
  new SlashCommandBuilder().setName('model')
    .setDescription("Choose an LLM model and reasoning effort").setDescriptionLocalizations({"ja":"LLMモデル・Reasoning effortの切替（Embed+プルダウン）","zh-CN":"选择LLM模型和推理强度","zh-TW":"选择LLM模型和推理强度"}),
  new SlashCommandBuilder().setName('main')
    .setDescription("Set the main conversation channel").setDescriptionLocalizations({"ja":"会話するメインチャンネルを設定する","zh-CN":"设置主聊天频道","zh-TW":"设置主聊天频道"})
    .addSubcommand(s => s.setName('set').setDescription("Use this channel or a specified channel as main").setDescriptionLocalizations({"ja":"このチャンネル/指定チャンネルをメインに","zh-CN":"将此频道或指定频道设为主频道","zh-TW":"将此频道或指定频道设为主频道"})
      .addChannelOption(o => o.setName('channel').setDescription("Channel to use as main").setDescriptionLocalizations({"ja":"メインにするチャンネル","zh-CN":"主频道","zh-TW":"主频道"})
        .addChannelTypes(0))) // GuildText
    .addSubcommand(s => s.setName('off').setDescription("Disable").setDescriptionLocalizations({"ja":"解除","zh-CN":"解除","zh-TW":"解除"}))
    .addSubcommand(s => s.setName('show').setDescription("Show current settings").setDescriptionLocalizations({"ja":"現在の設定","zh-CN":"查看当前设置","zh-TW":"查看当前设置"})),
  new SlashCommandBuilder().setName('memory')
    .setDescription("Manage long-term memories").setDescriptionLocalizations({"ja":"長期記憶の管理","zh-CN":"管理长期记忆","zh-TW":"管理长期记忆"})
    .addSubcommand(s => s.setName('list').setDescription("List memories").setDescriptionLocalizations({"ja":"記憶の一覧","zh-CN":"记忆列表","zh-TW":"记忆列表"}))
    .addSubcommand(s => s.setName('forget').setDescription("Delete a memory").setDescriptionLocalizations({"ja":"記憶を削除","zh-CN":"删除记忆","zh-TW":"删除记忆"})
      .addIntegerOption(o => o.setName('id').setDescription("ID of the memory to delete").setDescriptionLocalizations({"ja":"削除する記憶のID","zh-CN":"要删除的记忆ID","zh-TW":"要删除的记忆ID"}).setRequired(true)))
    .addSubcommand(s => s.setName('clear').setDescription("Delete all memories").setDescriptionLocalizations({"ja":"全記憶を削除","zh-CN":"删除全部记忆","zh-TW":"删除全部记忆"})),
  new SlashCommandBuilder().setName('stop')
    .setDescription("Stop the browser task and save its state").setDescriptionLocalizations({"ja":"Agentのブラウザ作業を止めて画面を保存する","zh-CN":"停止浏览器任务并保存状态","zh-TW":"停止浏览器任务并保存状态"}),
  new SlashCommandBuilder().setName('steps')
    .setDescription('Show or set browser actions per task (0 = unlimited)')
    .setDescriptionLocalizations({ ja: 'ブラウザ作業の操作回数を表示・設定（0は無制限）', 'zh-CN': '查看或设置浏览器操作次数（0为无限）', 'zh-TW': '查看或設定瀏覽器操作次數（0為無限）' })
    .addIntegerOption(o => o.setName('count').setDescription('Actions per task; 0 = unlimited. Omit to show current setting')
      .setDescriptionLocalizations({ ja: '1作業の操作回数。0は無制限。省略すると現在値を表示', 'zh-CN': '每项任务的操作次数；0为无限，省略则查看', 'zh-TW': '每項工作的操作次數；0為無限，省略則查看' }).setMinValue(0)),
  new SlashCommandBuilder().setName('web')
    .setDescription('Open your private Harklet web dashboard on this computer')
    .setDescriptionLocalizations({ ja: 'このPCで使う自分専用のHarklet Web画面を開く', 'zh-CN': '在本机打开私人Harklet网页', 'zh-TW': '在本機開啟私人Harklet網頁' }),
  new SlashCommandBuilder().setName('service')
    .setDescription("External services (Google Workspace / Microsoft 365)").setDescriptionLocalizations({"ja":"外部サービス接続 (Google Workspace / Microsoft 365)","zh-CN":"外部服务（Google Workspace / Microsoft 365）","zh-TW":"外部服务（Google Workspace / Microsoft 365）"})
    .addSubcommand(s => s.setName('list').setDescription("List connections").setDescriptionLocalizations({"ja":"接続状況の一覧","zh-CN":"查看连接状态","zh-TW":"查看连接状态"}))
    .addSubcommand(s => s.setName('connect').setDescription("Connect a service").setDescriptionLocalizations({"ja":"サービスを接続","zh-CN":"连接服务","zh-TW":"连接服务"})
      .addStringOption(o => o.setName('provider').setDescription("google or m365").setDescriptionLocalizations({"ja":"google または m365","zh-CN":"google 或 m365","zh-TW":"google 或 m365"}).setRequired(true)
        .addChoices({ name: 'Google Workspace (Gmail/Calendar)', value: 'google' },
          { name: 'Microsoft 365 (Outlook/Calendar)', value: 'm365' })))
    .addSubcommand(s => s.setName('disconnect').setDescription("Disconnect a service").setDescriptionLocalizations({"ja":"サービスを切断","zh-CN":"断开服务","zh-TW":"断开服务"})
      .addStringOption(o => o.setName('provider').setDescription("google or m365").setDescriptionLocalizations({"ja":"google または m365","zh-CN":"google 或 m365","zh-TW":"google 或 m365"}).setRequired(true)
        .addChoices({ name: 'Google Workspace', value: 'google' },
          { name: 'Microsoft 365', value: 'm365' }))),
];

// This command clears the entire Harklet database, so expose it only in an opted-in test guild.
if (process.env.HARKLET_ENABLE_RESET === '1' && config.guildId) {
  commands.push(new SlashCommandBuilder().setName('reset')
    .setDescription("Test only: delete Harklet channels and all DB data").setDescriptionLocalizations({"ja":"テスト用: Harkletのチャンネルと全DBデータを消去","zh-CN":"仅测试：删除Harklet频道和全部数据库数据","zh-TW":"仅测试：删除Harklet频道和全部数据库数据"})
    .setDefaultMemberPermissions('8'));
}

export { commands };
