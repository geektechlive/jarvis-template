---
title: LLM Routing
description: How Jarvis routes each task to one of four backends (CLI/Claude, Apple Foundation Models, OpenRouter, Anthropic) — role-to-backend table, the interactive model guard, HyDE, and Graphiti config.
sidebar_position: 4
---

# LLM Routing

This document is the single source of truth for how Jarvis routes work to a model.
Every role-to-model decision lives in `harness/config/models.yaml`; the tables here are
a **snapshot of that file** — when `models.yaml` changes, regenerate them from it rather
than editing in place.

## Four backends, one embedding engine

Jarvis no longer runs a simple "Claude vs Ollama" split. Reasoning is spread across
four backends, and Ollama has been demoted to embeddings only.

| Backend | What it is | Auth | Used for |
|---------|-----------|------|----------|
| **cli** | Claude (Haiku 4.5 / Sonnet 4.6) via the ion Claude-CLI subprocess | OAuth token, not an API key | The session itself plus most reasoning roles (extraction, research, summary, panel, synthesizer, verifier, staff work) |
| **apple** | On-device Apple Foundation Models (macOS 26 Tahoe / Darwin 25+), served by `tools-py/apple-foundation` on port 9878 via the `afm` Swift helper | None (local) | High-frequency, latency-sensitive classification: `router`, `intent`, `tagger`, `hyde`. Free, offline, ~6-7x faster than cli/Haiku, typed valid output |
| **openrouter** | Cloud API | `OPENROUTER_API_KEY` | Code-shaped roles (`code`, `improve`, `procedural` → `qwen/qwen-2.5-coder-32b-instruct`) and Graphiti's graph LLM (`google/gemini-2.5-flash`) |
| **anthropic** | Direct Anthropic API | `ANTHROPIC_API_KEY` | Only the `cloud` role (the `/cloud` escape hatch) — max-quality Sonnet off the CLI path |

**Ollama is embeddings only.** The Mini's Ollama serves `nomic-embed-text` for all
recall and procedural memory. Reasoning models (qwen2.5, llama3.1) are **no longer
resident** — issue #613 moved everything off them because a 19 GB qwen load was evicting
the embedding model from GPU and blocking recall. Embeddings run on the **NAS**
(`OLLAMA_EMBED_HOST=http://<nas-ip>:11435`), not the Mini.

### The interactive model guard

`harness-ts/src/hooks/modelSelect.ts` enforces one hard rule: for **interactive**
sessions, any non-Claude requested model is forced to Sonnet via CLI. There is no
OpenRouter exemption (an earlier one let a stray `openai/gpt-4o-mini` pin survive on the
main session). OpenRouter-backed roles (`code`/`improve`/`procedural`/`graphiti`) and
dispatched staff pick their model via the role entries below and the spawner/roster —
they do **not** pass through `model_select`, so the guard never touches them.

## Role-to-backend table

Snapshot of `models.yaml` (regenerate when it changes). Roles with a fallback fall back
when the primary backend is unavailable (e.g. Apple Intelligence is off or the `afm`
service is down).

| Role | Backend | Model | Fallback | Purpose |
|------|---------|-------|----------|---------|
| **default** | cli | claude-haiku-4-5 | — | Catch-all for unspecified roles |
| **router** | apple | default | cli / haiku | Mail-triage + intent classification |
| **intent** | apple | default | cli / haiku | Ambient intent detection |
| **extraction** | cli | claude-haiku-4-5 | — | Post-turn fact extraction |
| **research** | cli | claude-haiku-4-5 | — | Research staff work |
| **summary** | cli | claude-haiku-4-5 | — | Daily/weekly/monthly conversation summaries |
| **code** | openrouter | qwen-2.5-coder-32b | — | Code analysis/generation |
| **writing** | cli | claude-haiku-4-5 | — | Drafting/polish |
| **panel** | cli | claude-sonnet-4-6 | — | Reflection panel (multi-perspective) |
| **reflection** | cli | claude-haiku-4-5 | — | Overnight reflection support |
| **improve** | openrouter | qwen-2.5-coder-32b | — | Self-improvement code generation |
| **synthesizer** | cli | claude-sonnet-4-6 | — | Briefing synthesis |
| **procedural** | openrouter | qwen-2.5-coder-32b | — | Skill capture from logs |
| **cloud** | anthropic | claude-sonnet-4-6 | — | `/cloud` explicit override |
| **tagger** | apple | default | openrouter / gemini-2.5-flash-lite | Memory tagging on write |
| **hyde** | apple | default | openrouter / gemini-2.5-flash-lite | Hypothetical-document generation for recall |
| **normalize** | cli | claude-haiku-4-5 | — | Fact normalization to third person |
| **security_advisor** | cli | claude-sonnet-4-6 | — | Security architecture / threat-model review |
| **importance** | cli | claude-haiku-4-5 | — | Memory importance scoring |
| **goal_proposal** | cli | claude-haiku-4-5 | — | Autonomy goal proposals |
| **verifier** | cli | claude-haiku-4-5 | — | LLM-as-judge gate on autonomy output |

