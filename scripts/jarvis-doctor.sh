#!/usr/bin/env bash
# SCRIPT:     jarvis-doctor.sh
# PURPOSE:    Read-only diagnostic. Audits all Jarvis services on M2 and reports
#             their real state. Does NOT modify any state.
# INPUT:      none
# OUTPUT:     Plaintext service report to stdout
# EXIT CODES: 0=all healthy, 1=one or more services degraded or down, 2=not on mini
# EXAMPLE:    jarvis-doctor

set -euo pipefail

export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/Users/<username>/bin:/Users/<username>/.local/bin

HOSTNAME_SHORT=$(hostname -s 2>/dev/null || uname -n | cut -d. -f1)

log() {
    printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

# ---------------------------------------------------------------------------
# Guard: must run on M2 Mini
# ---------------------------------------------------------------------------
# M2's actual hostname is "MacMini"; "mini" is the SSH alias from dev mac.
# Accept either, plus the user "<username>" as the signal we're on the right box.
if [ "$HOSTNAME_SHORT" != "mini" ] && [ "$HOSTNAME_SHORT" != "MacMini" ]; then
    log "ERROR: jarvis-doctor must run on M2 Mini, not '$HOSTNAME_SHORT'"
    log "Run via: make doctor   (SSHes to mini automatically)"
    exit 2
fi
if [ "$(whoami)" != "<username>" ]; then
    log "ERROR: jarvis-doctor must run as user '<username>', not '$(whoami)'"
    exit 2
fi

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# print_row LABEL VALUE
print_row() {
    printf '  %-14s %s\n' "$1" "$2"
}

# launchctl_state LABEL
launchctl_state() {
    local label="$1"
    launchctl list "$label" 2>/dev/null | awk '/[[:space:]]"state"/ {gsub(/[";,]/, "", $NF); print $NF}' \
        || echo "not-loaded"
}

# pgrep_result PATTERN
pgrep_result() {
    local pattern="$1"
    pgrep -af "$pattern" 2>/dev/null | head -3 || echo "not running"
}

# log_tail PATH LINES
log_tail() {
    local path="$1" lines="${2:-3}"
    if [ -f "$path" ]; then
        tail -"$lines" "$path" 2>/dev/null | sed 's/^/    /'
    else
        echo "    (no log at $path)"
    fi
}

# curl_health URL → "pass (NNms)" or "fail: <reason>" or "unreachable"
curl_health() {
    local url="$1"
    # macOS BSD date has no %N (nanoseconds); seconds precision is plenty for a diagnostic.
    local start end secs
    start=$(date +%s)
    local http_code
    http_code=$(curl -sf -o /dev/null -w "%{http_code}" -m 5 "$url" 2>/dev/null || echo "000")
    end=$(date +%s)
    secs=$(( end - start ))
    if [ "$http_code" = "200" ]; then
        echo "pass (${secs}s)"
    elif [ "$http_code" = "000" ]; then
        echo "unreachable"
    else
        echo "fail: HTTP $http_code"
    fi
}

# file_recent PATH MAX_SECONDS → "recent (<Ns ago)" or "stale (Ns ago)" or "missing"
file_recent() {
    local path="$1" max_sec="$2"
    if [ ! -f "$path" ]; then
        echo "missing"
        return
    fi
    local mtime now age
    mtime=$(stat -f %m "$path" 2>/dev/null || echo 0)
    now=$(date +%s)
    age=$(( now - mtime ))
    if [ "$age" -le "$max_sec" ]; then
        echo "recent (${age}s ago)"
    else
        echo "stale (${age}s ago)"
    fi
}

# ---------------------------------------------------------------------------
# Service definitions (name plist_label process_pattern log_path)
# ---------------------------------------------------------------------------

# Retry window for transient checks (curl:, sock:, proc).
# 40s covers ion's ThrottleInterval=30s plus a generous respawn/init margin.
# heartbeat: checks are NOT retried — staleness is inherently time-based.
RETRY_WINDOW_SEC=40
RETRY_INTERVAL_SEC=3

VERDICTS=()      # parallel to service names
NAMES=()

diagnose_service() {
    local name="$1"
    local plist_label="$2"
    local proc_pattern="$3"
    local log_path="$4"
    local health_method="$5"   # "curl:URL" | "proc" | "sock:PATH" | "heartbeat:PATH:MAX_SEC"

    echo ""
    echo "[$name]"

    # heartbeat: checks are inherently time-based and cannot recover in a poll
    # window, so we run them once and skip the retry loop.
    if [[ "$health_method" == heartbeat:* ]]; then
        local proc_out lctl_state health_out
        proc_out=$(pgrep_result "$proc_pattern")
        lctl_state=$(launchctl_state "$plist_label")
        local rest="${health_method#heartbeat:}"
        local hb_path="${rest%%:*}"
        local hb_max="${rest##*:}"
        local hb_result
        hb_result=$(file_recent "$hb_path" "$hb_max")
        if [[ "$hb_result" == recent* ]]; then
            health_out="pass ($hb_result)"
        else
            health_out="fail ($hb_result)"
        fi
        print_row "process:" "$proc_out"
        print_row "launchctl:" "$lctl_state"
        print_row "health:" "$health_out"
    else
        # For curl:, sock:, and proc: poll until healthy or the retry window
        # expires.  This makes the doctor tolerant of a service that is briefly
        # down during a launchd respawn (ThrottleInterval=30s on ion means the
        # socket can be absent for up to ~30s after a kickstart -k).
        local proc_out lctl_state health_out
        local deadline
        deadline=$(( $(date +%s) + RETRY_WINDOW_SEC ))
        local attempt=0

        while true; do
            proc_out=$(pgrep_result "$proc_pattern")
            lctl_state=$(launchctl_state "$plist_label")

            case "$health_method" in
                curl:*)
                    local url="${health_method#curl:}"
                    health_out=$(curl_health "$url")
                    ;;
                sock:*)
                    local sock="${health_method#sock:}"
                    if [ -S "$sock" ]; then
                        health_out="pass (socket present)"
                    else
                        health_out="fail (socket missing: $sock)"
                    fi
                    ;;
                proc)
                    if [[ "$proc_out" == "not running" ]]; then
                        health_out="fail (process not found)"
                    else
                        health_out="pass (process alive)"
                    fi
                    ;;
                *)
                    health_out="unknown"
                    ;;
            esac

            # Already healthy — done.
            if [[ "$lctl_state" == "running" ]] && [[ "$health_out" == pass* ]]; then
                break
            fi

            # Window expired — accept current (failing) values.
            if [ "$(date +%s)" -ge "$deadline" ]; then
                break
            fi

            attempt=$(( attempt + 1 ))
            sleep "$RETRY_INTERVAL_SEC"
        done

        # Print values from the final poll iteration.
        if [ "$attempt" -gt 0 ]; then
            print_row "process:" "$proc_out (after ${attempt} retries)"
            print_row "launchctl:" "$lctl_state (after ${attempt} retries)"
        else
            print_row "process:" "$proc_out"
            print_row "launchctl:" "$lctl_state"
        fi
        print_row "health:" "$health_out"
    fi

    # Log tail
    print_row "log_tail:" ""
    log_tail "$log_path" 3

    # Verdict (shared for both paths — uses the variables set above)
    local verdict
    if [[ "$lctl_state" == "running" ]] && [[ "$health_out" == pass* ]]; then
        verdict="HEALTHY"
    elif [[ "$proc_out" == "not running" ]] || [[ "$health_out" == fail* ]] || [[ "$health_out" == "unreachable" ]]; then
        verdict="DOWN"
    else
        verdict="DEGRADED"
    fi

    print_row "verdict:" "$verdict"
    NAMES+=("$name")
    VERDICTS+=("$verdict")
}

