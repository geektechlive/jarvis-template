---
title: Memory Architecture
description: ChromaDB semantic collections, a SQLite episodic ledger, and a DuckDB/Parquet cold archive — with a consolidation pipeline and confidence decay.
sidebar_position: 3
---

# Memory Architecture

Memory is how Jarvis becomes trustworthy. Without it, Jarvis would repeat advice, forget preferences, and treat every question as a blank slate. This document explains not just what the system does, but why it's built this way.

## Overview: Why Three Tiers

Jarvis uses a **three-tier memory model** because no single storage technology handles all requirements well:

1. **Hot memory (ChromaDB + SQLite)** provides fast semantic recall — find related facts by meaning, not exact keywords.
2. **Episodic memory (SQLite)** tracks the event log — who decided what, when, conversation history, permission approvals.
3. **Cold archive (Parquet on NAS)** keeps aged facts searchable without bloating the hot tier.

Why not just one database? ChromaDB is built for semantic search (finding "Alex prefers async/await" when asked "what's Alex's coding style?"), but it lacks rich querying — you cannot ask "show me facts created after May 1 AND tagged 'project' AND with confidence > 0.8". SQLite provides that. Parquet archives aged entries so the hot tier stays fast.

## Three Tiers Explained

### Tier 1: Hot Memory (ChromaDB + SQLite)

**ChromaDB** stores **eight collections** (`COLLECTIONS` tuple, `store.py`). Five are primary semantic stores; three are auxiliary tiers (a feed cache, a cold/superseded tier, and an ephemeral tier):

| Collection | Role | Purpose |
|---|---|---|
| `user_profile` | Primary | Stated preferences and clarifications from the principal — directly shape responses |
| `knowledge` | Primary | Extracted facts from conversations, mail, and ingested content |
| `news` | Auxiliary (feed cache) | Cached news/feed items; TTL-decayed during consolidation alongside `knowledge`/`archive`/`agent_memories` (`consolidation.py`) |
| `agent_memories` | Primary | Jarvis's own self-state: routine outcomes, autonomy logs, heartbeats |
| `episodic_journal` | Primary | Claude Code session history: what was coded, which files changed |
| `archive` | Auxiliary (cold/superseded tier) | Entries decay-archived from `knowledge`; queried as a fallback when a primary collection returns too few hits, and exported to cold Parquet by `archive_to_cold()` (`store.py`, `consolidation.py`) |
| `task_memory` | Auxiliary (ephemeral) | Facts written in ephemeral mode so an ad-hoc session does not pollute durable memory; purged after 7 days by `_purge_task_memory()` (`consolidation.py`) |
| `procedural` | Primary | Skill patterns captured from long tool-call chains (deploy steps, setup procedures); reusable automation |

**Why embeddings are local (Ollama, not OpenAI):** Each entry in ChromaDB is stored as a vector from `nomic-embed-text`. Sending all of Jarvis's memories to a hosted API would be a privacy problem. Embeddings run on a local Ollama instance — by default the dedicated NAS embed host at `http://<nas-ip>:11435` (`OLLAMA_EMBED_HOST`), falling back to `OLLAMA_HOST` when that is unset (`store.py`). Ollama is **embeddings-only**; no memory data leaves the LAN.

**SQLite's role (parallel to ChromaDB):** ChromaDB is fast at "find facts similar to this query" but weak at structured queries. SQLite's `memories_meta` table holds (`episodic.py`):

- `confidence` (0.0–1.0): how trustworthy is this fact? User-stated preferences start at 1.0; facts extracted from mail start at 0.5.
- `trust_score` (0.0–1.0): a separate dimension from confidence, tracking reliability of the source.
- `tags`: semantic labels (e.g., "project:Jarvis", "tech:TypeScript", "person:Sarah") for filtering.
- `superseded_by`: when a fact is contradicted or merged, it's marked as superseded rather than deleted. Recall excludes superseded entries.
- `access_count` and `last_accessed_at`: tracks how often the fact is recalled; used during decay.
- `ttl_days`: optional expiration (overrides the default retention policy).
- Bi-temporal columns `valid_from` / `valid_until` / `known_from` / `known_until` distinguish when a fact was true from when Jarvis believed it.

