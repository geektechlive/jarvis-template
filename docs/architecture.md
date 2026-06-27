---
title: Architecture
description: Full system map — ion runtime, TypeScript orchestration, Python services, and infrastructure topology, with the reasoning behind every layer.
sidebar_position: 1
---

# Jarvis Architecture

## Overview

Jarvis is a personal, always-on AI agent that runs 24/7 on a Mac Mini. It is not a chatbot wrapper or a cloud service. It is a persistent infrastructure layer that combines:

- A custom-forked ion runtime (Go-based agent engine) that runs Claude Sonnet 4.6 via the Claude CLI backend
- A TypeScript orchestration layer that handles memory, scheduling, proactive routines, and staff delegation
- A distributed memory system: hot vector store (ChromaDB), episodic ledger (SQLite), and temporal knowledge graph (Neo4j + Graphiti)
- A two-Mini topology: M2 runs the engine (ion, embeddings client, vec-server, relay); M4 runs the client UI (Ion Desktop)

The aim is not a smarter chatbot but a quieter one: an agent that removes operational friction, delegates to a 27-member staff of specialists, proactively delivers briefings, learns from clarifications, and earns every interruption.

## The Stack: Layer by Layer

### 1. Ion Runtime (Go, Forked from dsswift/ion)

**What it is:** A lightweight AI agent engine written in Go. It manages sessions, tool dispatch, hook lifecycle, and subprocess communication with Claude Sonnet 4.6.

**Why forked:** The upstream ion lacked three critical features:
- `before_prompt` hook for CliBackend: needed to inject memory, clarifications, and decision context before Claude sees the prompt
- `FireMessageUpdate` hook: fires at `turn_end` with accumulated reply text, enabling persona enforcement and reply auditing
- ion relay: a standalone relay server for mobile bidirectional communication via WebSocket and Cloudflare tunnel

These gaps would have required rewriting major machinery in Jarvis (harness-ts/). The fork costs ~300 lines of Go; updating upstream regularly via git merge is manageable.

**Key contracts:**
- Receives prompts, dispatches to Claude CLI (`backend: "cli"`)
- Fires hooks in sequence: `before_prompt` → Claude → `turn_end` → (tools fire asynchronously) → `turn_start`
- Extension system: TypeScript runs in-process (harness-ts/src/extension.ts), receives hook events via RPC, returns hook responses
- No API key. Auth: OAuth token written to disk at first login; Claude CLI handles the rest

**Location on M2:** `~/.ion/bin/ion` (binary; never `~/bin/ion` as the daemon) + `~/.ion/engine.json` (config) + `harness-ts/dist/extension.js` (the bundled extension). Staff agent specs are not bundled with the extension — they are copied from `harness/agents/*.md` and `harness/workers/*.md` to `~/.claude/agents/` by `make deploy-ion`, since Claude Code reads specs from `~/.claude/agents/`.

---

### 2. TypeScript Orchestration Layer (harness-ts/)

**What it is:** The actual Jarvis agent. All business logic lives here: hooks, scheduling, memory recall, tool coordination, staff routing, learning, reflection, and identity enforcement.

**Why TypeScript:**
- Async/await for parallel operations (multiple API calls, database queries, vector recall all in flight)
- Strong typing (strict mode + extra flags) prevents silent data corruption in a 24/7 system
- npm ecosystem: esbuild for bundling, vitest for tests, better-sqlite3 for episodic store access
- Easy to deploy: single JavaScript file loaded by ion

**Key modules:**

- **`extension.ts`:** wires hooks, registers tools and slash commands, starts scheduler and autonomy loop
- **`scheduler/index.ts`:** cron-like job runner; fires 48+ routines (morning_brief, meeting_prep, weekly_curator, etc.)
- **`autonomy/index.ts`:** polls every 60 seconds for due goals; respects idle gate (15 min) and daily cap (20 runs)
- **`hooks.ts`:** hook implementations:
  - `before_prompt`: recalls memory, injects clarifications, detects decision stakes, checks pending approvals
  - `turn_end`: audits persona, logs reply, fires voice synthesis and learning pipeline asynchronously
