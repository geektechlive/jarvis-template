---
title: Triage and Inbox
description: How Jarvis classifies and routes ingested content — decision types, urgency floors, inbox accumulator, and the drain pattern.
sidebar_position: 14
---

# Triage and Inbox

## Overview: The Content Pipeline

When Jarvis ingests content from external sources — mail, iMessage, Safari, Discord, calendar events, commits, Slack — it goes through a triage classifier before reaching the conversation:

```
ingest_item (tool) → triage classifier → decision → inbox accumulator OR direct notification
```

The triage system is owned by the Chief of Communications agent. It answers a single question for every item: **How urgent is this, and where should it go?**

## Why Triage?

Jarvis ingests items from many sources with varying signal-to-noise ratios. Without triage:

- Every item would either be ignored (silent death) or flood the conversation (noise)
- Low-signal sources (RSS, GitHub commits) would consume the same attention budget as high-signal sources (calendar conflicts, high-weight contacts)
- Jarvis would be reactive instead of proactive

Triage solves this by classifying each item's urgency and routing it to the appropriate delivery bucket. The system is learnable: the Chief of Communications agent can override triage decisions, and those corrections are stored as preferences for future classification.

## Decision Types

The triage classifier returns exactly one of five decisions for every ingested item:

| Decision | Meaning | What Happens |
|----------|---------|--------------|
| **suppress** | Irrelevant or noise; store silently | No notification, no batch, no user awareness. Item is discarded. |
| **batch** | Relevant but not urgent; accumulate for digest | Item is added to the inbox accumulator. Will appear in morning brief or when user says "what's new". |
| **notify** | Informational; surface now as brief notification | Logged as `inbox_item` event with routine=notify. User sees a notification immediately. |
| **question** | Needs user attention; phrased as a short question | Logged as `inbox_item` event with routine=triage_question. The "reason" field contains the question (e.g., "I noticed your flight is delayed — want me to reschedule?"). Surfaces as a question in conversation. |
| **review** | Requires user Accept/Reject before any agent action | Logged as `inbox_item` event with routine=triage_review. User must explicitly approve or reject before the proposed action is taken. |

**Default conservatism:** The system prefers batch over notify, suppress over batch. This prevents low-signal sources from ever reaching notification level regardless of content urgency.

## Urgency Floors

Each source has a minimum urgency floor. A score below the floor is clamped to the floor, preventing low-signal sources from triggering high-priority decisions.

```typescript
URGENCY_FLOORS: {
  mail: 0.4,          // Important business; relatively high signal
  calendar: 0.7,      // Calendar events are almost always actionable
  commits: 0.3,       // Low signal; suppress by default
  slack: 0.6,         // Medium-high signal; mentions usually matter
  browser: 0.2,       // Lowest signal; Safari activity, links, etc.
}
```

**Why floors?** Without them, a message from a low-weight sender (e.g., an automated monitoring alert) could be classified as "urgent" and trigger a notify decision. Floors enforce source-level policy: "commits should never notify, only batch or suppress, regardless of content."

The classifier receives the floor for the item's source and applies it: `score = max(rawScore, floor)`. If the classifier returns 0.1 for a GitHub commit, the floor 0.3 applies, so the final score is 0.3.

## The Inbox Accumulator

Items with decision `batch` are added to the inbox accumulator, stored in the SQLite `agent_events` table.

### Hard Cap: 500 Items

The accumulator enforces a 500-item maximum. If an item arrives and the pending count is already 500, the new item is dropped and a warning is logged.

**Why 500?** Jarvis may go offline for days (network outage, Mini reboot). Without a cap, accumulated batch items could grow unbounded. 500 is a reasonable trade-off: it holds 2-3 days of moderate ingestion without risking memory or database bloat.

### Overflow Threshold: 20 Items

When the accumulator reaches exactly 20 pending items, an overflow notification fires:

```
I have 20 items waiting in the batch digest. Say 'what's new' for them now, 
or they will appear in the morning brief.
```

**Why 20?** This is a gentle nudge before accumulation becomes overwhelming. 20 items can be reviewed in a few minutes. The threshold gives Jarvis a chance to drain the inbox proactively without blocking until the hard cap is reached.

## Drain Pattern

