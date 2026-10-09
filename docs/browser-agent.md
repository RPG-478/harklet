# Agent browser / Agent専用ブラウザ

The chat agent starts browser work when a user asks it to use a website. It runs a separate Quicksand Linux VM for each Discord user. The VM contains Chromium and Playwright. Harklet controls that browser over a loopback-only CDP port. Quicksand uses QEMU and does not require Docker Desktop. Site login state is saved with each user's VM disk when the session stops.

## Setup

```bash
npm install
npm run browser:install
npm run register
npm start
```

Install Node.js 22.5+ and Python 3.11+. On Windows, hardware acceleration uses Windows Hypervisor Platform (WHPX); software emulation is slower. `npm run browser:install` creates `sidecar/.venv` and installs Quicksand plus its QEMU and CUA images.

Disk: the first install downloads about 1.2 GB of wheels (QEMU ~42 MB, CUA image ~477 MB, agent and Ubuntu base ~640 MB fetched on first VM boot) and unpacks to roughly 2 GB inside `sidecar/.venv`. VM saves live under `HARKLET_BROWSER_DATA_DIR` (default `./browser-data`) and grow with guest disk writes; keep at least 3 GB free on that drive. Only the latest save per user is kept.

Set `HARKLET_SECRET_KEY` in `.env` to a private random string of at least 16 characters. `HARKLET_CU_MODEL` can select a vision-capable model; otherwise browser work uses `LLM_MODEL`. Ask Harklet in ordinary chat to research or work on a website; it chooses whether to start the browser, posts progress and the final result, and includes that result in the next chat turn. Send private browser requests in a DM. `/stop` stops work, saves the VM and invalidates its viewer link. Idle VMs are saved and stopped after 30 minutes.

When a VM starts, Harklet sends the user a DM with a noVNC URL. Install [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) on the Bot host to provide a temporary HTTPS link through a Cloudflare Quick Tunnel. No account, domain, inbound port or same-network connection is needed. Set `HARKLET_CLOUDFLARED` if the binary is not on PATH. The link includes a random 256-bit key; the local gateway checks it before serving noVNC or accepting WebSocket connections. The first request exchanges the key for a Secure, HttpOnly cookie and removes it from the page URL. Keep the DM link private: anyone with it can view the screen until the VM closes. Cloudflare carries the viewer traffic. If cloudflared is missing or fails, the DM link falls back to Bot-local `127.0.0.1`; set `HARKLET_REMOTE_VIEWER=0` to force local-only mode. The viewer scales the desktop to fit phone screens by default; the noVNC settings panel can switch to original size for detail. The VM runs its VNC server in read-only mode, so the viewer cannot interact with the desktop. Login screens and other sensitive page content may be visible in the viewer.

When the Agent needs login details, the browser view displays a prompt to return to Discord. Enter the requested values through the Discord modal. The prompt disappears when the request is answered, times out, or the session is stopped.

Websites such as Gmail and GitHub require sign-in inside the VM. The chat agent delegates browser tasks to a separate vision loop; it cannot switch among native service tools during a single run.

VM saves live in `./browser-data/quicksand/sandboxes/`, with names derived from a hash of the Discord user ID. Set `HARKLET_BROWSER_DATA_DIR` to move them. Protect this directory: the saved guest browser contains website cookies and downloaded files. Earlier local Playwright profiles are not migrated into the VM, so users must sign in again once. Login values in Harklet's database remain encrypted and bound to the HTTPS origin where they were entered.

`HARKLET_BROWSER_PROVIDER=local` opts into the earlier host browser mode. It requires `npm run browser:install:local` and does not provide VM isolation. `HARKLET_BROWSER_HEADLESS=1` applies only to local mode. `HARKLET_PYTHON` can point to another Python executable with Quicksand installed.

## Boundaries

- The Agent receives only browser actions. It cannot run host shell commands, upload arbitrary host files, or navigate to `file:` URLs through its browser tool. The VM has no host directory mounts.
- Web access requires Quicksand's `NetworkMode.FULL`. This gives the guest outbound network access, which may include reachable host or LAN services. Harklet blocks common private URL destinations in browser requests by default, but this is not a network firewall and cannot prevent DNS rebinding.
- The CDP port is forwarded only to host `127.0.0.1`. Other local processes on the host can potentially access it. A website the Agent is logged into can still be changed by the Agent; VM isolation protects the host environment, not the website account.
- The DM link opens a read-only noVNC view. The Agent can request TOTP, SMS or email codes through a Discord modal; one-time codes are not saved. The Agent can wait for a push approval performed on the user's own device. Passkeys, security keys and CAPTCHAs that require direct interaction in the VM are not supported.
- Discord modal fields do not hide entered characters. Do not enter credentials where the screen is visible to others.

## 日本語

標準設定では、チャットでWeb作業を頼むとDiscordユーザーごとにQuicksandのLinux VMを起動し、その中のChromiumを操作します。Docker Desktopは不要ですが、Python 3.11以上と初回のVM画像ダウンロードが必要です。`npm run browser:install` で導入できます。ログイン状態はVMのディスクに保存されます。以前のホストブラウザのログイン状態は引き継がれず、初回だけ再ログインが必要です。

VMにはホストのフォルダを共有しません。Web閲覧用にネットワークを開くため、ホストやLANへの通信を完全には遮断できません。作業開始時には本人のDMへnoVNCのURLを送ります。Bot側にcloudflaredを導入すると、一時的なHTTPSリンクをスマホや別ネットワークから開けます。URLにはランダムな閲覧鍵が含まれるので共有しないでください。導入されていない場合はBotと同じPCの`127.0.0.1`からだけ開けます。画面は初期設定でスマホ幅に縮小され、細部を見たい場合はnoVNC設定から原寸表示に切り替えられます。VNC側は閲覧専用です。2FAの数字コードはDiscordモーダルで入力でき、使い終わったら保存せずに消します。手元の端末で承認するプッシュ通知は待機できますが、VM内で直接操作が必要なパスキー・セキュリティキー・CAPTCHAには対応していません。終了は`/stop`です。

Agentがログイン情報を求めたときは、ブラウザ画面にDiscordへ戻る案内を表示します。Discordのモーダルに入力すると案内が消え、作業が再開します。入力期限切れや `/stop` でも案内を解除します。
