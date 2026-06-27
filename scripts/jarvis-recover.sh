#!/opt/homebrew/bin/bash
# (homebrew bash 5+ required for associative arrays; macOS system /bin/bash is 3.2)
# SCRIPT:     jarvis-recover.sh
# PURPOSE:    Idempotent "reset to known good" for all Jarvis services on M2.
#             Kills orphans, cleans stale state, bootouts and bootstraps in
#             dependency order, healthchecks each service, and notifies Discord.
# INPUT:      none
# OUTPUT:     Timestamped log to stdout and ~/Jarvis/logs/jarvis-recover.log
# EXIT CODES: 0=all services healthy, 1=one or more failed to recover, 2=pre-flight fail
# EXAMPLE:    jarvis-recover

set -euo pipefail

export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/Users/<username>/bin:/Users/<username>/.local/bin

# ---------------------------------------------------------------------------
# Config (override via env for tuning without code change)
# ---------------------------------------------------------------------------
JARVIS_RECOVER_TIMEOUT_SEC="${JARVIS_RECOVER_TIMEOUT_SEC:-90}"
REPO=/Users/<username>/Jarvis
LOG="$REPO/logs/jarvis-recover.log"
LOCKDIR=/tmp/jarvis-recover.lock

# ---------------------------------------------------------------------------
# Logging — mirrors jarvis-notify.sh style
# ---------------------------------------------------------------------------
log() {
    local msg
    msg="$(printf '[%s] %s' "$(date '+%Y-%m-%d %H:%M:%S')" "$*")"
    printf '%s\n' "$msg"
    printf '%s\n' "$msg" >> "$LOG"
}

error() {
    local msg
    msg="$(printf '[%s] ERROR: %s' "$(date '+%Y-%m-%d %H:%M:%S')" "$*")"
    printf '%s\n' "$msg" >&2
    printf '%s\n' "$msg" >> "$LOG"
}

# ---------------------------------------------------------------------------
# Pre-flight: hostname check + lock
# ---------------------------------------------------------------------------
HOSTNAME_SHORT=$(hostname -s 2>/dev/null || uname -n | cut -d. -f1)

# M2's actual hostname is "MacMini"; "mini" is the SSH alias from dev mac.
if [ "$HOSTNAME_SHORT" != "mini" ] && [ "$HOSTNAME_SHORT" != "MacMini" ]; then
    printf 'ERROR: jarvis-recover must run on M2 Mini, not "%s"\n' "$HOSTNAME_SHORT" >&2
    printf 'Run via: make recover   (SSHes to mini automatically)\n' >&2
    exit 2
fi
if [ "$(whoami)" != "<username>" ]; then
    printf 'ERROR: jarvis-recover must run as user "<username>", not "%s"\n' "$(whoami)" >&2
    exit 2
fi

if ! mkdir "$LOCKDIR" 2>/dev/null; then
    printf 'ERROR: another jarvis-recover is already running (lock: %s)\n' "$LOCKDIR" >&2
    exit 2
fi
trap 'rmdir "$LOCKDIR" 2>/dev/null || true' EXIT

mkdir -p "$REPO/logs"
START_EPOCH=$(date +%s)

log "=== jarvis-recover starting (timeout per service: ${JARVIS_RECOVER_TIMEOUT_SEC}s) ==="

# ---------------------------------------------------------------------------
# Idempotency guard: run doctor check first; if all healthy, skip restart
# ---------------------------------------------------------------------------
if command -v jarvis-doctor >/dev/null 2>&1 || [ -x "$HOME/bin/jarvis-doctor" ]; then
    DOCTOR_BIN="${HOME}/bin/jarvis-doctor"
    [ -x "$DOCTOR_BIN" ] || DOCTOR_BIN="jarvis-doctor"
    if "$DOCTOR_BIN" >/dev/null 2>&1; then
        log "All services already healthy — no action needed."
        ~/bin/jarvis-notify deploy_skipped "recover" "all services healthy, no restart required" || true
        exit 0
    fi
    log "Doctor reports degraded/down services — proceeding with recovery."
