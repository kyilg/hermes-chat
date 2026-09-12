#!/data/data/com.termux/files/usr/bin/bash
# Hermes on Termux: セットアップチェックリスト（手動確認付き、随時再実行可）
set -e

echo "== [1/7] Termux パッケージ更新 =="
pkg update -y && pkg upgrade -y

echo "== [2/7] ビルドツールチェーン（Rust依存のwheelビルド用） =="
pkg install -y git clang rust make pkg-config libffi openssl ripgrep || echo "(一部失敗: インストーラ次第で不要)"

echo "== [3/7] Hermes Agent 導入（Tier2。Python 3.14→TUR 3.13 は自動） =="
echo "  実行: curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash"
echo "  ※初回は30〜60分かかります。失敗時は tur-repo + python3.13 を手動導入して再実行"
read -r -p "インストールが完了したら Enter" _

echo "== [4/7] APIサーバ設定 (~/.hermes/.env) =="
echo "  OPENCODE_GO_API_KEY=…            # PCの ~/.hermes/.env からコピー"
echo "  API_SERVER_ENABLED=true"
echo "  API_SERVER_HOST=127.0.0.1"
echo "  API_SERVER_PORT=8643"
echo "  API_SERVER_KEY=<任意のキー>       # supervisor/settings.json と一致させる"
read -r -p "設定が完了したら Enter" _

echo "== [5/7] 本リポジトリ取得 =="
read -r -p "リポジトリURL (例 git@github.com:you/hermes-chat.git): " REPO
test -n "$REPO"
git clone "$REPO" ~/hermes-chat
cp ~/hermes-chat/supervisor/settings.example.json ~/hermes-chat/supervisor/settings.json
echo "  supervisor/settings.json の hermes_api_key を編集してください"
read -r -p "編集が完了したら Enter" _

echo "== [6/7] バッテリー最適化（手動・必須） =="
echo "  設定→アプリ→Termux→バッテリー→無制限（OEMにより「自動起動」「バックグラウンド」許可も）"
termux-notification --title "Hermes Chat" --content "バッテリー最適化を無効化したら続行してください" 2>/dev/null || true
read -r -p "設定が完了したら Enter" _

echo "== [7/7] スーパーバイザ起動 =="
bash ~/hermes-chat/scripts/run-supervisor-termux.sh
echo "→ Chrome で http://127.0.0.1:8642 を開き「ホーム画面に追加」"
echo "完了。"