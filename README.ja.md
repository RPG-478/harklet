![harklet](assets/banner.jpg)

# harklet

普段のチャットでWeb作業を頼むと、Agentが必要に応じてユーザー専用のQuicksand Linux VM内でブラウザを操作します。Dockerは不要です。`/computer` は直接操作用の補助コマンドです。導入方法と権限の範囲は[専用ブラウザの説明](docs/browser-agent.md)を参照してください。

**Languages:** [English](./README.md) | 日本語 | [中文](./README.zh.md)

Hark Pro に着想を得たパーソナル AI アシスタント Discord Bot。

**チャットからAgentに仕事を任せる体験**を中心に、記憶、Web操作、提案、プロアクティブな支援をDiscordに提供します。

## 機能

| Hark Pro | harklet での実装 |
| --- | --- |
| 記憶を持つチャット | `/ask` + ユーザーごとの長期記憶(SQLite)。会話から重要な事実を自動抽出して保存 |
| Action Buttons | AI の応答に「リマインダー設定」「記憶に保存」などの実行ボタンが付く |
| プロアクティブ支援 | リマインダー配信 + 毎朝のモーニングブリーフ(`/brief`) |
| Home | `/home` — 常駐ダッシュボード。今日の一手・天気・GitHub概要・予定・記憶をカード表示。30分ごと自動更新 |
| Projects | `/project` — チャットを話題で分割するスレッド(互換: `/panel`) |
| Agentブラウザ | チャットでWeb作業を依頼すると、必要に応じて専用VMのブラウザを使い、進捗と結果を通知 |

GmailやGitHubは、VM内でログインしたWebサイトとして操作できます。専用のアカウント接続やOAuth連携はまだありません。

## セットアップ

1. [Discord Developer Portal](https://discord.com/developers/applications) で Application を作成し、Bot トークンを取得。
   - Bot 設定で **Message Content Intent** を ON(パネル内の自由会話に必要)。
2. OAuth2 → URL Generator で `bot` + `applications.commands` を選択し、Bot Permissions は `Send Messages` `Create Public Threads` `Read Message History` を付けて招待。

   必要なBot権限（ビットフィールド `3197968`）:
   - チャンネルの閲覧、メッセージ送信、スレッドでのメッセージ送信、公開スレッド作成、メッセージ履歴の閲覧、**チャンネルの管理**(`/main set` の自動作成用)

   招待URLテンプレート: `https://discord.com/oauth2/authorize?client_id=<CLIENT_ID>&permissions=3197968&scope=bot%20applications.commands`
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
| `/model` | Embed + プルダウンでモデル＆Reasoning effortをユーザーごとに切替。一覧はAPIから自動取得し、選択は「決定」ボタンで確定 |
| `/main set|off|show` | メインチャンネル設定。`set` で Harklet カテゴリ(chat/home/projects)も自動生成（要「サーバー管理」+Botに「チャンネル管理」） |
| `/remember <text>` | 長期記憶に保存 |
| `/memory list|forget|clear` | 記憶の一覧・削除 |
| `/remind add|list|cancel` | リマインダー。`10分後` `明日9時` `18:30` `2026-10-09 09:00` `in 10 min` `tomorrow 9am` などを解釈 |
| `/project <topic>` | プロジェクト(話題別スレッド)を作成。内部は書き込むだけで会話が続く |
| `/panel <topic>` | `/project` と同じ(互換用) |
| `/home open|cards|off` | Home設置/カスタムカード管理/解除(30分ごと自動更新・更新ボタンあり)。AI提案の「ホームに追加」ボタンで動的カードが増える |
| `/brief on|off|now` | 毎朝のブリーフィング設定・手動生成 |
| `/ping` | 生存確認 |

## LLM バックエンド

3系統のプロバイダをサポート。設定されたキーから自動判別します(`LLM_PROVIDER` で強制指定も可):

| Provider | キー環境変数 | API |
| --- | --- | --- |
| `openai` | `OPENAI_API_KEY` / `OPENROUTER_API_KEY` | OpenAI互換 `/chat/completions` — OpenAI / OpenRouter / LM Studio / Ollama / Gemini互換エンドポイント |
| `anthropic` | `ANTHROPIC_API_KEY` | ネイティブ `/v1/messages` |
| `google` | `GEMINI_API_KEY` / `GOOGLE_API_KEY` | ネイティブ `generateContent` |

`/model` でユーザーごとにモデルと Reasoning effort を切替可能。effort はプロバイダ別に変換: OpenRouter→`reasoning.effort`、OpenAI→`reasoning_effort`、Anthropic→`thinking.budget_tokens`、Gemini→`thinkingConfig.thinkingBudget`。

## 仕組み

- `src/index.js` — Discord イベント・コマンド・ボタン・スケジューラ
- `src/home.js` — Homeダッシュボード。LLM生成「今日の一手」+Open-Meteo天気+GitHub概要+リマインダー+記憶のEmbedカードを30分タイマーと更新ボタンで編集
- `src/dsh-agent.js` — 会話エンジン。DeepSeek Harness (DSH) のエージェントループをプロセス内に組み込み(cordis プラグイン → セッション → エージェントループ)、独自 `LlmAdapter` で OpenAI互換 / Anthropic / Google 各APIにブリッジ。構造化JSON `{reply, actions, remember}` をパース
- `src/llm.js` — プロバイダ別のモデル一覧自動取得
- `src/db.js` — `node:sqlite` による永続化(記憶・会話履歴・リマインダー・設定)
- `src/schedule.js` — 自然言語ふう時刻パーサ

## 注意

- Message Content Intent を使うため、Bot が **1万ユニークユーザー** を超える場合は Discord の審査が必要です(2026/6 改訂)。それ未満なら Portal のトグルで動きます。
- 応答生成中は「Harkletが返信中……」というプレースホルダを表示し、回答が届いたらそのメッセージを書き換えます。
- Message Content Intent が未許可でも、DM と Botへのメンションは本文が届くため会話できます(チャンネル内の自由会話のみ不可)。
- AI の自動記憶抽出は誤爆しえます。`/memory list` / `forget` で管理してください。

## License

MIT