- **`learning/index.ts`:** post-turn pipeline: gap detection (did Claude miss something?), fact extraction, semantic correction
- **`reflection/index.ts`:** three-agent panel (PatternFinder, GapFinder, Synthesizer) runs after `session_end`; dispatches via Claude CLI
- **`tools/`:** helpers for calendar (CalDAV), mail (SMTP), spotlight search (mdfind), browser fetch (Jina)
- **`episodic.ts`:** wrapper around SQLite; mirrors `harness/memory/episodic.py` API

**Compiled:** esbuild bundles `extension.ts` → `harness-ts/dist/extension.js` (single-file deployment)

---

### 3. Memory: Three-Tier Store

**Hot tier (ChromaDB + SQLite):** Fast, always consulted, small footprint.
- **ChromaDB:** eight semantic collections (`store.py` `COLLECTIONS`): user_profile, knowledge, news, agent_memories, episodic_journal, archive, task_memory, procedural
- **SQLite:** conversation messages, agent events, action audit log, FTS5 full-text index

Recall is hybrid: FTS5 first (exact phrase search), fallback to vector if FTS returns nothing. Dedup at write-time (threshold 0.95) and at consolidation (threshold 0.92).

**Session recall cache (commit bb875e1):** user_profile and procedural are fetched once on turn 1 and cached in-process (sessionRecallCache Map keyed by sessionKey). Turns 2+ serve these from the Map at 0ms; only knowledge and graphRecall are fetched per-turn. The profile block is also written to ion session memory via `ctx.setSessionMemory()`, which ion injects as `--append-system-prompt` into every subsequent CliBackend subprocess. This cuts per-turn vec-server overhead from 4 parallel HTTP calls to 1–2.

**Warm tier (Neo4j + Graphiti):** Temporal knowledge graph. Ingests each conversation as a "knowledge episode" at `turn_end`, queried at `before_prompt` for entity-edge context (e.g., "Alex met Sarah yesterday; they discussed budget for Q3").

**Cold tier (Parquet on Synology NAS):** Confidence-based decay runs first: each consolidation cycle decrements `memories_meta.confidence`, and when confidence drops below threshold the entry is marked `superseded_by='decay'` and moved to the ChromaDB `archive` collection. A separate pass (`archive_to_cold()` in `consolidation.py`, `_COLD_ARCHIVE_AGE_DAYS = 90`) exports `archive` entries older than 90 days to monthly Parquet shards on the NAS (via DuckDB), then deletes them from ChromaDB and `memories_meta`. The cold archive path is configured in `integrations.yaml` (`cold_archive_path`); `/cold-archive` searches it.

**Why three tiers:**
- Hot is fast and private (local, never leaves machine)
- Warm adds temporal semantics (edges between entities, not just facts)
- Cold archive keeps old learning without clogging the production store (query latency matters during a conversation)

---

### 4. Claude Sonnet 4.6 via CliBackend

**What it is:** ion invokes the `claude` CLI as a subprocess. No Anthropic SDK, no API key in code. Auth: OAuth token stored on disk (managed by `claude login`).

**Why subprocess instead of API client:**
- One less library to audit (attack surface reduction)
- Token counting and rate limits handled by the CLI, not reimplemented
- Easy to swap models for sub-tasks without restarting the daemon (just call `claude -m haiku` in `dispatchAgent`)
- Tool-use and streaming work transparently

**Invoked from:**
- Main Jarvis session: `engine.json: defaultModel=claude-sonnet-4-6`
- Staff agents: dispatched via `ctx.dispatchAgent({ agent, prompt })`; each staff member's model resolves through its `model_key` role
- Memory consolidation: `_llm_call()` in `consolidation.py` (subprocess + environment variable for model choice)

