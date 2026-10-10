# Service connector OAuth setup (bot operator, one time)

Harklet connects each Discord user to Google Workspace and Microsoft 365 on
their own consent. The API calls need an OAuth client, and Google/Microsoft
only let a human create one — this is a one-time ~5 minute job for whoever
runs the bot, not per user.

Two ways to feed the client into the bot:

- `.env`: `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `M365_CLIENT_ID`
- Embedded defaults: paste the values into `DEFAULT_CLIENT_ID` /
  `DEFAULT_CLIENT_SECRET` in `src/connect/google.js` and `src/connect/m365.js`,
  so OSS users get working connectors without any env vars (rclone-style).
  `.env` always wins when both are set.

## Google Workspace (Gmail + Calendar)

1. Open https://console.cloud.google.com/ and create a project (any name,
   no billing needed).
2. APIs & Services → Library → enable **Gmail API** and **Google Calendar API**.
3. APIs & Services → OAuth consent screen → External → fill in app name and
   your email (the rest can stay blank) → Save.
4. **Important**: on the same OAuth consent screen page, click
   "Publish app" / move it to **In production**. If it stays in "Testing",
   refresh tokens expire after 7 days and users have to re-connect weekly.
   Publishing an unverified app is fine for personal bots — users just see an
   "unverified app" warning and click Advanced → Continue.
5. APIs & Services → Credentials → Create Credentials → **OAuth client ID** →
   Application type: **Desktop app** → Create.
6. Copy the client ID and secret into `.env` or the `DEFAULT_*` constants.
   Desktop clients do not need a redirect URI — the loopback flow is implicit.

Scopes used: `openid email gmail.modify calendar.readonly`. After changing
scopes, existing connections must re-consent (`/service disconnect` then
connect again).

## Microsoft 365 (Outlook mail + calendar)

1. Open https://entra.microsoft.com/ (or portal.azure.com → Microsoft Entra ID)
   → App registrations → New registration.
2. Name anything; supported account types: "Accounts in any organizational
   directory and personal Microsoft accounts". No redirect URI needed.
3. In the app's **Authentication** → Advanced settings → set
   **Allow public client flows** to **Yes** (required for device code flow).
4. API permissions → Add → Microsoft Graph → Delegated → add
   `User.Read`, `Mail.Read`, `Calendars.Read`, `offline_access`.
5. Copy the **Application (client) ID** into `M365_CLIENT_ID`. No secret —
   device code flow is a public-client flow, which also means phone users
   just open microsoft.com/devicelogin and type a short code.

