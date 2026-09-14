#!/data/data/com.termux/files/usr/bin/bash
# Start the supervisor in the background (detached via nohup).
# Log goes to supervisor/supervisor.log.
cd "$(dirname "$0")/.."
# Phone default: hold the wake lock only while Hermes runs.
export HERMES_START_CMD="${HERMES_START_CMD:-bash scripts/hermes-gateway-termux.sh}"
export HERMES_API_URL="${HERMES_API_URL:-http://127.0.0.1:8643}"
# Restore remote control too (adb forward -> sshd) in case Android killed Termux.
if ! pgrep -x sshd >/dev/null 2>&1; then
  sshd >/dev/null 2>&1
  echo "sshd restarted"
fi
if curl -s -m 2 http://127.0.0.1:8642/api/supervisor/status >/dev/null 2>&1; then
  echo "supervisor already running"
  exit 0
fi
nohup python supervisor/supervisor.py >> supervisor/supervisor.log 2>&1 &
sleep 1
echo "supervisor pid $!"
# Admin GUI (APIキー・モデル・設定をブラウザで編集)
if ! curl -s -m 2 http://127.0.0.1:9119/ >/dev/null 2>&1; then
  nohup hermes dashboard --no-open >> dashboard.log 2>&1 &
  sleep 1
  echo "dashboard pid $!"
fi
echo "Chat:   http://127.0.0.1:8642"
echo "設定UI: http://127.0.0.1:9119"