else
    log "jarvis-doctor not found in ~/bin — skipping idempotency check, proceeding unconditionally."
fi

# ---------------------------------------------------------------------------
# Service table
#   Each entry: NAME|PLIST_LABEL|PLIST_PATH|PROC_PATTERN|HEALTH_METHOD
#   HEALTH_METHOD: "curl:URL" | "proc" | "sock:PATH" | "heartbeat:PATH:MAX_SEC"
# ---------------------------------------------------------------------------

PLIST_DIR="$HOME/Library/LaunchAgents"

declare -a SVC_NAMES=(
    "vec-server"
    "ion"
    "ion-relay"
    "discord-bot"
    "deploy-watchdog"
)
declare -A SVC_LABELS=(
    [vec-server]="com.example.tools-py-vector"
    [ion]="com.dsswift.ion"
    [ion-relay]="com.example.ion-relay"
    [discord-bot]="com.example.jarvis.discord-bot"
    [deploy-watchdog]="com.example.jarvis.deploy-watchdog"
)
declare -A SVC_PLISTS=(
    [vec-server]="$PLIST_DIR/com.example.tools-py-vector.plist"
    [ion]="$PLIST_DIR/com.dsswift.ion.plist"
    [ion-relay]="$PLIST_DIR/com.example.ion-relay.plist"
    [discord-bot]="$PLIST_DIR/com.example.jarvis.discord-bot.plist"
    [deploy-watchdog]="$PLIST_DIR/com.example.jarvis.deploy-watchdog.plist"
)
declare -A SVC_PATTERNS=(
    [vec-server]="tools-py/vector-store"
    [ion]="ion serve"
    [ion-relay]="ion-relay"
    [discord-bot]="discord-bot"
    [deploy-watchdog]="deploy-watchdog.sh"
)
declare -A SVC_HEALTH=(
    [vec-server]="curl:http://127.0.0.1:9876/health"
    [ion]="ion_health"
    [ion-relay]="proc"
    [discord-bot]="heartbeat:${HOME}/.jarvis/discord-bot.heartbeat:300"
    [deploy-watchdog]="proc"
)

# ---------------------------------------------------------------------------
# Helper: wait for a condition function, with progress ticks every 15s
# ---------------------------------------------------------------------------
wait_for() {
    local label="$1"
    local max_sec="${2:-$JARVIS_RECOVER_TIMEOUT_SEC}"
    shift 2
    local elapsed=0
    local next_tick=15
    while [ "$elapsed" -lt "$max_sec" ]; do
        if "$@" >/dev/null 2>&1; then
            return 0
        fi
        sleep 1
        elapsed=$(( elapsed + 1 ))
        if [ "$elapsed" -ge "$next_tick" ]; then
            log "  waiting for $label to become healthy... ${elapsed}s elapsed"
            next_tick=$(( next_tick + 15 ))
        fi
    done
    return 1
}

# ---------------------------------------------------------------------------
# Health probe for a single service
# ---------------------------------------------------------------------------
health_check() {
    local name="$1"
    local method="${SVC_HEALTH[$name]}"
    case "$method" in
        curl:*)
            local url="${method#curl:}"
            curl -sf -o /dev/null -m 5 "$url"
            ;;
        ion_health)
            ION_SOCKET_PATH=<mac-mini-ip>:21017 ~/bin/ion health
            ;;
        proc)
            pgrep -af "${SVC_PATTERNS[$name]}" >/dev/null 2>&1
            ;;
        heartbeat:*)
            local rest="${method#heartbeat:}"
            local hb_path="${rest%%:*}"
            local hb_max="${rest##*:}"
            [ -f "$hb_path" ] || return 1
            local mtime now age
            mtime=$(stat -f %m "$hb_path" 2>/dev/null || echo 0)
            now=$(date +%s)
            age=$(( now - mtime ))
            [ "$age" -le "$hb_max" ]
            ;;
        *)
            return 1
            ;;
    esac
}

