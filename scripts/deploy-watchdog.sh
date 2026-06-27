#!/usr/bin/env bash
# SCRIPT: deploy-watchdog.sh
# PURPOSE: Pull origin main, run make check, and deploy when new commits arrive.
#          Writes outcomes to vec-server memory so Jarvis surfaces them in briefings.
# INPUT: reads ~/.jarvis-deployed-sha for the last successfully deployed commit
# OUTPUT: logs/deploy-watchdog.log; POSTs to vec-server /remember on success or failure
# EXIT CODES: 0=nothing to deploy or deploy succeeded, 1=check failed or deploy error

set -euo pipefail

REPO=/Users/<username>/Jarvis
LOG=$REPO/logs/deploy-watchdog.log
SHA_FILE=~/.jarvis-deployed-sha
BLOCKED_SHA_FILE=~/.jarvis-deployed-sha.rollback-blocked
VEC_URL=http://127.0.0.1:9876

# Ion healthcheck timeout. Override via env to tune without code change.
ION_HEALTH_TIMEOUT_SEC="${ION_HEALTH_TIMEOUT_SEC:-90}"

export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/Users/<username>/bin:/Users/<username>/.local/bin

log() {
    printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

# ---------------------------------------------------------------------------
# EXIT trap — guarantees a Discord notification fires on any exit path,
# including unexpected crashes. Status is updated via DEPLOY_STATUS before
# explicit exits; unknown means the script died at an unexpected point.
# ---------------------------------------------------------------------------
DEPLOY_STATUS="unknown"
DEPLOY_FAILURE_REASON=""
DEPLOY_COMPONENT="watchdog"
DEPLOY_SHA_FOR_TRAP="unknown"
DEPLOY_PARTS_FOR_TRAP=""
DEPLOY_DURATION_FOR_TRAP=0
COMMIT_SUMMARY=""
NEW_SHA=""
_TRAP_FIRED=false
_DEPLOY_START_EPOCH=$(date +%s)

on_exit() {
    # Prevent double-fire if exit is already handled inline
    if [ "$_TRAP_FIRED" = "true" ]; then return; fi
    _TRAP_FIRED=true
    local _end _dur
    _end=$(date +%s)
    _dur=$(( _end - _DEPLOY_START_EPOCH ))
    case "$DEPLOY_STATUS" in
        success)
            ~/bin/jarvis-notify deploy_succeeded "$DEPLOY_SHA_FOR_TRAP" "$DEPLOY_PARTS_FOR_TRAP" "$_dur" "$COMMIT_SUMMARY" "$NEW_SHA" || true
            ;;
        failed)
            ~/bin/jarvis-notify deploy_failed "$DEPLOY_SHA_FOR_TRAP" "${DEPLOY_COMPONENT}" "$DEPLOY_FAILURE_REASON" "$COMMIT_SUMMARY" || true
            ;;
        skipped)
            ~/bin/jarvis-notify deploy_skipped "$DEPLOY_SHA_FOR_TRAP" "$DEPLOY_FAILURE_REASON" || true
            ;;
        nothing)
            # No-op: no new commit, nothing to report
            ;;
        *)
            # unknown: script crashed at an unexpected point
            ~/bin/jarvis-notify deploy_failed "${DEPLOY_SHA_FOR_TRAP}" "watchdog" "watchdog crashed (status=unknown, exit=$?)" "$COMMIT_SUMMARY" || true
            ;;
    esac
}

trap on_exit EXIT

