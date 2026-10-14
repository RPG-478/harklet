![harklet](assets/banner.jpg)

# harklet

**Languages:** [English](./README.md) | [日本語](./README.ja.md) | 中文

受 [Hark Pro](https://www.hark.com) 启发的个人 AI 助手 Discord Bot。

它将 Hark Pro 的核心体验 —— **拥有持久记忆的助手、主动建议、一键执行操作、按主题划分的项目对话** —— 带进 Discord 的斜杠命令、按钮和子区中。

## 功能

| 功能 | Harklet 实现 |
| --- | --- |
| 带记忆的对话 | 在聊天频道、私信或提及机器人时对话，使用每用户长期记忆（SQLite） |
| 操作按钮 | AI回复附带可执行按钮；直接下达"删除""创建"等指令时Agent立即执行（主页卡片/提醒/记忆/项目/地区/简报/模型） |
| 主动协助 | 提醒、每日晨间简报，以及重复任务到期时的私信建议；浏览器任务仍需用户请求或点击按钮 |
| Specialties | 在聊天中教助手重复任务的步骤；浏览器任务完成时，Agent 会判断其复用价值并记住，可按名称再次执行 |
| Home | `/start` 设置仪表盘，显示今日行动、提醒和记忆。天气需要设置城市，GitHub 概要需要 `GITHUB_USER`；每 30 分钟刷新 |
| Projects | 在聊天中请求创建项目子区，或使用 Projects 按钮 |
| Agent浏览器 | 在聊天中请求网页操作；Harklet 启动每用户专用 Quicksand Linux VM 并汇报结果。`/stop` 保存并关闭；[设置与限制](docs/browser-agent.md) |
| 实时画面 | 浏览器任务开始时通过私信发送只读 noVNC 链接。安装 cloudflared 后可通过 HTTPS 在手机或其他网络查看；可选交互模式供用户处理人工验证 |
| 面板 (Panels) | Home 卡片是 Hark 风格面板：Agent 可创建能拉取已连接服务实时数据、自带操作按钮的卡片。回复 Home 消息即可用对话方式重新设计 |

## 语言

聊天回复和浏览器任务会使用请求的语言。通过 `/language code:zh`、`/language code:en` 或其他 BCP47 语言代码可固定回复语言；`/language code:auto` 恢复自动选择。按钮、表单、Home 和操作结果提供英语、日语、中文翻译；其他固定界面回退到英语。命令说明跟随 Discord 客户端语言。自动识别和模型输出可能出错。

## 服务连接与重复任务

外部服务通过每用户 OAuth 连接 —— 使用 `/service connect` 或在聊天中直接要求。**Google Workspace**（Gmail 未读、今日日历）采用回环 URL + 代码输入；**Microsoft 365**（Outlook 未读、日历）采用设备码流程，可在手机上批准。刷新令牌与浏览器登录信息一样存放在 AES-256-GCM 保险库（`HARKLET_SECRET_KEY`）中。连接后 Agent 可按需读取数据，Home 面板也可显示。GitHub 账号操作使用 VM 浏览器；可选的 GitHub Home 卡片通过 API 读取公开仓库，仅在需要提高 API 速率限制时才需 `GITHUB_TOKEN`。

Specialties 保存工作流程的简要描述，而不是固定点击脚本。浏览器任务中提取的步骤不会保存输入值、验证码、坐标或 URL 查询参数。重复任务到期时，只有启用晨间简报的用户才会收到私信建议；任务不会自动执行。

## 安装

需要 Node.js 22.5 或更新版本。浏览器任务还需要 Python 3.11 或更新版本、Quicksand、数 GB 可用磁盘空间和支持图像的模型。详见[浏览器设置与限制](docs/browser-agent.md)。

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
# 编辑 .env: DISCORD_TOKEN / DISCORD_CLIENT_ID / 一种 LLM API 密钥
# 浏览器任务或 OAuth 连接需要 HARKLET_SECRET_KEY（至少16个字符）
# 可选连接器: GOOGLE_CLIENT_ID/SECRET、M365_CLIENT_ID（docs/oauth-setup.md）
```

4. 注册命令并启动：

```bash
npm run register   # 开发时在 .env 设置 DISCORD_GUILD_ID 可立即生效
npm run doctor     # 检查 token、LLM 端点和数据库
npm start
```

使用浏览器任务前，请运行 `npm run browser:install`，并设置 `HARKLET_SECRET_KEY` 和支持图像的 `HARKLET_CU_MODEL`（或使用支持图像的默认模型）。聊天 Agent 为网页请求选择 `computer` 操作后会启动虚拟机；没有单独的 `/computer` 命令。执行所请求的任务前不会再次确认；使用 `/stop` 停止。

若 Message Content Intent 未授权，Bot 会自动以无该 Intent 的方式重试并输出提示。此模式下频道内自由聊天不可用，但 **私信和 @提及仍然可用** —— Discord 会携带这两类消息的文本内容。

## 命令

日常使用只需在聊天频道、私信或 @提及 Harklet，用自然语言请求网页操作、提醒、记忆和项目。斜杠命令主要用于设置和管理。

| 命令 | 说明 |
| --- | --- |
| `/start` | 设置 Harklet 分类及 chat/home/projects 频道；再次运行时复用已有频道 |
| `/model` | 从当前 API 密钥可用模型中搜索或翻页，选择模型与推理强度后确认 |
| `/language code:<语言|auto>` | 固定回复语言或恢复自动选择 |
| `/main set|off|show` | 将已有频道设为主聊天频道、关闭或查看；`set` 不创建频道 |
| `/memory list|forget|clear` | 查看 / 删除记忆 |
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
- `src/i18n.js` / `src/user-lang.js` —— 固定界面翻译与每用户的语言设置
- `src/llm.js` —— 按提供商自动获取模型列表
- `src/db.js` —— 基于 `node:sqlite` 的持久化（记忆、历史、提醒、设置）
- `src/schedule.js` —— 自然语言时间解析器
- `src/computer/*` —— Agent浏览器栈：Quicksand VM 控制、视觉循环、登录模态框、AES-256-GCM 密钥保管库、带认证的 noVNC 查看器（可选 Cloudflare 隧道）；VM 由 `sidecar/quicksand_session.py` 驱动
- `src/connect/*` —— OAuth 服务连接器：Google Workspace（回环 URL + 模态框）与 Microsoft 365（设备码流程），刷新令牌存入加密保险库，可从聊天或 Home 面板注入数据
- `src/specialties.js` —— 可重复任务（Specialty）的提示：从已完成的浏览器任务中提取安全的步骤摘要，Agent 判断可复用时保存，并计算重复间隔的到期时间

## 注意

- 大范围发布前，请在 Developer Portal 核对 Discord 对特权 Intent 的现行要求。
- 模型思考期间使用 Discord 原生「正在输入…」提示。
- 自动提取的记忆可能有误，可用 `/memory list` / `/memory forget` 管理。
- `HARKLET_SECRET_KEY` 保护数据库中保存的凭据。虚拟机磁盘另行保存网站 Cookie，请保护 `browser-data` 和查看器链接。

测试服务器可设置 `DISCORD_GUILD_ID` 和 `HARKLET_ENABLE_RESET=1`，注册命令并重启 Bot 后向管理员显示 `/reset`。确认后会删除 Harklet 的频道、项目子区和数据库中的全部数据；虚拟机 Cookie 会保留。

## 测试

`npm test` 运行单元测试(无需密钥)。VM/integration 测试需要启动真实 Quicksand guest，因此默认关闭:

| 测试 | 开启方式 | 验证内容 |
| --- | --- | --- |
| `test/quicksand.integration.test.js` | `HARKLET_TEST_QUICKSAND=1` | VM启动、跨重启的cookie持久化 |
| `test/login-fill.integration.test.js` | `HARKLET_TEST_LOGIN_FILL=1` | VM内字段检测+密钥填充+提交后到达认证页 |
| `test/login-handoff.integration.test.js` | `HARKLET_TEST_LOGIN_HANDOFF=1` + LLM密钥 | vision agent在真实Discord登录页请求凭据 |
| `test/viewer-tunnel.integration.test.js` | `HARKLET_TEST_REMOTE_VIEWER=1` | Cloudflare隧道以HTTPS提供认证查看器 |

## License

MIT
