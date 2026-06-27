#!/usr/bin/env bash
# One-time setup script for the Mac Mini M1.
# Run this via SSH after cloning the repo.
#
# Usage:
#   ssh mini "bash ~/Jarvis/scripts/setup_mini.sh"

set -euo pipefail

REPO_DIR="$HOME/Jarvis"
PLIST_NAME="com.example.jarvis.plist"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"

echo "==> Jarvis setup starting..."

# 1. Homebrew deps
echo "==> Installing brew packages..."
brew install uv ollama llmfit 2>/dev/null || true

# 2. Python deps
echo "==> Installing Python dependencies..."
cd "$REPO_DIR"
uv sync
uv sync --extra voice  # Kokoro TTS (mlx-audio, soundfile, numpy)

# 3. .env
if [ ! -f "$REPO_DIR/.env" ]; then
    echo "==> Creating .env from template..."
    cp "$REPO_DIR/.env.example" "$REPO_DIR/.env"
    echo ""
    echo "  ACTION REQUIRED: Fill in your tokens in $REPO_DIR/.env"
    echo "  Then re-run: launchctl load $LAUNCH_AGENTS/$PLIST_NAME"
    echo ""
fi

# 4. Logs directory
mkdir -p "$REPO_DIR/logs"

# 5. Ollama models
echo "==> Starting Ollama..."
brew services start ollama 2>/dev/null || ollama serve &>/dev/null &
sleep 3

echo "==> Pulling Ollama models (this takes a while)..."
ollama pull nomic-embed-text
ollama pull qwen2.5:3b
ollama pull llama3.1:8b
ollama pull qwen2.5-coder:7b

# 6. launchd
echo "==> Installing launchd agent..."
mkdir -p "$LAUNCH_AGENTS"
cp "$REPO_DIR/$PLIST_NAME" "$LAUNCH_AGENTS/$PLIST_NAME"
launchctl load "$LAUNCH_AGENTS/$PLIST_NAME" 2>/dev/null || true

echo ""
echo "==> Setup complete."
echo "    Check status:  launchctl list | grep jarvis"
echo "    View logs:     tail -f $REPO_DIR/logs/agent.log"
echo ""
echo "    If .env was just created, fill it in then run:"
echo "    launchctl kickstart -k gui/\$(id -u)/com.example.jarvis"