**FTS5 hybrid fallback:** ChromaDB relies on embeddings, which require the Ollama embed endpoint. If the embed model is being loaded or swapped, that endpoint can time out. Rather than return nothing, recall falls back to SQLite FTS5 (full-text search). A quoted-string query like `"Alex uses fastify"` checks FTS5 first; if it finds matches, those are ranked and returned. If FTS5 returns nothing, the query falls back to semantic search. This hybrid approach ensures Jarvis can recall facts even when the embed endpoint is briefly unavailable.

### Tier 2: Episodic Store (SQLite)

The episodic store is the audit trail — structured, queryable, immutable-friendly. The schema (`episodic.py`) defines thirteen tables:

| Table | Purpose |
|---|---|
| `messages` | Conversation history (session, role, content, timestamp) |
| `agent_events` | Scheduler outputs, routine results, and other agent event rows (session, event, detail, ts) |
| `actions` | Permission log with lifecycle state: Proposed → Approved / Rejected / RolledBack (action, tier, payload, rollback_data) |
| `memories_meta` | Per-memory metadata: confidence, trust_score, source, collection, tags, access_count, superseded_by, ttl_days, bi-temporal validity |
| `memories_fts` | FTS5 virtual table — full-text index over memory content (chroma_id, collection, content) |
| `goals` | Autonomy goals (intent, cadence, owner, status, tool-call/minute budgets, run timestamps) |
| `goal_runs` | Goal execution history (goal_id, started/completed, iterations, status, result, error) |
| `perf_metrics` | Per-phase timing (phase, latency_ms, session, metadata) |
| `processed_mail` | Ingested-mail dedup ledger (source, message_id, uid, folder, triage_decision, fact_count, tier, message_date) |
| `external_actions_audit` | Audit of autonomy actions with external effects (goal_id, goal_run_id, intent, result, timestamps) |
| `processed_imessages` | iMessage dedup ledger (guid, rowid, sender, processed_at, triage_decision) |
| `matters` | Named "matters" grouping related items (id, name, description, status) |
| `matter_items` | Items belonging to a matter (matter_id, item_type, item_ref, added_at) |

**Why SQLite, not ChromaDB?** Episodic memory doesn't need semantic search. It needs transactions (ACID), joins (find all events in session X where event='routine_finished'), and FTS5 for searching message bodies. SQLite provides all three with zero network overhead.

**WAL mode:** The schema initializer sets `journal_mode = WAL` and `synchronous = NORMAL` (`episodic.py`). WAL allows concurrent reads while a write is pending, which matters when the threaded vec-server collides with another writer.

### Tier 3: Cold Archive (Parquet on NAS)

Entries that decay out of `knowledge` are first moved to the `archive` ChromaDB collection (marked `superseded_by='decay'`). The nightly `archive_to_cold()` job then exports cold `archive` entries to monthly Parquet shards on a NAS mount and deletes them from ChromaDB and `memories_meta` (`consolidation.py`).

The NAS mount path is configured as `cold_archive_path` in `harness/config/integrations.yaml` (default `~/mnt/jarvis/cold-archive`). If `duckdb` is not installed, the path is unconfigured, or the mount is absent, `archive_to_cold()` skips silently.

**Why archive instead of delete?** Data is easier to resurrect than to recreate. Archived data can still shape context — a cross-seasonal fact ("Alex's manager always wants status updates on Fridays") may be cold (not recalled in months) but become relevant again. Archival preserves it without bloating the hot tier.

**DuckDB's role:** `archive_to_cold()` uses DuckDB to write the exported rows to Parquet (`COPY ... TO ... (FORMAT PARQUET)`), appending to the current month's shard when one already exists (`consolidation.py`).

## ChromaDB Collections in Detail

### `user_profile`
Durable facts about the principal: preferences, clarifications, work patterns, constraints. Written by learning extractors and real-time correction logic. Durable (untagged entries are permanent).

**Example:** "Alex prefers GitHub issues over Jira" (source: `cli`, confidence: 1.0)

