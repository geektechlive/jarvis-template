---
title: Troubleshooting
description: Diagnosis and fixes for common Jarvis issues. Start with Quick Reference.
sidebar_position: 11
---

# Troubleshooting

When something breaks, find the symptom below and follow the shortest path to resolution. For critical outages, see [RECOVERY.md](RECOVERY.md) first (`make doctor` and `make recover`).

---

## Quick Reference

| Symptom | Root Cause | Fix |
|---------|-----------|-----|
| "ANTHROPIC_API_KEY not set" | CliBackend uses Claude CLI (OAuth), not SDK | Verify `engine.json: backend: cli`, run `claude auth status` on Mini |
| ion/services fail with EHOSTUNREACH | macOS privacy dialog (screen share, microphone, contacts) pending on Mini | Check Mini screen for dialog, approve permission, or check `launchctl list` for crashed services |
| Staff agent uses stale behavior | `git pull` used instead of `make deploy-jarvis`; agent spec copy step skipped | Run `make deploy-jarvis` and verify `ls -la ~/.claude/agents/` timestamps on Mini |
| Memory recall empty / `extension=0` | ion session recreated without extension registered | Run `pkill -f "ion serve"` then `launchctl kickstart -k gui/$(id -u <username>)/com.example.jarvis` on Mini |
| Memory extraction timeouts / degraded recall | Large Ollama model (gemma3:27b) loaded; GPU monopolized | Archived model; remove from `harness/config/models.yaml`; restart Ollama |
| `/recall` or other slash commands don't work | `ion prompt` always sends `send_prompt`, ignores `/` prefix | Use Ion Desktop or iOS app for slash commands; test via DB: `SELECT * FROM agent_events` |
| Morning brief / routine didn't fire | Routine disabled in YAML, or cross-process dedup triggered, or time window missed | Check `SELECT * FROM agent_events WHERE event='routine_started' ORDER BY created_at DESC` |
| Memory recall degraded / empty context | vec-server (port 9876) down or Ollama embedding unreachable | Run `make vec-status`, SSH to Mini: `curl http://localhost:9876/health` |
| `ion` command fails or codesign error | macOS 26 requires ad-hoc codesign after every rebuild | Run `codesign --force --sign - ~/bin/ion` on Mini, or use `make deploy-ion` |
| Git auth fails on Mini (`fatal: could not read from remote`) | Mini git remote uses HTTPS with expired PAT | SSH to Mini: `git -C ~/Jarvis remote set-url origin git@github.com:<your-org>/jarvis.git` |

---

## Detailed Issues

### ANTHROPIC_API_KEY Not Set or Expected

**Symptom:** Error message says "ANTHROPIC_API_KEY not found", or code assumes env var for LLM auth.

**Root cause:** Jarvis uses `CliBackend`, which invokes the Claude CLI as a subprocess. The CLI authenticates via OAuth token stored in `~/.claude/` on the Mini (not via API key). There is no `ANTHROPIC_API_KEY` in Jarvis' stack.

**Fix:**
1. Verify `~/.ion/engine.json` on Mini contains:
   ```json
   {
     "backend": "cli",
     "defaultModel": "claude-sonnet-4-6"
   }
   ```
2. Confirm Claude CLI is authenticated:
   ```bash
   ssh mini 'claude auth status'
   ```
3. If not authenticated, run:
   ```bash
   ssh mini 'claude auth login'
   ```
4. Test with a prompt:
   ```bash
   ION_SOCKET_PATH=<mac-mini-ip>:21017 ~/bin/ion prompt --key jarvis 'hello' --attach
   ```

See `docs/cli-backend.md` for full auth details.

---

### EHOSTUNREACH or Services Unreachable on Mini

**Symptom:** SSH to Mini works, but `ion prompt`, vec-server, or other tools fail with `EHOSTUNREACH`, `connection refused`, or similar network errors. Or: `make doctor` reports services as DOWN.

**Root cause (check in order):**
1. macOS privacy permission dialog pending (screen sharing, microphone, calendar, contacts, etc.). Mini shows the dialog but nothing dismisses it, and processes hang waiting for user input.
2. Services crashed or are in a stale launchctl state (orphan plist entries).

