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
| Home | `/home` — a persistent dashboard message: today's moves, weather, GitHub summary, reminders, memory cards. Auto-refreshes every 30 min |
| Projects | `/project` — a topic-scoped thread for splitting a chat by subject (legacy alias: `/panel`) |
| Agent browser | `/computer run|view|stop` — a Quicksand Linux VM for each user, with Docker-free setup; [setup and limits](docs/browser-agent.md) |

## Setup

1. Create an application at the [Discord Developer Portal](https://discord.com/developers/applications) and get a bot token.
   - Enable **Message Content Intent** under Bot → Privileged Gateway Intents (required for free chat inside panels).
2. Invite the bot via OAuth2 → URL Generator with scopes `bot` + `applications.commands` and permissions `Send Messages` `Create Public Threads` `Read Message History`.

   Required bot permissions (bitfield `3197968`):
   - View Channels, Send Messages, Send Messages in Threads, Create Public Threads, Read Message History, **Manage Channels** (for `/main set` auto-setup)

   Invite URL template: `https://discord.com/oauth2/authorize?client_id=<CLIENT_ID>&permissions=3197968&scope=bot%20applications.commands`
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

If the Message Content intent is not granted, the bot automatically retries without it and logs a notice. Channel free-chat is unavailable in that mode, but **DMs and @mentions still work** — Discord delivers their content without the intent.

## Commands

| Command | Description |
| --- | --- |
| `/ask <question>` | Ask the assistant. Replies use your memory and may include action buttons |
| `/model` | Embed + dropdowns to pick model & effort per user (list auto-fetched from provider; staged until you press 決定/Apply) |
| `/main set|off|show` | Set the main channel (plain messages = chat). `set` also creates a **Harklet** category with chat/home/projects channels (needs Manage Channels; Manage Server required) |
| `/remember <text>` | Save a fact to long-term memory |
| `/memory list|forget|clear` | List / delete memories |
| `/remind add|list|cancel` | Reminders. Parses `in 10 min`, `tomorrow 9am`, `18:30`, `2026-10-09 09:00`, Japanese (`10分後` `明日9時`), etc. |
| `/project <topic>` | Create a project thread to split the chat by subject. Just type inside to keep chatting |
| `/panel <topic>` | Same as `/project` (kept for compatibility) |
| `/home open|cards|off` | Place/manage custom cards/remove the Home dashboard (auto-refresh every 30 min). AI can offer an Add to Home button that creates dynamic cards |
| `/brief on|off|now` | Configure / trigger the daily briefing |
| `/ping` | Health check |

## LLM backend

Three provider styles are supported; the active one is auto-detected from which key is present (override with `LLM_PROVIDER`):

| Provider | Key env | API |
| --- | --- | --- |
| `openai` | `OPENAI_API_KEY` / `OPENROUTER_API_KEY` | OpenAI-compatible `/chat/completions` — works with OpenAI, OpenRouter, LM Studio, Ollama, Gemini's compat endpoint |
| `anthropic` | `ANTHROPIC_API_KEY` | Native `/v1/messages` |
| `google` | `GEMINI_API_KEY` / `GOOGLE_API_KEY` | Native `generateContent` |

`/model` lets each user pick a model and reasoning effort. Effort maps per provider: OpenRouter → `reasoning.effort`, OpenAI → `reasoning_effort`, Anthropic → `thinking.budget_tokens`, Gemini → `thinkingConfig.thinkingBudget`.

## How it works

- `src/index.js` — Discord events, commands, buttons, schedulers
- `src/home.js` — Home dashboard: embed cards (today's moves via LLM, Open-Meteo weather, GitHub summary, reminders, memories) edited in place on a 30-min timer and a refresh button
- `src/dsh-agent.js` — the conversation engine: DeepSeek Harness (DSH) agent loop embedded in-process (cordis plugins → sessions → agent loop), bridged to OpenAI-compatible / Anthropic / Google APIs via a custom `LlmAdapter`. Parses the structured JSON `{reply, actions, remember}` contract
- `src/llm.js` — model list auto-discovery per provider
- `src/db.js` — persistence via `node:sqlite` (memories, history, reminders, settings)
- `src/schedule.js` — natural-language-ish time parser

## Notes

- The Message Content Intent requires Discord verification once the bot exceeds **10,000 unique users** (June 2026 revision). Below that, the Developer Portal toggle is enough.
- While the model is thinking, the bot posts `Harkletが返信中……` and edits that message in place once the answer arrives.
- Auto-extracted memories can misfire. Manage them with `/memory list` and `/memory forget`.

## License

MIT
