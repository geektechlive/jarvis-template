# Graphiti — Temporal Knowledge Graph

Graphiti is a temporal entity-edge knowledge graph built on Neo4j 5.26+ and the graphiti-core Python library. Unlike ChromaDB which stores unstructured text chunks, Graphiti stores structured facts as typed entities and edges with temporal validity. This enables queries like "what did I believe about X in March?" or "what changed about this relationship since last month?"

Neo4j runs on the **Synology NAS** (a VM at `bolt://<nas-ip>:7687`), not on the Mac Mini. The Mini's vec-server talks to it over the LAN.

## Split backend (read this first)

Graphiti uses **two different model backends**, and conflating them is the most common source of confusion:

- **Graph LLM (entity/edge extraction + node summarization):** OpenRouter, `google/gemini-2.5-flash`. This is a cloud API call via `graphiti-core`'s `OpenAIClient` pointed at the OpenRouter base URL — no Claude CLI subprocess, no local Ollama model. Requires `OPENROUTER_API_KEY`.
- **Graph embeddings:** Ollama, `nomic-embed-text` (768-dim), served on the **NAS** via `OLLAMA_EMBED_HOST`.

So the graph "thinks" with Gemini-over-OpenRouter and "indexes" with Ollama nomic-embed-text. The reasoning model is **not** local and is **not** the Claude CLI.

## Data model

Each conversation episode is ingested into Graphiti, which extracts entities (nodes) and their relationships (edges). Each edge carries a `valid_at` timestamp and optional `invalid_at` timestamp, creating a queryable history of temporal relationships.

```
Episode (conversation exchange) → Entities (nodes) → Edges (relationships with timestamps)
```

Graphiti's core strength is relationship reasoning. Unlike ChromaDB's semantic similarity, Graphiti can answer transitive questions ("who worked with Alice?") and temporal questions ("what was true on May 15?") by walking the graph.

## Ingest flow

1. `turn_end` ion hook fires after message exchange completes
2. `graphIngest()` in `harness-ts/src/memory/recall.ts` formats the user message and assistant reply into an episode (max 1500 chars)
3. POST to vec-server `/graph/ingest` endpoint with `{text, name}`
4. vec-server `/graph/ingest` handler calls `graph.ingest()` in `harness/memory/graph.py`
5. `graph.ingest()` submits to `g.add_episode()` asynchronously; runs in a daemon thread and completes within the `ingest_timeout` (600s)

The ingest is fire-and-forget at the HTTP level (202 response), but the underlying `add_episode()` completes on a dedicated asyncio event loop, bounded by `ingest_timeout`.

## Recall flow

1. `before_prompt` ion hook fires before Claude responds
2. `graphRecall()` in `harness-ts/src/memory/recall.ts` queries vec-server `/graph/recall` endpoint with `{query, n, as_of?}`
3. vec-server calls `graph.recall()` in `harness/memory/graph.py`
4. `graph.recall()` invokes `g.search()` with the query and optional reference time
5. Returns list of entity-edge facts as dicts with `fact`, `source_node`, `target_node`, `source_name`, `target_name`, `created_at`, `valid_at`
6. Facts are optionally injected into the system prompt context, allowing Claude to reason about relationships

## Setup requirements

Ordered as prerequisites:

1. **Neo4j 5.26+ on the NAS**
   Neo4j runs in a VM on the Synology NAS, reachable at `bolt://<nas-ip>:7687`. Confirm it listens on the configured URI.

2. **Environment variable for Neo4j password**
   ```bash
   export GRAPHITI_NEO4J_PASSWORD=<your-password>
   ```
   Never commit this to source control. On the Mini it lives in `com.example.tools-py-vector.plist`.

3. **OpenRouter API key** (graph LLM backend)
   ```bash
   export OPENROUTER_API_KEY=<your-key>
   ```
   Without it, every ingest 401s. Also set in `com.example.tools-py-vector.plist`.

4. **Python dependencies**
   ```bash
   uv sync --extra graph
   ```
   Installs `graphiti-core` and the Neo4j driver.

5. **Enable in configuration**
   Set `graphiti.enabled: true` in `harness/config/models.yaml` under the `graphiti` block.

## Configuration reference

Set these fields in `harness/config/models.yaml` under `graphiti:`:

```yaml
graphiti:
  enabled: true                          # Master toggle
  neo4j_uri: bolt://<nas-ip>:7687  # Neo4j on the Synology NAS VM (not the Mini)
  neo4j_user: neo4j                      # Neo4j username
  llm_model: google/gemini-2.5-flash     # Graph LLM (extraction) via OpenRouter
  small_model: google/gemini-2.5-flash   # Node summarization; must be a valid OpenRouter
                                         # slug or graphiti falls back to gpt-4.1-nano -> 400
  embedding_model: nomic-embed-text      # Graph embeddings via Ollama on the NAS
  embedding_dim: 768                     # Embedding dimension
  group_id: jarvis                       # Scope label for multi-user isolation
  llm_timeout: 240                       # seconds per OpenRouter LLM call
  ingest_timeout: 600                    # seconds for the entire add_episode() chain
```

Password is passed via the `GRAPHITI_NEO4J_PASSWORD` environment variable; never hardcode it in config. The graph LLM key is `OPENROUTER_API_KEY`.

## HTTP endpoint reference

Both endpoints live on vec-server at `http://127.0.0.1:9876`.