### `knowledge`
General facts extracted from conversations, mail, journals, and ingested content. Durable unless explicitly TTL'd or decayed.

**Example:** "Alex's iOS app uses SwiftData + CloudKit" (source: `learning`, confidence: 0.75)

### `news`
Cached news and feed items. Treated as an ephemeral feed source — TTL-decayed during consolidation rather than kept permanently.

### `agent_memories`
Jarvis's self-state: when routines ran, their outcomes, autonomy logs.

**Example:** "morning_brief ran 2026-06-02 06:00" (source: `agent`, confidence: 1.0)

### `episodic_journal`
Claude Code session summaries; used to surface recent dev context during reflection.

**Example:** "2026-05-30 10:00 — Fixed iOS neon nav title with custom cyan .principal ToolbarItem" (source: `learning`)

### `archive`
Cold/superseded tier. Holds entries decay-archived from `knowledge`. Recall tops up from `archive` (results prefixed `[archive]`) when a primary collection returns fewer than the requested number of hits; the superseded filter is intentionally not applied here, since surfacing decayed long-term memory is the whole point.

### `task_memory`
Ephemeral facts written when ephemeral mode is active, so a throwaway session does not pollute durable memory. Purged after 7 days by `_purge_task_memory()`.

### `procedural`
Skill patterns captured from tool-call chains (deploy steps, setup procedures). Recall surfaces these as reference when a similar procedure is needed.

**Example:** "Deploy to Mini: git commit → make deploy-jarvis → verify commit hash on Mini via SSH" (source: `learning`)

## Write Path: Deduplication Thresholds

When a new fact arrives (via `/remember`, `learning.ts`, mail ingestion, etc.), it's checked against existing entries before being stored. Two thresholds exist because they serve different purposes (`store.py`):

### Write-Time Dedup (`DEDUP_ON_WRITE_THRESHOLD = 0.95`)

Incoming entries are checked against the nearest neighbors in ChromaDB. If any neighbor exceeds **0.95** cosine similarity, the write is rejected silently (the fact is deemed a duplicate).

**Why 0.95, not lower?** The threshold was bumped from 0.85 to 0.95 (2026-05-02). 0.85 was too aggressive: genuinely distinct facts about Alex's tech stack hit dedup against unrelated existing entries (a diagnostic confirmed "Alex uses fastify v5 ..." merged into an existing "Alex is developing intent.py / learning.py / agent.py" row). 0.95 keeps near-verbatim duplicates filtered while letting semantically distinct novel facts through.

**Why silent rejection?** If a fact is truly a duplicate, re-storing it wastes vectors and makes consolidation slower. Silent rejection is safe because the underlying embedding is the same.

### Consolidation-Time Dedup (`DEFAULT_DEDUP_THRESHOLD = 0.92`)

During nightly consolidation, a merge pass runs over `user_profile` entries with **0.92+** cosine similarity. An LLM verifies that two high-similarity entries are genuinely the same fact before merging.

**Why lower than write-time?** Consolidation has supervision. An LLM reads both entries and decides whether they're truly redundant. With that reasoning layer, 0.92 is conservative enough to avoid false merges. The two thresholds (0.95 write-time, 0.92 consolidation) are intentionally different and are not unified.

## Recall Path: Vector → FTS5 Fallback

The `recall()` function in `store.py` uses a hybrid strategy:

1. **Check if the query contains quoted strings.** If yes, route to FTS5 first (e.g., `"Alex uses fastify"` is a literal search).
2. **FTS5 full-text search.** If results are found, rank and return them. This is fast and exact.
3. **Fallback to vector similarity.** If FTS5 returns nothing, generate an embedding for the query and find the top-K nearest neighbors in ChromaDB.

**Why FTS5 first for quoted queries?** Quoted strings suggest the principal wants exact-match behavior, not semantic fuzziness. FTS5 provides that.

**Why fallback to vector?** FTS5 is brittle — if the user asks "Alex's coding style" but the stored fact is "prefers async/await patterns in TypeScript", FTS5 will miss it. Vectors catch semantic similarity.

