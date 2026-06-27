#!/bin/bash
# Send an iMessage or SMS via Messages.app AppleScript.
# Requires: macOS GUI session (Mini M2 always has one)
#
# Usage: imessage-send.sh <recipient> <body> [iMessage|SMS]
#   recipient: phone number (+13125551234) or Apple ID email
#   body:      message text
#   service:   iMessage (default) or SMS
#
# Security: recipient and body are passed as argv arguments to osascript (not
# interpolated into AppleScript code), eliminating injection and newline bugs.

set -euo pipefail

RECIPIENT="${1:-}"
BODY="${2:-}"
SERVICE="${3:-iMessage}"

if [ -z "$RECIPIENT" ] || [ -z "$BODY" ]; then
  echo "Usage: imessage-send.sh <recipient> <body> [iMessage|SMS]" >&2
  exit 1
fi

if [ "$SERVICE" != "iMessage" ] && [ "$SERVICE" != "SMS" ]; then
  echo "Error: service must be 'iMessage' or 'SMS'" >&2
  exit 1
fi

osascript - "$RECIPIENT" "$BODY" "$SERVICE" <<'APPLESCRIPT'
on run argv
  set targetRecipient to item 1 of argv
  set messageBody to item 2 of argv
  set serviceType to item 3 of argv

  tell application "Messages"
    set targetService to 1st service whose service type = serviceType
    set targetBuddy to buddy targetRecipient of targetService
    send messageBody to targetBuddy
  end tell
end run
APPLESCRIPT
