# harness/

This directory is data and memory only. Orchestration lives in `harness-ts/`.

**Do not add Python orchestration code here.**

## What lives here

| Path | Purpose |
|---|---|
| `memory/store.py` | ChromaDB VectorStore -- used by `tools-py/vector-store/` |
| `memory/episodic.py` | SQLite conversation + event store -- used by `tools-py/vector-store/` |
| `consolidation.py` | Memory consolidation logic -- used by `tools-py/vector-store/` |
| `identity/` | Persona `.md` files (SOUL, BEHAVIOR, MISSION, GOALS, PROJECTS) -- read by ion TS extension |
| `config/` | YAML config files (models, voice, integrations, persona, routines, staff) -- read by ion TS extension |

## What does NOT live here

All orchestration, agent logic, tools, commands, scheduler, and interface code moved to `harness-ts/src/` in Phase 3.
