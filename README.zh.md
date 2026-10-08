![harklet](assets/banner.jpg)

# harklet

`/computer` uses a dedicated browser profile for web tasks and does not require Docker. See [setup and limitations](docs/browser-agent.md).

**Languages:** [English](./README.md) | [日本語](./README.ja.md) | 中文

受 [Hark Pro](https://www.hark.com) 启发的个人 AI 助手 Discord Bot。

它将 Hark Pro 的核心体验 —— **拥有持久记忆的助手、主动建议、一键执行操作、按主题划分的项目对话** —— 带进 Discord 的斜杠命令、按钮和子区中。

## 功能

| Hark Pro | harklet 实现 |
| --- | --- |
| 带记忆的对话 | `/ask` + 每用户长期记忆（SQLite）。自动从对话中提取关键事实 |
| 操作按钮 | AI 回复附带可执行按钮，如"设置提醒""保存到记忆" |
| 主动协助 | 定时提醒推送 + 每日晨间简报（`/brief`） |
| Home | `/home` —— 常驻仪表盘消息：今日行动、天气、GitHub 概要、提醒、记忆卡片，每 30 分钟自动刷新 |
| Projects | `/project` —— 按主题拆分会话的子区（兼容别名 `/panel`） |

## 安装

1. 在 [Discord Developer Portal](https://discord.com/developers/applications) 创建应用并获取 Bot Token。
   - 在 Bot → Privileged Gateway Intents 开启 **Message Content Intent**（面板内自由聊天所需）。
2. 通过 OAuth2 → URL Generator 邀请 Bot，scope 选择 `bot` + `applications.commands`，权限勾选 `Send Messages` `Create Public Threads` `Read Message History`。

   所需 Bot 权限（位掩码 `3197968`）:
   - 查看频道、发送消息、在子区发送消息、创建公开子区、读取消息历史、**管理频道**（`/main set` 自动创建用）

   邀请链接模板: `https://discord.com/oauth2/authorize?client_id=<CLIENT_ID>&permissions=3197968&scope=bot%20applications.commands`
3. 安装并配置：

```bash
npm install
cp .env.example .env   # Windows: copy .env.example .env
# 编辑 .env: DISCORD_TOKEN / DISCORD_CLIENT_ID / OPENAI_API_KEY
```

4. 注册命令并启动：

```bash
npm run register   # 开发时在 .env 设置 DISCORD_GUILD_ID 可立即生效
npm run doctor     # 检查 token、LLM 端点和数据库
npm start
```

若 Message Content Intent 未授权，Bot 会自动以无该 Intent 的方式重试并输出提示。此模式下频道内自由聊天不可用，但 **私信和 @提及仍然可用** —— Discord 会携带这两类消息的文本内容。

## 命令

| 命令 | 说明 |
| --- | --- |
| `/ask <question>` | 向助手提问。回复基于你的记忆，并可附带操作按钮 |
| `/model` | Embed + 下拉菜单为每用户切换模型与推理强度（列表自动从API获取，选择后需按「决定」确认） |
| `/main set|off|show` | 设置主频道，频道内直接发言即可与助手对话（需"管理服务器"权限） |
| `/remember <text>` | 保存事实到长期记忆 |
| `/memory list|forget|clear` | 查看 / 删除记忆 |
| `/remind add|list|cancel` | 提醒。可解析 `10分後` `in 10 min` `tomorrow 9am` `18:30` `2026-10-09 09:00` 等 |
| `/project <topic>` | 创建项目子区以按主题拆分会话，区内直接输入即可持续对话 |
| `/panel <topic>` | 同 `/project`（兼容保留） |
| `/home open|cards|off` | 放置/管理自定义卡片/移除 Home（每 30 分钟自动刷新，附刷新按钮）。AI 可提议“添加到主页”生成动态卡片 |
| `/brief on|off|now` | 配置 / 手动生成每日简报 |
| `/ping` | 存活检查 |

## LLM 后端

支持三种提供商，按已配置的密钥自动识别（可用 `LLM_PROVIDER` 强制指定）:

| 提供商 | 密钥环境变量 | API |
| --- | --- | --- |
| `openai` | `OPENAI_API_KEY` / `OPENROUTER_API_KEY` | OpenAI 兼容 `/chat/completions` — OpenAI / OpenRouter / LM Studio / Ollama / Gemini 兼容端点 |
| `anthropic` | `ANTHROPIC_API_KEY` | 原生 `/v1/messages` |
| `google` | `GEMINI_API_KEY` / `GOOGLE_API_KEY` | 原生 `generateContent` |

`/model` 支持每用户切换模型与推理强度。effort 按提供商映射: OpenRouter→`reasoning.effort`、OpenAI→`reasoning_effort`、Anthropic→`thinking.budget_tokens`、Gemini→`thinkingConfig.thinkingBudget`。

## 结构

- `src/index.js` —— Discord 事件、命令、按钮、调度器
- `src/home.js` —— Home 仪表盘：LLM 生成“今日行动”+Open-Meteo 天气+GitHub 概要+提醒+记忆的 Embed 卡片，30 分钟定时与刷新按钮原地更新
- `src/dsh-agent.js` —— 对话引擎：将 DeepSeek Harness (DSH) 智能体循环嵌入进程内（cordis 插件 → 会话 → 智能体循环），通过自定义 `LlmAdapter` 桥接 OpenAI 兼容 / Anthropic / Google API，并解析结构化 JSON `{reply, actions, remember}`
- `src/llm.js` —— 按提供商自动获取模型列表
- `src/db.js` —— 基于 `node:sqlite` 的持久化（记忆、历史、提醒、设置）
- `src/schedule.js` —— 自然语言时间解析器

## 注意

- Bot 超过 **1 万独立用户** 后，Message Content Intent 需要 Discord 审核（2026 年 6 月修订）。在此之下，Portal 开关即可。
- 模型思考期间会显示「Harkletが返信中……」占位消息，收到回复后原地编辑替换。
- 自动提取的记忆可能有误，可用 `/memory list` / `/memory forget` 管理。

## License

MIT
