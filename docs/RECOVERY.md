# Jarvis Recovery Runbook

Quick reference for outage response. When something breaks, find the symptom below
and follow the shortest path to resolution.

---

## Symptoms

| What you see | Start here |
|---|---|
| Jarvis silent, no Discord, no iOS push | `make doctor` |
| Discord shows "Deploy failed" or "watchdog crashed" | `make doctor` then `make recover` |
| `make check` fails on M2 | Check venv: `make doctor` (look at `[venv]` section) |
| ion unresponsive but vec/relay alive | `make recover` |
| Watchdog crash-looped overnight | `make recover` — it is safe to run while watchdog is not deployed |
| Everything appears down after a reboot | `make recover` |

---

## `make doctor`

Read-only audit of all Jarvis services. Safe to run at any time, in any state.

```bash
make doctor
```

Reports per-service:
- `process` — PIDs from pgrep, or "not running"
- `launchctl` — launchd state (`running`, `not-loaded`, etc.)
- `health` — live healthcheck result (curl, socket, heartbeat, or proc probe)
- `log_tail` — last 3 lines of the service error log
- `verdict` — HEALTHY / DEGRADED / DOWN

Aggregate footer lists overall state and recommended next action.

**Exit code:** 0 = all healthy, 1 = something degraded or down.

---

## `make recover`

Full idempotent service reset. Kills orphans, cleans stale state, bootouts and
bootstraps all services in dependency order, healthchecks each.

```bash
make recover
```

Safe to run when:
- Services are partially or fully down
- After a botched deploy
- After an unexpected reboot
- After `make doctor` reports DEGRADED or DOWN

Do NOT run while:
- A `make deploy-jarvis` or `make deploy-ion` is actively in progress on M2
  (watchdog will be mid-deploy; kill it first if needed via `make recover` anyway)
- During a conversation you care about (ion will restart and your session history clears)

**Idempotency:** If `make doctor` reports all healthy, `make recover` exits immediately
with "all services healthy, no action needed" and fires a Discord notification.

**Timeout:** Default 90s per service. Override:
```bash
JARVIS_RECOVER_TIMEOUT_SEC=120 make recover
```

---

## Manual Fallbacks

Use these when `make recover` itself fails (e.g. plist missing, launchctl
"Input/output error").

### Stop a single service

```bash
ssh mini 'launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/<plist>'
```

### Start a single service

```bash
ssh mini 'launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/<plist>'
```

### Kill ion orphan

```bash
ssh mini 'pkill -f "ion serve" || true; rm -f ~/.ion/engine.sock'
```

### Kill vec-server orphan

```bash
ssh mini 'pkill -f "tools-py/vector-store" || true'
```

### Check launchctl bookkeeping vs reality

```bash
ssh mini 'launchctl list | grep -E "ion|vec|discord|watchdog|relay"'
ssh mini 'pgrep -af "ion serve|vector-store|discord-bot|deploy-watchdog|ion-relay"'
```

### Nuclear reset (last resort)

```bash
ssh mini 'pkill -9 -f "ion serve|vector-store|discord-bot|deploy-watchdog|ion-relay" 2>/dev/null || true'
ssh mini 'rm -f ~/.ion/engine.sock'
ssh mini 'for p in com.dsswift.ion com.example.tools-py-vector com.example.jarvis.discord-bot com.example.jarvis.deploy-watchdog com.example.ion-relay; do
  launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/${p}.plist 2>/dev/null || true
done'
# Then bootstrap in order: vec → ion → ion-relay → discord-bot → watchdog
```

---

## Common Pitfalls

**Venv shim staleness (root cause of May 2026 outage)**
Stale `.venv/bin/` shebangs referencing the old project path `/AgentHarness/` instead of
`/Jarvis/`. Symptom: `make check` fails with "No such file or directory" in pyright.
Fix: `ssh mini 'cd ~/Jarvis && uv sync --all-groups'`. Do NOT `rm -rf .venv` without
immediately running `uv sync --all-groups` — the venv is required for vec-server.

**launchctl bookkeeping disagreeing with pgrep**
`launchctl list` can show a service as registered while pgrep finds no process (zombie
entry). Always check both. `jarvis-doctor` reports both separately.

**ion socket cleanup**
`~/.ion/engine.sock` is a UNIX socket. If ion crashes without cleanup, the stale socket
can prevent restart. `jarvis-recover.sh` removes it automatically at Step 2. Manual:
`rm -f ~/.ion/engine.sock`.

**Ion health probe over TCP**
The correct probe for ion on M2 (even when running locally) is:
`ION_SOCKET_PATH=<mac-mini-ip>:21017 ~/bin/ion health`
Using `127.0.0.1` may not work if ion binds to the LAN interface.

**`make recover` while watchdog is mid-deploy**
The watchdog writes `~/.jarvis-deployed-sha` and checks SHA file state. If recover
restarts the watchdog mid-deploy, the SHA file may be inconsistent. Recover writes
`.prev` and the watchdog will re-detect the commit on next tick — this is safe.

---

## What NOT to Do

- Do not `rm -rf .venv` without immediately running `uv sync --all-groups`.
- Do not run `make recover` while a human conversation with Jarvis is active — the ion
  restart will clear the session.
- Do not `kill -9 launchd` (PID 1). Only target named process patterns.
- Do not edit `~/.jarvis-deployed-sha` manually to skip a commit — use
  `make deploy-ion-rollback` for intentional rollbacks.
- Do not `make deploy-ion` without committing first — the make target runs `git push`,
  which silently leaves M2 on old code if nothing is committed.
