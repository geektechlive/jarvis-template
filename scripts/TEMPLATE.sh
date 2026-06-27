#!/usr/bin/env bash
# SCRIPT:     my-script-name
# PURPOSE:    One sentence describing what this script does.
# INPUT:      Description of positional args ($1, $2, etc.)
# OUTPUT:     Stdout format (JSON / plain text / nothing)
# EXIT CODES: 0=success, 1=runtime error or usage error, 2=missing dependency
# EXAMPLE:    ./my-script-name arg1 arg2

set -euo pipefail

# Check argument count
if [[ $# -lt 1 ]]; then
  {
    echo "usage: my-script-name <arg1> [arg2]"
  } >&2
  exit 1
fi

# Check for required dependencies
command -v jq >/dev/null 2>&1 || {
  echo "error: jq not found in PATH" >&2
  exit 2
}

# Fetch credential from Keychain (if needed)
CREDS=$(security find-generic-password -s com.example.jarvis -a my-account -w 2>/dev/null) || {
  echo "error: credentials not found in Keychain (use: security add-generic-password -s com.example.jarvis -a my-account -w <value>)" >&2
  exit 1
}

# Main logic
my_var="$1"
result=$(echo "$my_var" | tr '[:lower:]' '[:upper:]')

# Output valid JSON on success
echo "{\"result\": \"$result\"}"
exit 0
