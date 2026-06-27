#!/usr/bin/env bash
# SCRIPT:     reminder-create.sh
# PURPOSE:    Create a reminder in iCloud via CalDAV VTODO PUT.
# INPUT:      <title> [list] [due-date]
#             due-date: YYYY-MM-DD or YYYY-MM-DD HH:MM (local time, America/Chicago)
# OUTPUT:     JSON {uid, title, list, dueDate}
# EXIT CODES: 0=success, 1=error, 2=missing dependency
# EXAMPLE:    ./reminder-create.sh "Buy groceries"
#             ./reminder-create.sh "Doctor appointment" "Reminders" "2026-06-15"

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo '{"error":"usage: reminder-create.sh <title> [list] [due-date]"}' >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

TITLE="$1"
LIST="${2:-}"
DUE_DATE="${3:-}"

ARGS=("--title" "$TITLE")
[[ -n "$LIST" ]] && ARGS+=("--list" "$LIST")
[[ -n "$DUE_DATE" ]] && ARGS+=("--due-date" "$DUE_DATE")

exec /usr/bin/env python3 "$SCRIPT_DIR/reminders-caldav.py" create "${ARGS[@]}"
