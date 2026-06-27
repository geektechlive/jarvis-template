---
title: Approvals
description: State machine for gating autonomous Jarvis actions — risk tiers, Discord integration, and the approval lifecycle.
sidebar_position: 13
---

# Approvals

## Overview

The approval system is a SQLite-backed state machine that gates autonomous actions requiring human review. When Jarvis is about to take a real-world action that is risky (merging a PR, applying self-improvement changes, deploying code), it creates an approval request instead of proceeding. The request is posted to Discord with reaction buttons for instant approval or denial, and persisted in the `approvals` table until resolved.

**Approval kinds:**
- `resolver` — patrol resolver PRs awaiting merge
- `improve` — self-improvement branches awaiting merge
- `desktop_deploy` — ion Desktop deployments
- `ios_deploy` — iOS TestFlight builds

## Why an Approval System?

Jarvis is always-on and can take real-world actions: pushing code, merging branches, sending mail, modifying configs. Without a human-in-the-loop checkpoint, an erroneous autonomous decision could cause harm. The approval system creates a gating mechanism:

1. **Safety first** — risky actions require explicit human consent
2. **Audit trail** — every approval decision is logged for reproducibility
3. **Low friction** — Discord reactions make approval instant; no tool-switching required
4. **Contextual awareness** — Jarvis sees pending approvals in every prompt and does not re-propose the same action

## State Machine

Approvals transition through these states:

```
requested (decided_at IS NULL)
  ├─ approved  (decided_at NOT NULL, decision='approved')
  ├─ denied    (decided_at NOT NULL, decision='denied')
  └─ expired   (decided_at NOT NULL, decision='expired')
```

**State diagram:**

```
┌─────────────┐
│  requested  │  ← createApproval()
└──────┬──────┘
       │
       ├─→ approved  (decide(id, 'approved', user))
       │      └─→ Approver applies the change
       │
       ├─→ denied    (decide(id, 'denied', user))
       │      └─→ Requester learns why and may retry
       │
       └─→ expired   (expireOlderThan(hours))
              └─→ Request becomes stale; must re-request
```

**Why expiry:** An un-acted-upon approval request becomes stale as context changes (new commits, requirements shift, timeline extends). Rather than leaving it pending forever, `expireOlderThan(hoursAgo)` marks old requests as expired. The requester can then re-submit if the action is still needed.

## Risk Tier Classification

Approvals are classified as `safe` or `risky` by examining the set of changed file paths via `classifyRiskTier(filesChanged)`. The tier determines whether the action auto-proceeds or requires explicit approval.

**Classification logic:**

An approval is classified as **safe** only if ALL of the following are true:
- At least one file changed (empty list is risky)
- Every file lives under `harness-ts/src/`
- No file matches a risky prefix or suffix

Otherwise it is **risky**.

**Risky prefixes:**
```
harness/identity/        (persona, behavior, mission, goals, projects)
harness/config/          (models.yaml, staff.yaml, routines.yaml)
harness-ts/src/patrol/   (patrol resolver logic)
harness-ts/src/improve/  (self-improvement logic)
harness-ts/src/approvals/  (approval system itself)
harness-ts/src/discord/  (Discord integration)
harness-ts/src/scheduler/  (proactive routines)
harness-ts/src/learning/   (learning pipeline)
harness-ts/src/hooks/    (prompt hooks)
```

**Risky suffixes:**
```
.plist                   (macOS configuration files)
```

**Why this spectrum:**

- **Safe:** changes to utility functions, minor refinements to non-critical modules. These can proceed without review.
- **Risky:** changes to identity, config, infrastructure, or the approval system itself. These require human eyes because they affect the principal's long-term persona or Jarvis's core behavior.

The patrol resolver always creates approvals with `risk_tier='risky'` regardless of the files changed. The improve loop also always marks improvements as `risky` because they edit identity and config files. Desktop and iOS deployments use tier classification.

## Discord Integration

When an approval is created, it is posted to Discord for visibility and instant reaction-based approval/denial.

**Flow:**

1. `createApproval(...)` inserts a row into the `approvals` table
2. `postPendingDigest()` fetches all pending approvals and posts a single digest message to Discord
3. The message includes one line per approval with a 1-indexed "local index" (e.g., "1. resolver PR #42", "2. improve auto/improve-xxx")
4. `bindDigest(approvalIds, messageId, indexMap)` stores the Discord message ID and local index for each approval
5. When a user reacts to the message, the Discord bot's reaction handler uses `findByLocalIndex(localIndex)` to look up which approval was clicked
6. The bot calls `decide(id, decision, userId)` to record the decision and re-reads the approval via `getById(id)`

**Why this design:**

- **Single message per digest:** aggregates all pending approvals into one Discord post, reducing notification spam
- **Local indexing:** users type `:one:` or `:two:` to vote on an approval without guessing approval IDs
- **Message binding:** Discord message IDs are stored so the bot can update the message with edit counts or decision outcomes