**Staff models are indirect.** Staff agents do not appear in this table. Each staff
member's `model_key` in `staff.yaml` resolves to one of the roles above via
`loadStaffModel()` in `harness-ts/src/config.ts`. To change a staff member's model,
point its `model_key` at a different role — don't invent a per-staff role.

## Upgrade rules

Defined in `models.yaml` under `routing`. When Haiku is the default, these can upgrade
it to Sonnet:

- **Length-based:** prompts over `upgrade_on_length_chars` (2000) upgrade to
  `upgrade_target` (Sonnet). Reserved for v2 — v1 hook payload does not expose prompt text.
- **Keyword-based:** `upgrade_keywords` (review, analyze, design, panel, architecture)
  signal deep-reasoning intent. Also v2-gated for the same reason.

Both are configured but inert in v1 because `ModelSelectInfo` does not carry prompt
text. The interactive guard above is what actually fires today.

## HyDE: hypothetical-document embeddings

Enabled by default (`hyde_enabled: true`). Before recall, Jarvis generates a
hypothetical memory entry that would answer the question, embeds it, and merges results
with the primary vector pass — bridging the gap when a memory is phrased differently
than the query (the `hyde` role, on-device Apple by default). One extra embedding;
recall precision improves materially.

## Query augmentation

`query_augmentation_enabled: true`: at write time Jarvis pre-computes likely search
queries for a fact and embeds them alongside it, widening recall surface without extra
read-time inference.

## Recall ranking knobs

- `recall_relevance_threshold: 0.7` — facts below 0.7 cosine similarity are injected
  only if token budget allows; at/above 0.7 always injected.
- `recency_boost_enabled: true` — recent memories get a small score multiplier before
  thresholding so fresh facts aren't buried.
- `importance_boost_factor: 0.3` — ranking is scaled by `(1 + factor * importance/10)`;
  a top-importance (10) entry gets up to a 1.3x boost.
- `rerank_enabled: false` — cross-encoder rerank is off by default (needs
  `uv sync --extra rerank`).
- `verification_enabled: true` — runs the `verifier` LLM-as-judge critic on autonomy
  goal output before delivery.

## Graphiti temporal knowledge graph

Graphiti (`graphiti.enabled: true`) is an entity-edge layer over ChromaDB capturing
relationships and *when they changed*, not just isolated facts. It runs on **Neo4j on
the NAS**, not the Mini.

- `neo4j_uri: bolt://<nas-ip>:7687` — Neo4j on the Synology NAS VM
- `neo4j_user: neo4j`, password via `GRAPHITI_NEO4J_PASSWORD` (never hardcoded)
- `llm_model: google/gemini-2.5-flash` — graph reasoning via OpenRouter
- `small_model: google/gemini-2.5-flash` — node summarization; must be a valid
  OpenRouter slug or graphiti falls back to gpt-4.1-nano (OpenAI) → 400
- `embedding_model: nomic-embed-text`, `embedding_dim: 768` — embeddings (Ollama on NAS)
- `group_id: jarvis`; `llm_timeout: 240`s; `ingest_timeout: 600`s

**Deployment:** `uv sync --extra graph` for the `graphiti-core` dependency. Note the
split backend — graph **LLM** is OpenRouter/Gemini, graph **embeddings** are Ollama.

## Model warm-up at startup

`prewarm_on_startup: [router, embed]` pre-loads the router model and warms the embedding
endpoint (`embed` is a special token → `OLLAMA_EMBED_HOST`, the NAS) so the first turn
and first recall don't pay cold-start latency.

## Configuration reference

All routing lives in `harness/config/models.yaml`:

```yaml
routing:
  default_model: claude-haiku-4-5-20251001
  upgrade_on_length_chars: 2000
  upgrade_keywords: [review, analyze, design, panel, architecture]
  upgrade_target: claude-sonnet-4-6
```

Each role is a top-level key with `backend` (`cli` / `apple` / `openrouter` /
`anthropic`) and `model`, optionally `fallback_backend` / `fallback_model` / `timeout`.
Changes take effect on the next prompt (60-second config cache).

## Overrides

- `/cloud <prompt>` forces Sonnet via the Anthropic API (the `cloud` role).
- A staff spec's `model_key` selects the role it routes through.
- Explicit dispatch (`ctx.dispatchAgent(..., { model: 'claude-sonnet-4-6' })`) bypasses
  routing entirely.

## Troubleshooting

- **Apple Foundation fallback firing unexpectedly?** The `afm` service (port 9878)
  returns `ok:false` when Apple Intelligence is off — roles then use their
  `fallback_backend`. Check the apple-foundation service and macOS Intelligence setting.
- **OpenRouter role 401?** Verify `OPENROUTER_API_KEY`. The interactive guard means a
  stray non-Claude pin on the main session is impossible by design.
- **Facts not recalled?** Check `recall_relevance_threshold`; use `/recall-stats` for
  actual similarity scores.
- **Staff agent using the wrong model?** Verify its `model_key` in `staff.yaml` resolves
  to a role that exists in `models.yaml`.
- **Neo4j connection refused?** Confirm Neo4j on the NAS is up and
  `GRAPHITI_NEO4J_PASSWORD` is set. Logs: `~/Jarvis/logs/vector.error.log`.
