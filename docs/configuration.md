---
title: Configuration Reference
description: Field-level reference for all YAML configuration files in harness/config/.
sidebar_position: 20
---

# Configuration Reference

All Jarvis configuration lives in `harness/config/` as YAML files. This reference documents every field, its type, default value, and what happens when you change it.

## models.yaml

Controls model routing — which LLM backend and model handles each task role, plus the
memory/retrieval and knowledge-graph flags.

> **Role→backend matrix lives in [llm-routing.md](./llm-routing.md).** That document is the
> single source of truth for which backend (`cli`, `apple`, `openrouter`, `anthropic`) and
> model each role uses, the interactive model guard, and fallback behavior. This page
> documents the *file structure* and the non-routing flags. Do not duplicate the role
> table here — when `models.yaml` changes, update llm-routing.md.

### Role entry structure

Each role is a top-level key in `models.yaml`. A role entry has:

| Field | Type | Description |
|-------|------|-------------|
| `backend` | string | One of `cli` (Claude via the ion Claude-CLI subprocess), `apple` (on-device Apple Foundation Models), `openrouter` (cloud), or `anthropic` (direct Anthropic API). Ollama is **embeddings only** and is never a reasoning backend. |
| `model` | string | Model id, or `default` for the backend's default (used by `apple` roles) |
| `fallback_backend` | string | Optional. Backend to use when the primary is unavailable (e.g. Apple Intelligence is off) |
| `fallback_model` | string | Optional. Model paired with `fallback_backend` |
| `timeout` | number | Optional. Per-call timeout in seconds |

See [llm-routing.md](./llm-routing.md) for the full per-role matrix.

### Routing Rules

The `model_select` hook (`harness-ts/src/hooks/modelSelect.ts`) applies these when Haiku is
the default. Both upgrade rules are configured but inert in v1 — the hook payload does not
yet expose prompt text; they are reserved for v2 (see llm-routing.md). The interactive
model guard is what actually fires today.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `routing.default_model` | string | `claude-haiku-4-5-20251001` | Fallback when role-specific routing is incomplete |
| `routing.upgrade_on_length_chars` | number | `2000` | Char threshold to upgrade Haiku→Sonnet (v2; prompt length not in v1 hook payload) |
| `routing.upgrade_keywords` | array | `[review, analyze, design, panel, architecture]` | Keywords triggering Haiku→Sonnet upgrade (v2) |
| `routing.upgrade_target` | string | `claude-sonnet-4-6` | Target model for upgrades |

### Memory & Retrieval

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `hyde_enabled` | boolean | `true` | Generate a hypothetical memory entry and merge results with the primary vector pass |
| `query_augmentation_enabled` | boolean | `true` | Embed anticipated search queries alongside stored facts at write time |
| `recency_boost_enabled` | boolean | `true` | Apply recency boost on all `recall()` calls by default |
| `recall_relevance_threshold` | number | `0.7` | Min cosine similarity to inject facts unconditionally; facts below threshold only added if token budget allows |
| `importance_boost_factor` | number | `0.3` | Recall ranking multiplier: `score *= (1 + factor * importance/10)` (importance is 1-10, so a top-importance entry gets up to a 1.3x boost) |
| `rerank_enabled` | boolean | `false` | Enable cross-encoder reranking (requires `uv sync --extra rerank`) |
| `verification_enabled` | boolean | `true` | Run an LLM-as-judge critic (`verifier` role) on autonomy goal output before delivery |

### Startup

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `prewarm_on_startup` | array | `[router, embed]` | Model roles to warm at startup to reduce first-turn latency; `embed` is a special token warming the embedding endpoint (`OLLAMA_EMBED_HOST`) |

### Knowledge Graph (Graphiti)

Entity-edge layer over ChromaDB. The graph **LLM** runs on OpenRouter/Gemini; graph
**embeddings** run on Ollama (NAS). See [graphiti.md](./graphiti.md) for the subsystem and
[llm-routing.md](./llm-routing.md) for backend rationale.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `graphiti.enabled` | boolean | `true` | Enable temporal knowledge graph layer (requires Neo4j 5.26+ and `uv sync --extra graph`) |
| `graphiti.neo4j_uri` | string | `bolt://<nas-ip>:7687` | Neo4j connection URI — the Synology NAS VM, not the Mini |
| `graphiti.neo4j_user` | string | `neo4j` | Neo4j username (password via `GRAPHITI_NEO4J_PASSWORD`, never hardcoded) |
| `graphiti.llm_model` | string | `google/gemini-2.5-flash` | Graph synthesis LLM (via OpenRouter) |
| `graphiti.small_model` | string | `google/gemini-2.5-flash` | Model for graphiti's `ModelSize.small` calls (node summarization); must be a valid OpenRouter slug or graphiti falls back to gpt-4.1-nano → 400 |
| `graphiti.embedding_model` | string | `nomic-embed-text` | Embedding model (via Ollama) |
| `graphiti.embedding_dim` | number | `768` | Embedding vector dimension |
| `graphiti.group_id` | string | `jarvis` | Namespace for this agent's graph data |
| `graphiti.llm_timeout` | number | `240` | Seconds per Claude CLI subprocess call |
| `graphiti.ingest_timeout` | number | `600` | Seconds for the entire `add_episode()` chain |

