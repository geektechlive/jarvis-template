#!/usr/bin/env bash
# Local daemon management helper.
# Run these on the Mac Mini (or dev machine for testing).
#
# Usage:
#   ./scripts/daemon.sh start
#   ./scripts/daemon.sh stop
#   ./scripts/daemon.sh restart
#   ./scripts/daemon.sh status
#   ./scripts/daemon.sh logs

set -euo pipefail

SERVICE="com.example.jarvis"
PLIST="$HOME/Library/LaunchAgents/$SERVICE.plist"
LOG_FILE="$(dirname "$0")/../logs/agent.log"
ERR_FILE="$(dirname "$0")/../logs/agent.error.log"

cmd="${1:-status}"

case "$cmd" in
  start)
    launchctl load "$PLIST"
    echo "Started."
    ;;
  stop)
    launchctl unload "$PLIST"
    echo "Stopped."
    ;;
  restart)
    launchctl kickstart -k "gui/$(id -u)/$SERVICE"
    echo "Restarted."
    ;;
  status)
    launchctl list | grep "$SERVICE" || echo "Not running."
    ;;
  logs)
    tail -f "$LOG_FILE"
    ;;
  errors)
    tail -f "$ERR_FILE"
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status|logs|errors}"
    exit 1
    ;;
esac
