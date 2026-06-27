#!/usr/bin/env bash
# SCRIPT:     reminder-complete.sh
# PURPOSE:    Mark a reminder complete in iCloud via CalDAV VTODO PUT.
# INPUT:      <title-or-uid> [list]
#             Matches by title substring (case-insensitive) or exact UID.
# OUTPUT:     JSON {success, title, uid, list}
# EXIT CODES: 0=success, 1=error (not found or update failed), 2=missing dependency
# EXAMPLE:    ./reminder-complete.sh "Buy groceries"
#             ./reminder-complete.sh "Buy groceries" "Reminders"

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo '{"error":"usage: reminder-complete.sh <title-or-uid> [list]"}' >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

QUERY="$1"
LIST="${2:-}"

ARGS=("--query" "$QUERY")
[[ -n "$LIST" ]] && ARGS+=("--list" "$LIST")

exec /usr/bin/env python3 "$SCRIPT_DIR/reminders-caldav.py" complete "${ARGS[@]}"