**What if the embed endpoint is down?** FTS5 doesn't require embeddings, so recall still works via FTS5 alone when the NAS embed endpoint is briefly unavailable. This is why FTS5 is not optional. Note: query length is capped (`MAX_QUERY_CHARS = 4000`) before embedding, because an over-long query exceeds `nomic-embed-text`'s context window.

## Nightly Consolidation Pipeline

Consolidation runs overnight. It is designed to be safe to re-run.

### Jobs

**1. Summarize sessions**
Each conversation session is summarized into a short narrative and stored in the `knowledge` collection. Raw messages are verbose; summaries compress many messages into a single semantic entry, making cross-session recall faster and dedup more accurate.

**2. Consolidate cross-session**
Summaries from the past 7 days (`window_days`) are fed to an LLM that extracts durable patterns, which become new `user_profile` entries.

**3. Deduplicate preferences**
High-similarity pairs (`dedup_threshold = 0.92`) in `user_profile` are merged with LLM verification.

**4. Decay knowledge**
Entries unrecalled for `decay_unused_days` (90) have their `confidence` decremented per cycle. When confidence drops low enough, the entry is moved to the `archive` collection and marked `superseded_by='decay'`. `decay_contradiction_check` runs LLM checks during decay.

**5. Purge task memory**
`_purge_task_memory()` deletes `task_memory` entries older than 7 days.

**6. Archive to cold**
`archive_to_cold()` exports cold `archive` entries to monthly Parquet shards on the NAS via DuckDB, then deletes them from ChromaDB and `memories_meta`.

> Consolidation reasoning runs via Claude (CliBackend), not local Ollama. For which model each role uses, see [llm-routing.md](./llm-routing.md) — that is the single source of truth for model/backend routing.

## Session Recall Cache

Before every prompt, Jarvis recalls relevant facts from ChromaDB via vec-server. This involves an Ollama embedding call plus vector search and is the dominant latency source.

**The optimization (commit bb875e1):** `user_profile` and `procedural` facts are stable across a session — re-embedding and re-querying them every turn is waste. On turn 1, they are fetched as normal, cached in `sessionRecallCache` (an in-process Map keyed by sessionKey), and written to ion session memory via `ctx.setSessionMemory()`. Ion persists this and injects it as `--append-system-prompt` for every subsequent CliBackend subprocess.

On turns 2+, `user_profile` and `procedural` are served from the Map at 0ms. Only `knowledge` (query-specific) and `graphRecall` (skipped for prompts shorter than 30 chars) are fetched per-turn. Measured result: `vecMs` drops from ~800ms median to near-zero on turns 2+.

The cache is cleared at `session_end`.

**extractAndStore cadence (same commit):** Fact extraction does NOT fire every turn. It runs at turns 4, 7, 10, 13... (formula: `turnCount >= 4 && (turnCount - 4) % 3 === 0`) and always at `session_end`. For the typical 1–3 turn session this means zero mid-session LLM extraction calls, one at session_end. `detectMemoryCorrection()` still fires every turn since it's fast and non-LLM.

## Real-Time Memory Correction

After each turn, `detectMemoryCorrection()` in `learning.ts` checks if the latest message contradicts a `user_profile` fact. For example, if Jarvis recalled "Alex prefers Svelte" but the principal just said "I'm moving away from Svelte to React now", the old fact is marked `superseded_by='correction'` and a new fact is written.

**Why real-time instead of waiting for consolidation?** Preferences can flip mid-session. Real-time detection ensures Jarvis's behavior adapts immediately.

## Reflection Panel

At session end, a three-agent panel reviews the full conversation to extract durable user preferences, behavioral patterns, and knowledge gaps. The panel produces a small set of normalized facts, stored in `user_profile`.

**Why a panel (not a single agent)?** Single agents over-fit to recent conversation or hallucinate preferences. Three agents with different analytical lenses — finding patterns, finding gaps, synthesizing — produce more balanced, less noisy memory updates. The Synthesizer resolves disagreements between PatternFinder and GapFinder.

### Three Sequential Passes