### POST `/graph/ingest`

Fire-and-forget episode ingestion. Runs `add_episode()` in a background daemon thread.

Request:
```json
{
  "text": "User: what did we discuss about the project?\nJarvis: We agreed...",
  "name": "episode-slug",
  "group_id": "jarvis"
}
```

Response:
```json
{
  "status": "queued",
  "name": "episode-slug"
}
```

Returns 202 immediately. Silently no-ops when `graphiti.enabled` is false.

### POST `/graph/recall`

Semantic search across entity-edge facts.

Request:
```json
{
  "query": "what did I say about the AWS migration?",
  "n": 10,
  "as_of": "2026-05-15T12:00:00",
  "group_id": "jarvis"
}
```

All fields except `query` are optional.

Response:
```json
{
  "results": [
    {
      "fact": "Alex decided to postpone the AWS migration until Q4",
      "source_node": "uuid-1",
      "target_node": "uuid-2",
      "source_name": "Alex",
      "target_name": "AWS migration",
      "created_at": "2026-05-15T10:30:00",
      "valid_at": "2026-05-15T10:30:00"
    }
  ]
}
```

Returns empty list when `graphiti.enabled` is false or the graph is unreachable.

## When to use direct recall vs. automatic

**Automatic ingest/recall** happens every turn when Graphiti is enabled:
- Ingest fires in the `turn_end` hook automatically
- Recall fires in the `before_prompt` hook automatically

**Direct queries via vec-server endpoints** are for:
- Diagnostics and debugging (curl from CLI or test scripts)
- One-off temporal queries (e.g., "what was true on this date?")
- Integration with external services

For normal operation, enable Graphiti in config and let the hooks manage ingestion and recall.

## Implementation details

### Threading and async isolation

Graphiti's Neo4j AsyncDriver requires a single dedicated asyncio event loop. The `graph.py` module manages this with:
- A dedicated daemon thread running its own event loop
- All async operations submitted via `asyncio.run_coroutine_threadsafe()`
- Synchronous wrapper functions that block until completion with a timeout

This pattern isolates the async context and prevents loop-per-thread conflicts.

### Embedding and LLM routing

Entity/edge extraction and node summarization use the configured `llm_model` / `small_model` (`google/gemini-2.5-flash` via **OpenRouter**, not Ollama and not the Claude CLI). Graph embeddings use `embedding_model` (`nomic-embed-text`) on **Ollama at `OLLAMA_EMBED_HOST`** (the NAS). This is the split backend described at the top: cloud Gemini for reasoning, local-on-NAS Ollama for vectors.

`small_model` must resolve to a valid OpenRouter slug. If it is unset, graphiti-core falls back to its built-in default (`gpt-4.1-nano`), which OpenRouter rejects with a 400 — so it is pinned to the same Gemini slug as `llm_model`.

If Graphiti is enabled but Neo4j is unreachable, a warning is logged and the graph functions return empty results. The system degrades gracefully.

### Deduplication and versioning

Graphiti automatically handles entity and edge versioning when facts change. If an edge's truth changes, `invalid_at` is set on the old edge and a new edge is created with a fresh `valid_at`. Temporal queries respect this window.

## Source of truth

The Graphiti implementation is in:

- `harness/memory/graph.py`: Python client wrapping graphiti-core; OpenRouter LLM client + Ollama embedder wiring, ingest and recall logic
- `harness-ts/src/memory/recall.ts`: TypeScript orchestration; `graphIngest()` and `graphRecall()` functions
- `tools-py/vector-store/server.py`: HTTP endpoint handlers `_handle_graph_ingest` and `_handle_graph_recall`
- `harness/config/models.yaml`: Graphiti configuration block
- `docs/llm-routing.md`: how Graphiti's backends fit the broader routing picture

## Troubleshooting

### Graphiti is enabled but recall returns empty results

1. Confirm Neo4j on the NAS is running and reachable: `lsof -i :7687` from a NAS shell, or test the bolt URI from the Mini
2. Confirm `GRAPHITI_NEO4J_PASSWORD` is set and correct
3. Confirm `graphiti-core` is installed: `python -c "import graphiti_core"`
4. Check the vec-server error log for Neo4j connection errors
5. Verify at least one episode has been ingested (ingest is async; allow time up to `ingest_timeout`)

### Ingest 401s or edges are not extracted

Entity/edge extraction is driven by the OpenRouter graph LLM:
1. Confirm `OPENROUTER_API_KEY` is set (a missing key 401s every ingest)
2. Confirm `llm_model` and `small_model` are valid OpenRouter slugs (an unset `small_model` falls back to `gpt-4.1-nano` → 400)
3. Check the vec-server error log for OpenRouter errors or timeouts (`llm_timeout` is 240s per call)

### Embeddings fail during ingest/recall

1. Confirm Ollama on the NAS serves `nomic-embed-text` at `OLLAMA_EMBED_HOST`
2. Confirm `embedding_dim` (768) matches the model
3. Check the vec-server error log for embed-endpoint timeouts

### Temporal queries (`as_of`) return no results

1. Confirm at least one episode was ingested before the `as_of` timestamp
2. Use an ISO datetime string: `2026-05-15T12:00:00` (not a relative or Unix timestamp)
3. Remember that `valid_at` is set to the ingest time; facts ingested after `as_of` will not appear
</content>
</invoke>
