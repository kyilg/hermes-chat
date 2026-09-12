# Hermes Chat — Android 用モバイルチャットUI + 省電力スーパーバイザ

Android(Termux)上の [Hermes Agent](https://hermes-agent.nousresearch.com) を、スマホ専用 PWA（ChatGPT風）から利用する構成。
OpenCode Go 等のモデル API は Hermes の OpenAI 互換 API サーバ（`/v1`）経由でのみ呼び、クライアントは直接呼ばない。
「アプリ起動時だけ Hermes を起動 / 無操作で自動停止」をサーバー側スーパーバイザが制御する。

## 構成

```
Android
 ├ 常駐: supervisor.py (stdlib only, 127.0.0.1:8642 を占有)
 │   ├ 静的UI(PWA)配信
 │   ├ /v1/* と /health を Hermes API(127.0.0.1:8643)へSSE対応リバースプロキシ（APIキーはサーバー側注入）
 │   ├ Hermes停止中にトラフィック → hermes gateway run を起動し /health を待つ
 │   └ アイドルTTL(既定10分)経過かつ 接続0・実行中run 0 で graceful 停止
 ├ Termux: hermes gateway run (API_SERVER_PORT=8643, 通信プラットフォームは使わない)
 └ Hermes Chat (PWA) ← ブラウザで http://127.0.0.1:8642 をホーム画面に追加
```

停止条件の判定は **サーバー側**（ブラウザがバックグラウンドで凍結されても正しい）。
`POST /v1/runs` の run_id を追跡し、`GET /v1/runs/{id}` が終端（completed/cancelled/failed/…）になるまで停止しない。
SSE ストリーム中のコネクションも停止を妨げる。`max_task_minutes`（0=無制限）は暴走タスク用の安全弁。

## リポジトリ構成

```
supervisor/supervisor.py        waker+プロキシ+アイドル制御（依存ライブラリなし）
supervisor/settings.example.json  設定テンプレート（→ settings.json にコピー）
web/                            React+Vite PWA（PCでビルド、dist/ はコミット済み）
scripts/                        Termux 用スクリプト
```

## スーパーバイザ設定（supervisor/settings.json）

| キー | 既定 | 説明 |
|---|---|---|
| `idle_ttl_minutes` | 10 | 無操作で Hermes を停止するまでの分 |
| `max_task_minutes` | 0 | 1 run の実行上限（分、0=無制限） |
| `hermes_api_key` | (空) | `/v1` へ注入する Bearer キー。**必須** |

PWA の設定画面（⚙）から TTL 等を変更可能（`PUT /api/supervisor/settings`）。

## 環境変数（supervisor）

| 変数 | 既定 |
|---|---|
| `SUPERVISOR_HOST` / `SUPERVISOR_PORT` | `127.0.0.1` / `8642` |
| `HERMES_API_URL` | `http://127.0.0.1:8643` |
| `WEB_ROOT` | `../web/dist` |
| `HERMES_START_CMD` | `hermes gateway run` |
| `HERMES_HOME` | (なし) |
| `HERMES_CHAT_SETTINGS` | `./settings.json` |

## PC での開発・ローカルE2E（Phase 1）

```bash
cd web && npm install && npm run build      # dist/ 生成（コミット対象）
# Hermes 側: API_SERVER_ENABLED=true API_SERVER_PORT=8643 で hermes gateway run
cd supervisor && python supervisor.py        # 127.0.0.1:8642 で待受
```

検証済みフロー（本機で OpenCode Go / deepseek-v4-flash 相手に実施）:
起動(down→starting→up 約15秒) / SSEストリーミング中継 / runs追跡と完了検知 /
アイドルTTL経過で自動停止 / 停止中のリクエスト→503 hermes_starting + 自動復帰→再送で200。

## Android への導入（実証済みルート）

1. **Termux を F-Droid からインストール**（https://f-droid.org/packages/com.termux/ 。**Playストア版・GitHubのAPKは不可**: Play Protectにブロックされる）。初回起動でbootstrap完了まで数十秒待つ
2. **Hermes Agent をコミュニティaptリポジトリ経由で導入**（`install.sh`はTermuxで失敗する: `firecrawl-anydoc`のRust/maturinビルドが落ちる）:
   ```
   curl -fsSL https://raw.githubusercontent.com/adybag14-cyber/termux-python/main/scripts/setup_apt_repo.sh | bash
   pkg update && pkg install hermes-agent
   ```
   （リポジトリ設定スクリプトが失敗する場合は手動: 署名鍵を `$PREFIX/etc/apt/trusted.gpg.d/` に配置し、
   `deb [signed-by=<鍵パス>] http://144.21.61.111/termux stable main` を `$PREFIX/etc/apt/sources.list.d/` に書く）
3. **venv を補完する**（apt版venvにはpip/aiohttpが同梱されていない。APIサーバはこれが無いと起動しない）:
   ```
   VENV=/data/data/com.termux/files/usr/lib/hermes-agent/app/venv
   $VENV/bin/python -m ensurepip --upgrade
   $VENV/bin/python -m pip install aiohttp
   ```
4. **Hermes 0.21.0以上へ更新**（apt版0.20.6は `x-opencode-session` ヘッダを送らず、OpenCode Goリレーが拒否する）:
   ```
   git clone --depth 1 https://github.com/NousResearch/hermes-agent.git ~/hermes-src
   $VENV/bin/python -m pip install --no-deps --no-build-isolation -e ~/hermes-src
   ```
   （`--no-deps` でRustビルドを一切回避。setuptools/wheel が入っていない場合は先に `pip install -U pip setuptools wheel`）
5. `~/.hermes/.env` に追記（PC の設定を流用。`OPENCODE_GO_API_KEY` 等は PC の `.env` からコピー）:
   ```
   OPENCODE_GO_API_KEY=...
   API_SERVER_ENABLED=true
   API_SERVER_HOST=127.0.0.1
   API_SERVER_PORT=8643
   API_SERVER_KEY=任意のキー
   API_SERVER_CORS_ORIGINS=http://127.0.0.1:8642,http://localhost:8642
   ```
   ※ `API_SERVER_CORS_ORIGINS` は必須。ブラウザ(PWA)は同一オリジンでも `Origin` ヘッダを送るため、無いと全チャットが `403 Forbidden` になる
6. 本リポジトリをスマホへ: `git clone`（dist/ 込みで取得）
7. `cp supervisor/settings.example.json supervisor/settings.json` し `hermes_api_key` を設定
8. **設定GUI（ダッシュボード）用の依存を導入**（⚙ →「Hermes設定GUIを開く」で使う）:
   ```
   pkg install nodejs-lts
   $VENV/bin/python -m pip install fastapi uvicorn starlette python-multipart ptyprocess
   ```
   ※ チャット自体（APIサーバ）は不要。`aiohttp + stdlib` のみで動作する
9. 起動: `bash scripts/run-supervisor-termux.sh`（Termux:Widget に登録すればタップ起動）
   **Termux:Widget（1タップ起動）の導入**:
   1. F-Droid から **Termux:Widget**（`com.termux.widget`）をインストール（Termux本体には付属しない別アプリ）
   2. 起動スクリプトを配置: `run-supervisor-termux.sh` を `~/.shortcuts/hermes-chat.sh` として作成（`chmod +x` 必須。本リポジトリではスマホの `~/hermes-chat/scripts/` にあるものを利用）
   3. **Android本体のホーム画面**（Termuxではなく壁紙のある画面）で長押し → ウィジェット → **Termux:Widget** を追加 → 表示された「hermes-chat」を選ぶ（「キーボード入力」は Termux:Widget の別バリエーション。スクリプト実行は通常タップで可）
   4. 以後、再起動後はホーム画面のウィジェットをタップするだけで起動
10. **バッテリー最適化を Termux に対して無効化**（設定→アプリ→Termux→バッテリー。Xiaomi 等は自動起動/バックグラウンド許可も）
    再起動後は Termux を一度開くだけでスーパーバイザが復帰（Termux:Boot は任意）
11. Chrome で `http://127.0.0.1:8642` を開き「ホーム画面に追加」で PWA 登録

`scripts/hermes-gateway-termux.sh` を `HERMES_START_CMD` にすると、
Hermes 稼働中のみ `termux-wake-lock` を保持し、停止時に解除する（待機中はディープスリープ維持）。

## PCからの遠隔セットアップ（任意）

スマホの画面操作をせず、PCのターミナルから上の手順1〜11を実行する方法。
「adb（USB）→ポート転送→Termux内sshd」の順に接続し、以降の全コマンドを `ssh` 経由で実行する。

1. PC側: [platform-tools](https://developer.android.com/tools/releases/platform-tools) の `adb` を導入し、実機のUSBデバッグを有効化（設定→開発者向けオプション→USBデバッグ）。`adb devices` で認識を確認
2. スマホ側で一度だけ Termux を起動し、SSHサーバを立てる:
   ```
   pkg install openssh
   # PCの公開鍵 (~/.ssh/id_ed25519.pub 等) を ~/.ssh/authorized_keys に登録
   #   鍵の受け渡しは `scp` か、`termux-setup-storage` 後に `~/storage/shared/` 経由
   sshd
   ```
3. PC側でポート転送を張って接続:
   ```
   adb forward tcp:8022 tcp:8022
   ssh -p 8022 -i ~/.ssh/id_ed25519 127.0.0.1
   ```
4. 以後、READMEの手順2〜11のコマンドを `ssh -p 8022 127.0.0.1 "<コマンド>"` の形で実行する。例:
   ```
   ssh -p 8022 127.0.0.1 "curl -fsSL <aptリポジトリスクリプト> | bash && pkg update && pkg install hermes-agent"
   ```
5. APK（F-Droid版Termux等）はPCから: `adb install -r ./com.termux_<ver>.apk`
   （Xiaomi等は事前に「USB経由のインストール」を許可。インストール時の確認ダイアログはスマホ画面でのタップが必要な場合がある）
6. ファイル配備は `scp -P 8022` または tar の転送で。
7. バッテリー除外などスマホ設定コマンドも `adb shell dumpsys deviceidle whitelist +com.termux` のようにPCから実行できる

補足:
- Termux の **RUN_COMMAND（外部アプリからのコマンド実行）は adb からは権限を渡せない**（F-Droid版では動かない）。遠隔操作は必ず **sshd + adb forward** を使う
- スマホを再起動した場合は USB を繋ぎ直し、`adb forward` を張り直せば再度操作できる（ホーム画面の Termux:Widget があればPC不要）

## 運用上の注意

- **GUI設定**: チャットPWAの⚙ →「Hermes設定GUIを開く」で `http://127.0.0.1:9119`（Hermes公式ダッシュボード）を開くと、APIキー・モデル・config.yaml をブラウザから編集できる（loopback・ログイン不要）。`scripts/run-supervisor-termux.sh` がサーバ起動時に合わせて起動する
- **Hermes 停止中は cron / メッセージング gateway / webhook / kanban も停止する**（オンデマンド運用の前提）
- ポートは loopback のみ。外部公開する場合は `SUPERVISOR_HOST=0.0.0.0` + アクセス制御を別途
- `GET /api/supervisor/status` で状態確認、`POST /api/supervisor/start|stop` で手動制御
- 起動に数十秒かかるため、PWA は「起動中…」画面を表示し /health を待つ
- **Termux特有のメモリ確保クラッシュ（Scudo SIGABRT）時は、スーパーバイザが自動再起動し進行中のリクエストを自動再送する**（アプリ側の対処不要）

## トラブルシューティング

| 症状 | 対処 |
|---|---|
| Termux APK が `INSTALL_FAILED_VERIFICATION_FAILURE` / Play Protect 拒否 | GitHub版APKを使っている。**F-Droid版（release署名）** を導入する |
| `install.sh` が Rust/maturin ビルドで失敗（`firecrawl-anydoc`） | install.sh はTermux非対応。**コミュニティaptリポジトリ**から導入（導入ステップ2） |
| `No module named pip` / APIサーバが起動しない（aiohttp欠落） | apt版venvにpip無し。`ensurepip` + `pip install aiohttp`（導入ステップ3） |
| OpenCode Go が「missing x-opencode-session」と拒否 | 0.20.6が古い。**0.21.0以上へ更新**（導入ステップ4） |
| `403 Forbidden` で全チャット失敗 | `API_SERVER_CORS_ORIGINS` が未設定/不一致（導入ステップ5） |
| `hermes_starting` が返る | 起動中。`/api/supervisor/status` が up になるまで再試行 |
| `no_api_key` 502 | `settings.json` の `hermes_api_key` 未設定 |
| 自動停止しない | `active_runs` が空か、`idle_for_seconds` が TTL 未満か確認。SSE 接続中は停止しない |
| Android に殺される | バッテリー最適化の無効化 / OEM の自動起動許可 / `termux-wake-lock` |
| クラッシュ（Scudo SIGABRT）で応答が途中で切れる | スーパーバイザが自動再起動・自動再送する。頻発する場合は Termux/TUR の更新を確認 |