diagnose_venv() {
    echo ""
    echo "[venv]"

    local result
    local venv_ok=false
    if /opt/homebrew/bin/uv run pyright --version >/dev/null 2>&1; then
        result="pass (uv run pyright --version ok)"
        venv_ok=true
    else
        result="fail (uv run pyright --version failed — possible stale shebang)"
    fi
    print_row "check:" "$result"

    # Extra: show shebangs in .venv/bin that reference wrong project paths
    local stale
    # Looks for stale shebangs that survived the AgentHarness→Jarvis rename.
    # This is intentional — the doctor LOOKS FOR this pattern; do not "fix" it
    # to /Jarvis/ in a future cleanup.
    stale=$(grep -rl '/AgentHarness/' /Users/<username>/Jarvis/.venv/bin/ 2>/dev/null | head -3 || true)
    if [ -n "$stale" ]; then
        print_row "stale_shims:" "$(echo "$stale" | tr '\n' ' ')"
    else
        print_row "stale_shims:" "none detected"
    fi

    local verdict
    if $venv_ok; then
        verdict="HEALTHY"
    else
        verdict="DEGRADED"
    fi
    print_row "verdict:" "$verdict"
    NAMES+=("venv")
    VERDICTS+=("$verdict")
}

# ---------------------------------------------------------------------------
# Run diagnostics
# ---------------------------------------------------------------------------

