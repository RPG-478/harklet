# Computer use sidecar

harklet の `/computer` は、Docker 上の Linux デスクトップを Cua SDK で操作します。この `sidecar/` は、Node 側から呼ばれるローカルの HTTP ブリッジです。

## セットアップ

1. Docker Desktop（または Docker Engine）を起動しておく。Windows では WSL2 が必要です。
2. Python 3.12 か 3.13 で仮想環境を作る（3.14 では `cua-sandbox` が入りません）。

```
python -m venv sidecar/.venv
sidecar/.venv/Scripts/python -m pip install -r sidecar/requirements.txt   # Windows
sidecar/.venv/bin/python -m pip install -r sidecar/requirements.txt       # macOS / Linux
```

3. `.env` に `HARKLET_SECRET_KEY`（16文字以上のランダムな文字列）を設定する。
4. `npm run register` で `/computer` を登録し、Bot を再起動する。

## 仕組み

- サイドカーは `127.0.0.1` だけで待ち受け、起動ごとのランダムなトークンがないリクエストを拒否します。
- ログイン情報は Discord のモーダルで受け取り、AES-256-GCM で暗号化して harklet の DB に保存します。
- AI には `{{保存名}}` のような名前だけを渡します。値は `type_secret` の時にホスト側から入力され、AI の入力・履歴・進捗メッセージには出ません。
- `/computer view` の画面リンクは操作もできて、約1時間有効です。本人にだけ見えるエフェメラルで返します。

## 既知の制限

- Discord のモーダルは入力文字を隠せません。画面を覗かれる場所では入力しないでください。
- 画面に平文のパスワードが出ていると、スクリーンショット経由で AI に見えます。パスワード欄が伏せ字になるサイトで使ってください。
- サンドボックスの画面は Linux です。Windows や macOS の画面をそのまま操作することはできません。
- 操作は二通りあります。Cua Driver のアクセシビリティ情報で要素を選んで押す方法（click_element）と、スクリーンショットの座標で押す方法（click）です。要素の一覧が取れない時は座標だけで動きます。
- 要素の方法が Linux の仮想デスクトップで動くかは、まだ実機で確認していません。
- 操作は今のところスクリーンショットから座標を決めて行います。アクセシビリティ情報による要素指定は未実装です。