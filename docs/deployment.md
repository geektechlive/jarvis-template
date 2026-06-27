---
title: Deployment
description: Two-Mini topology, make deploy targets, LaunchAgent architecture, ion codesign requirement, and the step-by-step deploy checklist.
sidebar_position: 6
---

# Deployment

This document explains Jarvis's deployment architecture, why it's built this way, and how to deploy changes correctly. Read this before deploying to avoid silent failures.

## Infrastructure Topology

Jarvis runs on two Mac Minis in a distributed topology:

- **Mac Mini M2** (<mac-mini-ip>, user: `<username>`, hostname: `mini`)
  - Ion daemon (engine, orchestration, session management)
  - Ollama (embeddings only: nomic-embed-text on dedicated NAS instance)
  - Vec-server (ChromaDB HTTP wrapper, port 9876)
  - Voice-tts (Kokoro TTS via mlx-audio)
  - Ion-relay (WebSocket relay for WAN push notifications)
  - Cloudflared tunnel (outbound to Cloudflare for iPhone WAN access)
  - Deploy watchdog (auto-deploy on main branch commits)
  - Mail check, calendar check, and utility scripts

- **Mac Mini M4** (<m4-mini-ip>, user: `<username>`, hostname: `mini-m4`)
  - Ion Desktop only (graphical frontend)
  - No backend services; it's a client

**Why this split?** Relay and Cloudflare tunnel run on M2 so WAN access to Jarvis (iPhone via tunnel) survives an M4 reboot. M4 is optional for desktop use; losing it doesn't break mobile or the engine. On LAN, iPhone uses Bonjour discovery to reach M4 directly; on WAN, it connects through M2's tunnel.

**Why local Minis, not cloud?** Zero cold-start latency, 24/7 availability without egress costs, full privacy (nothing leaves the network), and the harness doesn't need external APIs — only local LLMs and ChromaDB.

## LaunchAgent Architecture

All Jarvis services run as LaunchAgents (user-space, non-root). Plist files are stored in the repo root and installed to `~/Library/LaunchAgents/` on M2.

**Key plist fields:**

- `Label` — service identifier (e.g., `com.dsswift.ion` for the ion daemon)
- `ProgramArguments` — bash script or binary to run
- `RunAtLoad` — start on login
- `KeepAlive` — restart if it crashes
- `ThrottleInterval` — wait this many seconds before restarting after a crash (default 10s is too fast; Jarvis uses 30s)
- `StandardErrorPath` — where logs go (use this for debugging)

**Why LaunchAgents instead of system daemons (LaunchDaemons)?** User-space agents have access to the GUI session (Calendar, Mail, Keychain), macOS user events, and Spotlight. System daemons can't access any of these.

### Installing Services

To install all LaunchAgents on M2:

```bash
make install-launchagents
```

Or manually for a single service:

```bash
cp com.example.tools-py-vector.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.tools-py-vector.plist
```

To restart a service without reinstalling:

```bash
launchctl kickstart -k gui/$(id -u)/com.example.tools-py-vector
```

To check status:

```bash
launchctl list | grep tools-py-vector
```

## Make Deploy Targets

All deployments happen through `make` targets. **Never use `git pull` directly on Mini — it updates source files but skips critical rebuild steps.**

### `make deploy-jarvis` (Daily Driver)

**When:** You changed harness-ts code, agent specs, identity files, scripts, or config.

**What it does:**
1. Push your local commits to origin
2. SSH to M2 and pull the repo
3. Run `npm install` for harness-ts dependencies
4. Rebuild `harness-ts/dist/extension.js` and `harness-ts/dist/child-extension/index.js` using esbuild
5. Bundle staff agent specs into `harness-ts/dist/agents/` (the extension discovery source) and copy `harness/agents/*.md` + `harness/workers/*.md` to `~/.claude/agents/` for Claude Code
6. Copy tool scripts (`mail-check.py`, `calendar-check.py`, etc.) to `~/bin/`
7. Restart the ion LaunchAgent

**Why the agent spec copy is critical:** Claude Code reads agent specs from `~/.claude/agents/`, not from `~/Jarvis/harness/agents/`. If this copy step fails, staff agents run but use their stale behavior from the last deployment. Symptom: agent pulls from outdated knowledge collection, ignores new routing rules, or uses old system prompts.

**Example:**

```bash
git add .
git commit -m "fix(staff): update admin agent routing"
make deploy-jarvis
```

