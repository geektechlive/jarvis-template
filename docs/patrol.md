---
title: Patrol Resolver
description: Autonomous GitHub issue resolver — complexity gates, risk tiers, git safety checks, approval workflow, and feedback learning.
sidebar_position: 15
---

# Patrol Resolver

## Overview

Patrol is a background autonomous system that monitors GitHub issues and attempts to resolve them without human prompting. It is an always-on engineering assistant that can read the repo, propose fixes, create branches, run tests, open pull requests, and request approval to merge.

**Why Patrol exists:** Small bugs and config issues accumulate. Without patrol, they sit in the backlog indefinitely. Patrol gives Jarvis a way to clear known-good, low-risk issues autonomously while preserving human review for anything risky. This is the core productivity multiplier — humans focus on hard problems; Jarvis plows through known-good work.

## The Resolver Pipeline

The resolver runs on a scheduled cadence (via `scheduler/index.ts`) and proceeds through these stages:

```
1. Issue Fetch          → Fetch all open issues labeled `jarvis-auto` from GitHub
2. Daily Cap Check      → Confirm < 10 issues resolved today (circuit breaker)
3. Priority Ranking     → Sort by milestone, severity, issue number
4. Failure Filtering    → Skip issues with ≥3 recent failures (unless re-labeled)
5. Eligibility Filter   → Skip if pending approval exists
6. Complexity Gate      → Skip if body too short, enhancement, or feat prefix
7. Workspace Check      → Abort if dirty (prevents git diff corruption)
8. Agent Run            → Dispatch to eng-lead worker agent (Claude Sonnet 4.6)
9. Changes Detection    → Parse `git status --porcelain` to find files changed
10. make check          → Validate lint, test, build (300s timeout)
11. Risk Classification → Classify changes by scope and file pattern
12. Safe Path           → Commit, push, close (if low-risk)
    OR
    Risky Path          → Stage, stash, create approval, notify Discord
13. Feedback Poll       → Monitor for deploy outcome (success/failure/unknown)
14. Stale Cleanup       → Remove old stash entries > 7 days
```

Each stage has its own abort condition and logging event for observability.

## Complexity Gate

Not all issues are worth attempting autonomously. The complexity gate filters issues before dispatch to the agent.

**Gate criteria** (`complexityGate()` in resolver.ts):
- Issue must have a GitHub issue number
- Issue body must be ≥ 10 characters (avoids one-liners)
- Issue must NOT have the `enhancement` label (new features are risky)
- Issue must NOT start with `feat:` prefix (feature requests bypass resolver)

**Why this gate:** The resolver will waste compute on issues it cannot solve. A vague one-liner or a feature request is almost guaranteed to fail or produce over-scoped changes. Filtering these early preserves resources and prevents false failures that accumulate in the recent-failures map.

**When an issue fails the gate:** It is skipped silently (no notification, no failure count increment). This means the issue can be triaged by humans or the description can be improved without the resolver getting in the way.

## Priority Ranking and Failure Recovery

Issues are ranked by:
1. **Milestone rank** — M1 (Reliability & Safety) → M4 (Tools & Integrations); unknown milestones rank last (99)
2. **Severity rank** — critical → high → medium → low; no severity also ranks last (99)
3. **Issue number** — lower numbers (older issues) win ties

**Why this order:** Critical reliability bugs in core systems unblock everything else. Medium-priority tool bugs can wait. This prevents new, high-visibility issues from starving old, low-priority tech debt.

**Failure recovery:** Each issue tracks recent failures (resolver_check_failed, resolver_agent_failed) over 30 days. If an issue has ≥3 failures, it is removed from the queue. **However**, if a human re-labels or edits the issue after the last failure, the failure count resets. This allows humans to signal "I fixed the root cause, try again."

**Why this threshold:** 3 failures catches systemic problems (e.g., a dependency issue affecting all resolver runs) without blocking forever. Reset-on-update gives humans control without requiring manual intervention.

## Daily Cap

The resolver has a **daily cap of 10 resolved issues** (`RESOLVER_DAILY_CAP = 10`).

**Why:** Prevents the resolver from consuming all compute on a bad day. If a config issue causes every issue to appear solvable, the resolver should not attempt all 100 at once. The cap preserves resources for interactive use and prevents CI/CD saturation.

**How it works:** At the start of each run, the resolver queries recent_events for 'resolver_delivered' (successful closes) in the last 24 hours. If ≥10 are found, the resolver stands down entirely. Otherwise, it processes up to `min(remaining_slots, 3)` issues per invocation (allows multiple runs per day).

