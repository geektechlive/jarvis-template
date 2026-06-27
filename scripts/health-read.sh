#!/bin/bash
set -euo pipefail
# Reads the daily health summary written by the Jarvis Health Shortcut.
# Checks three locations in priority order:
#   1. ~/.jarvis/health-today.json  (direct write, fastest)
#   2. iCloud Drive Shortcuts folder (iPhone Shortcut saves here)
#   3. Not found → returns available:false guidance
# Check all known locations in priority order (.json and .txt — Shortcuts saves
# text-type output with .txt extension even when subpath specifies .json)
HEALTH_FILE="${HOME}/.jarvis/health-today.json"
for CANDIDATE in \
  "${HOME}/Library/Mobile Documents/com~apple~CloudDocs/Jarvis/health/health-today.json" \
  "${HOME}/Library/Mobile Documents/com~apple~CloudDocs/Jarvis/health/health-today.txt" \
  "${HOME}/Library/Mobile Documents/com~apple~CloudDocs/Shortcuts/Jarvis/health-today.json" \
  "${HOME}/Library/Mobile Documents/com~apple~CloudDocs/Shortcuts/Jarvis/health-today.txt" \
  "${HOME}/Library/Mobile Documents/iCloud~is~workflow~my~workflows/Documents/Jarvis/health-today.json" \
  "${HOME}/Library/Mobile Documents/iCloud~is~workflow~my~workflows/Documents/Jarvis/health-today.txt"; do
  if [ ! -f "$HEALTH_FILE" ] && [ -f "$CANDIDATE" ]; then
    HEALTH_FILE="$CANDIDATE"
  fi
done

if [ ! -f "$HEALTH_FILE" ]; then
  echo '{"available": false, "reason": "No health data exported yet. Run the Jarvis Health Export Shortcut on iPhone (Shortcuts app → Jarvis Health Export). It saves to iCloud Drive/Shortcuts/Jarvis/health-today.json."}'
  exit 0
fi
# Check if data is from today
TODAY=$(date +%Y-%m-%d)
MOD_DATE=$(stat -f "%Sm" -t "%Y-%m-%d" "$HEALTH_FILE" 2>/dev/null || date -r "$HEALTH_FILE" +%Y-%m-%d 2>/dev/null)
if [ "$MOD_DATE" != "$TODAY" ]; then
  echo "{\"available\": false, \"reason\": \"Health data is from $MOD_DATE, not today. Run the Shortcut to refresh.\", \"stale_data\": $(cat "$HEALTH_FILE")}"
  exit 0
fi
cat "$HEALTH_FILE"