### `make deploy-ion` (Ion Engine Rebuild)

**When:** You changed `ion/engine/*.go` (the Go source code in the ion submodule).

**What it does:**
1. Push your local commits to origin
2. SSH to M2 and update the ion git submodule
3. Run `go build` to compile the ion binary
4. Ad-hoc codesign the binary (`codesign --force --sign -`)
5. Rebuild `harness-ts/dist/extension.js`
6. Copy agent specs
7. Restart the ion LaunchAgent

**Why codesign is necessary:** macOS 26 (Tahoe) removed the old `sudo spctl --add` workaround. Every time the ion binary is rebuilt, it must be ad-hoc codesigned before the kernel will execute it. This survives reboots.

**Example:**

```bash
# Edit ion/engine/cmd/ion/main.go
git add ion/
git commit -m "fix(ion): handle stale filelock on restart"
make deploy-ion
```

### `make deploy-ion-go` (Rebuild Only, No SSH)

**When:** You're already on M2 and only need to rebuild the Go binary.

Faster than `deploy-ion` for iteration during development.

### `make deploy-ts-local` (TypeScript Rebuild Only, No SSH)

**When:** You changed harness-ts or harness config but NOT ion Go code, and you're already on M2.

Rebuilds esbuild and restarts ion without touching the Go binary.

### `make deploy-vec` (Vector Server Restart)

**When:** You changed `tools-py/vector-store/*.py`.

Pushes to origin, SSHes to M2, restarts the vec-server LaunchAgent.

### `make deploy-relay` (Relay Binary Rebuild)

**When:** You changed `ion/relay/*.go`.

Cross-compiles the relay binary, scps it to M2, and restarts the ion-relay LaunchAgent.

## The Ion Daemon Restart Sequence

When `make deploy-jarvis` or `make deploy-ion` runs, it restarts the ion daemon using this sequence:

```bash
pkill -9 -f 'ion serve'                    # Kill any orphaned serve process
sleep 0.5
lsof -ti :21017 | xargs kill -9            # Free the socket port
sleep 1
launchctl bootstrap ...com.dsswift.ion     # Register the new plist
launchctl kickstart -k gui/$(id -u)...     # Start it
```

