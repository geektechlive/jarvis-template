---
title: Self-Improvement Loop
description: How Jarvis proposes changes to its own config and identity on review branches, with daily caps and approval gates.
sidebar_position: 12
---

# Self-Improvement Loop

## Overview

Jarvis can autonomously propose improvements to its own configuration files, identity documents, and staff agent specifications. All proposals land on timestamped branches (`auto/improve-YYYY-MM-DDTHH-MM-SS`), never directly on main. A human must approve each merge via `/improve approve <branch>`. Rejected proposals are tracked and re-proposing them requires a material change in context.

This design balances autonomy with safety: Jarvis can identify and draft improvements without silently altering its behavior.

## The Safety Model: Why Branches, Not Direct Commits

**The problem:** If Jarvis had direct write access to its own config files, it could silently change how it behaves without human oversight. Config drift could compound over days or weeks.

**The solution:** Every improvement lands on an `auto/improve-*` branch. This creates a **review gate** even when approval is automatic. The branch serves as an audit trail: you can always see what Jarvis changed, when, and in response to what context.

**Why non-fast-forward merges?** The `--no-ff` flag preserves the branch in git history as a distinct commit. Without it, a fast-forward merge collapses the branch into main and you lose the record that this was a separate proposal. The git log entry `merge: auto/improve-2026-06-02T14-30-45 [approved]` remains visible forever.

**Why a daily cap?** Without it, Jarvis could create dozens of unapproved branches per day, cluttering the repo and losing meaning. One branch per calendar day prevents branch pollution and forces prioritization: if one improvement is already queued for approval, Jarvis stops proposing until you resolve it.

## Improvable Files

Jarvis may only edit files on an explicit allowlist. This prevents it from modifying its own runtime logic or infrastructure:

| Path | Purpose | Why Improvable |
|------|---------|----------------|
| `harness/config/models.yaml` | Model role assignments (e.g., triage LLM, consolidation LLM) | Configuration choices that affect behavior but don't require code changes |
| `harness/config/staff.yaml` | Staff roster config (enable/disable members, tune routing rules) | Staffing decisions are meta-preferences, not infrastructure |
| `harness/config/routines.yaml` | Enable/disable/retune scheduled routines | Routine cadences and flags are tunable knobs |
| `harness/identity/BEHAVIOR.md` | Explicit behavioral rules and constraints | Identity documents evolve as Jarvis learns; humans guide, Jarvis refines |
| `harness/identity/MISSION.md` | Mission and objectives | Same rationale |
| `harness/identity/GOALS.md` | Active goals and priorities | Same rationale |
| `harness/identity/PROJECTS.md` | Active projects and status | Same rationale |
| `harness/agents/*.md` | Staff agent specifications | Specs include tool access, routing rules, and system prompts; all tunable without code changes |

**Files that CANNOT be improved:**

- `harness/identity/SOUL.md` — Core persona (voice, values, fundamental identity) must not drift. Only humans can change this.
- `harness-ts/src/**` — The TypeScript runtime. Self-improvement should never edit its own orchestration logic.
- `tests/`, `tools-py/`, infrastructure files — Off-limits.

**Why SOUL.md is protected:** SOUL.md contains your core values and voice — the essence of who Jarvis is. If Jarvis could rewrite SOUL.md, it could gradually transform itself into something different without your noticing. By keeping SOUL.md human-only, you retain control of fundamental identity even as specific behaviors and preferences evolve.

## Daily Cap

Before attempting to run, the improve loop checks whether an `auto/improve-*` branch already exists for today's calendar date:

```typescript
const today = new Date().toISOString().slice(0, 10)  // e.g., "2026-06-02"
const r = await git(['branch', '--list', `auto/improve-${today}-*`])
```

If any branch matches today's date, the run exits immediately:

```
daily cap reached -- branch auto/improve-2026-06-02T14-30-45 already exists for today.
Use /improve approve auto/improve-2026-06-02T14-30-45 to merge it, or /improve reject to discard before running again.
```

**Why?** Prevents runaway branch creation and forces humans to stay in control. If Jarvis has already proposed something today, you need to act on it before it proposes more.

## Approval Flow

### `/improve approve <branch>`

Merges the branch to main with a non-fast-forward commit:

```bash
git merge --no-ff -m "merge: auto/improve-2026-06-02T14-30-45 [approved]" -- <branch>
git push origin main
git push origin --delete <branch>
```

The branch is then deleted locally and remotely. The commit message `[approved]` signals human approval in the log.

**Preconditions:**
- Working tree must be clean (no uncommitted changes)
- Branch must match the pattern `auto/improve-[\w-]+` (prevents typos and injection)
- Branch must exist both locally and remotely

**Post-merge workflow:**
- An approval record is created in SQLite (`approvals` table)
- The approval is marked `decided_at=NOW, decision='approved'`
- An event is logged to episodic: `improvement_merged`
- A second event is logged for feedback: `feedback_endorsement` (marks the branch as reinforced)

### `/improve reject <branch>`

