#!/data/data/com.termux/files/usr/bin/bash
# Hold the Termux wake lock ONLY while Hermes is running (needs Termux:API).
# Use as HERMES_START_CMD on the phone (bash scripts/hermes-gateway-termux.sh)
# so idle time keeps the CPU in deep sleep. Falls back gracefully when the
# Termux:API app is not installed.
if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock
  trap 'termux-wake-unlock' EXIT
fi
exec hermes gateway run