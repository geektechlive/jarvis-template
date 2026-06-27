#!/bin/bash
# Wrapper script for the com.dsswift.ion LaunchAgent.
# Starts ion serve, waits for the socket, then establishes the persistent
# Jarvis session. When launchd restarts after a crash, the session is
# re-established cleanly (start_session is idempotent on duplicate keys).

set -e

ION="$HOME/.ion/bin/ion"
HARNESS=/Users/<username>/Jarvis
EXT="$HARNESS/harness-ts/dist/extension.js"

mkdir -p "$HARNESS/logs"

echo "[ion-serve] starting daemon (pid $$)"

# Clear a stale engine lock before starting. engine.pid.lock holds the PID of
# the engine that owns the daemon. launchd runs only ONE instance of this wrapper
# at a time, so whenever this startup code runs, any ion already holding the lock
# is an orphan from a previous wrapper that exited uncleanly (SIGKILL with no trap
# firing) -- it is never the engine we are about to start. Three cases:
#   - dead PID / reused by a non-ion process -> just remove the stale lock file.
#   - LIVE ion still holding the lock -> a zombie orphan. We MUST kill it; leaving
#     it makes our fresh `ion serve` crash-loop on "Engine already running:
#     filelock: locked by PID N" until something kills the orphan by hand.
_LOCK_FILE="$HOME/.ion/engine.pid.lock"
if [ -f "$_LOCK_FILE" ]; then
    _lock_pid=$(tr -d '[:space:]' < "$_LOCK_FILE" 2>/dev/null)
    if [ -n "$_lock_pid" ]; then
        _proc_name=$(ps -p "$_lock_pid" -o comm= 2>/dev/null | awk -F'/' '{print $NF}')
        if [ "$_proc_name" = "ion" ]; then
            echo "[ion-serve] killing orphaned ion holding the lock (PID $_lock_pid)"
            kill "$_lock_pid" 2>/dev/null || true
            for _ in 1 2 3 4 5 6; do
                ps -p "$_lock_pid" >/dev/null 2>&1 || break
                sleep 0.5
            done
            if ps -p "$_lock_pid" >/dev/null 2>&1; then
                echo "[ion-serve] orphan ignored SIGTERM, sending SIGKILL (PID $_lock_pid)"
                kill -9 "$_lock_pid" 2>/dev/null || true
                sleep 0.5
            fi
            rm -f "$_LOCK_FILE"
        else
            echo "[ion-serve] removing stale lock (PID $_lock_pid, process='$_proc_name')"
            rm -f "$_LOCK_FILE"
        fi
    fi
fi

# ION_SOCKET_PATH=0.0.0.0:21017 makes the engine listen on TCP so Ion
# Desktop on M4 can connect over LAN instead of via Unix socket.
# caffeinate -w $$ holds PreventSystemSleep for this script's lifetime and
# exits automatically when the script exits -- no need to kill it explicitly.
# Running ion serve directly (not as caffeinate's child) means SIGTERM reaches
# ion serve cleanly via the trap below without signal-propagation ambiguity.
caffeinate -w $$ &
CAFF_PID=$!

"$ION" serve &
ION_PID=$!

# Propagate SIGTERM/SIGINT cleanly to the ion daemon
trap 'kill $ION_PID 2>/dev/null; wait $ION_PID 2>/dev/null' TERM INT

echo "[ion-serve] waiting for socket..."
for i in $(seq 1 40); do
    if "$ION" health 2>/dev/null; then
        echo "[ion-serve] daemon ready"
        break
    fi
    sleep 0.25
done

# Verify the daemon actually came up. The loop above can fall through
# silently if `health` never succeeds (binary missing, socket bind
# failure, etc.) -- fail loud so launchd's restart counter and our logs
# both reflect the failure.
if ! "$ION" health 2>/dev/null; then
    echo "[ion-serve] ERROR: daemon did not become ready within 10s" >&2
    exit 1
fi

echo "[ion-serve] initializing jarvis session"
# Stop any persisted session so the extension is always registered fresh.
# start_session is idempotent on duplicate keys but skips extension loading
# when the session already exists -- stopping first guarantees extension=1.
"$ION" stop --key jarvis 2>/dev/null || true
"$ION" start \
    --key jarvis \
    --profile jarvis \
    --dir "$HARNESS" \
    --extension "$EXT"

echo "[ion-serve] jarvis session ready"
wait "$ION_PID"