**Fix:**
1. **Check Mini screen:** Use Screen Sharing from dev Mac to view the Mini desktop. Look for any permission dialog (gray overlay asking to allow access). If found, click "Allow".
2. **If no dialog visible or after approving:** Run `make doctor` to audit all services:
   ```bash
   make doctor
   ```
   Look for entries marked `DOWN` or `DEGRADED`.
3. **If doctor reports DOWN services:** Follow [RECOVERY.md](RECOVERY.md) and run:
   ```bash
   make recover
   ```
4. **Manual service restart (if recover is stuck):**
   ```bash
   ssh mini 'pkill -f "ion serve" || true'
   ssh mini 'rm -f ~/.ion/engine.sock'
   ssh mini 'launchctl kickstart -k gui/$(id -u <username>)/com.example.jarvis'
   ```

---

### Staff Agents Use Stale Behavior After Deploy

**Symptom:** Deployed code changes, but staff agent still runs with old behavior (pulls from wrong ChromaDB collection, uses old tool, has stale instructions).

**Root cause:** Used `git pull` or `make deploy-ion` instead of `make deploy-jarvis`. The agent spec copy step (`cp harness/agents/*.md ~/.claude/agents/`) was skipped. Claude Code reads agent specs from `~/.claude/agents/` on the dev Mac or Mini, not from the repo.

**Fix:**
1. Run the correct deploy command:
   ```bash
   make deploy-jarvis
   ```
2. Verify specs were copied to Mini:
   ```bash
   ssh mini 'ls -la ~/.claude/agents/' | head -20
   ```
   Timestamps should match the most recent commit time. If they are old, the copy failed.
3. If timestamps are stale, manually re-copy:
   ```bash
   ssh mini 'cp -f ~/Jarvis/harness/agents/*.md ~/.claude/agents/'
   ssh mini 'cp -f ~/Jarvis/harness/workers/*.md ~/.claude/agents/'
   ```
4. Test the agent:
   ```bash
   ION_SOCKET_PATH=<mac-mini-ip>:21017 ~/bin/ion prompt --key jarvis '/list-staff' --attach
   ```

**Prevention:** Always use `make deploy-jarvis` for harness-ts changes, not `git pull` or `make deploy-ion`.

---

### Memory Recall Empty / `extension=0` After Daemon Restart

**Symptom:** Ion session starts, but `before_prompt` hook does not fire; memory recall is empty; `extension=0` in logs; context is missing.

**Root cause:** The ion session was recreated (daemon restart, crash recovery) without the TypeScript extension re-registered. The `ion-serve.sh` script must stop the old session before starting a new one to ensure a fresh session with the extension.

**Fix:**
1. Stop the orphaned `ion serve` process:
   ```bash
   ssh mini 'pkill -f "ion serve" || true'
   ```
2. Clean the socket file:
   ```bash
   ssh mini 'rm -f ~/.ion/engine.sock'
   ```
3. Restart the ion service via launchctl:
   ```bash
   ssh mini 'launchctl kickstart -k gui/$(id -u <username>)/com.example.jarvis'
   ```
4. Verify extension is registered:
   ```bash
   ION_SOCKET_PATH=<mac-mini-ip>:21017 ~/bin/ion health
   # Should show extension=1 in the output
   ```

**Note:** Restarting ion clears the current conversation history. Only do this when no active session is in progress.

---

### Ollama Model Timeout During Conversation

**Symptom:** Memory extraction slow or fails; `extractAndStore` times out; triage classification delays; factExtraction emits errors.

