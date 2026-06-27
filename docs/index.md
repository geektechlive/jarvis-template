---
title: Documentation Index
description: Navigation guide for Jarvis, a personal always-on AI chief of staff running on Mac Mini.
sidebar_position: 0
---

## Quick Orientation

Jarvis is a personal, always-on AI chief of staff running 24/7 on Mac Mini, driven by Claude Sonnet 4.6 through the ion agent runtime. It is not a chatbot wrapper. It is persistent agent infrastructure with durable memory, a hand-picked staff of 27 specialist sub-agents, a proactive scheduler, and the capacity to learn and improve itself.

> The config files (`harness/config/models.yaml`, `routines.yaml`, `staff.yaml`) are the single source of truth; the tables and counts in these docs are point-in-time snapshots and may lag the config. Jarvis absorbs operational overhead — managing mail, calendar, goals, learning, triage, and consolidation — so the principal can focus on deep work.

### Key Concepts

- **ion** — the Go-based agent runtime that runs Jarvis; handles session lifecycle, hooks, tool dispatch, and integration with Claude
- **harness-ts** — TypeScript orchestration layer; extension hooks, command routing, staff delegation, memory recall, scheduler, and autonomy
- **CliBackend** — Jarvis talks to Claude via the Claude CLI subprocess (no API key required; uses local auth)
- **Staff agents** — 27 domain specialists (admin, learning, clarity, calendar, mail, triage, cfo, tech_advisor, wellness, etc.) routable by intent
- **vec-server** — HTTP server exposing ChromaDB memory (vector recall, consolidation) and Neo4j graph ingest for episodic knowledge

---

## Track 1: Understanding Jarvis

Start here if you're new to Jarvis and want to understand its design before touching code.

| Document | What It Covers |
|-----------|---|
| [concept.md](concept.md) | Why Jarvis exists, the core design bets (delegation-first, never monolithic, competence over latency) |
| [architecture.md](architecture.md) | Full system map: ion runtime, harness-ts orchestration, hook lifecycle, staff routing, memory layers, scheduler, autonomy |
| [identity.md](identity.md) | Persona stack: SOUL.md (narrative), persona.yaml (banned tokens), behavior/mission/goals/projects markdown files |
| [cli-backend.md](cli-backend.md) | How Jarvis talks to Claude: no API key, subprocess-based, `beforePrompt` hook for recall injection, turn_end extraction |

---

## Track 2: Deploying Jarvis

For someone setting up Jarvis on their own hardware.

| Document | What It Covers |
|-----------|---|
| [deployment.md](deployment.md) | Two-Mini topology (M2 runs engine/Ollama/relay, M4 runs Ion Desktop), LaunchAgents, make targets, TLS/tunnel setup |
| [integrations.md](integrations.md) | Wiring up mail (IMAP/SMTP), calendar (CalDAV), Discord (bot), Spotlight, Safari, AppleScript, Keychain |
| [contributing.md](contributing.md) | Dev environment: `make check`, `uv sync`, running tests locally, deploying to Mini, commit/push workflow |
| [troubleshooting.md](troubleshooting.md) | Common issues: socket errors, hook misfires, orphan processes, permission prompts, Ollama timeouts, git remote failures |

---

## Track 3: Extending Jarvis

For developers adding new capabilities: tools, commands, staff agents, routines, or memory procedures.

| Document | What It Covers |
|-----------|---|
| [hooks.md](hooks.md) | All ion extension hooks: `beforePrompt`, `turn_end`, `sessionStart`, `sessionEnd`, firing order, payload structure |
| [staff.md](staff.md) | Staff registry system: how agents are routed, spec fields, naming, handoff rules, dispatch patterns |
| [llm-routing.md](llm-routing.md) | Model selection by role: Sonnet (main, staff), Haiku (triage, patrol), Ollama (embeddings only), when and why each is used |
| [scheduler.md](scheduler.md) | Proactive routines: morning_brief, meeting_prep, overnight_reflection, weekly curator, all timing and config |
| [memory.md](memory.md) | Memory architecture: ChromaDB collections (user_profile, knowledge, agent_memories), episodic SQLite schema, dedup thresholds, consolidation |
| [triage.md](triage.md) | How ingested content is classified and routed: decision types, urgency floors, inbox accumulator, drain pattern |
| [conventions.md](conventions.md) | Standing cross-cutting conventions: debugging discipline, ion engine + SDK API gotchas, branch policy, dependency rules, agent-spec discipline |

---

## Track 4: Operations Reference

Day-to-day operation, debugging, and autonomous systems.

| Document | What It Covers |
|-----------|---|
| [scheduler.md](scheduler.md) | All proactive routines, timing, configuration in routines.yaml, daily/weekly/interval jobs |
| [proactive.md](proactive.md) | Condition-based ambient triggers: idle gate, goal runners, meeting prep, brief delivery |
| [autonomy.md](proactive.md) | Always-on goal runner: goal lifecycle, run caps, idle gate, proposal → confirmation → active flow |
| [approvals.md](approvals.md) | Approval state machine: proposed/approved/denied/rolledback states, the `/approve` and `/deny` commands, action log |
| [improve.md](improve.md) | Self-improvement loop: auto/improve-* branches, allowlist, daily cap, `/improve approve/reject`, commit workflow |
| [patrol.md](patrol.md) | Autonomous issue resolver: every 6h, scans GitHub issues, classifies urgency, attempts fixes, merges PRs, closes issues |
| [matters.md](matters.md) | What Jarvis cares about: core responsibilities, decision heuristics, priority ordering |

---

## Reference & Deep Dives

| Document | Purpose |
|-----------|---------|
| [graphiti.md](graphiti.md) | Neo4j knowledge graph integration: entity extraction, graph ingest, schema, recall at `beforePrompt` |
| [RECOVERY.md](RECOVERY.md) | Emergency recovery procedures: corrupted DB, failed deploys, lost sessions |
| [patrol-ignore.md](patrol-ignore.md) | Issues excluded from patrol resolver (by label, repo, or pattern) |

---

## Navigation Tips

- **New to Jarvis?** Start with concept.md, then architecture.md, then pick a track based on your role.
- **Deploying?** Go to deployment.md first; it links to integrations and contributing.
- **Adding a staff agent?** Read staff.md, then llm-routing.md for model selection, then scheduler.md if it's a routine.
- **Debugging?** Start with troubleshooting.md.
- **Changing memory behavior?** Read memory.md for schema and dedup thresholds, then patrol.md if it's an autonomous issue.
