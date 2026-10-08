![harklet](assets/banner.jpg)

# harklet

Hark Pro に着想を得たパーソナル AI アシスタント Discord Bot。

Hark Pro(hark.com)の中核体験 — **記憶を持つアシスタント、会話からの次の一手の提案、ワンタップ実行、プロアクティブな支援** — を Discord のコマンド・ボタン・スレッドに落とし込んでいます。

## 機能

| Hark Pro | harklet での実装 |
| --- | --- |
| 記憶を持つチャット | `/ask` + ユーザーごとの長期記憶(SQLite)。会話から重要な事実を自動抽出して保存 |
| Action Buttons | AI の応答に「リマインダー設定」「記憶に保存」などの実行ボタンが付く |
| プロアクティブ支援 | リマインダー配信 + 毎朝のモーニングブリーフ(`/brief`) |
| Projects | `/panel` — トピックごとの会話スレッド。パネル内はコマンド不要で自由会話 |

## セットアップ

1. [Discord Developer Portal](https://discord.com/developers/applications) で Application を作成し、Bot トークンを取得。
   - Bot 設定で **Message Content Intent** を ON(パネル内の自由会話に必要)。
2. OAuth2 → URL Generator で `bot` + `applications.commands` を選択し、Bot Permissions は `Send Messages` `Create Public Threads` `Read Message History` を付けて招待。
3. リポジトリをセットアップ:

```bash
npm install
cp .env.example .env   # Windows: copy .env.example .env
# .env を編集: DISCORD_TOKEN / DISCORD_CLIENT_ID / OPENAI_API_KEY
```

4. コマンド登録と起動:

```bash
npm run register   # コマンドをDiscordに登録(開発中は .env に DISCORD_GUILD_ID を入れると即時反映)
npm run doctor     # トークン・LLM・DBの疎通確認
npm start
```

## コマンド

| コマンド | 説明 |
| --- | --- |
| `/ask <question>` | アシスタントに質問。記憶を踏まえて回答し、実行ボタンを提案 |
| `/remember <text>` | 長期記憶に保存 |
| `/memory list|forget|clear` | 記憶の一覧・削除 |
| `/remind add|list|cancel` | リマインダー。`10分後` `明日9時` `18:30` `2026-10-09 09:00` などを解釈 |
| `/panel <topic>` | 会話パネル(スレッド)を作成。パネル内は普通に書き込むだけで会話が続く |
| `/brief on|off|now` | 毎朝のブリーフィング設定・手動生成 |
| `/ping` | 生存確認 |

## LLM バックエンド

OpenAI 互換 API なら何でも使えます。`OPENAI_BASE_URL` と `OPENAI_MODEL` を変えれば OpenRouter、LM Studio、Ollama などにも接続可能。

## 仕組み

- `src/index.js` — Discord イベント・コマンド・ボタン・スケジューラ
- `src/llm.js` — OpenAI 互換チャット API。JSON 出力 {reply, actions, remember} をパース
- `src/db.js` — `node:sqlite` による永続化(記憶・会話履歴・リマインダー・設定)
- `src/schedule.js` — 自然言語ふう時刻パーサ

## 注意

- Message Content Intent を使うため、Bot が **1万ユニークユーザー** を超える場合は Discord の審査が必要です(2026/6 改訂)。それ未満なら Portal のトグルで動きます。
- AI の自動記憶抽出は誤爆しえます。`/memory list` / `forget` で管理してください。

## License

MIT
