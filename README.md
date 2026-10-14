![harklet](assets/banner.jpg)

# harklet

**Languages:** English | [日本語](./README.ja.md) | [中文](./README.zh.md)

A personal AI assistant Discord bot inspired by [Hark Pro](https://www.hark.com).

It brings an **agent that works from ordinary chat**, with persistent memory and a dedicated browser, into Discord. The agent can choose browser work when a request calls for it. Slash commands remain shortcuts for direct control.

## Features

| Feature | In Harklet |
| --- | --- |
| Chat with memory | Chat channel, DM, or mention + per-user long-term memory (SQLite). Key facts are auto-extracted from conversation |
| Action Buttons | Replies carry executable buttons, and direct requests are done on the spot: add/delete Home cards, reminders, memories, projects, region, briefing, model |
| Proactive assistance | Daily briefing plus a DM suggestion when a repeatable Specialty is due; browser work starts only after you ask or press its action button |
| Specialties | Teach a repeatable workflow in chat, or let the computer agent remember a useful workflow when it finishes. Ask for it again by name; optional repeat interval |
| Home | `/start` places a dashboard with today's moves, reminders and memories. Weather needs a city; the GitHub summary needs `GITHUB_USER`. It refreshes every 30 min |
| Panels | Home cards are Hark-style panels: the agent can build cards that pull live data from connected services and carry their own action buttons. Reply to the Home message to redesign them in chat |
| Projects | Ask in chat or use the Projects button to create a topic-scoped thread |
| Agent browser | Ask in chat for Web work; Harklet starts a per-user Quicksand Linux VM and reports the result. `/stop` saves and closes it; [setup and limits](docs/browser-agent.md) |
| Live screen | A read-only noVNC link is sent by DM when browser work starts. With cloudflared installed, it opens over HTTPS from a phone or another network. Optional interactive mode lets the owner solve human checks |

## Languages

Chat replies and browser tasks use the language of the request. `/language code:ja`, `/language code:en`, or another BCP47 tag pins the response language; `/language code:auto` returns to automatic selection. Buttons, modals, Home labels and action results have English, Japanese and Chinese translations. Other fixed UI falls back to English. Command descriptions follow the Discord client locale. Language detection and model output can still be imperfect.

## Integrations and recurring work

External services connect per user with OAuth — `/service connect` or just ask in chat. **Google Workspace** (Gmail unread, Calendar today) uses a loopback auth URL; **Microsoft 365** (Outlook unread, Calendar today) uses the device code flow so you can approve from a phone. Refresh tokens live in the same AES-256-GCM vault as browser logins (`HARKLET_SECRET_KEY`). Once connected, the agent can read those services on request and Home panels can display them. GitHub account actions use the agent browser; the optional GitHub Home card reads public repositories through the API (`GITHUB_TOKEN` only raises the API rate limit).

Specialties keep a short description of the workflow, not a replayable script. Browser-derived steps omit typed values, verification codes, coordinates, and URL queries. You can say “remember this workflow”, “run it again”, “show my Specialties”, or “forget this Specialty”. Repeat interval suggestions are sent only when the daily briefing is enabled; they do not run the task automatically.

## Setup

Requirements: Node.js 22.5+. Browser work additionally needs Python 3.11+, Quicksand installation, several GB of disk space and a vision-capable model. See [browser setup and limits](docs/browser-agent.md).

1. Create an application at the [Discord Developer Portal](https://discord.com/developers/applications) and get a bot token.
   - Enable **Message Content Intent** under Bot → Privileged Gateway Intents (required for free chat inside panels).
2. Invite the bot via OAuth2 → URL Generator with scopes `bot` + `applications.commands` and permissions `Send Messages` `Create Public Threads` `Read Message History`.

   Required bot permissions (bitfield `3197968`):
   - View Channels, Send Messages, Send Messages in Threads, Create Public Threads, Read Message History, **Manage Channels** (for `/start` auto-setup)

   Invite URL template: `https://discord.com/oauth2/authorize?client_id=<CLIENT_ID>&permissions=3197968&scope=bot%20applications.commands`
3. Install and configure:

```bash
npm install
cp .env.example .env   # Windows: copy .env.example .env
# edit .env: DISCORD_TOKEN / DISCORD_CLIENT_ID and one LLM API key
# for browser work or OAuth connections, set HARKLET_SECRET_KEY (16+ characters)
# optional connectors: GOOGLE_CLIENT_ID/SECRET, M365_CLIENT_ID (docs/oauth-setup.md)
```

4. Register commands and start:

```bash
npm run register   # set DISCORD_GUILD_ID in .env for instant guild-scoped registration during dev
npm run doctor     # verify token, LLM endpoint, and DB
npm start
```

To enable browser work, run `npm run browser:install` before `npm start` and set `HARKLET_SECRET_KEY` plus a vision-capable `HARKLET_CU_MODEL` (or use a vision-capable default model). The browser starts when the chat agent chooses a `computer` action for a Web request; there is no separate `/computer` command. It does not ask for confirmation before starting that requested task. Use `/stop` to stop it.

If the Message Content intent is not granted, the bot automatically retries without it and logs a notice. Channel free-chat is unavailable in that mode, but **DMs and @mentions still work** — Discord delivers their content without the intent.

## Commands

For everyday use, write in the chat channel created by `/start`, DM Harklet, or mention it. Ask for Web work, reminders, memories, projects, and briefings in ordinary language. Use a DM for private requests.

| Command | Description |
| --- | --- |
| `/start` | Set up the Harklet category and chat/home/projects channels; reuses existing channels on later runs (Manage Server and Manage Channels required) |
| `/model` | Search and page through models available to the configured API key, then apply model and effort per user |
| `/language code:<tag|auto>` | Pin a response language or return to automatic selection |
| `/main set|off|show` | Set an existing channel as the main chat, disable it, or show it. `set` does not create channels |
| `/memory list|forget|clear` | List / delete memories |
| `/stop` | Stop browser work and save the VM |
| `/service list|connect|disconnect` | Manage per-user OAuth connections to Google Workspace / Microsoft 365 (also available by asking in chat) |

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
- `src/i18n.js` / `src/user-lang.js` — fixed UI translations and per-user language choice
- `src/llm.js` — model list auto-discovery per provider
- `src/db.js` — persistence via `node:sqlite` (memories, history, reminders, settings)
- `src/schedule.js` — natural-language-ish time parser
- `src/computer/*` — agent browser stack: Quicksand VM control, vision loop, login-handoff modals, AES-256-GCM secret vault, authenticated noVNC viewer (+ optional Cloudflare tunnel); the VM is driven by `sidecar/quicksand_session.py`
- `src/connect/*` — OAuth service connectors: Google Workspace (loopback URL + modal) and Microsoft 365 (device code flow), refresh tokens in the encrypted vault, provider ops callable from chat or injected into Home panels
- `src/specialties.js` — repeatable workflow hints (Specialties): extracts safe step summaries from completed browser work, promotes them when the agent marks a run reusable, and computes repeat-interval due dates

## Notes

- Discord may require approval for privileged intents as the bot grows. Check the current Developer Portal requirements before broad distribution.
- While the model is thinking, Discord's native typing indicator is used.
- Auto-extracted memories can misfire. Manage them with `/memory list` and `/memory forget`.
- `HARKLET_SECRET_KEY` protects saved credentials in the database. Browser VM disks separately retain website cookies; protect `browser-data` and keep viewer links private.

For a test server only, `DISCORD_GUILD_ID` plus `HARKLET_ENABLE_RESET=1` exposes `/reset` to administrators after command registration and bot restart. It confirms before deleting Harklet's channels, project threads and all Harklet DB data, including saved login values. VM cookies remain.

## Testing

`npm test` runs the unit suite (no secrets needed). The VM/integration tests are opt-in because they boot a real Quicksand guest and need the local Python sidecar:

| Test | Gate | What it proves |
| --- | --- | --- |
| `test/quicksand.integration.test.js` | `HARKLET_TEST_QUICKSAND=1` | VM boots, cookies persist across restarts |
| `test/login-fill.integration.test.js` | `HARKLET_TEST_LOGIN_FILL=1` | In-VM field detection + secret fill + submit reaches an authenticated page |
| `test/login-handoff.integration.test.js` | `HARKLET_TEST_LOGIN_HANDOFF=1` + LLM key | Vision agent asks for credentials on the real Discord login page |
| `test/viewer-tunnel.integration.test.js` | `HARKLET_TEST_REMOTE_VIEWER=1` | Cloudflare quick tunnel serves the authenticated viewer over HTTPS |

## License

MIT