| Agent | Purpose | Output |
|-------|---------|--------|
| **PatternFinder** | Identifies durable preferences and work habits stable across sessions | A few patterns: "Alex prefers async/await", "Alex codes in small incremental commits" |
| **GapFinder** | Identifies missing context that would improve future responses | A few gaps: "Alex lives in Houston", "Alex's iOS app uses SwiftData + CloudKit" |
| **Synthesizer** | Distills both analyses into the most valuable, durable facts | A few ranked facts: highest signal, no redundancy |

Each agent runs via `ctx.dispatchAgent()` with a system prompt that enforces third-person normalization ("Alex prefers X" instead of "the user..." or "I..."). For the specific model behind each role, see [llm-routing.md](./llm-routing.md).

### Deduplication and Normalization

Reflection facts go through the same write-time dedup as any other write (`DEDUP_ON_WRITE_THRESHOLD = 0.95`). Reflection output is LLM-generated and normalized to third person, which keeps related facts phrased consistently and improves recall precision.

### Timing: Session End, Not Turn End

Reflection runs at `session_end` (after all conversation is complete), never after every turn. Reflection needs the full conversation arc; running per-turn would produce incomplete or over-fitted patterns.

## Confidence Decay and Archival

`memories_meta.confidence` is seeded by source (`_SOURCE_CONFIDENCE` in `store.py`): explicit user input and memory corrections start at 1.0; extracted/learning/reflection at 0.75; ingested sources (mail, journal, browser) lower. Each nightly consolidation pass that finds an entry unrecalled decrements its confidence; when it drops low enough, the entry is moved to the `archive` collection.

**Why decay instead of TTL alone?** TTL is binary: on day 89 the fact is hot; on day 91 it's gone. Decay is gradual: as a fact cools, its influence wanes before it's archived. If a cold fact is recalled, it can be warmed back up.

## Configuration: consolidation.yaml

```yaml
consolidation:
  window_days: 7                    # Days of session summaries to include in cross-session consolidation
  dedup_threshold: 0.92             # Cosine threshold for nightly consolidation dedup
  decay_unused_days: 90             # Days without recall before confidence starts decaying
  decay_contradiction_check: true   # Run LLM checks during decay (slower but safer)
  message_retention_days: 30        # How long to keep raw messages before deleting summarized ones
  delete_summarized_messages: false # DESTRUCTIVE — only enable after trusting summaries
  refresh_repos: []                 # Repos to re-ingest nightly (empty by default)
```

The cold-archive NAS mount path lives separately, as `cold_archive_path` in `harness/config/integrations.yaml`.

## Key Principles

**Immutability:** Facts are never updated in-place. Corrections are new entries with `superseded_by` pointers to the old ones. This preserves the audit trail.

**Confidence over deletion:** Rather than hard-delete facts, mark them as superseded or decayed. This allows resurrection and prevents data loss from mistakes.

**Local-first:** Embeddings run on a local (LAN) Ollama instance — the NAS embed host — and consolidation/reflection reasoning runs via Claude (CliBackend). No memory data is sent to external APIs.

**Hybrid querying:** ChromaDB for semantics, SQLite for structure, Parquet for cold storage. Each tool does what it's designed for.

## Source of Truth

Implementation files:
- `harness/memory/store.py` — ChromaDB collections, recall, dedup-on-write, embed host resolution
- `harness/memory/episodic.py` — SQLite schema and episodic operations
- `harness/consolidation.py` — nightly jobs (summarize, consolidate, deduplicate, decay, purge, archive)
- `harness/config/consolidation.yaml` — nightly configuration
- `harness/config/integrations.yaml` — `cold_archive_path` NAS mount
- `harness-ts/src/memory/recall.ts` — TypeScript recall and ingest orchestration
- `harness-ts/src/learning/index.ts` — fact extraction and real-time correction

## Related Reading

- `./llm-routing.md` — model/backend routing (single source of truth)
- `./integrations.md` — how mail, calendar, and spotlight feed memory
- `./concept.md` — high-level system architecture
- `./staff.md` — how staff agents use and augment memory
- `../README.md` — project overview