CliBackend is only one of four reasoning backends. Reasoning is spread across **cli** (Claude via the CLI subprocess), **apple** (on-device Apple Foundation Models), **openrouter** (cloud, code-shaped roles + Graphiti's graph LLM), and **anthropic** (direct API, only the `/cloud` role). Each role-to-backend assignment lives in `harness/config/models.yaml`. For the full routing table, backends, the interactive model guard, HyDE, and Graphiti config, see [docs/llm-routing.md](llm-routing.md) — that doc is the single source of truth; routing details are intentionally not duplicated here.

---

### 5. Ollama: Embeddings Only

**Model:**
- **nomic-embed-text:** embeddings for all recall and procedural memory (required for every turn)

**Where it runs:** Embeddings run on the **Synology NAS** (`OLLAMA_EMBED_HOST=http://<nas-ip>:11435`), not the Mini. The Mini-local Ollama is only an unused fallback when `OLLAMA_EMBED_HOST` is unset.

**Why a dedicated embedding host:** High-frequency background jobs (extractAndStore, gap detection) must be fast and free. Cloud embeddings would incur thousands of requests/month. Local embeddings are low-latency and zero cost. Reasoning models (qwen2.5, llama3.1) are **no longer resident** in Ollama — issue #613 moved everything off them because a large reasoning-model load was evicting the embedding model from GPU and blocking recall. All reasoning now runs through the cli/apple/openrouter/anthropic backends (see [docs/llm-routing.md](llm-routing.md)).

---

### 6. Infrastructure Topology

**Mac Mini M2 (<mac-mini-ip>, <username>):** The engine box. Runs 24/7.
- ion daemon (LaunchAgent `com.dsswift.ion`)
- vec-server (port 9876): HTTP wrapper around ChromaDB + SQLite episodic store
- voice-tts (port 9877): Kokoro TTS server (async reply-to-voice)
- ion-relay (`com.example.ion-relay`, binds `127.0.0.1:8443`): WebSocket relay for mobile bidirectional comms
- cloudflared (`com.example.cloudflared`): Cloudflare tunnel (`jarvis-relay` → `wss://relay.<your-domain>`) for WAN access
- Embeddings are fetched from the NAS, not served locally: `OLLAMA_EMBED_HOST=http://<nas-ip>:11435`

**Mac Mini M4 (<m4-mini-ip>, <username>):** The client box. Runs Ion Desktop app only.
- Ion.app (UI): connects to M2 ion engine over LAN TCP (port 21017)

**Synology NAS (<nas-ip>):** Embeddings and knowledge-graph host.
- Ollama embeddings endpoint (nomic-embed-text), `:11435` — `OLLAMA_EMBED_HOST`
- Neo4j 5.26+ VM for Graphiti (`bolt://<nas-ip>:7687`)

**iPhone:** Jarvis iOS app.
- LAN path: Bonjour discovery → M4 Ion Desktop (localhost) → M2 ion daemon (TCP 21017 over LAN)
- WAN path: Cloudflare tunnel → M2 ion-relay (port 8443) → M2 ion daemon (localhost socket)

**Why two Minis:**
- Relay and tunnel live on M2, so WAN access survives M4 reboot (M2 never reboots)
- M2 is headless production; M4 is the interactive workstation
- Separation of concerns: engine stability is decoupled from UI uptime

---

## Message Flow: The Complete Sequence

1. **User sends message** via Ion Desktop (M4) or iOS app (via relay on M2)
2. **ion daemon receives turn** (session, message text, timestamp)
3. **`before_prompt` hook fires** → harness-ts injects into system prompt:
   - Current time and timezone
   - **Turn 1:** Full recall — user_profile (5), knowledge (8), procedural (3), graphRecall (5) from vec-server. Results cached in-process and written to ion session memory via `ctx.setSessionMemory()`.
   - **Turn 2+:** user_profile and procedural served from session cache (0ms); only knowledge fetched from vec-server; graphRecall skipped for short prompts (< 30 chars). Ion injects the session memory block as `--append-system-prompt` automatically.
   - Pending clarifications (e.g., "When you mention 'the project', clarify which one")
   - Extracted decision stakes (e.g., "This conversation involves financial commitment; ensure >90% confidence before recommending")
   - Pending reminders and briefings awaiting delivery
   - Approvals pending human review
   - Persona constraints and banned tokens (from `persona.yaml`)
   - Working memory snapshot (hot scheduler findings, 4-hour TTL)

4. **ion dispatches to Claude Sonnet 4.6** via `claude` CLI subprocess:
   ```
   claude -m claude-sonnet-4-6 <prompt>
   ```

5. **Claude generates response** (streaming or buffered)

6. **`turn_end` hook fires** → harness-ts:
   - Logs the reply to SQLite `messages` table
   - Runs `bannedTokenEnforcement()`: scans reply for banned tokens/phrases; alerts if persona violated
   - Fires voice synthesis asynchronously (Kokoro TTS to `tools-py/voice-tts`)
   - Ingests to Graphiti asynchronously (Neo4j episode ingestion)
   - Fires learning pipeline asynchronously:
     - `detectMemoryCorrection()`: fires every turn — did Claude contradict or update a prior belief?
     - `extractAndStore()`: fires at turns 4, 7, 10... (every 3 turns from turn 4) and always at `session_end`. Skipped on turns 1–3 to avoid wasted LLM calls on short sessions.
     - `extractConcreteValues()`: fires when session has 9+ messages — pulls concrete data (emails, phone numbers, dates)

7. **Tools execute** (if Claude requested any):
   - `recall_memory`, `remember_fact`, `calendar_create_event`, `mail_send`, `git_diff`, etc.
   - Tool dispatch returns results to Claude via ion's built-in tool-use loop

8. **`turn_start` hook fires** (after tools complete) → marks any dispatched agents as done

9. **Reply delivered** to iOS app / Discord / caller

---

## The Scheduled Backbone: Proactive Routines

48+ routines fire on schedule, independent of user interaction:

| Frequency | Routines | Purpose |
|-----------|----------|---------|
| **Every 1 min** | `autonomy`, `resolver_feedback_poll` | Always-on: goal runner, resolver feedback loop |
| **Every 5 min** | `meeting_prep`, `proactive_check` | Push upcoming meeting context; threshold-based alerts |
| **Every 6 hours** | `log_patrol`, `commit_patrol`, `issue_patrol`, `rss_fetch` | Scan logs for errors; file GitHub issues; fetch RSS feeds |
| **Every 12 hours** | `issue_resolver` | Pick an auto-filed issue, fix it, push to main |
| **Daily** | `morning_brief` (07:30), `midday_checkin` (13:00), `overnight_reflection` (03:00), `memory_consolidation` (02:00), `vault_export` (03:30) | Core proactive deliverables |
| **Weekly** | `weekly_curator` (Mon 08:00), `tech_advisor_watch` (Thu 09:00), `weekly_newsdesk` (Fri 15:00) | Specialist briefs |

Each routine runs in a dedicated session (not the main Jarvis conversation). If a routine needs context or approval, it surfaces to Discord or iOS for human decision.

---

## Design Principles: The Recurring WHY

### 1. Local First, Privacy by Default
Everything runs on the home network. No conversation data leaves it except via explicit integrations (mail fetch, GitHub API). Embeddings run on the NAS, the cold Parquet archive lives on the NAS, and Neo4j/Graphiti runs in a VM on the NAS — none of it is a cloud service.

### 2. Async and Non-Blocking
The `turn_end` hook spawns learning, voice, and Graphiti ingestion asynchronously. Claude replies stream back to the user while memory ingestion happens in the background. Blocking would add 500ms+ per turn.

### 3. Many Small Tools Over One Large Agent
Instead of one "knowledge base agent" that does everything, Jarvis delegates to 27 specialists:
- Chief of Communications (mail)
- Portfolio Manager (investments)
- Systems Engineer (infrastructure)
- Repo Steward (GitHub)
- etc.

Each specialist has a tight spec and is routed by intent. Routing is deterministic (suffix match on `/` commands) and by description match (heuristic for free-form messages). This prevents prompt injection and keeps each agent's scope clear.

### 4. Memory is Multi-Channel
A fact can be true in vector form (semantic), temporal form (entity-edge in Neo4j), or historical form (episodic in SQLite). Different recall patterns use different channels:
- Free-form recall: ChromaDB semantic similarity
- Temporal context: Graphiti entity-edge queries
- Conversation history: SQLite message log
- Decision tracking: SQLite actions table (Proposed → Approved)

### 5. Clarification to Learning is the Core Mechanism
When Jarvis is unsure about a preference, it asks one short question. The answer is stored in `user_profile` collection as a durable preference. Over time, "clarify and remember" builds a learned model of the principal's values, not a hard-coded ruleset.

### 6. Persona is Injected, Not Trained
Jarvis's tone (British, Oxford-educated, dry wit, unflappable) is not in-context instructions alone. It's:
- Injected via `before_prompt` system prompt (`bannedTokenEnforcement()`)
- Enforced at `turn_end` (auditing banned tokens)
- Sourced from `harness/config/persona.yaml` (banned tokens + desired phrases)
- Expressed through staff agent specs (each staff agent gets a "You report to Jarvis; be precise, tone is his job" system prompt)

This triadic approach (system-prompt injection, turn-end auditing, staff discipline) prevents tone drift across thousands of turns and staff dispatches.

---

## What Jarvis is NOT

### Not a Chatbot Wrapper
Jarvis does not wrap an API client. It is a full agent infrastructure with memory, scheduling, proactive delivery, staff delegation, and learning loops. A chatbot wrapper would add context, call GPT, get a response, and log it. Jarvis also schedules briefings without prompting, files GitHub issues from error logs, learns preferences from clarifications, and reflects on patterns across sessions.

### Not a Cloud Service
Everything runs on local hardware (M2 Mini). There is no Jarvis cloud account, no auth service, no remote logging. Conversation data never reaches a third party unless Jarvis explicitly calls an external API (mail fetch, GitHub API, etc.). Even then, the API call is made on the Mini; results are cached locally.

### Not Ollama-Powered
Ollama is used only for embeddings (nomic-embed-text), served from the NAS (`OLLAMA_EMBED_HOST`). It is not a reasoning engine — reasoning models are no longer resident in Ollama. Reasoning runs through the cli/apple/openrouter/anthropic backends, with Claude Sonnet 4.6 via the Claude CLI as the main session model (see [docs/llm-routing.md](llm-routing.md)). Ollama is fast and free for embeddings; the decisions that matter go to Claude.

### Not an API Key Management Tool
Jarvis does not import the Anthropic SDK. There is no API key in `.env`. Auth is handled by the Claude CLI (`claude login` once; OAuth token written to disk). This decouples Jarvis from Anthropic's API breaking changes and reduces the attack surface.

### Not Monolithic
Jarvis is composed of many services: ion (runtime), harness-ts (orchestration), vec-server (memory), voice-tts (synthesis), ion-relay (mobile bridge), Ollama (embeddings), Neo4j (knowledge graph). Each can be restarted independently. The main daemon (ion) can crash; routines continue running because the scheduler is in-process.

---

## Recap: Why This Architecture

| Design Decision | Why |
|---|---|
| **Fork ion instead of wrapper** | Needed `before_prompt` for CliBackend and `FireMessageUpdate` for persona enforcement. Wrapper would add 1-2s latency. |
| **TypeScript for orchestration** | Async/await, strong typing, npm ecosystem, easy bundling. Python would be slower for high-frequency hooks. |
| **CliBackend subprocess** | One less dependency to audit. Tool-use and streaming work transparently. Easy to swap models for sub-tasks. |
| **Ollama for embeddings only (on the NAS)** | Fast, free, on the home network. Cloud embeddings would cost thousands/month. Reasoning models were moved off Ollama (issue #613) because a large model load evicted the embedder from GPU and blocked recall. |
| **Three-tier memory** | Hot (ChromaDB) for speed, warm (Neo4j) for temporal semantics, cold (Parquet on the NAS) for archive. Single store would be too slow or too large. |
| **Two-Mini topology** | M2 is headless engine (never reboots). M4 is interactive client. Relay on M2 means WAN access survives M4 reboot. |
| **48+ scheduled routines** | Proactive delivery (morning brief, meeting prep, alerts) removes friction. Scheduled jobs are independent of user input. |
| **27-member staff roster** | Specialization prevents prompt injection. Each agent has tight scope. Routing is deterministic. |
| **Clarification to learning** | Instead of hard-coded rules, Jarvis asks and remembers. Preferences are durable and override-able. |

---

## Onboarding: Where to Read Next

- **Memory architecture in depth:** [docs/memory.md](memory.md)
- **Staff roster and routing:** [docs/staff.md](staff.md)
- **Identity and persona:** [docs/identity.md](identity.md)
- **Integrations (mail, calendar, Discord, GitHub):** [docs/integrations.md](integrations.md)
- **Graphiti knowledge graph:** [docs/graphiti.md](graphiti.md)
- **Concept and design principles:** [docs/concept.md](concept.md)
