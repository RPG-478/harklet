![harklet](assets/banner.jpg)

# harklet

Chat browser work uses a dedicated Quicksand Linux VM and does not require Docker. Use `/stop` to save and close it. See [setup and limitations](docs/browser-agent.md).

**Languages:** [English](./README.md) | [日本語](./README.ja.md) | 中文

受 [Hark Pro](https://www.hark.com) 启发的个人 AI 助手 Discord Bot。

它将 Hark Pro 的核心体验 —— **拥有持久记忆的助手、主动建议、一键执行操作、按主题划分的项目对话** —— 带进 Discord 的斜杠命令、按钮和子区中。

## 功能

| Hark Pro | harklet 实现 |
| --- | --- |
| 带记忆的对话 | 在聊天频道、私信或提及机器人时对话，使用每用户长期记忆（SQLite） |
| 操作按钮 | AI回复附带可执行按钮；直接下达"删除""创建"等指令时Agent立即执行（主页卡片/提醒/记忆/项目/地区/简报/模型） |
| 主动协助 | 提醒、每日晨间简报，以及重复任务到期时的私信建议；浏览器任务仍需用户请求或点击按钮 |
| Specialties | 在聊天中教助手重复任务的步骤；浏览器任务完成时，Agent 会判断其复用价值并记住，可按名称再次执行 |
| Home | `/home` —— 常驻仪表盘消息：今日行动、天气、GitHub 概要、提醒、记忆卡片，每 30 分钟自动刷新 |
| Projects | 在聊天中请求创建项目子区，或使用 Projects 按钮 |
| Agent浏览器 | 在聊天中请求网页操作；Harklet 启动每用户专用 Quicksand Linux VM 并汇报结果。`/stop` 保存并关闭；[设置与限制](docs/browser-agent.md) |
| 实时画面 | 浏览器任务开始时通过私信发送只读 noVNC 链接。安装 cloudflared 后可通过 HTTPS 在手机或其他网络查看 |
| 面板 (Panels) | Home 卡片是 Hark 风格面板：Agent 可创建能拉取已连接服务实时数据、自带操作按钮的卡片。回复 Home 消息即可用对话方式重新设计 |

外部服务通过每用户 OAuth 连接 —— 使用 `/service connect` 或在聊天中直接要求。**Google Workspace**（Gmail 未读、今日日历）采用回环 URL + 代码输入；**Microsoft 365**（Outlook 未读、日历）采用设备码流程，可在手机上批准。刷新令牌与浏览器登录信息一样存放在 AES-256-GCM 保险库（`HARKLET_SECRET_KEY`）中。连接后 Agent 可按需读取数据，Home 面板也可显示。GitHub 仍作为 VM 内的网站操作（Home 的 GitHub 概要卡片使用单独的只读令牌）。

## 安装

1. 在 [Discord Developer Portal](https://discord.com/developers/applications) 创建应用并获取 Bot Token。
   - 在 Bot → Privileged Gateway Intents 开启 **Message Content Intent**（面板内自由聊天所需）。
2. 通过 OAuth2 → URL Generator 邀请 Bot，scope 选择 `bot` + `applications.commands`，权限勾选 `Send Messages` `Create Public Threads` `Read Message History`。

   所需 Bot 权限（位掩码 `3197968`）:
   - 查看频道、发送消息、在子区发送消息、创建公开子区、读取消息历史、**管理频道**（`/start` 自动创建用）

   邀请链接模板: `https://discord.com/oauth2/authorize?client_id=<CLIENT_ID>&permissions=3197968&scope=bot%20applications.commands`
3. 安装并配置：

```bash
npm install
cp .env.example .env   # Windows: copy .env.example .env
# 编辑 .env: DISCORD_TOKEN / DISCORD_CLIENT_ID / OPENAI_API_KEY
# 可选: HARKLET_SECRET_KEY（加密 Agent 浏览器保存的登录信息）
# 可选: GOOGLE_CLIENT_ID/SECRET、M365_CLIENT_ID（服务连接器）
```

4. 注册命令并启动：

```bash
npm run register   # 开发时在 .env 设置 DISCORD_GUILD_ID 可立即生效
npm run doctor     # 检查 token、LLM 端点和数据库
npm start
```

若 Message Content Intent 未授权，Bot 会自动以无该 Intent 的方式重试并输出提示。此模式下频道内自由聊天不可用，但 **私信和 @提及仍然可用** —— Discord 会携带这两类消息的文本内容。

## 命令

日常使用只需在聊天频道、私信或 @提及 Harklet，用自然语言请求网页操作、提醒、记忆和项目。斜杠命令主要用于设置和管理。

| 命令 | 说明 |
| --- | --- |
| `/start` | 设置 Harklet 分类及 chat/home/projects 频道；再次运行时复用已有频道 |
| `/model` | 从当前 API 密钥可用模型中搜索或翻页，选择模型与推理强度后确认 |
| `/main set|off|show` | 将已有频道设为主聊天频道、关闭或查看；`set` 不创建频道 |
| `/memory list|forget|clear` | 查看 / 删除记忆 |
| `/home open|cards|off` | 放置/管理自定义卡片/移除 Home（每 30 分钟自动刷新，附刷新按钮）。AI 可提议“添加到主页”生成动态卡片 |
| `/stop` | 停止浏览器任务并保存虚拟机 |
| `/service list|connect|disconnect` | 管理每用户对 Google Workspace / Microsoft 365 的 OAuth 连接（也可在聊天中直接要求） |

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
- `src/computer/*` —— Agent浏览器栈：Quicksand VM 控制、视觉循环、登录模态框、AES-256-GCM 密钥保管库、带认证的 noVNC 查看器（可选 Cloudflare 隧道）；VM 由 `sidecar/quicksand_session.py` 驱动
- `src/connect/*` —— OAuth 服务连接器：Google Workspace（回环 URL + 模态框）与 Microsoft 365（设备码流程），刷新令牌存入加密保险库，可从聊天或 Home 面板注入数据

## 注意

- Bot 超过 **1 万独立用户** 后，Message Content Intent 需要 Discord 审核（2026 年 6 月修订）。在此之下，Portal 开关即可。
- 模型思考期间使用 Discord 原生「正在输入…」提示。
- 自动提取的记忆可能有误，可用 `/memory list` / `/memory forget` 管理。

## License

MIT
