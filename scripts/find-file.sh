#!/usr/bin/env bash
set -euo pipefail
[[ $# -eq 0 ]] && { echo "Usage: find-file <filename>" >&2; exit 1; }
mdfind -name "$1" -onlyin /Users/<username> 2>/dev/null \
  | grep -v '\.Trash\|/Library/Caches\|/Library/Application Support\|\.noindex' \
  | head -20