Deletes the branch locally and remotely without merging:

```bash
git branch -D <branch>
git push origin --delete <branch>
```

The branch is gone, but its rejection is recorded:

- Approval record marked `decided_at=NOW, decision='rejected'`
- Event logged: `improvement_rejected`
- Feedback event: `feedback_correction` (marks the branch as rejected)

**Why track rejections?** The next time the improve loop runs, it reads rejection history via `recentImprovementEvents(90)`. If Jarvis proposes a change that is textually identical to one you rejected, it skips that proposal and surfaces a warning. The system prompt includes this history:

```
Do not re-propose previously rejected changes unless context has materially changed.
Build on what was previously approved rather than repeating it.
```

## The Improvement Loop: How It Works

When `/improve` is triggered (either via command or proactive scheduler), the loop:

1. **Check daily cap** — Is there already a branch for today? If yes, exit.

2. **Create a branch** — `git checkout -b auto/improve-<timestamp>`

3. **Load context** — Read all improvable files into a single user prompt, including:
   - Full content of `harness/config/*.yaml` files
   - Full content of `harness/identity/*.md` files
   - All `harness/agents/*.md` specs
   - Improvement history (past 90 days of approved and rejected changes)
   - Current focus area (from scheduler or user input)

4. **LLM loop** — Repeat until deadline or `DONE`:
   - Call an LLM (the `improve` role — OpenRouter `qwen/qwen-2.5-coder-32b-instruct` — or fall back to the improve-worker agent via `dispatchAgent`)
   - Parse XML suggestion: `<file>`, `<old>`, `<new>`, `<reason>` (or `<action>create`, `<content>` for new scripts)
   - Apply the change to disk
   - Run `pytest tests/ -q` to validate
   - If tests pass: `git add <file> && git commit -m "improve: <reason> [auto]"`
   - If tests fail: revert and retry up to `MAX_RETRIES=2` times
   - If still failing after retries: discard the change and log a revert event

5. **Final validation** — After the loop deadline:
   - Run `make check` (full lint + test suite)
   - If any check fails: delete the branch and exit
   - If all checks pass: `git push origin <branch>`

6. **Approval record** — Create an approval request in SQLite:
   - `kind='improve'`
   - `github_run_id=<branch_name>` (used later to find the branch when approving)
   - `files_changed=<list of files edited>`
   - `diff_excerpt=<first 2000 chars of `git diff main...branch`>`
   - `risk_tier='risky'` (always risky because it edits identity/config)

7. **Notify** — Surface the branch in an inbox item and Discord digest:
   ```
   Self-improvement branch ready: auto/improve-2026-06-02T14-30-45.
   2 change(s) committed, make check passed.
   Approval #42 queued in Discord.
   Use /improve approve auto/improve-2026-06-02T14-30-45 to merge and deploy.
   ```

### Deduplication: Avoiding Duplicate Proposals

If two branches propose identical changes (same diff output), the system keeps the older one and discards the newer:

```typescript
const currentDiff = await branchDiffVsMain(branch)
const allBranches = await getAllImproveBranches()
for (const b of allBranches) {
  if (b === branch) continue
  const existingDiff = await branchDiffVsMain(b)
  if (existingDiff === currentDiff) {
    // Keep b, delete branch
    await deleteBranch(branch)
    return `skipped — ${b} already proposes an identical change.`
  }
}
```

**Why?** Prevents redundant proposals cluttering the branch list and confusing the approval queue.

## Script Creation

Jarvis can also create new scripts in `scripts/` when it observes a capability gap. The system prompt includes:

> You may CREATE a new script in scripts/ when you observe a capability gap that a script would fill.

**Constraints:**
- Only flat filenames under `scripts/` — no subdirectories
- Every script must start with:
  ```bash
  # created_by: agent
  # created_at: YYYY-MM-DD
  ```
- Shell scripts are validated with `shellcheck` before commit
- Scripts are registered in `.usage.json` with state `candidate`

**Why only flat filenames?** Prevents Jarvis from creating deep directory structures that would be hard to maintain. Scripts are simple hand tools, not mini-libraries.

**Why the header?** Marks scripts created by Jarvis so humans know they're auto-generated and can be modified or deleted without concern for backwards compatibility.

## System Prompt Strategy

The improve loop uses a tuned system prompt that emphasizes:

### Good Improvements (do these):
1. Add concrete examples to vague rules
2. Add missing negative constraints to prevent failure modes
3. Replace corporate/AI-sounding text with plain language
4. Tighten agent specs: clearer tool descriptions, sharper routing rules, remove redundant DO NOT instructions
5. Enable a disabled routine if a clear user need exists
6. Add a missing rule for a visible failure pattern
7. Make implicit rules explicit

### Bad "Improvements" (never propose these):
- Rewording without changing behavior
- Renaming section headers
- Making text more formal or "professional"
- Adding corporate buzzwords: leverage, synergy, circle back, move the needle
- Adding AI filler: "provide insightful responses", "It's worth noting"
- Removing safety constraints or persona rules
- Adding banned tokens

