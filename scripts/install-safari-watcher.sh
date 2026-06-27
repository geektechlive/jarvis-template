#!/usr/bin/env bash
# Install the Safari ambient watcher as a LaunchAgent on the current host.
# Run once per Safari host: MacBook (dev) and M4 Mini.
#
#   bash scripts/install-safari-watcher.sh
#
# Reads /Users/<username>/Library/Safari/History.db (read-only). Requires the
# user to grant Terminal (or whichever shell) "Full Disk Access" in System
# Settings → Privacy & Security, otherwise History.db reads return empty.

set -euo pipefail

REPO="$(cd "$(dirname "$0")"/.." && pwd)"
BIN_DIR="$HOME/bin"
LOG_DIR="$HOME/Jarvis/logs"
PLIST_NAME="com.example.safari-watcher.plist"
LAUNCH_DIR="$HOME/Library/LaunchAgents"
DST_PLIST="$LAUNCH_DIR/$PLIST_NAME"

echo "→ Installing safari-watcher to $BIN_DIR/"
mkdir -p "$BIN_DIR"
cp "$REPO/scripts/safari-watcher.py" "$BIN_DIR/safari-watcher.py"
chmod +x "$BIN_DIR/safari-watcher.py"

mkdir -p "$LOG_DIR"
mkdir -p "$LAUNCH_DIR"

echo "→ Writing LaunchAgent $DST_PLIST"
cp "$REPO/scripts/$PLIST_NAME" "$DST_PLIST"

if launchctl list "com.example.safari-watcher" >/dev/null 2>&1; then
  echo "→ Unloading existing agent"
  launchctl unload "$DST_PLIST" 2>/dev/null || true
fi

echo "→ Loading agent"
launchctl load "$DST_PLIST"

echo
echo "✓ safari-watcher installed."
echo "  Run a one-shot dry-run to confirm the History.db read works:"
echo "    $BIN_DIR/safari-watcher.py --dry-run --hours 1"
echo
echo "  If history is empty, grant Terminal Full Disk Access in System Settings"
echo "  → Privacy & Security → Full Disk Access, then re-run."
