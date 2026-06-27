---
title: Development Conventions
description: Standing cross-cutting rules — debugging discipline, ion engine and SDK API gotchas, branch policy, dependency rules, and operational anti-patterns not covered by the feature docs.
sidebar_position: 13
---

# Development Conventions

This document collects standing rules and hard-won operational conventions that apply
across every area of the codebase. They are not covered by the feature-specific docs
(architecture, memory, deployment, hooks) because they cut across all of them.

Read this when you are:

- Starting to debug an unexpected regression
- About to write code that touches the ion engine or extension SDK
- About to write or tighten an agent spec
- Choosing a branching strategy for a batch of changes
- Modifying Python dependencies

---

## Debugging Discipline

Before investigating anything, list exactly what changed since the last known-good
state: commits, deploys, config edits, OS permission dialogs, or external service
changes. Rank hypotheses by what was actually modified, not by what feels most likely.

**Do not investigate infrastructure until app-level changes are ruled out.** If you
changed a staff agent spec, investigate the spec before looking at ion engine logs. If
you changed a memory extraction path, check the extraction logic before checking
ChromaDB. Infrastructure problems are real but rare; code changes are the most common
cause of regressions.

### Practical checklist

1. Run `git log --oneline -10` locally and on the deployment target — are they the same commit?
2. List every file changed in the last commit batch.
3. Identify which subsystem each changed file belongs to.
4. Form a ranked hypothesis list (most-changed subsystem first).
5. Only after exhausting app-level hypotheses, check service health (vec-server, Ollama, the ion daemon).

---

## Ion Engine: Read the Docs Before You Code

**Before making any claim or writing any code related to the ion engine or its extension
SDK, read the relevant document in `ion/docs/`.** Do not rely on training-data
assumptions about ion's API. The fork may diverge from upstream, the SDK surface exposed
to the TypeScript harness can lag behind the ion docs, and some hooks that appear in the
type definitions are stubs with zero callers.

Key references, in order of authority:

1. **`ion/engine/internal/extension/host_rpc.go`** — Go source of truth for what
   actually works from async extension contexts. If a method is not wired here, it does
   not work regardless of what the docs say.
2. **`ion/docs/extensions/sdk-typescript.md`** — IonContext API (`sendPrompt`,
   `dispatchAgent`, `callTool`, `setSessionMemory`, `getSessionMemory`, etc.).
3. **`ion/docs/hooks/reference.md`** — all hooks and their payloads.
4. **`ion/docs/configuration/engine-json.md`** — engine.json fields.

### SDK surface vs ion docs

The TypeScript harness compiles directly against the ion submodule source
(`ion/engine/extensions/sdk/ion-sdk/index.ts`) via an `--alias:ion-sdk=` flag in the
esbuild scripts. There is no vendored copy of the SDK. When adding a new `IonContext`
method, check the submodule source to confirm it is exposed — the submodule may lag
behind the ion documentation by one or more commits.

---

## Extension SDK API Gotchas

### `ctx.setSessionMemory()` / `ctx.getSessionMemory()`

These methods compile against the ion submodule SDK (see above). Ion injects session
memory as `--append-system-prompt` for every subsequent CLI-backend subprocess. The
session cache pattern (`user_profile` + `procedural` written on turn 1, served from an
in-process Map on turns 2+) depends on this injection working correctly.

### `dispatchAgent` requires a non-empty task string

Passing an empty string to `dispatchAgent` causes the engine to return `"prompt is
required"`. This error is recorded in the session's working memory and pollutes
`getSessionMemory()` output on subsequent turns. Every `dispatchAgent` call site must
guard against empty-task paths:

```typescript
if (!task.trim()) {
  log.warn('dispatchAgent called with empty task — skipping')
  return
}
await ctx.dispatchAgent({ task, ... })
```

### `FireBeforeProviderRequest` is a stub

This hook has zero callers in the engine. Registering a handler for it does nothing.
The correct per-turn injection point for the CLI backend is `before_prompt`.

### `ion prompt` never triggers slash commands

`ion prompt` always sends a `send_prompt` message to the LLM regardless of a `/`
prefix. Registered slash commands are only dispatched when a frontend (the desktop or
mobile app) sends a `"command"`-type message. When testing slash-command behavior:

- Use a frontend app for end-to-end tests.
- To inspect output without a frontend, query `agent_events WHERE event='inbox_item'`
  in the episodic SQLite database.
- Do not invoke `/recall`, `/learn`, or any other command via `ion prompt` and expect
  command dispatch — it will not happen.

---

## Vec-Server API Constraints

### Empty-string queries are rejected

The vec-server `/recall` and `/recall_meta` endpoints both return
`400 {"error": "query required"}` for empty-string input. Never call `recallMeta('', ...)`
or `recall('', ...)`.

- For query-driven lookups: always pass a meaningful query string.
- For non-query-specific top-N lookups (e.g., "show me recent memories"): query
  `memories_meta` in the episodic SQLite database directly.

### `episodic.fts_search()` bypasses collection filtering

