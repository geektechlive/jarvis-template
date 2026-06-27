#!/usr/bin/env zsh
set -euo pipefail

cd "$(dirname "$0")/.."

TOKEN=$(ssh mini 'cat ~/.jarvis/token' 2>/dev/null)
if [[ -z "$TOKEN" ]]; then
    echo "error: could not read token from mini -- is the server running? (make logs)" >&2
    exit 1
fi

export AGENT_HARNESS_URL=http://<mac-mini-ip>:8765
export AGENT_HARNESS_TOKEN=$TOKEN

exec uv run python -m harness
