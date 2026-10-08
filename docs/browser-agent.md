# Agent browser / Agent専用ブラウザ

`/computer` gives each Discord user a dedicated Chromium profile. It can open websites, click visible controls, type, scroll, and keep login sessions between runs. It does **not** control the user's everyday browser or desktop. Docker, WSL2 and Python are not required.

## Setup

```bash
npm install
npm run browser:install
npm run register
npm start
```

Set `HARKLET_SECRET_KEY` in `.env` to a private random string of at least 16 characters. `HARKLET_CU_MODEL` can select a vision-capable model; otherwise `/computer` uses `LLM_MODEL`. Use `/computer run task:<request>` to start, `/computer view` to get a private screenshot in Discord, and `/computer stop` to close the session. The dedicated browser window is visible by default; set `HARKLET_BROWSER_HEADLESS=1` on a machine without a desktop.

Profiles live in `./browser-data` by default, one per Discord user. Set `HARKLET_BROWSER_DATA_DIR` to move them. They contain site cookies and downloads, so protect this directory and do not commit or share it. Existing login values are encrypted in the Harklet database and bound to the HTTPS website origin where they were entered. Values saved by the old Docker prototype had no origin and must be entered again.

## Boundaries

- The Agent receives only browser actions. It cannot run shell commands, upload arbitrary host files, or navigate to `file:` URLs through `/computer`.
- Requests to localhost and common private network addresses are blocked by default. Set `HARKLET_BROWSER_ALLOW_PRIVATE=1` only if the Agent must use a local site. This URL filter is not a complete network sandbox (for example, DNS rebinding remains possible).
- The browser profile separates cookies from the user's regular browser. It is **not** an OS or VM security boundary: the Bot and browser still run under the host user's account. A site the Agent can access may still take actions with that site's login. Use a VM or separate machine for stronger isolation.
- `/computer view` returns a current screenshot, not a live remote-control link. The user can interact with the visible dedicated browser window for MFA or other manual steps.
- Discord modal fields do not hide entered characters. Do not enter credentials where the screen is visible to others.

## 日本語

`/computer` はDiscordユーザーごとに専用のChromiumプロファイルを作ります。Docker Desktop・WSL2・Pythonは不要です。初回は `npm run browser:install` でブラウザ本体を取得します。普段使いのブラウザやPC全体は操作しません。ログイン状態は `browser-data/` に残るので、このフォルダを保護してください。

専用プロファイルは強い隔離ではありません。BotとブラウザはPC上の同じユーザー権限で動きます。PC全体をAgentに任せる機能は、このモードには含みません。
