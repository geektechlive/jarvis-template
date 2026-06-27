#!/usr/bin/env bash
# SCRIPT:     reminder-list.sh
# PURPOSE:    List reminders from iCloud via CalDAV VTODO query.
# INPUT:      Optional positional arg: list (calendar collection) name to filter by.
#             Optional --all flag to include completed reminders (default: incomplete only).
# OUTPUT:     JSON array of {uid, title, dueDate, completed, list, priority}
# EXIT CODES: 0=success, 1=error, 2=missing dependency
# EXAMPLE:    ./reminder-list.sh
#             ./reminder-list.sh "Reminders"
#             ./reminder-list.sh --all

set -euo pipefail

LIST_FILTER=""
INCLUDE_COMPLETED=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --all) INCLUDE_COMPLETED=true; shift ;;
    --) shift; LIST_FILTER="${1:-}"; shift || true ;;
    -*) echo "error: unknown flag $1" >&2; exit 1 ;;
    *) LIST_FILTER="$1"; shift ;;
  esac
done

# Delegate to the Python CalDAV implementation which handles credential loading,
# discovery, VTODO parsing, and JSON output.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ARGS=()
[[ -n "$LIST_FILTER" ]] && ARGS+=("--list" "$LIST_FILTER")
[[ "$INCLUDE_COMPLETED" == "true" ]] && ARGS+=("--all")

exec /usr/bin/env python3 "$SCRIPT_DIR/reminders-caldav.py" list "${ARGS[@]}"