**Circuit breaker pattern:** The daily cap acts as a circuit breaker. If something is wrong (e.g., all test runs are failing), the resolver will hit the cap, log a warning, and stand down for the day rather than hammering the system.

## Git Safety Checks

Autonomous git operations are irreversible. The resolver has multiple safety layers:

### 1. Dirty Workspace Check
**Before agent dispatch:** Run `git status --porcelain` and abort if the workspace has uncommitted changes.

**Why:** Uncommitted changes from a prior failed run would corrupt the `git diff` used to detect what the agent changed. If the workspace is dirty, something went wrong (daemon crash, previous resolver failed to clean up), and the safest move is to abort and notify the user.

### 2. Post-Check Rollback
**After `make check` fails:** Run `git checkout -- .` and `git clean -fd` to discard all changes.

**Why:** If lint, tests, or build fail, the fix is incomplete. Discarding changes prevents a half-broken commit from being created. A new agent run can try again with fresh eyes.

### 3. Stash-Based Staging (Risky Path)
**For high-risk changes:** Stage changes with `git add`, create a diff excerpt, stash with `git stash push --staged -m approval-{id}`, and leave the issue open.

**Why:** Stashing preserves the changes across daemon restarts (unlike in-memory state). The approval ID is burned into the stash message, so the changes can be retrieved and applied later if approved. This decouples the fix attempt from the approval decision.

### 4. Post-Push Reset (Push Failure)
**If `git push` fails:** Run `git reset --hard HEAD~1` to undo the commit.

**Why:** If the push fails (e.g., branch protection, network), the local commit is orphaned and dangerous to the next agent run. Resetting ensures the repo is clean for retry.

## Risk Classification

After `make check` passes, the resolver classifies the changes by risk tier using `classifyRiskTier(changedFiles)` (see `approvals/riskTier.ts`).

**Risk tiers:**
- **SAFE** — Commit and push immediately (no approval required)
  - Example: config file, docs, test-only changes
- **LOW** — May auto-proceed (depends on approvals.yaml)
- **MEDIUM** — Requires explicit approval
- **HIGH** — Requires explicit approval (higher scrutiny)
- **CRITICAL** — Blocked; resolver will not attempt

**Why risk tiers:** A one-line config fix is fundamentally different from a refactor touching 15 files. Tiers let humans set different review thresholds per file pattern. Safe changes (docs, tests) can ship directly; risky changes (core logic, multiple subsystems) must get human eyes.

## Approval Integration

When a change is classified as risky (MEDIUM/HIGH/CRITICAL), the resolver creates an approval record instead of committing directly.

**Approval flow:**
```
1. createApproval() stores metadata in the SQLite approvals table
   - kind: 'resolver'
   - github_issue_number: the issue being fixed
   - summary: the commit message
   - files_changed: list of modified files
   - diff_excerpt: first 2000 chars of the git diff
   - risk_tier: 'risky' (resolver always creates with this tier)

2. git stash push --staged -m approval-{id}
   → Changes are stashed, not committed

3. postPendingDigest()
   → Adds the approval to a Discord digest batch

4. notifyResolverAwaiting()
   → Posts to Discord: approval ID, summary, file list, GitHub link

5. Issue comment: "Resolver staged a fix awaiting approval (approval #{id})"
   → Closes the feedback loop in GitHub

6. logEvent('resolver_awaiting_approval')
   → Audits the decision to wait
```

**Why stashing:** Stashes survive daemon restarts and cluster reboots. Approval metadata is durable in SQLite. When the user approves via `/approve {id}`, the stash is re-applied and pushed.

**Why the digest:** Combining multiple approvals into a single Discord message reduces notification spam and lets humans review all pending work at once.

## Feedback Learning

After the resolver commits and pushes (safe path only), a feedback loop runs to detect the deploy outcome.

**Feedback stages:**
```
1. resolver_delivered event logged with commit SHA
   → Watchdog detects the new commit in main
   
2. Watchdog runs CI/CD and logs deploy outcome
   → desktop_deploy status=success or failure
   → OR watchdog SUCCEEDED or FAILED
   
3. Feedback poller wakes up after 1-5 min
   → Query vec-server for memories containing the short SHA
   → classifyOutcome() matches deploy status against the SHA prefix
   → Log resolver_shipped (success) or resolver_failed (failure)
   
4. Discord notification
   → "Autonomous resolver deployed commit ABC: X files changed"
   → Or: "Deploy failed for commit ABC"
```

