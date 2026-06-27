#!/bin/bash
# iMessage watcher — reads chat.db for new inbound messages and POSTs them to
# the Jarvis webhook. Triggered by launchd WatchPaths on ~/Library/Messages/.
#
# Idempotency: ROWID cursor file tracks last-processed position.
# Cursor advances only after a successful webhook POST (exit 0).
# On failure (exit 1), launchd will retry on next directory change.
#
# Requires: Full Disk Access granted to /usr/bin/sqlite3
# Token:    IMESSAGE_WEBHOOK_TOKEN env var (set in harness launchd plist)

set -euo pipefail

CURSOR_FILE="${HOME}/.jarvis/imessage_cursor_rowid"
CHAT_DB="${HOME}/Library/Messages/chat.db"
# ion's webhooks SDK runs ONE listener for all routes; its built-in default is
# 127.0.0.1:7421. engine.json port/bindInterface overrides are currently inert
# because of an upstream config-merge bug (dsswift/ion#242 -- mergeInto drops the
# webhooks block), so we target ion's actual default, 7421. The local watcher
# reaches it over loopback. Overridable via IMESSAGE_WEBHOOK_PORT (raise to 8765
# once #242 lands and we pin the listener for the LAN-facing UniFi webhook).
WEBHOOK_URL="http://127.0.0.1:${IMESSAGE_WEBHOOK_PORT:-7421}/webhook/imessage"
TOKEN="${IMESSAGE_WEBHOOK_TOKEN:-}"
LOG_PREFIX="imessage-watcher"

mkdir -p "$(dirname "$CURSOR_FILE")"

LAST_ROWID=$(cat "$CURSOR_FILE" 2>/dev/null || echo "0")

# Verify FDA
if ! /usr/bin/sqlite3 "$CHAT_DB" "SELECT 1" >/dev/null 2>&1; then
  echo "[ERROR] ${LOG_PREFIX}: cannot read chat.db -- grant Full Disk Access to /usr/bin/sqlite3" >&2
  exit 1
fi

# Query inbound messages since last cursor (limit 50 per batch)
MESSAGES=$(/usr/bin/sqlite3 -json "$CHAT_DB" \
  "SELECT
     m.ROWID     AS rowid,
     m.guid      AS guid,
     COALESCE(m.text, '') AS text,
     m.date      AS date,
     m.cache_has_attachments AS cache_has_attachments,
     h.id        AS sender_id,
     COALESCE(h.service, 'iMessage') AS service,
     COALESCE(c.display_name, c.chat_identifier, '') AS chat_name,
     (SELECT COUNT(DISTINCT chj.handle_id)
      FROM chat_message_join cmj2
      JOIN chat_handle_join chj ON chj.chat_id = cmj2.chat_id
      WHERE cmj2.message_id = m.ROWID) AS participant_count
   FROM message m
   LEFT JOIN handle h ON m.handle_id = h.ROWID
   LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
   LEFT JOIN chat c ON cmj.chat_id = c.ROWID
   WHERE m.is_from_me = 0
     AND m.ROWID > ${LAST_ROWID}
   ORDER BY m.ROWID ASC
   LIMIT 50" 2>/dev/null || echo "[]")

# Nothing new
if [ "$MESSAGES" = "[]" ] || [ -z "$MESSAGES" ]; then
  exit 0
fi

# Determine max ROWID among the rows actually fetched in this batch.
# We derive it from $MESSAGES (the already-fetched JSON) so the cursor
# never skips rows 51-N when the backlog exceeds the batch limit of 50.
MAX_ROWID=$(/usr/bin/python3 -c \
  'import json,sys; rows=json.load(sys.stdin); print(max(r["rowid"] for r in rows) if rows else 0)' \
  <<< "$MESSAGES" 2>/dev/null || echo "$LAST_ROWID")

if [ -z "$MAX_ROWID" ] || [ "$MAX_ROWID" = "0" ]; then
  MAX_ROWID="$LAST_ROWID"
fi

# POST to webhook
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "$WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${TOKEN}" \
  --data-raw "$MESSAGES" \
  --max-time 10 2>/dev/null || echo "000")

if [ "$HTTP_STATUS" = "200" ]; then
  echo "$MAX_ROWID" > "$CURSOR_FILE"
  echo "[INFO] ${LOG_PREFIX}: posted $(echo "$MESSAGES" | /usr/bin/python3 -c 'import json,sys; print(len(json.load(sys.stdin)))' 2>/dev/null || echo "?") messages (cursor=$MAX_ROWID)"
else
  echo "[WARN] ${LOG_PREFIX}: webhook returned HTTP ${HTTP_STATUS} -- cursor not advanced, will retry" >&2
  exit 1
fi