---

## routines.yaml

Defines proactive scheduled routines and their delivery mechanisms.

### Top-Level Flags

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `ephemeral_memory_enabled` | boolean | `true` | Route rule-flagged extractions to task_memory instead of knowledge |
| `working_memory_enabled` | boolean | `true` | Enable working memory accumulation for routines |
| `entity_batching_enabled` | boolean | `true` | Batch entity mentions across multiple extractions |
| `quiet_hours_start` | number | `23` | Hour when quiet hours begin (24-hour CT format) |
| `quiet_hours_end` | number | `6` | Hour when quiet hours end (exclusive, 24-hour CT format) |

### Routine Fields

Every routine supports:

| Field | Type | Description |
|-------|------|-------------|
| `enabled` | boolean | Toggle on/off without removing |
| `time` | string | Exact time in "HH:MM" format (CT) |
| `day` | string | For weekly: "monday", "friday", etc. |
| `interval_minutes` | number | Repeating job interval in minutes |
| `ignore_quiet_hours` | boolean | Always-on flag (true for critical routines like `findings_dispatcher`, `resolver_feedback_poll`) |
| `max_run_ms` | number | Timeout in milliseconds |
| `deliver_to` | array | `[tui]` default; options: `tui`, `discord` |
| `ephemeral` | boolean | Route extractions to task_memory when true |
| `writes_chain_context` | boolean | Routine writes context for chained staff handoffs |
| `description` | string | Human-readable purpose |

### Key Routines

**Daily:**
- `morning_brief` (07:30) — calendar, mail, open items
- `midday_checkin` (13:00) — unresolved triage summary
- `evening_journal` (21:00) — journaling (gated by this flag)
- `overnight_reflection` (03:00) — opens prompt for reflection decision

**Staff Watches (weekly on schedule):**
- `github_watch` (daily 09:00) — PRs, CI failures, new issues
- `cfo_watch` (Fri 09:00) — charges, uncategorized subscriptions
- `security_watch` (Thu 09:30) — CVEs, credential leaks, OSINT
- `portfolio_watch` (daily 09:25) — significant moves, breaking news

**Autonomous Routines:**
- `memory_consolidation` (02:00) — session summaries, dedup, decay
- `issue_resolver` (every 240 min) — picks jarvis-auto issues and implements fixes
- `findings_dispatcher` (every 10 min) — drain the findings queue, route by criticality
- `resolver_feedback_poll` (every 1 min) — poll vec-server for watchdog deploy outcomes
- `autonomy` (every 1 min) — goal-runner (managed by autonomy module, not scheduler)

Changing `enabled: true` to `enabled: false` disables the routine immediately on next engine restart. Removing a routine from the config is safe — no cleanup needed.

---

## persona.yaml

Enforces Jarvis's persona — Oxford-educated British chief of staff, dry wit, formal tone.

| Field | Type | Contents |
|-------|------|----------|
| `banned_tokens` | array | `["!", "—"]` — forbidden characters |
| `banned_phrases` | array | Phrases to avoid: "certainly", "of course", "great question", "let's dive in", "as an AI", etc. |
| `permitted_moves` | array | Allowed stylings: "one understated joke per longer exchange", "gentle correction phrased as a question", "if I may" |

**How it works:** The extension's `bannedTokenEnforcement()` hook scans every assistant response before turn_end. If any banned token or phrase appears, the response is regenerated. This is the authoritative persona enforcement — no code-level checks, pure string scanning.

**If you change this file:**
- Ban new tokens/phrases for stricter control (e.g., ban "I feel" for colder tone)
- Remove entries to relax constraints
- Changes take effect on next engine restart

---

## consolidation.yaml

Controls memory consolidation during overnight routine.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `consolidation.window_days` | number | `7` | Cross-session analysis window |
| `consolidation.dedup_threshold` | number | `0.92` | Cosine similarity threshold for deduplication (write-time: 0.85, consolidation: 0.92) |
| `consolidation.decay_unused_days` | number | `90` | Entries not recalled within N days move to archive |
| `consolidation.decay_contradiction_check` | boolean | `true` | Run LLM contradiction detection during decay (slower) |
| `consolidation.message_retention_days` | number | `30` | Days to retain raw messages after summarization |
| `consolidation.delete_summarized_messages` | boolean | `false` | DESTRUCTIVE: set true only after trusting summaries |
| `consolidation.refresh_repos` | array | `[]` | Repos to re-ingest nightly (Phase 13, empty by default) |

**If you change `dedup_threshold`:**
- Lower to 0.85: more aggressive deduplication, risk of losing nuanced variations
- Raise to 0.95: stricter matching, may retain duplicates
- Write-time threshold (0.85) and consolidation threshold (0.92) are intentionally different

**If you change `decay_unused_days`:**
- Shorter (e.g., 30): archive entries faster, memory stays tighter
- Longer (e.g., 180): keep entries longer, larger memory footprint
- Archived entries are not recalled but not deleted

