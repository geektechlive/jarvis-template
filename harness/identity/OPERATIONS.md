# Operations (reference — NOT injected into the system prompt)

> This file holds operational *procedure* relocated out of BEHAVIOR.md so it does
> not consume per-turn system-prompt tokens. It is not loaded by `loadSoul()`.
> It is reference material for procedures Jarvis performs rarely (deploying,
> hiring/retiring staff, writing durable files). Read it on demand when one of
> those situations actually arises. Authoritative behavior/voice stays in
> SOUL.md and BEHAVIOR.md.

## Persistent state — where staff write durable files

Any staff member who creates persistent, user-facing artifacts (CSVs, JSON logs, markdown summaries, transcripts, briefs that should survive across sessions) writes to iCloud Drive, not to a local-only path. The canonical root is:

```
~/Library/Mobile Documents/com~apple~CloudDocs/Jarvis/
```

Visible in Finder as `~/iCloud Drive/Jarvis/`.

Inside `Jarvis/`, organize by **function**, not by staff member name. Two staff members may share a function. Examples:

- `Jarvis/finance/`        -- Personal CFO
- `Jarvis/journal/`        -- evening journal, reflection summaries
- `Jarvis/research/`       -- Research Analyst briefs worth keeping
- `Jarvis/meetings/`       -- Chief of Strategy panel transcripts
- `Jarvis/knowledge-curation/` -- Knowledge Curator audit reports

When a staff member creates a new function-folder, they document the schema in their **own agent spec** under a "Persistent state" or "<Function> directory" heading. The spec is the source of truth; an on-disk README is a human-facing mirror.

iCloud Drive provides durability: cross-device sync, automatic version history, Time Machine coverage. No git commits, no manual backup, no helper scripts.

What does **not** go in iCloud Drive:

- Runtime databases with file locks (`~/.jarvis/episodic.db`, ChromaDB collections, lock files). Cloud sync mid-write risks corruption. These stay machine-local at `~/.jarvis/`.
- Credentials (`~/.jarvis-mail-creds`). Stay machine-local with chmod 600.
- Ephemeral logs (`~/Jarvis/logs/`). Machine-local; rotated by launchd.

If a staff member is unsure whether something is durable user-facing artifact vs. runtime state, the rule is: would Alex be unhappy if he lost it on a Mini reflash? If yes, iCloud. If no, local.

## Mutations to harness/data/ files

`harness/data/` contains tool-facing structured files (contacts.yaml, portfolio.yaml, etc.) that are tracked in git. When Jarvis or any staff member writes to a file in this directory, immediately commit and push:

```bash
git -C ~/Jarvis add harness/data/<file>
git -C ~/Jarvis commit -m "data: <brief description of what changed>"
git -C ~/Jarvis push origin main
```

Do not leave data mutations uncommitted. These files are read by tool code and must stay in sync with origin.

**Journal entries do not belong here.** Daily journal and reflection summaries are human-facing artifacts — write them to iCloud Drive at `~/Library/Mobile Documents/com~apple~CloudDocs/Jarvis/journal/`, not to `harness/data/journal/`. See the Persistent state section above.

## Self-deployment

Jarvis has a deploy-watchdog LaunchAgent that monitors `origin/main` for new commits
and deploys automatically. This is how all code changes reach the running engine.

**My role: commit and push. Nothing else.**

```bash
git -C ~/Jarvis add <files>
git -C ~/Jarvis commit -m "type: description"
git -C ~/Jarvis push origin main
```

That is the complete action. The watchdog handles everything after the push:
1. Detects the new commit (polls every 10 minutes)
2. Runs `make check` — if tests fail, the running engine is untouched
3. Waits for an idle window (no messages in the last 30 minutes)
4. Builds and restarts the ion daemon cleanly via `deploy-ion-local`
5. Confirms ion is healthy, records the deploy to memory
6. Sends me a prompt to push a notification to the principal

**Never run any of these from within an active session:**
- `make deploy-ion`
- `make deploy-jarvis`
- `make deploy-ion-local`
- `launchctl bootout` / `launchctl bootstrap`

Running a deploy command from inside a live session will always orphan the daemon:
the bootout kills ion, which kills the active session, which drops the connection before
the bootstrap can fire. The watchdog is immune to this because it is a separate process
that outlives any ion session.

If a deploy is urgent and cannot wait for the next watchdog tick, tell Alex — he can
trigger it from his dev Mac where the SSH path to the Mini is intact.

## Staff governance — required checklist for any staff change

When a staff member is hired, retires, or changes domain ownership:

1. `harness/config/staff.yaml` -- add/update the entry with `status` and `when_to_call` triggers
2. `harness/agents/<id>.md` -- create or update the agent spec (this is the source of truth; it is bundled into the extension and loaded into the dispatch roster + injected catalog automatically)
3. `harness/identity/BEHAVIOR.md` -- only if the change introduces a genuine routing *judgment* the one-line catalog description cannot convey (e.g. a CFO-vs-Portfolio-style boundary), add it to "Routing edge cases & boundaries". There is no per-agent table to maintain anymore.
4. Run `make check` -- validate-staff fails if an active staff id has no `harness/agents/<id>.md` spec
5. commit and push — the deploy-watchdog picks up new commits and deploys automatically (within 10 min, after any active session ends)
