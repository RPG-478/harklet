![harklet](assets/banner.jpg)

# harklet

**Languages:** English | [日本語](./README.ja.md) | [中文](./README.zh.md)

A personal AI assistant Discord bot inspired by [Hark Pro](https://www.hark.com).

It brings Hark Pro's core experience — **an assistant with persistent memory, proactive suggestions, one-tap actions, and scoped project conversations** — into Discord slash commands, buttons, and threads.

## Features

| Hark Pro | In harklet |
| --- | --- |
| Chat with memory | `/ask` + per-user long-term memory (SQLite). Key facts are auto-extracted from conversation |
| Action Buttons | AI replies come with executable buttons such as "set reminder" and "save to memory" |
| Proactive assistance | Scheduled reminder delivery + daily morning briefing (`/brief`) |
| Projects | `/panel` — a topic-scoped thread where you can chat freely without commands |

## Setup

1. Create an application at the [Discord Developer Portal](https://discord.com/developers/applications) and get a bot token.
   - Enable **Message Content Intent** under Bot → Privileged Gateway Intents (required for free chat inside panels).
2. Invite the bot via OAuth2 → URL Generator with scopes `bot` + `applications.commands` and permissions `Send Messages` `Create Public Threads` `Read Message History`.
3. Install and configure:

```bash
npm install
cp .env.example .env   # Windows: copy .env.example .env
# edit .env: DISCORD_TOKEN / DISCORD_CLIENT_ID / OPENAI_API_KEY
```

4. Register commands and start:

```bash
npm run register   # set DISCORD_GUILD_ID in .env for instant guild-scoped registration during dev
npm run doctor     # verify token, LLM endpoint, and DB
npm start
```

If the Message Content intent is not granted, the bot automatically retries without it (panel free-chat is disabled) and logs a notice.

## Commands

| Command | Description |
| --- | --- |
| `/ask <question>` | Ask the assistant. Replies use your memory and may include action buttons |
| `/remember <text>` | Save a fact to long-term memory |
| `/memory list|forget|clear` | List / delete memories |
| `/remind add|list|cancel` | Reminders. Parses `in 10 min`, `tomorrow 9am`, `18:30`, `2026-10-09 09:00`, Japanese (`10分後` `明日9時`), etc. |
| `/panel <topic>` | Create a conversation panel (thread). Just type inside to keep chatting |
| `/brief on|off|now` | Configure / trigger the daily briefing |
| `/ping` | Health check |

## LLM backend

Any OpenAI-compatible chat completions API works. Point `OPENAI_BASE_URL` and `OPENAI_MODEL` at OpenAI, OpenRouter, LM Studio, Ollama, etc. Without a key, non-AI features still work and `/ask` replies with a setup hint.

## How it works

- `src/index.js` — Discord events, commands, buttons, schedulers
- `src/llm.js` — OpenAI-compatible client; parses structured JSON {reply, actions, remember}
- `src/db.js` — persistence via `node:sqlite` (memories, history, reminders, settings)
- `src/schedule.js` — natural-language-ish time parser

## Notes

- The Message Content Intent requires Discord verification once the bot exceeds **10,000 unique users** (June 2026 revision). Below that, the Developer Portal toggle is enough.
- Auto-extracted memories can misfire. Manage them with `/memory list` and `/memory forget`.

## License

MIT