The inbox is drained on demand (typically via the morning brief or the user's `what's new` command) using a cursor-based query:

```typescript
function drainCursorId(): number {
  const row = lastEvent(SESSION, 'inbox_drained');
  return row.detail['after_id'] ?? 0;
}

function drain(n = 200): BatchItem[] {
  const cursor = drainCursorId();
  const rows = eventsSince(cursor, SESSION, 'inbox_batch');
  
  // Emit a drain marker
  logEvent(SESSION, 'inbox_drained', { after_id: maxId });
  
  // Return sorted by descending score
  return rows.sort((a, b) => b.score - a.score).slice(0, n);
}
```

**Why cursor-based?** Every drain emits a marker event (`inbox_drained`) with the last item ID. The next drain starts from that ID, so items are drained exactly once. This works even if Jarvis crashes mid-drain or the session ends unexpectedly.

**Why sort by score?** Higher-urgency items are presented first. A 0.9-score item appears before a 0.3-score item, so the user sees the most important batch items first.

## Classification Model

Triage classification runs on the `intent` role. As of issue #775 that role is `backend: apple` — **on-device Apple Foundation Models** (macOS 26 Tahoe / Darwin 25+), served by `tools-py/apple-foundation` on port 9878 via the `afm` Swift helper. The primary path in `classify()` (`harness-ts/src/triage/index.ts`) calls `afmGenerateTyped()` with a typed schema (`decision` enum, `score`, `reason`), so the model emits guaranteed-valid structured output.

For the full role-to-backend picture, see [LLM Routing](./llm-routing.md) — that doc is the single source of truth for backends and roles.

**Why on-device?** Triage fires on every ingested item — potentially dozens per day. On-device Apple Foundation Models are the right fit for this high-frequency, latency-sensitive path: they are **free, offline, keyless, and ~6-7x faster than cli/Haiku**, with typed valid output. This inverts the old rationale (a local Ollama model was once used "because Claude would be too expensive/slow"): the reason for the switch is now on-device speed, zero cost, and offline operation — not cost avoidance.

**Fallback:** When Apple Intelligence is off or the `afm` service returns `ok:false`, the `intent` role's configured fallback takes over — `fallback_backend: cli` / `fallback_model: claude-haiku-4-5-20251001`. On the CLI fallback path, `classify()` dispatches a one-shot agent named `triage-classifier` (a dispatch name, not a role) via the scheduler ctx. The raw Ollama HTTP path that still exists in `index.ts` is vestigial under the current config — Ollama is now embeddings-only (`nomic-embed-text` on the NAS); `qwen2.5:14b` is no longer resident.

**Fallback timeout:** If classification takes longer than 15 seconds (`TIMEOUT_MS`), triage returns `batch` (the most conservative decision) with reason "classifier unavailable". This prevents timeouts from blocking ingestion.

## Learnable Overrides

The Chief of Communications agent can override triage decisions and store the corrections as user preferences:

```typescript
// Chief of Comms agent response:
"For Sarah's messages, always notify immediately, never batch."

// Stored as:
remember_fact("contact_routing", "sarah@example.com → decision: notify, floor: 0.9")
```

When the classifier is called, the system fetches overrides from memory and injects them as context:

```typescript
const context = await recall_memory("contact_routing");
const result = await classify(item, context);
```

**Why learnable?** The triage classifier is probabilistic. Over time, the user's feedback (approvals, rejections, explicit routing rules) reveals preferences that the classifier cannot capture from content alone. Storing these as facts lets Jarvis refine its routing without retraining the model.

## Configuration

Triage configuration lives in `harness/config/models.yaml`. The `intent` role is a top-level key (note: the field is `backend`, not `provider`):

```yaml
intent:
  backend: apple
  model: default
  fallback_backend: cli
  fallback_model: claude-haiku-4-5-20251001
```

The mail-triage path uses the parallel `router` role, configured identically. See [LLM Routing](./llm-routing.md) for the complete role table; do not duplicate it here.

Sources and floors are hardcoded in `triage/index.ts` and should be updated when new ingest sources are added. Example:

```typescript
export const URGENCY_FLOORS: Record<string, number> = {
  mail: 0.4,
  calendar: 0.7,
  // Add new source here
  slack_dm: 0.8,  // Direct messages are high-signal
};
```

## Summary

Triage is a three-layer system:

1. **Classifier** (on-device Apple Foundation Models via the `intent` role; cli/Haiku fallback) — returns decision + urgency score
2. **Router** (triageAndAdd) — applies decision, routes to suppression, batch, or notification
3. **Accumulator** (inbox.drain) — batches items, enforces caps, drains on demand with cursor-based deduplication

It is the gatekeeping mechanism between Jarvis's many ingestion sources and the conversation. Without it, the signal-to-noise ratio would be unmanageable. With it, Jarvis routes content intelligently, surfacing only what matters when it matters.