**Root cause:** Ollama is embeddings-only now (`nomic-embed-text`), so reasoning models no longer contend for the GPU (issue #613). The residual risk: if a stray large model is pulled onto the embed Ollama, loading it blocks the embed endpoint during model swap, stalling recall and extraction. `OllamaEmbeddingFunction(timeout=120)` guards against transient stalls; the durable fix is `OLLAMA_KEEP_ALIVE=-1` for the embed model so it never unloads.

**Fix:**
1. Check `harness/config/models.yaml` for `gemma3:27b` or other large archived models:
   ```bash
   grep -i "gemma3" harness/config/models.yaml
   ```
2. If found, remove it from the config (it's archived; no role should reference it).
3. Restart Ollama on Mini to unload the model:
   ```bash
   ssh mini 'launchctl stop gui/$(id -u <username>)/com.example.ollama'
   sleep 2
   ssh mini 'launchctl start gui/$(id -u <username>)/com.example.ollama'
   ```
4. Deploy the config change:
   ```bash
   make deploy-jarvis
   ```
5. Verify active models:
   ```bash
   ssh mini 'ollama list'
   ```
   Should show only `nomic-embed-text`. Any reasoning model (qwen/llama/gemma) present is a misconfiguration — embeddings run on the NAS Ollama and no role uses a local reasoning model.

---

### Slash Commands Don't Work (e.g., `/recall` not executing)

**Symptom:** Running `ion prompt --key jarvis '/recall something'` doesn't execute the recall command; prompt is sent to LLM instead.

**Root cause:** `ion prompt` always sends a `send_prompt` message to the LLM, regardless of a `/` prefix. Slash commands are only dispatched when the frontend (Ion Desktop app or iOS) sends a `"command"` type message. The CLI has no way to signal a command.

**Fix:**
1. **For testing commands:** Use Ion Desktop or iOS app, not CLI.
2. **To verify slash command works:** After running it in the app, check the database:
   ```bash
   ssh mini 'sqlite3 ~/.jarvis/conversations.db "SELECT * FROM agent_events WHERE event='"'"'inbox_item'"'"' ORDER BY created_at DESC LIMIT 5;"'
   ```
   If the command was routed and executed, you'll see `inbox_item` events.
3. **For CLI testing:** Use `ion health` to check extension status, or seed a reminder directly into the DB and watch for `status='fired'`.

---

### Morning Brief or Scheduled Routine Didn't Fire

**Symptom:** Expected routine (morning_brief at 07:30, weekly_curator at Mon 08:00, etc.) did not run at the scheduled time.

**Root cause (check in order):**
1. Routine is disabled in `harness/config/routines.yaml`.
2. Cross-process dedup fired: a `routine_started` event already exists within the last 23 hours for that routine.
3. Mini was offline or ion daemon not running at the trigger time.
4. Routine time window passed before ion daemon was ready.

**Fix:**
1. Check if routine is enabled:
   ```bash
   grep -A3 "morning_brief:" harness/config/routines.yaml
   ```
   Should have `enabled: true`.
2. Query the event log to see when the routine last fired:
   ```bash
   ssh mini 'sqlite3 ~/.jarvis/conversations.db "SELECT created_at, detail FROM agent_events WHERE event='"'"'routine_started'"'"' AND detail LIKE '"'"'%morning_brief%'"'"' ORDER BY created_at DESC LIMIT 5;"'
   ```
3. If the last `routine_started` event is older than 23 hours, the dedup window has passed and the routine should fire on the next trigger. If it's recent, the dedup is active (by design, to avoid double-fire).
4. To manually trigger a routine, seed it into the reminders table with a past `fire_at`:
   ```bash
   ssh mini 'sqlite3 ~/.jarvis/conversations.db "INSERT INTO reminders (type, detail, fire_at, status) VALUES ('"'"'routine'"'"', '"'"'morning_brief'"'"', datetime('"'"'now'"'"', '"'"'-1 hour'"'"'), '"'"'pending'"'"');"'
   ```
   Scheduler polls every 60 seconds and will pick it up.

---

### Memory Recall Degraded / Context Missing in Conversation

**Symptom:** Conversations lack prior context; vector store recall returns empty; `before_prompt` injection is blank; memory is not being retrieved.

**Root cause (check in order):**
1. vec-server (port 9876) is down or crashed.
2. Ollama embedding model (nomic-embed-text) is unreachable or not loaded.
3. ChromaDB is corrupted or empty.

**Fix:**
1. Check vec-server health:
   ```bash
   make vec-status
   ```
2. If DOWN, restart it:
   ```bash
   ssh mini 'launchctl kickstart -k gui/$(id -u <username>)/com.example.tools-py-vector'
   ```
3. Verify Ollama is running and has the embedding model:
   ```bash
   ssh mini 'ollama list | grep nomic-embed-text'
   ```
4. If model is missing, pull it:
   ```bash
   ssh mini 'ollama pull nomic-embed-text'
   ```
5. Test vec-server endpoint directly:
   ```bash
   ssh mini 'curl http://localhost:9876/health'
   ```
   Should return HTTP 200 with a health status.
6. If vec-server is still failing, check logs:
   ```bash
   make vec-logs
   ```

---

### `ion` Binary Not Found or Codesign Error

**Symptom:** Running `ion` on Mini fails; macOS security dialog appears; binary cannot execute.

**Root cause:** macOS 26 (Tahoe) requires ad-hoc codesign for all binaries after compilation. The `sudo spctl --add` workflow was removed. If the binary was rebuilt but not codesigned, it will not run.

**Fix:**
1. **Manual codesign:**
   ```bash
   ssh mini 'codesign --force --sign - ~/bin/ion'
   ```
2. **Verify codesign:**
   ```bash
   ssh mini 'codesign --verify ~/bin/ion'
   ```
3. **Or use the deployment script (preferred):**
   ```bash
   make deploy-ion
   ```
   This handles submodule update, Go build, codesign, and launchctl restart in one step.
4. Test the binary:
   ```bash
   ION_SOCKET_PATH=<mac-mini-ip>:21017 ~/bin/ion health
   ```

---

### Git Remote Auth Fails on Mini (`fatal: could not read from remote`)

**Symptom:** `make deploy-*` command fails with auth error; git push rejected on Mini; HTTPS git operations fail.

**Root cause:** Mini's git remote uses HTTPS with an embedded Personal Access Token (PAT) that has expired. PATs expire after 90 days of inactivity.

**Fix:**
1. Switch to SSH (no token expiry):
   ```bash
   ssh mini 'git -C ~/Jarvis remote set-url origin git@github.com:<your-org>/jarvis.git'
   ```
2. Verify the change:
   ```bash
   ssh mini 'git -C ~/Jarvis remote -v'
   ```
3. Deploy again:
   ```bash
   make deploy-jarvis
   ```

**Prevention:** SSH-based git remotes do not expire. Use SSH for all Mini git operations.

---

## Log Locations

| Service | Error Log | Notes |
|---------|-----------|-------|
| ion daemon | `~/.ion/engine.log` on Mini | Grep `before_prompt` to confirm extension fires |
| vec-server | `~/Jarvis/logs/vector.error.log` on Mini | ChromaDB + embedding errors |
| voice-tts | `~/Jarvis/logs/voice.error.log` on Mini | Kokoro TTS errors (if running) |
| TypeScript extension | in `~/.ion/engine.log` | All `harness-ts/` logs fold into ion's engine log |
| Ollama | Terminal or system logs | Run `ollama serve` in terminal to see real-time output |

---

## Useful Diagnostic Commands

```bash
# Health check (read-only audit)
make doctor

# Full service recovery (idempotent)
make recover

# View ion daemon status
ION_SOCKET_PATH=<mac-mini-ip>:21017 ~/bin/ion health

# Test a prompt
ION_SOCKET_PATH=<mac-mini-ip>:21017 ~/bin/ion prompt --key jarvis 'hello' --attach

# List registered staff agents
ION_SOCKET_PATH=<mac-mini-ip>:21017 ~/bin/ion prompt --key jarvis '/list-staff' --attach

# Check launchctl services on Mini
ssh mini 'launchctl list | grep com.<username>'

# Verify agent specs are deployed
ssh mini 'ls -la ~/.claude/agents/ | wc -l'

# Check vec-server health
ssh mini 'curl -s http://localhost:9876/health | jq'

# View recent agent events
ssh mini 'sqlite3 ~/.jarvis/conversations.db "SELECT created_at, event, detail FROM agent_events ORDER BY created_at DESC LIMIT 20;"'

# Tail ion logs on Mini
make ion-logs

# Tail vec-server logs on Mini
make vec-logs

# Check if any process is hung
ssh mini 'pgrep -af "ion serve|vector-store|discord-bot"'

# Kill orphaned ion serve
ssh mini 'pkill -f "ion serve" || true && rm -f ~/.ion/engine.sock'
```

---

## When to Use Recovery vs Troubleshooting

- **Use [RECOVERY.md](RECOVERY.md)** when: Jarvis is partially or fully down; multiple services are failing; you need a full service reset.
- **Use this guide** when: A specific feature is broken; context is missing; a command doesn't work; you need to understand root cause.
- **Use `make doctor`** first: Always run `make doctor` to audit service status before deciding between recovery and targeted fixes.
