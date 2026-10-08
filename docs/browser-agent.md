# Agent browser / Agent専用ブラウザ

The chat agent can start browser work when a user asks it to use a website. `/computer` also runs a separate Quicksand Linux VM for each Discord user. The VM contains Chromium and Playwright. Harklet controls that browser over a loopback-only CDP port. Quicksand uses QEMU and does not require Docker Desktop. Site login state is saved with each user's VM disk when the session stops.

## Setup

```bash
npm install
npm run browser:install
npm run register
npm start
```

Install Node.js 22.5+ and Python 3.11+. On Windows, hardware acceleration uses Windows Hypervisor Platform (WHPX); software emulation is slower. The first install downloads QEMU and multiple VM image layers, so allow disk space and download time. `npm run browser:install` creates `sidecar/.venv` and installs Quicksand plus its QEMU and CUA images.

Set `HARKLET_SECRET_KEY` in `.env` to a private random string of at least 16 characters. `HARKLET_CU_MODEL` can select a vision-capable model; otherwise browser work uses `LLM_MODEL`. Ask Harklet in ordinary chat to research or work on a website; it chooses whether to start the browser, posts progress and the final result, and includes that result in the next chat turn. `/ask private:true` routes browser progress and credential prompts to your DM. Use `/computer run task:<request>` for direct control, `/computer view` for a private screenshot, and `/computer stop` to save and close the VM. Idle VMs are saved and stopped after 30 minutes.

Websites such as Gmail and GitHub require sign-in inside the VM. There are no native Gmail or GitHub account connectors yet. The chat agent delegates browser tasks to a separate vision loop; it cannot switch among native service tools during a single run.

VM saves live in `./browser-data/quicksand/sandboxes/`, with names derived from a hash of the Discord user ID. Set `HARKLET_BROWSER_DATA_DIR` to move them. Protect this directory: the saved guest browser contains website cookies and downloaded files. Earlier local Playwright profiles are not migrated into the VM, so users must sign in again once. Login values in Harklet's database remain encrypted and bound to the HTTPS origin where they were entered.

`HARKLET_BROWSER_PROVIDER=local` opts into the earlier host browser mode. It requires `npm run browser:install:local` and does not provide VM isolation. `HARKLET_BROWSER_HEADLESS=1` applies only to local mode. `HARKLET_PYTHON` can point to another Python executable with Quicksand installed.

## Boundaries

- The Agent receives only browser actions. It cannot run host shell commands, upload arbitrary host files, or navigate to `file:` URLs through `/computer`. The VM has no host directory mounts.
- Web access requires Quicksand's `NetworkMode.FULL`. This gives the guest outbound network access, which may include reachable host or LAN services. Harklet blocks common private URL destinations in browser requests by default, but this is not a network firewall and cannot prevent DNS rebinding.
- The CDP port is forwarded only to host `127.0.0.1`. Other local processes on the host can potentially access it. A website the Agent is logged into can still be changed by the Agent; VM isolation protects the host environment, not the website account.
- `/computer view` returns a screenshot, not an interactive noVNC link. Quicksand's CUA image contains noVNC, but Harklet does not expose its unauthenticated VNC service. Manual MFA in the VM is not yet supported.
- Discord modal fields do not hide entered characters. Do not enter credentials where the screen is visible to others.

## 日本語

標準設定では、`/computer` はDiscordユーザーごとにQuicksandのLinux VMを起動し、その中のChromiumを操作します。Docker Desktopは不要ですが、Python 3.11以上と初回のVM画像ダウンロードが必要です。`npm run browser:install` で導入できます。ログイン状態はVMのディスクに保存されます。以前のホストブラウザのログイン状態は引き継がれず、初回だけ再ログインが必要です。

VMにはホストのフォルダを共有しません。Web閲覧用にネットワークを開くため、ホストやLANへの通信を完全には遮断できません。`/computer view` は静止画で、現状はVM内の手動MFA操作には対応していません。
