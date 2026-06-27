#!/usr/bin/env bash
# SCRIPT: jarvis-notify.sh
# PURPOSE: Send Discord notifications for deploy events (succeed, fail, skip)
# USAGE: jarvis-notify deploy_succeeded <sha> <component> [duration_sec]
#        jarvis-notify deploy_failed <sha> <component> "<error summary>"
#        jarvis-notify deploy_skipped <sha> "<reason>"
# EXIT: Always 0 (Discord failures do not propagate)

set -euo pipefail

log() {
    printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

error() {
    printf '[%s] ERROR: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >&2
}

# Read webhook URL from macOS Keychain
read_webhook_url() {
    local service='jarvis-discord-webhook'
    local account="${USER:-<username>}"
    security find-generic-password -s "$service" -a "$account" -w 2>/dev/null || echo ""
}

# Build and send Discord embed via webhook
post_embed() {
    local webhook_url="$1"
    local title="$2"
    local description="$3"
    local color="$4"
    local fields_json="$5"

    local payload
    payload=$(jq -n \
        --arg title "$title" \
        --arg description "$description" \
        --argjson color "$color" \
        --argjson fields "$fields_json" \
        '{
            embeds: [{
                title: $title,
                description: $description,
                color: $color,
                fields: $fields
            }]
        }')

    curl -sf -X POST "$webhook_url?wait=true" \
        -H 'Content-Type: application/json' \
        -d "$payload" \
        2>/dev/null || {
        error "Discord webhook failed"
        return 1
    }
}

# Color constants
COLOR_GREEN=5096765      # 0x4CAF50
COLOR_RED=16010548       # 0xF44336
COLOR_GRAY=10394537      # 0x9E9E9E
COLOR_ORANGE=16751616    # 0xFF9800

# Main event dispatcher
notify_deploy_succeeded() {
    local sha="$1"
    local component="$2"
    local duration_sec="${3:-}"
    local commits_summary="${4:-}"
    local full_sha="${5:-}"

    local webhook_url
    webhook_url=$(read_webhook_url)
    if [ -z "$webhook_url" ]; then
        error "Discord webhook URL not found in Keychain"
        return 0  # Still exit 0 — don't break the deploy
    fi

    # Components and duration header
    local header_line
    header_line="Components: $(echo "$component" | xargs | tr ' ' '·')"
    [ -n "$duration_sec" ] && header_line="$header_line · ${duration_sec}s"

    # Build commits block (semicolon-separated from watchdog)
    local commits_block=""
    if [ -n "$commits_summary" ]; then
        commits_block=$(echo "$commits_summary" | tr ';' '\n' | sed '/^[[:space:]]*$/d' | while IFS= read -r line; do
            line=$(echo "$line" | xargs)
            [ -n "$line" ] && printf '• %s\n' "$line"
        done) || true
    fi

    # Extract issue refs from commits
    local issue_refs=""
    if [ -n "$commits_summary" ]; then
        issue_refs=$(echo "$commits_summary" | grep -oE '#[0-9]+' | sort -u | tr '\n' ' ' || true)
    fi

    # Commit link (goes into description, not a field)
    local commit_link="https://github.com/<your-org>/jarvis/commit/${full_sha:-$sha}"

    # Compose description
    local description="$header_line"
    if [ -n "$commits_block" ]; then
        description=$(printf '%s\n\n**Changes shipped:**\n%s' "$description" "$commits_block")
    fi
    if [ -n "$issue_refs" ]; then
        description=$(printf '%s\n\nIssues: %s' "$description" "$issue_refs")
    fi
    description=$(printf '%s\n\n[View commit on GitHub](%s)' "$description" "$commit_link")

    local fields='[]'

    post_embed "$webhook_url" "✅ Deploy succeeded" "$description" "$COLOR_GREEN" "$fields" || true
    log "notified Discord: deploy succeeded"
}

notify_deploy_failed() {
    local sha="$1"
    local component="$2"
    local error_summary="$3"
    local commits_summary="${4:-}"

    local webhook_url
    webhook_url=$(read_webhook_url)
    if [ -z "$webhook_url" ]; then
        error "Discord webhook URL not found in Keychain"
        return 0
    fi

    local description="$component"
    if [ -n "$commits_summary" ]; then
        local commits_line
        commits_line=$(echo "$commits_summary" | tr ';' '\n' | sed '/^[[:space:]]*$/d' | head -3 | while IFS= read -r line; do
            line=$(echo "$line" | xargs)
            [ -n "$line" ] && printf '• %s\n' "$line"
        done) || true
        [ -n "$commits_line" ] && description=$(printf '%s\n\n**Commits attempted:**\n%s' "$description" "$commits_line")
    fi

    local fields
    fields=$(jq -n --arg sha "$sha" --arg error "$error_summary" '[
        {name: "Commit", value: $sha, inline: true},
        {name: "Error", value: $error, inline: false}
    ]')

    post_embed "$webhook_url" "❌ Deploy failed" "$description" "$COLOR_RED" "$fields" || true
    log "notified Discord: deploy failed"
}

notify_deploy_skipped() {
    local sha="$1"
    local reason="$2"

    local webhook_url
    webhook_url=$(read_webhook_url)
    if [ -z "$webhook_url" ]; then
        error "Discord webhook URL not found in Keychain"
        return 0
    fi

    local fields
    fields=$(jq -n --arg sha "$sha" '[
        {name: "Commit", value: $sha, inline: true}
    ]')

    post_embed "$webhook_url" "💤 Deploy deferred" "$reason" "$COLOR_GRAY" "$fields" || true
    log "notified Discord: deploy skipped"
}

notify_embed_degraded() {
    local host="$1"

    local webhook_url
    webhook_url=$(read_webhook_url)
    if [ -z "$webhook_url" ]; then
        error "Discord webhook URL not found in Keychain"
        return 0
    fi

    local fields
    fields=$(jq -n --arg host "$host" '[
        {name: "Host", value: $host, inline: true}
    ]')

    post_embed "$webhook_url" "⚠️ Embed Ollama unreachable" "Vector memory recall is degraded. Recall will fall back to FTS until Ollama recovers." "$COLOR_ORANGE" "$fields" || true
    log "notified Discord: embed degraded"
}

notify_embed_recovered() {
    local host="$1"

    local webhook_url
    webhook_url=$(read_webhook_url)
    if [ -z "$webhook_url" ]; then
        error "Discord webhook URL not found in Keychain"
        return 0
    fi

    local fields
    fields=$(jq -n --arg host "$host" '[
        {name: "Host", value: $host, inline: true}
    ]')

    post_embed "$webhook_url" "✅ Embed Ollama recovered" "Vector memory recall restored." "$COLOR_GREEN" "$fields" || true
    log "notified Discord: embed recovered"
}

notify_log_error() {
    local subsystem="$1"
    local headline="$2"

    local webhook_url
    webhook_url=$(read_webhook_url)
    if [ -z "$webhook_url" ]; then
        error "Discord webhook URL not found in Keychain"
        return 0
    fi

    local fields
    fields=$(jq -n --arg subsystem "$subsystem" '[
        {name: "Subsystem", value: $subsystem, inline: true}
    ]')

    post_embed "$webhook_url" "🔴 Error: $subsystem" "$headline" "$COLOR_RED" "$fields" || true
    log "notified Discord: log error ($subsystem)"
}

# Argument parsing
if [ $# -lt 2 ]; then
    echo "Usage: jarvis-notify <event> <args>"
    echo "Events:"
    echo "  deploy_succeeded <sha> <component> [duration_sec]"
    echo "  deploy_failed <sha> <component> '<error_summary>'"
    echo "  deploy_skipped <sha> '<reason>'"
    echo "  embed_degraded <host>"
    echo "  embed_recovered <host>"
    echo "  log_error <subsystem> '<headline>'"
    exit 0
fi

event_type="$1"
shift

case "$event_type" in
    deploy_succeeded)
        notify_deploy_succeeded "$@"
        ;;
    deploy_failed)
        notify_deploy_failed "$@"
        ;;
    deploy_skipped)
        notify_deploy_skipped "$@"
        ;;
    embed_degraded)
        notify_embed_degraded "$@"
        ;;
    embed_recovered)
        notify_embed_recovered "$@"
        ;;
    log_error)
        notify_log_error "$@"
        ;;
    *)
        error "Unknown event: $event_type"
        exit 0
        ;;
esac

exit 0
