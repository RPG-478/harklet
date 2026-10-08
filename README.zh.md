![harklet](assets/banner.jpg)

# harklet

**Languages:** [English](./README.md) | [日本語](./README.ja.md) | 中文

受 [Hark Pro](https://www.hark.com) 启发的个人 AI 助手 Discord Bot。

它将 Hark Pro 的核心体验 —— **拥有持久记忆的助手、主动建议、一键执行操作、按主题划分的项目对话** —— 带进 Discord 的斜杠命令、按钮和子区中。

## 功能

| Hark Pro | harklet 实现 |
| --- | --- |
| 带记忆的对话 | `/ask` + 每用户长期记忆（SQLite）。自动从对话中提取关键事实 |
| 操作按钮 | AI 回复附带可执行按钮，如"设置提醒""保存到记忆" |
| 主动协助 | 定时提醒推送 + 每日晨间简报（`/brief`） |
| Projects | `/panel` —— 按主题创建对话子区，区内可直接聊天无需命令 |

## 安装

1. 在 [Discord Developer Portal](https://discord.com/developers/applications) 创建应用并获取 Bot Token。
   - 在 Bot → Privileged Gateway Intents 开启 **Message Content Intent**（面板内自由聊天所需）。
2. 通过 OAuth2 → URL Generator 邀请 Bot，scope 选择 `bot` + `applications.commands`，权限勾选 `Send Messages` `Create Public Threads` `Read Message History`。
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

若 Message Content Intent 未授权，Bot 会自动以无该 Intent 的方式重试（面板自由聊天将不可用）并输出提示。

## 命令

| 命令 | 说明 |
| --- | --- |
| `/ask <question>` | 向助手提问。回复基于你的记忆，并可附带操作按钮 |
| `/remember <text>` | 保存事实到长期记忆 |
| `/memory list|forget|clear` | 查看 / 删除记忆 |
| `/remind add|list|cancel` | 提醒。可解析 `10分後` `in 10 min` `tomorrow 9am` `18:30` `2026-10-09 09:00` 等 |
| `/panel <topic>` | 创建对话面板（子区），区内直接输入即可持续对话 |
| `/brief on|off|now` | 配置 / 手动生成每日简报 |
| `/ping` | 存活检查 |

## LLM 后端

兼容任何 OpenAI 格式的 chat completions API。修改 `OPENAI_BASE_URL` 和 `OPENAI_MODEL` 即可接入 OpenAI、OpenRouter、LM Studio、Ollama 等。未配置密钥时，非 AI 功能仍可用，`/ask` 会回复设置提示。

## 结构

- `src/index.js` —— Discord 事件、命令、按钮、调度器
- `src/llm.js` —— OpenAI 兼容客户端；解析结构化 JSON {reply, actions, remember}
- `src/db.js` —— 基于 `node:sqlite` 的持久化（记忆、历史、提醒、设置）
- `src/schedule.js` —— 自然语言时间解析器

## 注意

- Bot 超过 **1 万独立用户** 后，Message Content Intent 需要 Discord 审核（2026 年 6 月修订）。在此之下，Portal 开关即可。
- 自动提取的记忆可能有误，可用 `/memory list` / `/memory forget` 管理。

## License

MIT