**Why this complexity?** When `launchctl stop` runs, the `ion serve` child process gets orphaned (launchd doesn't propagate the signal to grandchildren). Without `pkill -9 -f 'ion serve'`, the old process keeps running and prevents the new one from binding to port 21017. The sleep calls give the OS time to clean up file handles.

**Trade-off:** Restarting the daemon clears the current conversation history (the session is recreated fresh). This is intentional: the `scripts/ion-serve.sh` wrapper calls `ion stop --key jarvis` before `ion start`, guaranteeing the extension is loaded fresh on every restart.

## Ion Binary: Codesign Requirement

Every time `go build` completes, the binary must be ad-hoc codesigned:

```bash
codesign --force --sign - ~/bin/ion
```

**Why?** macOS enforces code signing. Without it, the kernel refuses to execute the binary (error: `code signature invalid`). Ad-hoc signing (`--sign -`) is the minimal form — it doesn't require a developer certificate, just marks the binary as signed by the local machine.

**When does this run?**
- Automatically in `make deploy-ion`
- Automatically in `make deploy-ion-go`
- Must be done manually if you rebuild the binary on Mini directly

## Deploy Sequence (Step-by-Step)

1. **Make changes locally** on your development machine (not M2).

2. **Run lint and tests:**
   ```bash
   make check    # lint + pyright + pytest + staff validation
   ```

3. **Commit your changes:**
   ```bash
   git add src/ harness/ scripts/
   git commit -m "feat(learning): add session gap detection"
   ```
   Do NOT commit if `make check` failed.

4. **Choose the right deploy target:**
   - harness-ts/src/ or harness/config/ → `make deploy-jarvis`
   - ion/engine/ → `make deploy-ion`
   - tools-py/vector-store/ → `make deploy-vec`
   - ion/relay/ → `make deploy-relay`

5. **Run the deploy:**
   ```bash
   make deploy-jarvis
   ```
   The Makefile pushes your branch to origin, so make sure your local commits are ready first.

6. **Verify on M2:**
   ```bash
   ssh mini
   cd ~/Jarvis
   git log --oneline -1        # Confirm latest commit hash
   tail -f logs/ion.error.log  # Watch for startup errors
   ```

7. **Test the changed code path:**
   - If you changed memory recall, run a query that triggers recall
   - If you changed an agent spec, run a command that routes to that agent
   - If you changed icon/relay, test a real push from iPhone to M2
   - Paste the output to confirm it works

8. **Close related GitHub issues** immediately after confirming success:
   ```bash
   # GitHub MCP or gh CLI
   gh issue close #123 --body "Deployed in commit abc1234"
   ```

## Common Deployment Mistakes

### Mistake 1: Skipping `make check` before commit

**Problem:** You commit without running lint. The Makefile tries to push, which fails because CI/CD catches linting errors.

**Fix:** Always run `make check` first. It's fast (< 30s) and catches everything before deploy.

### Mistake 2: Using `git pull` on M2 directly

**Problem:** You SSH to M2 and run `git pull`. Source files update but:
- Agent specs don't copy to `~/.claude/agents/`
- TypeScript extension doesn't rebuild
- LaunchAgent doesn't restart
- Ion binary doesn't get codesigned

Result: M2 sits on stale code silently until the next real deploy.

**Fix:** Always use `make deploy-*` from your dev machine. It handles all five mandatory steps.

### Mistake 3: Restarting the wrong service

**Problem:** You change vec-server code but run `make deploy-jarvis`, which restarts ion instead. Vector store keeps running stale code.

**Fix:** Match the target to the changed code:
- Changed `harness-ts/` → `make deploy-jarvis`
- Changed `tools-py/vector-store/` → `make deploy-vec`
- Changed `ion/engine/` → `make deploy-ion`

### Mistake 4: Not verifying the commit hash on M2

**Problem:** You run `make deploy-jarvis` successfully, but M2 is still three commits behind. The push succeeded, but the pull failed silently (maybe a merge conflict).

**Fix:** Always SSH and verify:
```bash
ssh mini
git -C ~/Jarvis log --oneline -1
```

It should match your local `git log --oneline -1`.

### Mistake 5: Deploying without updating the ion submodule

**Problem:** You update `ion/engine/*.go` but forget to commit the submodule pointer. The push succeeds, M2 pulls, but M2's `ion/` submodule still points at the old commit.

**Fix:** Git treats submodules as separate commits. After modifying `ion/`, stage the submodule:
```bash
git add ion/
git commit -m "chore(ion): update submodule to abc1234"
```

Then `make deploy-ion` will run `git submodule update --init --recursive` on M2.

## SSH Path Quirks

**Problem:** You SSH to M2 and try to run `npm` or `esbuild`, and you get `command not found`.

**Root cause:** SSH login shells don't source `~/.zprofile` (which sets up PATH). Homebrew binaries live at `/opt/homebrew/bin/`, and they're only in PATH for GUI login sessions and interactive bash shells.

**Fix options:**

Option A: Use full paths in scripts:
```bash
/opt/homebrew/bin/npm install
/opt/homebrew/bin/esbuild ...
```

Option B: Use make targets (which are tested and set PATH correctly):
```bash
make deploy-ts-local    # on M2, rebuilds TS without SSH
```

Option C: Run interactive login bash first:
```bash
ssh mini bash -i
npm install              # Now in PATH
```

## Logs and Debugging

**Check if a service is running:**

```bash
ssh mini
launchctl list | grep ion            # Check ion daemon
launchctl list | grep tools-py      # Check vec-server
```

**View error logs:**

```bash
ssh mini
tail -f ~/Jarvis/logs/ion.error.log       # Ion daemon errors
tail -f ~/Jarvis/logs/vector.error.log    # Vec-server errors
```

**Restart a service manually:**

```bash
ssh mini
launchctl kickstart -k gui/$(id -u)/com.dsswift.ion
```

**Check if a port is listening:**

```bash
ssh mini
lsof -ti :21017                 # Ion socket (M2 listens on 0.0.0.0:21017)
lsof -ti :9876                  # Vec-server HTTP
```

## Deployment Proof

After deploying, verify the change is actually live. Do NOT trust exit codes or CI logs alone.

**Example workflow:**

```bash
ssh mini
git -C ~/Jarvis log --oneline -1          # Confirm commit hash

# Test the changed code path end-to-end
curl -X POST http://127.0.0.1:9876/health
# or
ion prompt --key jarvis "hello"
# or
git -C ~/Jarvis diff HEAD~1 harness/agents/admin.md    # Confirm spec changed
```

Paste the output. If it matches your local changes, the deploy succeeded.