remember() {
    local text="$1"
    local encoded
    encoded=$(printf '%s' "$text" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')
    curl -sf -X POST "$VEC_URL/remember" \
        -H 'Content-Type: application/json' \
        -d "{\"text\": $encoded, \"collection\": \"agent_memories\", \"source\": \"deploy-watchdog\"}" \
        2>/dev/null \
        || log "WARN: vec-server unreachable, outcome not stored in memory"
}

mkdir -p "$REPO/logs"
cd "$REPO"

git pull origin main --quiet --autostash

NEW_SHA=$(git rev-parse HEAD)
SHORT_NEW=$(git rev-parse --short HEAD)
DEPLOYED_SHA=$(cat "$SHA_FILE" 2>/dev/null || echo "")
SHORT_OLD=$([ -n "$DEPLOYED_SHA" ] && printf '%.7s' "$DEPLOYED_SHA" || echo "none")

# Check rollback-blocked list to prevent looping on a broken commit
if [ -f "$BLOCKED_SHA_FILE" ]; then
  BLOCKED_SHA=$(cat "$BLOCKED_SHA_FILE")
  if [ "$NEW_SHA" = "$BLOCKED_SHA" ]; then
    log "rollback-blocked: $SHORT_NEW is blocked due to prior rollback; awaiting a new commit"
    DEPLOY_STATUS="skipped"
    DEPLOY_FAILURE_REASON="rollback-blocked: awaiting new commit"
    exit 0
  else
    # Different SHA = genuine fix; clear the block
    rm -f "$BLOCKED_SHA_FILE"
  fi
fi
BUILD_DATE=$(date '+%Y-%m-%d %H:%M')

# Track SHA for trap use
DEPLOY_SHA_FOR_TRAP="$SHORT_NEW"

# Record previous SHA (for rollback forensics)
cp "$SHA_FILE" "$SHA_FILE.prev" 2>/dev/null || true

# --- Embed Ollama health check (runs every cycle regardless of SHA) ---
EMBED_HEALTH_FILE=~/.jarvis-embed-health
EMBED_HOST=$(grep -A1 'OLLAMA_EMBED_HOST' ~/Library/LaunchAgents/com.example.tools-py-vector.plist 2>/dev/null \
    | grep '<string>' | sed 's/.*<string>\(.*\)<\/string>.*/\1/' \
    || echo "http://127.0.0.1:11434")
PREV_EMBED_STATE=$(cat "$EMBED_HEALTH_FILE" 2>/dev/null || echo "ok")

if curl -sf --connect-timeout 3 "$EMBED_HOST/api/tags" > /dev/null 2>&1; then
    CUR_EMBED_STATE="ok"
else
    CUR_EMBED_STATE="degraded"
fi

if [ "$CUR_EMBED_STATE" != "$PREV_EMBED_STATE" ]; then
    echo "$CUR_EMBED_STATE" > "$EMBED_HEALTH_FILE"
    if [ "$CUR_EMBED_STATE" = "degraded" ]; then
        log "WARN: embed Ollama at $EMBED_HOST is unreachable — vector recall degraded"
        ~/bin/jarvis-notify embed_degraded "$EMBED_HOST" || true
    else
        log "embed Ollama at $EMBED_HOST recovered"
        ~/bin/jarvis-notify embed_recovered "$EMBED_HOST" || true
    fi
fi

if [ "$NEW_SHA" = "$DEPLOYED_SHA" ]; then
    DEPLOY_STATUS="nothing"
    exit 0
fi

ROLLBACK_ATTEMPTED=false

if [ -n "$DEPLOYED_SHA" ]; then
    COMMIT_SUMMARY=$(git log --oneline "$DEPLOYED_SHA..$NEW_SHA" 2>/dev/null | head -5 | tr '\n' '; ' || echo "unknown")
else
    COMMIT_SUMMARY=$(git log --oneline -5 2>/dev/null | tr '\n' '; ' || echo "unknown")
fi

log "new commit $SHORT_NEW (was $SHORT_OLD)"
log "commits: $COMMIT_SUMMARY"

# --- Untracked-file guard -------------------------------------------------
# A stray UNTRACKED file in a linted path (harness/ tools-py/ scripts/ tests/
# harness-ts/) makes `make check` fail; because `git pull --autostash` preserves
# untracked files, it would wedge the deploy on every tick behind an opaque lint
# dump. Surface the file list and SKIP (not fail, never auto-delete) so the
# principal can act. Keys on UNTRACKED only -- committed staff work still deploys.
# Keep this path list in sync with the `lint` target in the Makefile.
UNTRACKED_LINTED=$(git -C "$REPO" status --porcelain --untracked-files=all \
    | grep -E '^\?\? (harness/|tools-py/|scripts/|tests/|harness-ts/)' \
    | sed 's/^?? //' || true)
if [ -n "$UNTRACKED_LINTED" ]; then
    UNTRACKED_ONELINE=$(echo "$UNTRACKED_LINTED" | tr '\n' ' ')
    log "SKIP: untracked files in linted paths would fail make check: $UNTRACKED_ONELINE"
    DEPLOY_STATUS="skipped"
    DEPLOY_FAILURE_REASON="untracked files in linted paths: $UNTRACKED_ONELINE"
    exit 0
fi

log "running make check..."

CHECK_LOG=$REPO/logs/deploy-check-$SHORT_NEW.log

if ! make -C "$REPO" check > "$CHECK_LOG" 2>&1; then
    log "FAILED: make check — see $CHECK_LOG"

    TAIL=$(tail -20 "$CHECK_LOG")
    DIAGNOSIS="(diagnosis not available)"

    if command -v claude &>/dev/null; then
        log "spawning claude to diagnose..."
        PROMPT="Jarvis CI check failed for commit $SHORT_NEW.

Error output (last 20 lines):
$TAIL

Diagnose the root cause in 2-3 sentences. Name the specific file and line number if visible. Do not suggest running commands or attempt a fix."
        DIAGNOSIS=$(claude -p "$PROMPT" 2>/dev/null || echo "(diagnosis failed)")
        log "diagnosis: $DIAGNOSIS"
        printf '\n--- Claude diagnosis ---\n%s\n' "$DIAGNOSIS" >> "$CHECK_LOG"
    fi

    DEPLOY_STATUS="failed"
    DEPLOY_COMPONENT="check"
    DEPLOY_FAILURE_REASON="$(echo "$TAIL" | head -3)"

    remember "Deploy FAILED $BUILD_DATE: old build $SHORT_OLD, rejected build $SHORT_NEW. Tests did not pass. Commits: $COMMIT_SUMMARY Diagnosis: $DIAGNOSIS"
    exit 1
fi

log "make check passed"

# --- Detect which components changed since the last deployed commit ---
CHANGED=""
if [ -n "$DEPLOYED_SHA" ]; then
    CHANGED=$(git diff --name-only "$DEPLOYED_SHA" "$NEW_SHA" 2>/dev/null || echo "")
fi

NEEDS_ION=false     # ion/engine/ Go source changed
NEEDS_TS=false      # harness-ts/ or harness/config/ changed
NEEDS_AGENTS=false  # agent/worker/identity specs changed (hot-reload, no restart)
NEEDS_VEC=false     # tools-py/ or harness/memory/ changed
NEEDS_SCRIPTS=false # scripts/ changed
NEEDS_DATA=false    # harness/data/ runtime YAML changed (no deployment needed)

if [ -n "$CHANGED" ]; then
    echo "$CHANGED" | grep -q  "^ion/engine/"                                            && NEEDS_ION=true     || true
    echo "$CHANGED" | grep -qE "^harness-ts/"                                            && NEEDS_TS=true      || true
    echo "$CHANGED" | grep -qE "^harness/config/"                                        && NEEDS_TS=true      || true
    echo "$CHANGED" | grep -qE "^harness/(agents|workers|identity)/"                     && NEEDS_AGENTS=true  || true
    echo "$CHANGED" | grep -qE "^(tools-py/|harness/memory/|harness/consolidation\.py)" && NEEDS_VEC=true     || true
    echo "$CHANGED" | grep -q  "^scripts/"                                               && NEEDS_SCRIPTS=true || true
    echo "$CHANGED" | grep -qE "^harness/data/"                                          && NEEDS_DATA=true    || true
fi

# deploy-ion-local already rebuilds TS and copies agents; skip the cheaper targets
if [ "$NEEDS_ION" = "true" ]; then
    NEEDS_TS=false
    NEEDS_AGENTS=false
fi

# If nothing specific matched — check for data-only commit first, then default to TS deploy
if [ "$NEEDS_ION" = "false" ] && [ "$NEEDS_TS" = "false" ] && [ "$NEEDS_AGENTS" = "false" ] && [ "$NEEDS_VEC" = "false" ] && [ "$NEEDS_SCRIPTS" = "false" ]; then
    if [ "$NEEDS_DATA" = "true" ]; then
        log "data-only commit ($SHORT_NEW) — no deployment needed"
        DEPLOY_STATUS="nothing"
        echo "$NEW_SHA" > "$SHA_FILE"
        _TRAP_FIRED=true
        exit 0
    fi
    log "no specific component detected in diff — defaulting to TS deploy"
    NEEDS_TS=true
fi

ION_RESTART=false
if [ "$NEEDS_ION" = "true" ] || [ "$NEEDS_TS" = "true" ]; then
    ION_RESTART=true
fi

log "deploy plan: ion=$NEEDS_ION ts=$NEEDS_TS agents=$NEEDS_AGENTS vec=$NEEDS_VEC scripts=$NEEDS_SCRIPTS data=$NEEDS_DATA"

# --- Active session gate (only when ion will restart) ---
if [ "$ION_RESTART" = "true" ]; then
    DB="$HOME/.jarvis/conversations.db"
    if [ -f "$DB" ]; then
        RECENT_MSGS=$(sqlite3 "$DB" \
            "SELECT COUNT(*) FROM messages WHERE ts > strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-10 minutes');" \
            2>/dev/null || echo "0")
        if [ "${RECENT_MSGS:-0}" -gt 0 ]; then
            log "active session ($RECENT_MSGS messages in last 10 min) — deferring ion restart to next tick"
            DEPLOY_STATUS="skipped"
            DEPLOY_FAILURE_REASON="active conversation in last 10 min"
            exit 0
        fi
    fi
    log "no active sessions — proceeding with ion restart"
fi

DEPLOY_PARTS=""

# --- Ion engine: Go rebuild + TS + restart ---
if [ "$NEEDS_ION" = "true" ]; then
    log "deploying ion engine (Go + TS rebuild + restart)..."
    if ! make -C "$REPO" deploy-ion-local >> "$LOG" 2>&1; then
        log "FAILED: deploy-ion-local"
        DEPLOY_STATUS="failed"
        DEPLOY_COMPONENT="ion-engine"
        DEPLOY_FAILURE_REASON="$(tail -3 "$LOG")"
        remember "Deploy FAILED $BUILD_DATE: ion-local failed for $SHORT_NEW (was $SHORT_OLD). Commits: $COMMIT_SUMMARY"
        exit 1
    fi
    DEPLOY_PARTS="${DEPLOY_PARTS} ion-engine(Go+TS)"
fi

# --- TS extension only: rebuild + restart, no Go ---
if [ "$NEEDS_TS" = "true" ]; then
    log "deploying TS extension + restart (no Go rebuild)..."
    if ! make -C "$REPO" deploy-ts-local >> "$LOG" 2>&1; then
        log "FAILED: deploy-ts-local"
        DEPLOY_STATUS="failed"
        DEPLOY_COMPONENT="ts-extension"
        DEPLOY_FAILURE_REASON="$(tail -3 "$LOG")"
        remember "Deploy FAILED $BUILD_DATE: ts-local failed for $SHORT_NEW (was $SHORT_OLD). Commits: $COMMIT_SUMMARY"
        exit 1
    fi
    DEPLOY_PARTS="${DEPLOY_PARTS} ts-extension"
fi

# --- Agent specs: copy only, hot-reload, no restart ---
# Skip if ion restarted — deploy-ion-local and deploy-ts-local already copy agents
if [ "$NEEDS_AGENTS" = "true" ] && [ "$ION_RESTART" = "false" ]; then
    log "copying agent specs (no restart required)..."
    if make -C "$REPO" deploy-agents-local >> "$LOG" 2>&1; then
        DEPLOY_PARTS="${DEPLOY_PARTS} agent-specs"
    else
        log "WARN: deploy-agents-local failed"
    fi
fi

# --- Vec-server: restart only, independent of ion ---
if [ "$NEEDS_VEC" = "true" ]; then
    log "restarting vec-server (Python/memory changed)..."
    if make -C "$REPO" deploy-vec-local >> "$LOG" 2>&1; then
        DEPLOY_PARTS="${DEPLOY_PARTS} vec-server"
    else
        log "WARN: deploy-vec-local failed — vec-server may be stale"
        remember "Deploy WARN $BUILD_DATE: vec-server restart failed for $SHORT_NEW"
    fi
fi

# --- Scripts: copy to ~/bin ---
if [ "$NEEDS_SCRIPTS" = "true" ]; then
    log "installing updated scripts to ~/bin..."
    if make -C "$REPO" deploy-scripts-local >> "$LOG" 2>&1; then
        DEPLOY_PARTS="${DEPLOY_PARTS} scripts"
    else
        log "WARN: deploy-scripts-local failed"
    fi
fi

# --- Ion health check (only when restarted) ---
if [ "$ION_RESTART" = "true" ]; then
    log "waiting for ion to become healthy (max ${ION_HEALTH_TIMEOUT_SEC}s)..."
    READY=false
    NEXT_TICK=15
    for i in $(seq 1 "$ION_HEALTH_TIMEOUT_SEC"); do
        if ION_SOCKET_PATH=<mac-mini-ip>:21017 ~/bin/ion health &>/dev/null 2>&1; then
            READY=true
            log "ion healthy after ${i}s"
            break
        fi
        sleep 1
        if [ "$i" -ge "$NEXT_TICK" ]; then
            log "waiting for ion to become healthy... ${i}s elapsed"
            NEXT_TICK=$(( NEXT_TICK + 15 ))
        fi
    done

    if [ "$READY" != "true" ]; then
        log "WARN: ion did not respond within ${ION_HEALTH_TIMEOUT_SEC}s — attempting rollback"
        remember "Deploy WARN $BUILD_DATE: ion did not respond within ${ION_HEALTH_TIMEOUT_SEC}s after restart. Commit: $SHORT_NEW. Commits: $COMMIT_SUMMARY"

        if [ "$ROLLBACK_ATTEMPTED" = "false" ] && [ -n "$DEPLOYED_SHA" ]; then
            ROLLBACK_ATTEMPTED=true
            PREV_SHA="$DEPLOYED_SHA"
            SHORT_PREV=$(printf '%.7s' "$PREV_SHA")
            log "rolling back to previous SHA: $SHORT_PREV"

            # Block the broken SHA so watchdog doesn't loop on it
            # (next tick will see NEW_SHA = BLOCKED_SHA and skip deployment)
            echo "$NEW_SHA" > "$BLOCKED_SHA_FILE"

            # Revert SHA file to previous so the next watchdog tick re-tries correctly
            echo "$PREV_SHA" > "$SHA_FILE"

            if git -C "$REPO" checkout "$PREV_SHA" -- . >> "$LOG" 2>&1; then
                log "checkout of $SHORT_PREV succeeded — re-running TS deploy for rollback"
                if make -C "$REPO" deploy-ts-local >> "$LOG" 2>&1; then
                    log "rollback deploy succeeded — running ion health check again (${ION_HEALTH_TIMEOUT_SEC}s)..."
                    ROLLBACK_READY=false
                    for j in $(seq 1 "$ION_HEALTH_TIMEOUT_SEC"); do
                        if ION_SOCKET_PATH=<mac-mini-ip>:21017 ~/bin/ion health &>/dev/null 2>&1; then
                            ROLLBACK_READY=true
                            log "ion healthy after rollback (${j}s)"
                            break
                        fi
                        sleep 1
                    done
                    if [ "$ROLLBACK_READY" = "true" ]; then
                        log "ROLLBACK SUCCEEDED: running on $SHORT_PREV"
                        DEPLOY_STATUS="failed"
                        DEPLOY_COMPONENT="ion-healthcheck"
                        DEPLOY_FAILURE_REASON="ion did not recover within ${ION_HEALTH_TIMEOUT_SEC}s; rolled back to $SHORT_PREV"
                        remember "Deploy ROLLBACK SUCCEEDED $BUILD_DATE: rolled back from $SHORT_NEW to $SHORT_PREV. Ion now healthy."
                        exit 1
                    else
                        log "ROLLBACK FAILED: ion still unresponsive after rollback to $SHORT_PREV"
                    fi
                else
                    log "ROLLBACK FAILED: deploy-ts-local failed for $SHORT_PREV"
                fi
            else
                log "ROLLBACK FAILED: git checkout $SHORT_PREV failed"
            fi
        else
            log "rollback skipped: ROLLBACK_ATTEMPTED=$ROLLBACK_ATTEMPTED, DEPLOYED_SHA=${DEPLOYED_SHA:-empty}"
        fi

        DEPLOY_STATUS="failed"
        DEPLOY_COMPONENT="ion-healthcheck"
        DEPLOY_FAILURE_REASON="ion did not respond within ${ION_HEALTH_TIMEOUT_SEC}s and rollback failed"
        remember "Deploy FAILED $BUILD_DATE: ion healthcheck + rollback both failed. Commit: $SHORT_NEW. Commits: $COMMIT_SUMMARY"
        exit 1
    fi
fi

cp "$SHA_FILE" "$SHA_FILE.prev" 2>/dev/null || true
echo "$NEW_SHA" > "$SHA_FILE"
log "deployed $SHORT_NEW successfully — components:${DEPLOY_PARTS}"

# Tell the trap what to report, then fire it manually and mark done
DEPLOY_STATUS="success"
DEPLOY_PARTS_FOR_TRAP="${DEPLOY_PARTS}"
_end=$(date +%s)
DEPLOY_DURATION_FOR_TRAP=$(( _end - _DEPLOY_START_EPOCH ))
~/bin/jarvis-notify deploy_succeeded "$SHORT_NEW" "${DEPLOY_PARTS}" "$DEPLOY_DURATION_FOR_TRAP" "$COMMIT_SUMMARY" "$NEW_SHA" || true
_TRAP_FIRED=true   # suppress trap re-fire at exit

remember "Deploy SUCCEEDED $BUILD_DATE: $SHORT_OLD → $SHORT_NEW. Components:${DEPLOY_PARTS}. Changes: $COMMIT_SUMMARY"

# --- Notify Jarvis ---
if [ "$ION_RESTART" = "true" ]; then
    sleep 5  # give ion-serve.sh time to establish the jarvis session
    NOTIFY_MSG="System: deploy-watchdog restarted the ion engine. Commit $SHORT_NEW is now live (was $SHORT_OLD). Components deployed:${DEPLOY_PARTS}. Changes shipped: $COMMIT_SUMMARY. Push a notification to the principal confirming you are back online and summarising what was deployed."
else
    NOTIFY_MSG="System: deploy-watchdog updated components without restarting ion. Commit $SHORT_NEW is now live (was $SHORT_OLD). Components deployed:${DEPLOY_PARTS}. Changes shipped: $COMMIT_SUMMARY. Push a notification to the principal summarising what was deployed."
fi

log "notifying Jarvis of successful deploy..."
if ION_SOCKET_PATH=<mac-mini-ip>:21017 ~/bin/ion prompt --key jarvis "$NOTIFY_MSG" --attach >> "$LOG" 2>&1; then
    log "Jarvis notified successfully"
else
    log "WARN: ion prompt to Jarvis failed — he will see the deploy in memory on next session"
fi
