#!/usr/bin/env bash
# SCRIPT: setup-discord-bot.sh
# PURPOSE: One-time interactive setup for Discord bot integration.
#          Stores secrets in macOS keychain, writes non-secret config to integrations.yaml.
# EXIT CODES: 0=success, 1=error

set -euo pipefail

REPO=/Users/<username>/Jarvis
CONFIG=$REPO/harness/config/integrations.yaml
HOSTNAME=$(hostname -s 2>/dev/null || uname -n | cut -d. -f1)

log() {
    printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

error() {
    printf 'ERROR: %s\n' "$*" >&2
    exit 1
}

banner() {
    cat <<'EOF'
╔═══════════════════════════════════════════════════════════╗
║         Jarvis Discord Bot Setup                         ║
║                                                           ║
║ This script configures Discord integration for Jarvis.   ║
║ Your bot token will be stored securely in the keychain.  ║
╚═══════════════════════════════════════════════════════════╝
EOF
}

check_on_mini() {
    # Warn if not on M2 Mini, but allow proceeding
    if [ "$HOSTNAME" != "mini" ]; then
        log "WARN: Not running on 'mini' (detected: $HOSTNAME)"
        log "WARN: This script should run on the Mac Mini where Jarvis runs."
        log "WARN: Proceeding anyway — you may need to copy secrets manually."
        read -p "Continue? (y/n) " -r
        [[ $REPLY =~ ^[Yy]$ ]] || error "Setup cancelled"
    fi
}

prompt_for_secrets() {
    log "Gathering Discord credentials..."
    echo ""

    read -p "Discord bot token (will be stored in keychain): " -rs DISCORD_TOKEN
    [ -n "$DISCORD_TOKEN" ] || error "Bot token is required"
    echo ""

    read -p "Discord webhook URL (will be stored in keychain): " -rs DISCORD_WEBHOOK_URL
    [ -n "$DISCORD_WEBHOOK_URL" ] || error "Webhook URL is required"
    echo ""

    read -p "Discord channel ID (stored in config file): " DISCORD_CHANNEL_ID
    [ -n "$DISCORD_CHANNEL_ID" ] || error "Channel ID is required"

    read -p "Discord owner user ID (stored in config file): " DISCORD_OWNER_USER_ID
    [ -n "$DISCORD_OWNER_USER_ID" ] || error "Owner user ID is required"

    echo ""
}

store_in_keychain() {
    local service="$1"
    local password="$2"

    log "Storing '$service' in keychain..."
    local sec_output
    if ! sec_output=$(security add-generic-password -U \
        -s "$service" \
        -a "$(whoami)" \
        -w "$password" 2>&1); then
        error "Failed to store '$service' in keychain: $sec_output (hint: this script needs a GUI session to unlock the login keychain; run on Mini Terminal, not via SSH)"
    fi
}

update_config_yaml() {
    local token="$1"
    local webhook="$2"
    local channel="$3"
    local owner="$4"

    log "Updating integrations.yaml with non-secret config..."

    if [ ! -f "$CONFIG" ]; then
        error "Config file not found: $CONFIG"
    fi

    if ! grep -q "^discord:" "$CONFIG"; then
        error "discord: section missing from integrations.yaml — add it manually first"
    fi

    # Targeted sed replacements on the known channel_id and owner_user_id lines
    # under the discord: section. The placeholder values are empty quoted strings.
    # Using a BSD-compatible -i.bak then rm pattern (works on both macOS and Linux).
    sed -i.bak \
        -e "s|^\(  channel_id:\) \"[^\"]*\".*|\1 \"$channel\"|" \
        -e "s|^\(  owner_user_id:\) \"[^\"]*\".*|\1 \"$owner\"|" \
        "$CONFIG"
    rm -f "${CONFIG}.bak"

    # Verify the values landed (defensive — sed silently no-ops on mismatch)
    if ! grep -q "^  channel_id: \"$channel\"" "$CONFIG"; then
        error "Failed to update channel_id in integrations.yaml (expected pattern not found)"
    fi
    if ! grep -q "^  owner_user_id: \"$owner\"" "$CONFIG"; then
        error "Failed to update owner_user_id in integrations.yaml (expected pattern not found)"
    fi
}

verify_config() {
    log "Verifying configuration..."

    if ! grep -q "discord:" "$CONFIG"; then
        error "Discord section not found in integrations.yaml"
    fi

    if ! security find-generic-password -s jarvis-discord-bot-token >/dev/null 2>&1; then
        error "Bot token not found in keychain"
    fi

    if ! security find-generic-password -s jarvis-discord-webhook >/dev/null 2>&1; then
        error "Webhook URL not found in keychain"
    fi

    log "Configuration verified!"
}

main() {
    banner
    echo ""
    check_on_mini
    prompt_for_secrets

    store_in_keychain "jarvis-discord-bot-token" "$DISCORD_TOKEN"
    store_in_keychain "jarvis-discord-webhook" "$DISCORD_WEBHOOK_URL"

    update_config_yaml "$DISCORD_TOKEN" "$DISCORD_WEBHOOK_URL" \
        "$DISCORD_CHANNEL_ID" "$DISCORD_OWNER_USER_ID"

    verify_config

    cat <<EOF

✓ Discord bot setup complete!

Next steps:
  1. Run: make deploy-discord-bot
  2. Check status: make discord-bot-status
  3. View logs: make discord-bot-logs

The bot token and webhook URL are stored securely in the macOS keychain.
EOF
}

main "$@"