**Why feedback loop:** The resolver will make mistakes. By learning from deploy outcomes, it can improve. Feedback also closes the loop visually — users see whether the fix actually shipped or failed.

**Max wait:** 10 minutes. If no outcome is detected after 10 min, log resolver_unknown and move on (prevents stalled feedback from blocking future runs).

## Stale Approval Cleanup

The `scanStaleApprovals()` routine runs once per day (via `addDaily()` in scheduler) and surfaces approvals that have lingered ≥7 days without a decision.

**Stale approval handling:**
- Query SQLite for all pending approvals (created but not decided)
- Filter to those older than 7 days (`STALE_THRESHOLD_DAYS = 7`)
- Per approval: deduplicate notifications (skip if already surfaced in last 23 hours)
- Post to Discord: issue number, summary, age in days
- Log `stale_approval` event (not auto-reject, just notify)

**Why 7 days:** Approvals older than a week are likely forgotten or blocked on context. A human reminder gives them a chance to decide or re-triage.

**Why not auto-reject:** Rejecting a stale approval could hide valid work. Humans should decide whether to approve, reject, or update the description.

## Stash TTL Management

Stashes created by the resolver have a 7-day TTL (`STASH_TTL_DAYS = 7`). The `warnStaleStashEntries()` routine logs warnings for any stash older than the TTL.

**Why TTL:** Stashes are a temporary holding pattern. If an approval sits for a week, the stash may be out of date (main has advanced) or the issue context has changed. Warnings prompt humans to either approve/reject or leave the issue unlabeled.

**Cleanup is manual:** `git stash drop` must be run by humans (or a script). The resolver logs warnings but never auto-drops.

## Monitoring and Logs

### Events (SQLite agent_events table)

All resolver activities log events for audit and monitoring:

| Event | Trigger | Fields |
|-------|---------|--------|
| `resolver_started` | Resolver picks up an issue | `issue`, `title` |
| `resolver_dirty_workspace` | Pre-flight check finds uncommitted changes | `issue`, `files` |
| `resolver_agent_failed` | eng-lead agent crashed or timed out | `issue`, `status`, `err`, `usedSubprocess` |
| `resolver_no_changes` | Agent ran but made no file changes | `issue` |
| `resolver_check_failed` | `make check` failed (lint/test/build) | `issue`, `checkOutput` |
| `resolver_awaiting_approval` | Risky change stashed, awaiting approval | `issue`, `approvalId`, `files` |
| `resolver_delivered` | Commit pushed to main (safe path) | `issue`, `sha`, `files` |
| `resolver_shipped` | Deploy confirmed successful (feedback poll) | `issue`, `sha` |
| `resolver_failed` | Deploy confirmed failed (feedback poll) | `issue`, `sha` |
| `resolver_unknown` | Deploy outcome unknown after 10 min | `issue`, `sha` |
| `resolver_commit_failed` | `git commit` failed | `issue`, `err` |
| `resolver_push_failed` | `git push` failed | `issue`, `err` |
| `resolver_stash_failed` | `git stash push` failed | `issue`, `approvalId` |
| `resolver_all_capped` | Daily cap reached, standing down | `totalIssues`, `skippedByFailure` |
| `resolver_all_pending` | All eligible issues have pending approvals | `eligible` |
| `resolver_stale_stash` | Stash entry exceeds 7-day TTL | `stashRef`, `approvalId`, `ageDays` |
| `resolver_failure_reset` | Issue re-labeled after failure, reset counter | `issue` |
| `stale_approval` | Approval pending ≥7 days | `approvalId`, `age_days` |

### Logs (stderr, ion engine.log)

Real-time patrol activity:
```
patrol/resolver: daily cap reached, standing down
patrol/resolver: no jarvis-auto issues, standing down
patrol/resolver: issue has pending approval, trying next
patrol/resolver: skipped — complexity gate
patrol/resolver: dirty workspace, aborting
patrol/resolver: ion dispatch unavailable, falling back to subprocess
patrol/resolver: make check failed
patrol/resolver: risky change staged, awaiting approval
patrol/resolver: git push failed
patrol/staleApprovals: no stale approvals
patrol/staleApprovals: found 2 stale approvals
```

### Discord Notifications

Patrol posts updates to a configured Discord channel:

