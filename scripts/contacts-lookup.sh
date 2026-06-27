#!/bin/bash
# Look up contacts from macOS Contacts.app via AppleScript.
# Outputs JSON to stdout.
#
# Usage:
#   contacts-lookup.sh --name "Sarah"           # search by name fragment
#   contacts-lookup.sh --phone "+13125551234"   # resolve phone to display name
#
# Output (--name): JSON array of { "name": "...", "phones": [...], "emails": [...] }
# Output (--phone): JSON array of { "name": "..." } (empty array if not found)
#
# Security: query is passed as an argv argument to osascript (not interpolated
# into AppleScript code), eliminating the AppleScript injection vector. Contact
# data written into JSON is escaped by the escapeJSON handler.

set -euo pipefail

MODE=""
QUERY=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)  MODE="name";  QUERY="$2"; shift 2 ;;
    --phone) MODE="phone"; QUERY="$2"; shift 2 ;;
    *) echo "Usage: contacts-lookup.sh --name <name> | --phone <phone>" >&2; exit 1 ;;
  esac
done

if [ -z "$MODE" ] || [ -z "$QUERY" ]; then
  echo "Usage: contacts-lookup.sh --name <name> | --phone <phone>" >&2
  exit 1
fi

if [ "$MODE" = "name" ]; then
  # Pass QUERY as argv so it is never interpolated into AppleScript code.
  # Quoted heredoc (<<'APPLESCRIPT') disables all bash processing so AppleScript
  # escape sequences (\\ and \") reach osascript verbatim.
  osascript - "${QUERY}" <<'APPLESCRIPT'
on run argv
  set queryStr to item 1 of argv
  tell application "Contacts"
    set hits to every person whose name contains queryStr
    set output to "["
    set itemCount to count hits
    repeat with i from 1 to itemCount
      set p to item i of hits
      set pName to my escapeJSON(name of p)
      -- phones
      set phoneList to "["
      set phoneCount to count phones of p
      repeat with j from 1 to phoneCount
        set ph to item j of phones of p
        set phoneList to phoneList & "\"" & my escapeJSON(value of ph as text) & "\""
        if j < phoneCount then set phoneList to phoneList & ","
      end repeat
      set phoneList to phoneList & "]"
      -- emails
      set emailList to "["
      set emailCount to count emails of p
      repeat with j from 1 to emailCount
        set em to item j of emails of p
        set emailList to emailList & "\"" & my escapeJSON(value of em as text) & "\""
        if j < emailCount then set emailList to emailList & ","
      end repeat
      set emailList to emailList & "]"
      set output to output & "{\"name\":\"" & pName & "\",\"phones\":" & phoneList & ",\"emails\":" & emailList & "}"
      if i < itemCount then set output to output & ","
    end repeat
    set output to output & "]"
    return output
  end tell
end run

-- Escape backslash and double-quote for safe embedding in a JSON string value.
-- Must escape backslash first; reversing the order re-introduces the vulnerability.
on escapeJSON(s)
  -- Step 1: \ → \\
  set AppleScript's text item delimiters to "\\"
  set theItems to every text item of s
  set AppleScript's text item delimiters to "\\\\"
  set s to theItems as string
  set AppleScript's text item delimiters to ""
  -- Step 2: " → \"
  set AppleScript's text item delimiters to "\""
  set theItems to every text item of s
  set AppleScript's text item delimiters to "\\\""
  set s to theItems as string
  set AppleScript's text item delimiters to ""
  return s
end escapeJSON
APPLESCRIPT

elif [ "$MODE" = "phone" ]; then
  # Strip everything except digits; drop a leading 1 (country code).
  # Digit-only string has no injection risk, but argv is used for consistency.
  DIGITS_QUERY=$(echo "${QUERY}" | tr -cd '0-9')
  DIGITS_QUERY="${DIGITS_QUERY#1}"

  osascript - "${DIGITS_QUERY}" <<'APPLESCRIPT'
on run argv
  set digitsQuery to item 1 of argv
  tell application "Contacts"
    set allPeople to every person
    repeat with p in allPeople
      repeat with ph in phones of p
        set rawPhone to value of ph as text
        -- strip non-digits from the stored number
        set digits to ""
        repeat with c in characters of rawPhone
          if c is in "0123456789" then set digits to digits & c
        end repeat
        -- drop leading country code "1" if 11 digits
        if length of digits is 11 and digits starts with "1" then
          set digits to text 2 thru -1 of digits
        end if
        if digits is digitsQuery then
          set output to "[{\"name\":\"" & my escapeJSON(name of p as text) & "\"}]"
          return output
        end if
      end repeat
    end repeat
    return "[]"
  end tell
end run

on escapeJSON(s)
  set AppleScript's text item delimiters to "\\"
  set theItems to every text item of s
  set AppleScript's text item delimiters to "\\\\"
  set s to theItems as string
  set AppleScript's text item delimiters to ""
  set AppleScript's text item delimiters to "\""
  set theItems to every text item of s
  set AppleScript's text item delimiters to "\\\""
  set s to theItems as string
  set AppleScript's text item delimiters to ""
  return s
end escapeJSON
APPLESCRIPT
fi