The raw `fts_search()` method searches across all collections. Always pass an explicit
`collection=` parameter when you need to scope results:

```python
# Wrong — searches all collections
results = episodic.fts_search(query)

# Correct — scoped to the knowledge collection
results = episodic.fts_search(query, collection='knowledge')
```

The higher-level `VectorStore.recall()` applies collection filtering automatically; the
bypass only affects direct `fts_search()` calls.

---

## Dependency Rules

### Never add `litellm`

`litellm` was compromised in a supply-chain attack (March 2026). Do not add it as a
dependency under any circumstances, regardless of how convenient it looks for
multi-provider routing. Use the CLI-backend subprocess pattern for Claude calls and
direct HTTP clients for any other provider.

### `rerank_enabled` requires a separate sync step

Cross-encoder reranking in the memory store (`rerank_enabled: true` in `models.yaml`)
is disabled by default. Enabling it requires the `rerank` extra:

```bash
uv sync --extra rerank
```

Without this, the import fails at vec-server startup. If you enable reranking, record it
in your deployment runbook so the extra is included in future `uv sync` runs on the
target.

### Sync all extras together

When running `uv sync` with extras, include the full set your deployment uses rather
than a subset. A `uv sync --extra pdf` alone can silently drop previously synced extras
like `graph` (graphiti/neo4j). Use the complete set and verify imports still work:

```bash
uv sync --extra graph --extra pdf   # whatever your deployment needs
```

---

## Ollama Embedding Service

Large model loads can block the embed endpoint during a model swap. The vec-server
configures `OllamaEmbeddingFunction(timeout=120)` in `store.py`. If you see sporadic
embedding timeouts that resolve on retry, the cause is usually a model swap in progress,
not a service failure.

The permanent fix is to set `OLLAMA_KEEP_ALIVE=-1` for the embed model so it stays
loaded, or to run a dedicated Ollama process for embeddings separate from any other
model workload.

---

## Branch Policy

### Trivial changes: commit directly to main

Typos, single-line fixes, and config tweaks can commit directly to `main`. If you run a
deploy watchdog, it will pick them up on the next tick and ship them cleanly.

### Complex or multi-commit work: use a feature branch

When a change involves multiple commits, a schema migration, or a state-machine update,
use a short-lived feature branch:

1. Create a branch: `git checkout -b feat/your-feature`
2. Accumulate atomic commits — one logical change per commit, `make check` green before each.
3. Merge with `--no-ff`: `git checkout main && git merge --no-ff feat/your-feature`
4. Deploy immediately after the merge rather than waiting for a watchdog tick.

**Why `--no-ff`?** A no-fast-forward merge produces a single merge commit that is atomic
from a deploy watchdog's perspective — it never sees a partially-applied batch. It also
makes `git revert -m 1 <merge-sha>` possible if you need to back out the entire feature.

**Why deploy immediately after merge?** A deploy watchdog polls on a schedule. If you
merge and walk away, it may catch an intermediate state on its next tick. Deploying right
after a merge gives you a deterministic deploy and a verified commit hash on the target;
the watchdog remains the async safety net, not the primary mechanism.

---

## Agent Spec Discipline

### Fewer rules, not more

When a staff agent hesitates, re-prompts unnecessarily, or falls into a loop, the
instinct is to add more `DO NOT` rules to the spec. This is the wrong fix. More
prohibitions increase the cognitive load the model applies to every decision and create
tool paralysis — the agent spends cycles checking constraints instead of acting.

**The correct approach:** identify the root cause of the hesitation (usually an
ambiguous task description or a missing tool) and fix that. If the same task requires two
or more spec iterations, stop editing the spec and create a dedicated script in
`scripts/` instead. Scripts are independently testable without an active session; specs
are not.

A well-written spec:

- States what the agent owns (its domain), not what it must avoid.
- Gives one concrete example of a good output per responsibility.
- Does not enumerate edge cases — let the model reason about those.

---

## Interaction Design: Clarification Leads to Learning

When your agent is uncertain about a request, ask one short, specific question rather
than attempting a best-guess response or asking several questions at once. The answer
becomes a durable preference stored in `user_profile`. Over time, recurring
clarifications dry up as the agent accumulates preferences that cover them.

This is the primary learning mechanism; explicit corrections are secondary. The
discipline is:

- One question per uncertain turn.
- Phrase the question so the answer can be stored as a fact: "Do you prefer X or Y?"
  not "What would you like me to do?"
- After storing the answer, confirm it briefly so the principal knows it was saved.

---

## Cross-Reference

- [deployment.md](deployment.md) — deploy targets, commit-before-deploy rule, deployment-proof discipline.
- [extending.md](extending.md) — scripts-first pattern for adding capabilities to staff agents.
- [memory.md](memory.md) — dedup thresholds, FTS5 hybrid routing, confidence decay.
- [identity.md](identity.md) — persona enforcement mechanics, improvable-file allowlist.
- [contributing.md](contributing.md) — `make check`, test suite, code-style rules.
- [troubleshooting.md](troubleshooting.md) — symptom tables for common failures.