| Notification | Condition |
|---|---|
| `notifyResolverStarted` | Resolver picked up an issue |
| `notifyResolverDirtyWorkspace` | Workspace not clean, abort |
| `notifyResolverAgentFailed` | Agent crashed or timed out |
| `notifyResolverNoChanges` | Agent made no changes, label removed |
| `notifyResolverCheckFailed` | Lint/test/build failed, label removed |
| `notifyResolverAwaiting` | Risky change stashed, awaiting approval |
| `notifyResolverShipped` | Safe change committed and pushed |
| `notifyResolverDailyCap` | Daily cap reached |
| `notifyResolverAllCapped` | All issues at failure cap |
| `notifyResolverAllPending` | All eligible issues have pending approvals |

These notifications appear as inline Discord embeds with links to the GitHub issue.

## Configuration

Patrol is configured via:

| Config | Location | Purpose |
|--------|----------|---------|
| `RESOLVER_DAILY_CAP` | `resolver.ts` | Max resolved issues per day (10) |
| `RESOLVER_MAX_RUN_MS` | `resolver.ts` | Timeout for entire run (33 min) |
| `BODY_LIMIT` | `resolver.ts` | Max issue body chars to send to agent (3000) |
| `BODY_MIN` | `resolver.ts` | Min issue body chars to attempt fix (10) |
| `STASH_TTL_DAYS` | `resolver.ts` | Stash expiration warning threshold (7 days) |
| `STALE_THRESHOLD_DAYS` | `staleApprovals.ts` | Approval expiration threshold (7 days) |
| `stale_approval_scan` | `harness/config/routines.yaml` | Feature flag for stale approval scanning |
| Risk tier rules | `harness-ts/src/approvals/riskTier.ts` | File patterns → risk classification |

## Typical Workflow

### Happy Path (Safe Change)
```
1. Human adds jarvis-auto label to a bug issue
2. Resolver picks it up
3. eng-lead agent reads code and implements fix
4. make check passes
5. classifyRiskTier: detected as SAFE (e.g., test-only change)
6. Commit: "fix: resolve #123 foo [auto]"
7. Push to main
8. Close issue with "Resolved autonomously. Commit ABC."
9. Watchdog picks up commit, runs deploy
10. Feedback poller: "Deploy successful"
11. Discord: "Autonomous resolver deployed commit ABC"
```

### Risky Path (Approval Required)
```
1. Human adds jarvis-auto label to a bug issue
2. Resolver picks it up
3. eng-lead agent reads code and implements fix
4. make check passes
5. classifyRiskTier: detected as MEDIUM/HIGH (touches core code)
6. Stage changes, create approval #42
7. Stash staged changes as approval-42
8. Post Discord: "Awaiting approval #42 for issue #123"
9. Issue comment: "Resolver staged a fix awaiting approval"
10. Human reviews diff, runs `/approve 42` in Discord
11. Resolver applies stash, commits, pushes
12. Close issue, proceed as in happy path
```

### Failure Path
```
1. Agent runs, make check fails
2. Resolver rollbacks (git checkout --, git clean -fd)
3. Remove jarvis-auto label
4. Issue comment: "Autonomous resolver make check failed. [output]"
5. Discord: "Resolver check failed for issue #123"
6. Human triages: update description or re-add label once root cause is clear
```

## Design Rationale

### Why Subprocess Fallback?
The resolver uses `ion ctx.dispatchAgent()` when called from an active hook context, but falls back to `claude` CLI subprocess when called from the scheduler (which runs in an async context with no hook context). This dual path is necessary because ion's dispatch requires an active request context, but the scheduler timer fires independently.

### Why Stashing Over Branches?
The resolver could create feature branches (`resolver/#123`), but stashing is simpler and safer:
- Stash survives daemon restarts without needing branch cleanup
- No branch naming collision concerns
- Approval metadata is in SQLite, not in branch metadata
- Single git operation: `git stash push --staged` is atomic and fast

### Why Feedback Poll Instead of Sync?
The resolver doesn't wait for deploy to finish. Instead:
- Resolver finishes in ~2-3 min (agent run + git ops)
- Watchdog deploys asynchronously (another 2-5 min)
- Feedback poller checks in periodically (1-5 min poll cycle)

This decoupling allows the resolver to process multiple issues in parallel without blocking on CI/CD.

### Why Confidence-Based Failure Filtering?
Instead of a simple "skip if 3 failures," the resolver resets the failure count if the issue is updated after the last failure. This signals: "I acknowledge the context has changed, try again." It's a lightweight way to let humans override the circuit breaker without requiring explicit commands.
