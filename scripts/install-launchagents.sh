#!/usr/bin/env bash
# install-launchagents.sh — install dev-machine LaunchAgents for safari-watcher
# and claude-code-ingest. Run once from the Jarvis repo root on the dev machine.
#
# Usage: bash scripts/install-launchagents.sh [--unload]
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
LOGS_DIR="$REPO_DIR/logs"

SAFARI_LABEL="com.example.safari-watcher"
INGEST_LABEL="com.example.claude-code-ingest"

SAFARI_PLIST="$REPO_DIR/scripts/com.example.safari-watcher.plist"
INGEST_PLIST="$REPO_DIR/scripts/com.example.claude-code-ingest.plist"

# --unload: stop and remove both agents
if [[ "${1:-}" == "--unload" ]]; then
    echo "Unloading LaunchAgents..."
    launchctl bootout "gui/$(id -u)" "$LAUNCH_AGENTS_DIR/$SAFARI_LABEL.plist" 2>/dev/null || true
    launchctl bootout "gui/$(id -u)" "$LAUNCH_AGENTS_DIR/$INGEST_LABEL.plist" 2>/dev/null || true
    rm -f "$LAUNCH_AGENTS_DIR/$SAFARI_LABEL.plist" "$LAUNCH_AGENTS_DIR/$INGEST_LABEL.plist"
    echo "Done."
    exit 0
fi

echo "=== Jarvis LaunchAgent installer ==="
echo "Repo: $REPO_DIR"
echo ""

# Verify uv is available
if ! command -v uv &>/dev/null && ! [[ -x /opt/homebrew/bin/uv ]]; then
    echo "ERROR: uv not found. Install via: curl -LsSf https://astral.sh/uv/install.sh | sh" >&2
    exit 1
fi

# Create log directory
mkdir -p "$LOGS_DIR"
echo "✓ Logs directory: $LOGS_DIR"

# Create ~/.jarvis if absent (for blocklist file and dedup DB)
mkdir -p "$HOME/.jarvis"
echo "✓ ~/.jarvis directory ready"

# Create Safari blocklist file if absent
BLOCKLIST="$HOME/.jarvis/safari-blocklist.txt"
if [[ ! -f "$BLOCKLIST" ]]; then
    cat > "$BLOCKLIST" <<'EOF'
# Safari extra blocklist — one domain per line.
# Lines starting with # are ignored.
# Example: example-sensitive-site.com
EOF
    echo "✓ Created $BLOCKLIST"
else
    echo "✓ Blocklist already exists: $BLOCKLIST"
fi

# Verify plist files exist
for plist in "$SAFARI_PLIST" "$INGEST_PLIST"; do
    if [[ ! -f "$plist" ]]; then
        echo "ERROR: plist not found: $plist" >&2
        exit 1
    fi
done

# Validate plists
plutil -lint "$SAFARI_PLIST" >/dev/null && echo "✓ Safari plist valid"
plutil -lint "$INGEST_PLIST" >/dev/null && echo "✓ Claude Code ingest plist valid"

# Install plists (copy to LaunchAgents)
cp "$SAFARI_PLIST" "$LAUNCH_AGENTS_DIR/$SAFARI_LABEL.plist"
cp "$INGEST_PLIST" "$LAUNCH_AGENTS_DIR/$INGEST_LABEL.plist"
echo "✓ Plists copied to $LAUNCH_AGENTS_DIR"

# Load agents (unload first if already registered)
echo ""
echo "Loading LaunchAgents..."

for label in "$SAFARI_LABEL" "$INGEST_LABEL"; do
    plist_path="$LAUNCH_AGENTS_DIR/$label.plist"
    launchctl bootout "gui/$(id -u)" "$plist_path" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$plist_path"
    echo "✓ Loaded: $label"
done

echo ""
echo "Status:"
launchctl list | grep -E "safari-watcher|claude-code-ingest" || echo "(agents not yet appearing in list — may need a moment)"

echo ""
echo "=== Install complete ==="
echo ""
echo "Next steps:"
echo "  Smoke-test safari-watcher:    uv run python3 scripts/safari-watcher.py --smoke-test"
echo "  Smoke-test claude-code-ingest: uv run python3 scripts/claude-code-ingest.py --smoke-test"
echo "  View safari logs:             tail -f $LOGS_DIR/safari-watcher.error.log"
echo "  View ingest logs:             tail -f $LOGS_DIR/claude-code-ingest.out.log"
echo "  Unload agents:                bash scripts/install-launchagents.sh --unload"
