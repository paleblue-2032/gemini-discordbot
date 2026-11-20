# gemini-discordbot

自宅サーバーで Gemini を常駐させ、Discord から呼び出すための bot。

Discord 側の使い勝手は従来の `commandcode-discordbot` を引き継ぎつつ、AI の実行部分を
**Gemini API 直結** にしたもの。`AI_BACKEND=cmd` にすれば従来の Command Code CLI に戻せる。

## 目次

- [現在の状態](#現在の状態)
- [バックエンド](#バックエンド)
- [全体像](#全体像)
- [コマンド](#コマンド)
- [添付ファイル](#添付ファイル)
- [セキュリティ](#セキュリティ)
- [環境変数](#環境変数)
- [ディレクトリ](#ディレクトリ)
- [開発](#開発)
- [デプロイ](#デプロイ)
- [ロールバック](#ロールバック)
- [トラブルシューティング](#トラブルシューティング)

## 現在の状態

- `kanon-server`（i5-3570 / 8GB / Ubuntu Server 24.04.5）で systemd サービスとして稼働する前提。
- TypeScript + discord.js。Nix flake でビルドし、`nix build` の成果物を systemd から起動する。
- AI は既定で Gemini API に直接接続する。`cmd` バックエンドも残してある。
- スラッシュコマンドはグローバル登録。`ALLOWED_USER_IDS` が空なら、参加ギルドの全ユーザーが利用できる。
- `.env` は root 所有 600。Discord トークンと Gemini API キーは systemd の `EnvironmentFile` から渡す。
- 既存の `toyamakosen-bus-bot` や `fileshare`、`fan-quiet` には触らない。

## バックエンド

`AI_BACKEND` で切り替える。

| 値 | 動作 |
| --- | --- |
| `gemini`（既定の運用） | Gemini API の `generateContent` を直接呼ぶ。会話履歴は bot が保存する。ファイル操作・シェル実行などのエージェント機能はない |
| `cmd` | 従来どおり `cmd -p --yolo` を子プロセスで実行する。Command Code のツール・セッション・モデルを使う |

Gemini 直結では、`cwd` は添付ファイルの保存先とスレッド管理のために使う。
Gemini がサーバー上のファイルを自動で読むことはない。添付として送られた内容だけを読む。

`cmd` に戻す場合は `.env` の `AI_BACKEND=cmd` にして再起動する。
`cmd` は `cmdbot` ユーザーの `~/.commandcode/auth.json` を使うため、ヘッドレスログインが必要。

## 全体像

```
 スマホ (Discord)
      │  メッセージ / スラッシュコマンド
      ▼
 ┌────────────────────────────────┐
 │ kanon-server (i5-3570 / 8GB)   │
 │                                │
 │  gemini-discordbot (Node 22)   │
 │    │ channelId → 履歴/cwd      │
 │    │ HTTPS                     │
 │    ▼                           │
 │  Gemini API                    │
 │    generateContent             │
 │    │                           │
 │    ▼                           │
 │  Discord に表示                │
 └───────────────┬────────────────┘
                 │ HTTPS
                 ▼
   generativelanguage.googleapis.com
```

`AI_BACKEND=cmd` のときは、この図の Gemini API 部分が `cmd -p` と `api.commandcode.ai` に置き換わる。

## コマンド

| 入力 | 動作 |
| --- | --- |
| `!<メッセージ>` | そのチャンネル/スレッドの履歴に追加して Gemini に送る（`!` は除かれる） |
| `!` なしのメッセージ | 何もしない（スレッド内の会話に介入しない） |
| `/ask prompt:<text>` | 同上（スラッシュ版） |
| `/new` | セッションと Gemini の履歴を捨てて新しく始める |
| `/cwd <path>` | 作業ディレクトリを変更（許可ルート配下のみ）。履歴もリセットされる |
| `/model [model:<id>] [effort:<level>]` | モデルを表示・変更する。effort は `cmd` のときだけ有効 |
| `/status` | backend / cwd / モデル / 履歴件数 / 実行状態を表示する |
| `/storage` | ディスク使用量・SMART 判定・削除候補を表示する |
| `/stop` | 実行中・待機中の処理を取り消す |
| `/usage` | Gemini または Command Code の使用量の確認先を表示する |

通常メッセージは**先頭が `!` のときだけ**実行する。`TRIGGER_MODE=all` にすると全メッセージに反応する。
添付だけ送る場合も `!` を付ける（本文なしで `!` だけでも動く）。

### モデル

既定は `GEMINI_MODEL`（`gemini-3.1-flash-lite`）。`/model` の候補は Gemini の
`GET /v1beta/models` から取得し、`generateContent` に対応するモデルだけを表示する。
TTS・画像生成・embedding・live・computer-use などは除外している。

`/model` で設定したモデルは backend ごとに保存する。`AI_BACKEND` を切り替えても
Gemini 用のモデルと cmd 用のモデルは混ざらない。

### effort

Gemini 直結では effort を使わない。`/model effort:...` はエラーになる。
`cmd` バックエンドでは従来どおり `model-caps.ts` の表に従って検証する。

### フォーラム

フォーラムの投稿（スレッド）は、投稿ごとに独立した履歴・キュー・作業ディレクトリになる。
`FORUM_CWD=auto` では投稿ごとに `<DEFAULT_CWD>/<フォーラム名>/<投稿名>` を作る。
`shared` にすると全投稿で `DEFAULT_CWD` を共有する。

### 容量管理

`/srv` の使用率が `STORAGE_TARGET_PERCENT` を超えると、bot が自動作成した
スレッド作業ディレクトリを最終作業の古い順に削除する。SMART が劣化しているときは
`STORAGE_DEGRADED_PERCENT` まで強める。

## 添付ファイル

受け取った添付は作業ディレクトリの `.discord-uploads/` に保存し、Gemini に送る。

- 画像 / PDF / 音声 / 動画: `inlineData` として送る（1 ファイル 15MB、合計 20MB まで）
- テキスト系: UTF-8 として読み、本文に埋め込む（1 ファイル 256KB まで）
- それ以外: ファイル名とサイズだけを伝える

履歴にはファイルのパスだけを保存し、送信時に読み直す。ファイルが消えている場合は
その旨をテキストで伝える。`[[attach:path]]` によるファイル返却は `cmd` バックエンド向けの機能で、
Gemini 直結では使わない。

## セキュリティ

- `.env` は root 所有 600。Discord トークンと Gemini API キーを子プロセスに渡さない。
- systemd で `NoNewPrivileges` / `ProtectSystem=strict` / `PrivateTmp` などを有効にする。
- Gemini 直結にはシェル・ファイル書き込みのツールがない。プロンプトインジェクションで
  サーバー操作ができる経路は `cmd` バックエンドより狭い。
- `cmd` バックエンドは従来どおり `--yolo` + deny ルール + `deploy/guard.sh` で運用する。
- 招待するギルドは信頼できるものだけに限定する。

## 環境変数

`.env.example` を参照。主なものは次のとおり。

| 変数 | 内容 |
| --- | --- |
| `DISCORD_TOKEN` | Bot トークン（必須） |
| `AI_BACKEND` | `gemini` / `cmd`（既定 `cmd`、サーバーでは `gemini`） |
| `GEMINI_API_KEY` | Gemini API キー（`AI_BACKEND=gemini` のとき必須） |
| `GEMINI_MODEL` | 既定モデル（既定 `gemini-3.1-flash-lite`） |
| `GEMINI_BASE_URL` | API のベース URL（既定 `https://generativelanguage.googleapis.com/v1beta`） |
| `GEMINI_HISTORY_FILE` | 会話履歴の保存先（既定 `./gemini-history.json`） |
| `GEMINI_MAX_HISTORY_MESSAGES` | 1 チャンネルあたりの履歴上限（既定 40） |
| `GEMINI_TIMEOUT_MS` | API タイムアウト（既定 180000） |
| `GEMINI_MAX_OUTPUT_TOKENS` | 出力トークン上限（既定 8192） |
| `GEMINI_GOOGLE_SEARCH` | Google Search グラウンディング（既定 false） |
| `GEMINI_SYSTEM_PROMPT` | システムプロンプトの差し替え（任意） |
| `ALLOWED_USER_IDS` | 許可する Discord ユーザー ID（空なら全ユーザー） |
| `ALLOWED_CHANNEL_IDS` | 許可するチャンネル ID（空なら全チャンネル） |
| `ALLOWED_ROOTS` | `/cwd` で移動できるルート（必須） |
| `MAX_CONCURRENCY` | 同時実行数（既定 3） |
| `SESSIONS_FILE` | cwd / モデル / cmd セッションの保存先（既定 `./sessions.json`） |
| `FORUM_CWD` | `auto` / `shared` |
| `UPLOAD_TTL_HOURS` | 添付を残す時間（0 で削除しない） |
| `STORAGE_TARGET_PERCENT` | 作業領域の目標使用率（0 で自動削除を無効化） |
| `STORAGE_DEGRADED_PERCENT` | SMART 劣化時の目標使用率 |
| `SMART_FILE` | `gemini-disk-health.timer` が書く SMART スナップショット |
| `WORKDIR_META` | `AGENTS.md` の自動更新範囲（`thread` / `always` / `off`） |
| `CWD_CONFLICT` | 使用中ディレクトリへの `/cwd`（`deny` / `warn`） |
| `TRIGGER_MODE` | `prefix`（`!` 必須、既定）/ `all` |
| `CMD_BIN` | `cmd` の実行パス（`AI_BACKEND=cmd` のとき） |
| `CMD_MODEL` | cmd の既定モデル（`AI_BACKEND=cmd` のとき） |
| `CMD_EFFORT` | cmd の既定 effort（`AI_BACKEND=cmd` のとき） |

## ディレクトリ

| パス | 内容 |
| --- | --- |
| `src/bot.ts` | Discord ハンドラ、コマンド、添付、完了処理 |
| `src/gemini.ts` | Gemini API クライアント、履歴、添付の変換、モデル一覧 |
| `src/runner.ts` | `cmd` の spawn、NDJSON、exit code |
| `src/config.ts` | env 読み込み・検証 |
| `src/sessions.ts` | cwd / モデル / セッションの永続化 |
| `src/queue.ts` | チャンネル直列 + 同時実行 semaphore |
| `src/progress.ts` | 進捗メッセージの throttle |
| `src/attachments.ts` | 添付保存、`[[attach:]]` 抽出 |
| `src/models.ts` | `cmd --list-models` の parse（cmd 用） |
| `test/` | node:test + tsx |
| `deploy/gemini-discordbot.service` | systemd unit |
| `deploy/botctl` | `deploy` / `restart` / `stop` / `status` / `logs` などの運用入口 |
| `deploy/install-server.sh` | 初回セットアップ |

## 開発

```bash
npm ci
npm run typecheck
npm test
npm run build
```

Nix でビルドする場合:

```bash
nix build .#default -o result
./result/bin/gemini-discordbot
```

## デプロイ

初回はリポジトリをサーバーに置き、`.env` を作って unit をインストールする。

```bash
sudo env TAKEOVER=1 GEMINI_API_KEY='...' bash deploy/install-server.sh
```

`install-server.sh` は次を行う。

1. `/srv/gemini-discordbot` を clone / pull（所有者 `cmdbot:cmdwork`）
2. `nix build` で `result` を作成
3. `/srv/commandcode-discordbot/.env` から Discord トークンなどをコピーして
   `/srv/gemini-discordbot/.env` を作成（root 600）
4. `gemini-discordbot.service` と `gemini-disk-health.*` をインストール
5. `TAKEOVER=1` のとき、`commandcode-discordbot.service` を停止・自動起動無効化
6. `gemini-discordbot.service` を有効化して起動

旧 bot の unit・`.env`・リポジトリは残る。`toyamakosen-bus-bot` / `fileshare` /
`fan-quiet` には触らない。

2 回目以降の更新:

```bash
sudo botctl deploy gemini
```

`botctl deploy` は `git pull` → `nix build` → `systemctl restart` をまとめて行う。

SMART スナップショットは `gemini-disk-health.timer` が毎時
`/var/lib/gemini-discordbot/smart.json` に書く。旧 bot の `disk-health` とは分離してある。

## ロールバック

### 同じサービスを cmd に戻す

```bash
sudo nano /srv/gemini-discordbot/.env   # AI_BACKEND=cmd
sudo botctl restart gemini
```

`cmd` は `cmdbot` の `~/.commandcode/auth.json` と `settings.json` を使う。
Gemini 用の履歴は残るが、`cmd` では使われない。

### 旧 bot に戻す

```bash
sudo botctl disable gemini
sudo botctl enable commandcode
```

`botctl disable` は停止 + 自動起動無効化、`botctl enable` は有効化 + 起動。
どちらも NOPASSWD で実行できる。

## トラブルシューティング

```bash
sudo botctl status gemini
sudo botctl logs gemini
journalctl -u gemini-discordbot -f
```

- `GEMINI_API_KEY が設定されていません` → `/srv/gemini-discordbot/.env` を確認する。
- `HTTP 400` / `API key not valid` → キーの有効性と `GEMINI_BASE_URL` を確認する。
- `HTTP 429` → Gemini のレート制限。少し待つ。
- `HTTP 503` → モデルが混雑している。`/model` で別モデルに変えるか、時間を置く。
- 応答が空 → `/new` で履歴をリセットする。それでも直らなければログを見る。
- `cmd` に戻したのに動かない → `cmdbot` で `cmd login` 済みか確認する。
- ファンが回らない → `sensors`、`systemctl status fan-quiet`、`journalctl -u fan-quiet`。