# ---------------------------------------------------------------------------
# Step 1: Kill orphan processes
# ---------------------------------------------------------------------------
log "--- Step 1: Killing orphan processes ---"
for name in "${SVC_NAMES[@]}"; do
    local_pattern="${SVC_PATTERNS[$name]}"
    if pgrep -af "$local_pattern" >/dev/null 2>&1; then
        log "  pkill $local_pattern"
        pkill -f "$local_pattern" 2>/dev/null || true
    fi
done

log "  waiting 2s for graceful exit..."
sleep 2

# Second pass: -9 any survivors
for name in "${SVC_NAMES[@]}"; do
    local_pattern="${SVC_PATTERNS[$name]}"
    if pgrep -af "$local_pattern" >/dev/null 2>&1; then
        log "  pkill -9 $local_pattern (still running)"
        pkill -9 -f "$local_pattern" 2>/dev/null || true
    fi
done

# ---------------------------------------------------------------------------
# Step 2: Clean stale state files
# ---------------------------------------------------------------------------
log "--- Step 2: Cleaning stale state ---"
if [ -S "$HOME/.ion/engine.sock" ]; then
    log "  removing stale socket: ~/.ion/engine.sock"
    rm -f "$HOME/.ion/engine.sock"
fi

# ---------------------------------------------------------------------------
# Step 3: Bootout all services
# ---------------------------------------------------------------------------
log "--- Step 3: Booting out all services ---"
UID_NUM=$(id -u)

for name in "${SVC_NAMES[@]}"; do
    local_label="${SVC_LABELS[$name]}"
    local_plist="${SVC_PLISTS[$name]}"
    log "  bootout $local_label"
    launchctl bootout "gui/$UID_NUM" "$local_plist" 2>/dev/null || true
done

# Confirm all gone (max 30s each)
for name in "${SVC_NAMES[@]}"; do
    local_label="${SVC_LABELS[$name]}"
    elapsed=0
    while launchctl list 2>/dev/null | grep -q "$local_label" && [ "$elapsed" -lt 30 ]; do
        sleep 0.5
        elapsed=$(( elapsed + 1 ))
    done
    if launchctl list 2>/dev/null | grep -q "$local_label"; then
        log "  WARN: $local_label still registered after 15s — proceeding anyway"
    else
        log "  $local_label confirmed gone"
    fi
done

# ---------------------------------------------------------------------------
# Step 4: Bootstrap in dependency order + healthcheck each
# ---------------------------------------------------------------------------
log "--- Step 4: Bootstrapping services (dependency order) ---"
FAILED_SVC=""

for name in "${SVC_NAMES[@]}"; do
    local_label="${SVC_LABELS[$name]}"
    local_plist="${SVC_PLISTS[$name]}"

    if [ ! -f "$local_plist" ]; then
        log "  SKIP $name — plist not found: $local_plist"
        continue
    fi

    log "  bootstrapping $name ($local_label)..."
    if ! launchctl bootstrap "gui/$UID_NUM" "$local_plist"; then
        error "Failed to bootstrap $name"
        FAILED_SVC="$name"
        break
    fi

    log "  waiting for $name to become healthy (max ${JARVIS_RECOVER_TIMEOUT_SEC}s)..."
    if wait_for "$name" "$JARVIS_RECOVER_TIMEOUT_SEC" health_check "$name"; then
        log "  $name: HEALTHY"
    else
        error "$name did not become healthy within ${JARVIS_RECOVER_TIMEOUT_SEC}s"
        FAILED_SVC="$name"
        break
    fi
done

# ---------------------------------------------------------------------------
# Step 5: Report and Discord notify
# ---------------------------------------------------------------------------
END_EPOCH=$(date +%s)
DURATION=$(( END_EPOCH - START_EPOCH ))

if [ -n "$FAILED_SVC" ]; then
    log "=== RECOVERY FAILED at service: $FAILED_SVC (${DURATION}s elapsed) ==="
    ~/bin/jarvis-notify deploy_failed "recover" "$FAILED_SVC" "service did not become healthy within timeout" || true
    exit 1
else
    log "=== RECOVERY COMPLETE — all services healthy (${DURATION}s) ==="
    ~/bin/jarvis-notify deploy_succeeded "recover" "all-services" "$DURATION" || true
    exit 0
fi