### Anti-Hallucination Guardrail:
The system prompt includes:

> The `<old>` text MUST be copy-pasted verbatim from the === CURRENT SOURCE FILES === section.
> NEVER quote conversation history in `<old>` tags.
> Preserve exact whitespace and punctuation when copying.

This prevents the LLM from inventing text that doesn't exist in the source files. If the LLM outputs a change with an `<old>` block that doesn't match verbatim, the `applyTextChange()` function rejects it:

```typescript
const matchCount = content.split(old).length - 1
if (matchCount === 0) {
  return `Error: old text not found in ${filepath}`
}
if (matchCount > 1) {
  return `Error: old text appears ${matchCount} times; must be unique`
}
```

## Rejection History and Dedup

When the loop starts, it loads improvement history:

```typescript
const { merged, rejected } = recentImprovementEvents(90)
```

This returns:
- `merged`: approved branches from the past 90 days with their file lists
- `rejected`: rejected branches from the past 90 days

The system prompt gets:

```
Past improvements approved (last 90 days):
  - auto/improve-2026-05-28T09-15-30 [harness/config/staff.yaml, harness/identity/GOALS.md]
  - auto/improve-2026-05-25T14-00-00 [harness/agents/admin-agent.md]

Past improvements rejected (last 90 days):
  - auto/improve-2026-06-01T10-30-00

Do not re-propose previously rejected changes unless context has materially changed.
Build on what was previously approved rather than repeating it.
```

**Why two separate lists?** Approved changes are context for the LLM to build upon ("I see you already enabled this routine; I can now tune it further"). Rejected changes are warnings ("I see you rejected a similar proposal; don't repeat it").

## Slash Commands Reference

| Command | Effect |
|---------|--------|
| `/improve` | Runs the improvement loop once (15-min budget) |
| `/improve approve <branch>` | Merges branch to main with `--no-ff`, creates approval record, deletes branch |
| `/improve reject <branch>` | Deletes branch without merging, logs rejection |
| `/improve` with focus area | `run(15, 'focus_area')` passes focus to the LLM prompt |

**Note:** `/improve` is wired to the scheduler and may run proactively. You can also invoke it manually via `/improve` or through the approve/reject commands.

## What Cannot Be Improved (and Why)

| Component | Reason |
|-----------|--------|
| `harness/identity/SOUL.md` | Core persona must remain under human control. Changing it autonomously would allow Jarvis to drift away from fundamental values. |
| `harness-ts/src/**` | The orchestration runtime. Allowing edits would create an infinite loop: the extension could modify itself and reload. Security nightmare. |
| `tests/` | Test harnesses are infrastructure. Breaking tests allows broken changes to ship. |
| `tools-py/`, `ion/`, infrastructure | Same rationale as runtime. |

## Integration with Deployment

When you approve an improvement branch, the merge is pushed to main. The next time `make deploy-jarvis` runs, the new config is deployed to the Mini and launchd is restarted.

**Do NOT run `make deploy-jarvis` while an improvement loop is running.** The improve loop is making git commits; a concurrent deploy could corrupt the branch history or lose changes.

## Failure Modes and Recovery

### "Branch Already Exists for Today"
You have an unapproved improvement branch from earlier today. Either:
- `/improve approve <branch>` to merge it
- `/improve reject <branch>` to discard it

Then you can run `/improve` again.

### "Make Check Failed on Branch"
The branch passed tests in the loop but failed `make check` (lint + full test suite). The branch is deleted automatically. This usually means:
- Linting issues (spacing, imports)
- Test failures in a test that wasn't run in the loop
- Type errors in the full TypeScript build

Review the improvement loop output for details. If the change was good but the validation too strict, you can run `/improve` again to re-propose it.

### "Push to Origin Failed"
The branch is ready locally but pushing to GitHub failed (network issue, auth, etc.). The loop returns a message like:

```
branch auto/improve-2026-06-02T14-30-45 ready locally (push failed).
Use /improve approve auto/improve-2026-06-02T14-30-45 to merge.
```

You can still approve it locally. The branch will merge on main and push on the next retry.

### "LLM Call Timed Out"
The OpenRouter call (the `improve` role) or improve-worker agent took longer than 120 seconds. The loop exits cleanly with no branch created. Try again; this is usually transient (upstream latency).

## Performance and Tuning

- **Loop budget:** 15 minutes by default (configurable)
- **Model:** the `improve` role — OpenRouter `qwen/qwen-2.5-coder-32b-instruct` — or improve-worker agent via `dispatchAgent()`
- **Temperature:** 0.2 (low creativity, high consistency)
- **Context window:** 8192 tokens
- **Timeout per LLM call:** 120 seconds
- **Max retries per failed test:** 2 attempts
- **File content cap:** Files under 3KB sent in full; larger files have system prompts extracted only

Jarvis will not propose improvements that fail validation. The test gate ensures every suggestion is sound before surfacing it.