---

## voice.yaml

Configures text-to-speech for briefings and announcements.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `backend` | string | `elevenlabs` | Primary TTS provider: `elevenlabs` or `kokoro` |
| `elevenlabs.model` | string | `eleven_turbo_v2_5` | ElevenLabs model version |
| `elevenlabs.monthly_char_budget` | number | `10000` | Character budget per month |
| `elevenlabs.voice_id` | string | `<elevenlabs-voice-id>` | ElevenLabs voice ID |
| `enabled` | boolean | `true` | Global TTS toggle |
| `local_model.name` | string | `kokoro` | Fallback local model (no API cost) |
| `local_model.speed` | number | `1.0` | Playback speed (1.0 = normal) |
| `local_model.voice` | string | `bm_george` | Kokoro voice preset |
| `precache` | array | Common phrases pre-generated for low-latency playback: "Good morning, sir.", "Working on it.", "Leave it with me.", "Right away, sir.", "Noted." |
| `say.voice` | string | `Daniel` | Voice for ad-hoc say() calls |

**If you switch `backend` from elevenlabs to kokoro:**
- No API costs; runs locally on Mini
- Slightly lower quality but instant and free
- Set `enabled: true` to activate

---

## perf.yaml

Latency budgets by phase (P95 percentile, in milliseconds).

| Phase | Budget | Description |
|-------|--------|-------------|
| `intent` | 3000ms | Intent classification via router model (fast path) |
| `recall` | 1500ms | Vector recall alone (embedding + ChromaDB query) |
| `embed` | 200ms | Embedding only (nomic-embed-text with dedicated Ollama instance) |
| `chat` | 8000ms | Full interactive chat turn (intent + recall + LLM response) |
| `tool_turn` | 30000ms | Tool-using staff turn (includes tool-call loop iterations) |

**What happens when exceeded:**
- Latency measurements are logged via `record_perf()` in episodic.py
- `perf_report.py` compares actual P95 against budgets
- Exceeding budgets triggers performance logging (alerting infrastructure pending)

**If you lower budgets:**
- Forces optimization focus on slow paths
- May fail on heavy-load days
- Use for stricter SLOs

**If you raise budgets:**
- More permissive; fewer false alarms
- Risk of ignoring real performance issues

---

## integrations.yaml

Third-party service configuration (read-only unless noted).

### Memory

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `memory.ttl_days` | number | `30` | Default time-to-live for ephemeral entries (detail-pass extractions, RSS fetches) |
| `memory.cold_archive_path` | string | `/Volumes/jarvis/cold-archive` | NAS mount for cold Parquet archive (silently skipped if unmounted) |

### Calendar & Spotlight

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `calendar.exclude_calendar_names` | array | `[]` | Calendar names to hide from Jarvis (e.g., noisy team calendars) |
| `spotlight.roots` | array | `[~/Documents, ~/Downloads]` | File search roots for mdfind |
| `spotlight.nas_roots` | array | `[]` | NAS/iCloud Drive roots (leave empty until mounted) |
| `spotlight.timeout_seconds` | number | `10` | mdfind timeout |
| `spotlight.max_results` | number | `20` | Max Spotlight results per query |

### Mail

**Documentation only** — actual mail reading is via `scripts/mail-check.py`. Jarvis does not have a TypeScript `read_mail` tool.

| Field | Type | Description |
|-------|------|-------------|
| `mail.implementation` | string | `scripts/mail-check.py` |
| `mail.high_weight_senders` | array | High-priority sender addresses flagged for immediate attention |

### Cloud & Network

| Field | Type | Description |
|-------|------|-------------|
| `cloudflare.zones` | array | Managed zones: <your-domain>, relay.<your-domain>, observatory.<your-domain> |
| `unifi.controller_ip` | string | `<router-ip>` (UDM SE) |
| `unifi.watch_device_health` | boolean | Monitor device status |
| `unifi.watch_new_clients` | boolean | Alert on new client connections |

---

## feeds.yaml

RSS feed subscriptions for News Desk and on-demand news queries.

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier (used in logs and recall) |
| `url` | string | RSS feed URL |
| `category` | string | `technology`, `automotive`, or custom |
| `signal` | string | Priority: `high`, `medium`, `low` — affects ingestion frequency |
| `description` | string | Human-readable title |

**Example entry:**
```yaml
- id: hn_ai
  url: "https://hnrss.org/newest?q=AI+LLM+claude+anthropic&count=20"
  category: technology
  signal: high
  description: "Hacker News: AI/LLM topics"
```

**If you add a feed:**
- `rss_fetch` routine picks it up automatically
- `signal: high` fetches more frequently
- Entries are stored in knowledge with source tracking

**If you remove a feed:**
- Stops fetching immediately on next routine run
- Existing entries remain (not auto-deleted)

---

## Deployment

After editing any config file, restart the ion daemon to apply changes:

```bash
make deploy-jarvis  # Restarts LaunchAgent on Mini
```

For identity file changes (persona.yaml), hot-reload on mtime change — no restart required. All other configs require a full restart.