## Before-Prompt Injection

When Jarvis receives a user prompt, the `before_prompt` hook runs and checks for pending approvals. If any exist, a summary block is injected into the context so Jarvis is always aware of pending decisions.

**Why:** Without this, Jarvis might re-propose the same action (e.g., "I should merge this PR now") without knowing it already has a pending approval waiting for user decision. The injection ensures Jarvis is context-aware and does not churn.

The injection is built by examining the `approvals` table for rows with `decided_at IS NULL` and formatting a human-readable summary including:
- Approval ID
- Kind (resolver, improve, etc.)
- Summary (commit message, branch name, etc.)
- Requested timestamp
- GitHub link (if applicable)

## Audit Trail

Every approval decision is logged in the `actions` table with:
- `id` — auto-incremented row ID
- `kind` — `'resolver'`, `'improve'`, `'desktop_deploy'`, `'ios_deploy'`
- `github_issue_number` — link back to the GitHub issue (patrol resolver only)
- `summary` — human-readable description of the action
- `decided_by` — Discord user ID or CLI user of the person who approved/denied
- `decision` — `'approved'`, `'denied'`, or `'expired'`
- `decided_at` — Unix timestamp when decision was recorded

**Why:** Reproducibility and accountability. You can always audit why a particular action was taken, by whom, and when. Useful for incident review or explaining a decision to collaborators.

## Slash Commands

Commands are dispatched from Discord or the CLI. The approvals system drives these slash commands:

### `/approve <id>`
Approve a pending approval by its numeric ID. The user provides the approval ID (e.g., `/approve 42`).

**Behavior:**
- Calls `decide(id, 'approved', userId)`
- Triggers the appropriate action handler (e.g., `mergeBranch()` for improve approvals)
- Posts a confirmation to Discord
- Logs the decision to `actions` table

### `/deny <id>`
Reject a pending approval. The user provides the approval ID.

**Behavior:**
- Calls `decide(id, 'denied', userId)`
- No further action is taken (the action is not performed)
- Posts a denial notice to Discord
- Logs the decision

### `/pending`
List all pending approvals (those with `decided_at IS NULL`).

**Behavior:**
- Calls `getPending()` to fetch pending approvals
- Posts a digest of pending approvals to Discord (via `postPendingDigest()`)
- Useful if you want a fresh digest without waiting for the next one to auto-post

## Integration Points

### Patrol Resolver
When the patrol resolver detects a ready-to-merge issue, it creates a `resolver` approval:

```typescript
const approvalId = createApproval({
  kind: 'resolver',
  github_issue_number: issue.number,
  summary: commitMsg,
  files_changed: changedFiles,
  diff_excerpt: diffExcerpt,
  risk_tier: 'risky',  // always risky
})
```

The approval blocks the merge. When `/approve <id>` is issued, the resolver applies the patch and pushes the branch.

### Improve Loop
When the curator completes an improvement iteration, it creates an `improve` approval:

```typescript
const approvalId = createApproval({
  kind: 'improve',
  github_run_id: branch,  // branch name
  summary: `improve: ${fileCount} change(s) on ${branch}`,
  files_changed: committedFiles,
  diff_excerpt: diffExcerpt,
  risk_tier: 'risky',  // always risky (edits identity/config)
})
```

The approval blocks the merge. When `/improve approve <branch>` is issued, the merge is applied to main.

### Scheduler Interventions
The scheduler's `intervention_digest` routine checks pending approvals to surface stuck issues (no `jarvis-auto` label, not in pending approvals) to the user. This prevents Jarvis from appearing stuck when it is actually waiting for approval.

## Database Schema

```sql
CREATE TABLE approvals (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  kind                  TEXT    NOT NULL,
  github_run_id         TEXT,                 -- branch name (improve) or run ID (resolver)
  github_issue_number   INTEGER,              -- link to GitHub issue (resolver only)
  summary               TEXT    NOT NULL,     -- human-readable description
  files_changed         TEXT,                 -- JSON array of file paths
  diff_excerpt          TEXT,                 -- snippet of the actual diff
  risk_tier             TEXT    NOT NULL,     -- 'safe' or 'risky'
  discord_message_id    TEXT,                 -- Discord message ID after posting
  discord_local_index   INTEGER,              -- 1-based index within the digest message
  requested_at          INTEGER NOT NULL,    -- Unix timestamp (ms)
  decided_at            INTEGER,              -- Unix timestamp (ms); NULL while pending
  decision              TEXT,                 -- 'approved', 'denied', 'expired', or NULL
  decided_by            TEXT                  -- Discord user ID or CLI user
);

CREATE INDEX idx_approvals_pending 
  ON approvals(decided_at) WHERE decided_at IS NULL;
```

The index on `(decided_at) WHERE decided_at IS NULL` makes `getPending()` fast by only touching pending rows.