echo "=============================="
echo " Jarvis Doctor — $(date '+%Y-%m-%d %H:%M:%S')"
echo "=============================="

REPO=/Users/<username>/Jarvis

diagnose_service \
    "ion" \
    "com.dsswift.ion" \
    "ion serve" \
    "$REPO/logs/ion.error.log" \
    "proc"
    # ion health uses the socket below; check sock existence as secondary
    if [ -S "$HOME/.ion/engine.sock" ]; then
        echo "  ion_socket:   present"
    else
        echo "  ion_socket:   missing (~/.ion/engine.sock)"
    fi
    # Also try ion health for a live probe
    if ION_SOCKET_PATH=<mac-mini-ip>:21017 ~/bin/ion health >/dev/null 2>&1; then
        echo "  ion_probe:    pass"
    else
        echo "  ion_probe:    fail (ion health returned non-zero)"
    fi

diagnose_service \
    "vec-server" \
    "com.example.tools-py-vector" \
    "tools-py/vector-store" \
    "$REPO/logs/vector.error.log" \
    "curl:http://127.0.0.1:9876/health"

diagnose_service \
    "discord-bot" \
    "com.example.jarvis.discord-bot" \
    "discord-bot" \
    "$REPO/logs/discord-bot.error.log" \
    "heartbeat:${HOME}/.jarvis/discord-bot.heartbeat:300"

diagnose_service \
    "deploy-watchdog" \
    "com.example.jarvis.deploy-watchdog" \
    "deploy-watchdog.sh" \
    "$REPO/logs/deploy-watchdog.log" \
    "proc"

diagnose_service \
    "ion-relay" \
    "com.example.ion-relay" \
    "ion-relay" \
    "${HOME}/Library/Logs/ion-relay.error.log" \
    "proc"

diagnose_venv

# ---------------------------------------------------------------------------
# Aggregate footer
# ---------------------------------------------------------------------------

echo ""
echo "=============================="
echo " Summary"
echo "=============================="

COUNT_HEALTHY=0
COUNT_DEGRADED=0
COUNT_DOWN=0
DOWN_NAMES=()
DEGRADED_NAMES=()

for i in "${!VERDICTS[@]}"; do
    case "${VERDICTS[$i]}" in
        HEALTHY)  COUNT_HEALTHY=$(( COUNT_HEALTHY + 1 )) ;;
        DEGRADED) COUNT_DEGRADED=$(( COUNT_DEGRADED + 1 )); DEGRADED_NAMES+=("${NAMES[$i]}") ;;
        DOWN)     COUNT_DOWN=$(( COUNT_DOWN + 1 ));     DOWN_NAMES+=("${NAMES[$i]}") ;;
    esac
done

TOTAL="${#VERDICTS[@]}"

if [ "$COUNT_DOWN" -gt 0 ]; then
    echo "AGGREGATE: ${COUNT_DOWN} DOWN / ${COUNT_DEGRADED} DEGRADED / ${COUNT_HEALTHY} HEALTHY (of ${TOTAL})"
    echo "DOWN:      ${DOWN_NAMES[*]:-none}"
    [ "${#DEGRADED_NAMES[@]}" -gt 0 ] && echo "DEGRADED:  ${DEGRADED_NAMES[*]}"
    echo ""
    echo "Recommended actions:"
    echo "  make recover    — full idempotent service reset"
    exit 1
elif [ "$COUNT_DEGRADED" -gt 0 ]; then
    echo "AGGREGATE: ${COUNT_DEGRADED} DEGRADED / ${COUNT_HEALTHY} HEALTHY (of ${TOTAL})"
    echo "DEGRADED:  ${DEGRADED_NAMES[*]}"
    echo ""
    echo "Recommended actions:"
    echo "  make recover    — full idempotent service reset"
    exit 1
else
    echo "AGGREGATE: ALL HEALTHY (${COUNT_HEALTHY}/${TOTAL})"
    exit 0
fi
