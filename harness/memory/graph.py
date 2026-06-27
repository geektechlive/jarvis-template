"""Graphiti knowledge graph client -- temporal entity-edge layer over ChromaDB.

Disabled by default. Enable in harness/config/models.yaml:
  graphiti:
    enabled: true

Requires:
  - Neo4j 5.26+ at the configured URI
  - uv sync --extra graph
  - GRAPHITI_NEO4J_PASSWORD env var
  - OPENROUTER_API_KEY env var (set in com.example.tools-py-vector.plist)

Architecture notes:
  - LLM (entity extraction): graphiti-core OpenAIClient pointed at OpenRouter
    (google/gemini-2.5-flash). Direct HTTP API call; no subprocess overhead.
    Replaces the prior ClaudeCliClient (Claude CLI subprocess) which caused
    Haiku to echo the JSON Schema definition instead of producing instances.
  - Embedder: Ollama nomic-embed-text on NAS (OLLAMA_EMBED_HOST).
  - cross_encoder: _NoOpReranker sentinel required. Passing None is falsy,
    causing Graphiti.__init__ to create OpenAIRerankerClient() as default,
    which requires OPENAI_API_KEY. The sentinel must inherit CrossEncoderClient
    (graphiti-core validates the type via Pydantic).
"""

import asyncio
import logging
import os
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

_log = logging.getLogger(__name__)


class QuotaExhaustedError(RuntimeError):
    """Raised when the Claude CLI reports the org monthly usage limit has been hit."""


class RateLimitError(RuntimeError):
    """Raised when the Claude CLI is HTTP 429 rate-limited (transient; retry with backoff)."""


_UNINITIALIZED = object()  # sentinel: distinguishes "not yet built" from "built but unavailable"
_graphiti: Any = _UNINITIALIZED
_graphiti_lock = threading.Lock()
_config_cache: dict | None = None

# Dedicated event loop thread -- neo4j AsyncDriver must run on a single loop.
_loop: asyncio.AbstractEventLoop | None = None
_loop_lock = threading.Lock()


def _get_loop() -> asyncio.AbstractEventLoop:
    global _loop
    if _loop is not None:
        return _loop
    with _loop_lock:
        if _loop is not None:
            return _loop
        loop = asyncio.new_event_loop()
        def _start_loop(ev_loop: asyncio.AbstractEventLoop) -> None:
            asyncio.set_event_loop(ev_loop)
            ev_loop.run_forever()
        threading.Thread(
            target=_start_loop, args=(loop,), daemon=True, name="graphiti-loop"
        ).start()
        _loop = loop
    return _loop


def _run(coro: Any, timeout: float = 30) -> Any:
    """Submit a coroutine to the dedicated event loop and block until done."""
    return asyncio.run_coroutine_threadsafe(coro, _get_loop()).result(timeout=timeout)


def _cfg() -> dict:
    global _config_cache
    if _config_cache is not None:
        return _config_cache
    try:
        import yaml
        config_path = Path(__file__).parent.parent / "config" / "models.yaml"
        with open(config_path) as f:
            loaded: dict = yaml.safe_load(f) or {}
            _config_cache = dict(loaded.get("graphiti") or {})
    except Exception:
        _config_cache = {}
    return _config_cache


def is_enabled() -> bool:
    return bool(_cfg().get("enabled", False))


def ping(timeout: float = 5.0) -> bool:
    """Lightweight Neo4j connectivity check for observability probes.

    Opens a short-lived synchronous driver with the configured credentials and
    verifies connectivity. Returns False when graph memory is disabled or the
    server is unreachable. Never raises -- callers treat False as 'down'. This
    deliberately bypasses the async graphiti singleton so a probe never contends
    with the dedicated event-loop thread used by ingest/recall.
    """
    if not is_enabled():
        return False
    cfg = _cfg()
    uri = cfg.get("neo4j_uri", "bolt://127.0.0.1:7687")
    user = cfg.get("neo4j_user", "neo4j")
    password = os.environ.get("GRAPHITI_NEO4J_PASSWORD", "")
    try:
        from neo4j import GraphDatabase  # type: ignore[import]

        driver = GraphDatabase.driver(
            uri, auth=(user, password), connection_timeout=timeout
        )
        try:
            driver.verify_connectivity()
            return True
        finally:
            driver.close()
    except Exception:
        return False


def _embed_host() -> str:
    """Return the Ollama embed base URL with /v1 suffix."""
    host = os.environ.get("OLLAMA_EMBED_HOST") or os.environ.get(
        "OLLAMA_HOST", "http://127.0.0.1:11434"
    )
    return host.rstrip("/") + "/v1"


def _repair_node_resolutions(parsed: Any, response_model: Any) -> Any:
    """Backfill graphiti NodeResolutions items the model under-fills (#792).

    The structured-output schema is sent with strict=False (strict=True caused
    400 invalid_json_schema -- #769), so it is advisory: gemini-via-OpenRouter
    sometimes returns entity_resolutions items like ``{"id": 0}``, omitting the
    required ``name`` and ``duplicate_candidate_id``. ``NodeResolutions(**parsed)``
    then raises in graphiti and -- after 3 retries -- the whole entity/edge batch
    for that episode is dropped.

    graphiti's resolution loop only consumes ``id`` and ``duplicate_candidate_id``
    (``name`` is unused there) and already tolerates missing/extra ids. So we
    backfill safe defaults rather than re-enabling the risky strict mode:
      - ``duplicate_candidate_id = -1`` -> the schema's documented "no duplicate"
        sentinel, so the node is kept as-is and NEVER wrongly merged.
      - ``name = ""`` -> not read by the resolution loop.
    Items missing the ``id`` anchor are dropped (graphiti treats the gap as an
    unresolved node, same as ``-1``). Worst case is a missed dedup, never a wrong
    merge or a lost episode.

    No-ops for any other response_model or shape.
    """
    if getattr(response_model, "__name__", "") != "NodeResolutions":
        return parsed
    if not isinstance(parsed, dict):
        return parsed
    items = parsed.get("entity_resolutions")
    if not isinstance(items, list):
        return parsed

    # Treat a key that is absent OR present-but-null the same way (the model
    # under-fills either way). `is None` is deliberate, not falsiness: a real
    # duplicate_candidate_id of 0 is a valid merge target and must be preserved.
    fixed: list[Any] = []
    backfilled = 0
    dropped = 0
    for item in items:
        if not isinstance(item, dict) or item.get("id") is None:
            dropped += 1
            continue
        if item.get("duplicate_candidate_id") is None:
            item["duplicate_candidate_id"] = -1
            backfilled += 1
        if item.get("name") is None:
            item["name"] = ""
            backfilled += 1
        fixed.append(item)

    if backfilled or dropped:
        parsed["entity_resolutions"] = fixed
        _log.warning(
            "graph_llm: repaired NodeResolutions (backfilled=%d, dropped=%d) -- "
            "model under-filled the non-strict schema",
            backfilled,
            dropped,
        )
    return parsed


def _repair_edge_duplicate(parsed: Any, response_model: Any) -> Any:
    """Coerce a malformed graphiti EdgeDuplicate payload into a valid mapping (#794).

    Same root cause as #792 (advisory strict=False schema): gemini-via-OpenRouter
    sometimes returns the edge-dedup result as a top-level JSON *list* instead of
    ``{"duplicate_facts": [...], "contradicted_facts": [...]}``. graphiti then does
    ``EdgeDuplicate(**llm_response)`` (edge_operations.py) which raises
    "argument after ** must be a mapping, not list", and -- after 3 retries -- the
    edge batch for that episode is dropped (and the retries hold ingest-semaphore
    slots, saturating the path).

    graphiti tolerates out-of-range idx values in both lists (it warns + filters),
    so the conservative coercion is safe:
      - a single-element list wrapping the real object -> unwrap it (recovers the
        common "LLM wrapped the object in an array" mistake);
      - any other list (bare int list, empty, etc.) -> {} -> empty lists below,
        meaning "no duplicates, no contradictions": the edge is kept as-is and
        nothing is invalidated. Worst case is a missed dedup, never a wrong merge
        or a wrong invalidation.
    Missing/non-list fields are backfilled to []. No-op for any other response_model.
    """
    if getattr(response_model, "__name__", "") != "EdgeDuplicate":
        return parsed

    coerced = False
    if isinstance(parsed, list):
        if len(parsed) == 1 and isinstance(parsed[0], dict):
            parsed = parsed[0]
        else:
            parsed = {}
        coerced = True

    if not isinstance(parsed, dict):
        # Top-level scalar/null/bool (another off-shape failure mode) -> empty.
        parsed = {}
        coerced = True

    for field in ("duplicate_facts", "contradicted_facts"):
        if not isinstance(parsed.get(field), list):
            parsed[field] = []
            coerced = True

    if coerced:
        _log.warning(
            "graph_llm: repaired EdgeDuplicate -- model returned a non-object/"
            "under-filled payload under the non-strict schema"
        )
    return parsed


def _repair_edge_timestamps(parsed: Any, response_model: Any) -> Any:
    """Coerce a malformed graphiti EdgeTimestamps payload into a valid mapping (#821).

    Same root cause as #792/#794 (advisory strict=False schema): gemini-via-OpenRouter
    sometimes returns the edge-timestamps result as a top-level JSON *list* instead of
    ``{"valid_at": "...", "invalid_at": "..."}``. graphiti then does
    ``EdgeTimestamps(**llm_response)`` (edge_operations.py:604) which raises
    "argument after ** must be a mapping, not list", and the edge batch for that
    episode is dropped.

    EdgeTimestamps has two optional fields: ``valid_at: str | None`` and
    ``invalid_at: str | None``. An empty dict ``{}`` is a safe default (both fields
    default to None, meaning no timestamps set). Worst case is a missed timestamp,
    never a wrong merge or dropped episode.

    Coercions applied:
      - a single-element list wrapping a dict -> unwrap it;
      - any other list (bare str list, empty, etc.) -> {};
      - any non-dict top-level value (scalar, null, bool) -> {};
      - ``valid_at`` or ``invalid_at`` present but not a str or None -> reset to None.
    No-op for any other response_model.
    """
    if getattr(response_model, "__name__", "") != "EdgeTimestamps":
        return parsed

    coerced = False
    if isinstance(parsed, list):
        if len(parsed) == 1 and isinstance(parsed[0], dict):
            parsed = parsed[0]
        else:
            parsed = {}
        coerced = True

    if not isinstance(parsed, dict):
        # Top-level scalar/null/bool -> empty.
        parsed = {}
        coerced = True

    for field in ("valid_at", "invalid_at"):
        val = parsed.get(field)
        if val is not None and not isinstance(val, str):
            parsed[field] = None
            coerced = True

    if coerced:
        _log.warning(
            "graph_llm: repaired EdgeTimestamps -- model returned a non-object/"
            "under-filled payload under the non-strict schema"
        )
    return parsed


def _repair_json_content(content: str) -> "dict | list | None":
    """Attempt to repair malformed JSON using json_repair.

    Returns the repaired parsed object, or None when the content is
    entirely unparseable (empty, whitespace-only, code-fence-only, etc.).
    Callers should try json.loads() first; only call this on parse failure.
    json_repair returns '' for inputs it cannot recover -- this function
    treats that as None so callers do not accidentally call json.loads('').
    """
    import json as _json

    try:
        from json_repair import repair_json  # type: ignore[import]
        repaired = repair_json(content)
        if repaired:  # repair_json returns '' for fully unparseable content
            return _json.loads(repaired)
    except Exception:
        pass

    return None


def _build() -> Any | None:
    """Construct and return a Graphiti instance, or None if unavailable."""
    try:
        # isort: off
        from graphiti_core import Graphiti  # type: ignore[import-not-found]
        from graphiti_core.cross_encoder.client import CrossEncoderClient  # type: ignore[import-not-found]
        from graphiti_core.embedder.openai import OpenAIEmbedder, OpenAIEmbedderConfig  # type: ignore[import-not-found]
        from graphiti_core.llm_client.config import DEFAULT_MAX_TOKENS, LLMConfig, ModelSize  # type: ignore[import-not-found]
        from graphiti_core.llm_client.openai_client import OpenAIClient as _OpenAIClient  # type: ignore[import-not-found]
        # isort: on
    except ImportError:
        _log.warning("graphiti: graphiti-core not installed; run: uv sync --extra graph")
        return None

    class _OpenRouterLLMClient(_OpenAIClient):
        """Routes structured-output requests through Chat Completions + json_schema.

        graphiti-core's OpenAIClient._create_structured_completion uses
        client.responses.parse() (OpenAI Responses API), which OpenRouter does not
        support. This subclass overrides _generate_response to use
        chat.completions.create() with json_schema response_format instead.
        """

        def _handle_json_response(self, response: Any) -> Any:  # type: ignore[override]
            """Apply json-repair before json.loads() to tolerate malformed LLM output.

            Gemini (and other models routed via OpenRouter) occasionally returns
            structurally invalid JSON: unterminated strings, missing commas, trailing
            content. json-repair fixes the most common patterns, avoiding a graphiti
            internal retry and reducing log noise.

            When repair also fails (e.g. for empty/whitespace-only responses where
            repair_json returns ''), return {} so graphiti handles the failure via
            Pydantic validation + retry-with-context rather than a raw JSONDecodeError
            surfacing in the graphiti retry logs.
            """
            import json as _json

            result = response.choices[0].message.content or "{}"
            input_tokens = 0
            output_tokens = 0
            if hasattr(response, "usage") and response.usage:
                input_tokens = getattr(response.usage, "prompt_tokens", 0) or 0
                output_tokens = getattr(response.usage, "completion_tokens", 0) or 0

            try:
                return _json.loads(result), input_tokens, output_tokens
            except _json.JSONDecodeError:
                pass

            repaired = _repair_json_content(result)
            if repaired is not None:
                _log.debug(
                    "graph_llm: repaired malformed JSON response (original_len=%d)", len(result)
                )
                return repaired, input_tokens, output_tokens

            # json_repair could not recover content (e.g. empty or whitespace-only
            # response from the model). Return {} so graphiti handles this via Pydantic
            # validation + retry-with-context instead of a raw JSONDecodeError.
            _log.warning(
                "graph_llm: json_repair could not recover response (original_len=%d) -- "
                "returning {} for graphiti to handle via validation retry",
                len(result),
            )
            return {}, input_tokens, output_tokens

        async def _generate_response(  # type: ignore[override]
            self,
            messages: Any,
            response_model: Any = None,
            max_tokens: int = DEFAULT_MAX_TOKENS,
            model_size: Any = ModelSize.medium,
        ) -> Any:
            openai_messages = self._convert_messages_to_openai_format(messages)
            model = self._get_model_for_size(model_size)
            effective_max_tokens = max_tokens or self.max_tokens

            if response_model is not None:
                schema = response_model.model_json_schema()
                response = await self.client.chat.completions.create(
                    model=model,
                    messages=openai_messages,
                    # graphiti default temperature is 1, wrong for JSON-schema work
                    temperature=0,
                    max_tokens=effective_max_tokens,
                    response_format={
                        "type": "json_schema",
                        "json_schema": {
                            "name": response_model.__name__,
                            "schema": schema,
                            # strict must stay False: graphiti-core's pydantic schemas do not
                            # set additionalProperties:false, which OpenAI/Azure (reached via
                            # OpenRouter) require under strict mode -> 400 invalid_json_schema
                            # on every ingest. temperature=0 above is the safe determinism win.
                            "strict": False,
                        },
                    },
                )
            else:
                response = await self.client.chat.completions.create(
                    model=model,
                    messages=openai_messages,
                    temperature=self.temperature,
                    max_tokens=effective_max_tokens,
                    response_format={"type": "json_object"},
                )
            parsed, input_tokens, output_tokens = self._handle_json_response(response)
            # #792/#794/#821: repair payloads the model under-fills / mis-shapes under
            # the non-strict schema so graphiti's NodeResolutions(**parsed) /
            # EdgeDuplicate(**parsed) / EdgeTimestamps(**parsed) do not raise and drop
            # the episode. Each repair no-ops for every other response_model.
            parsed = _repair_node_resolutions(parsed, response_model)
            parsed = _repair_edge_duplicate(parsed, response_model)
            parsed = _repair_edge_timestamps(parsed, response_model)
            return parsed, input_tokens, output_tokens

    class _NoOpReranker(CrossEncoderClient):
        """Pass-through cross-encoder: returns passages in original order.

        Must inherit CrossEncoderClient -- graphiti-core validates the type via
        Pydantic. Passing None is falsy, triggering a default OpenAIRerankerClient()
        that requires OPENAI_API_KEY.
        """

        async def rank(self, query: str, passages: list[str]) -> list[tuple[str, float]]:
            return [(p, 1.0) for p in passages]

    cfg = _cfg()
    neo4j_uri = cfg.get("neo4j_uri", "bolt://127.0.0.1:7687")
    neo4j_user = cfg.get("neo4j_user", "neo4j")
    neo4j_password = os.environ.get("GRAPHITI_NEO4J_PASSWORD", "")
    llm_model = cfg.get("llm_model", "google/gemini-2.5-flash")
    embedding_model = cfg.get("embedding_model", "nomic-embed-text")
    embedding_dim = int(cfg.get("embedding_dim", 768))

    openrouter_key = os.environ.get("OPENROUTER_API_KEY", "")
    if not openrouter_key:
        _log.error(
            "graphiti: OPENROUTER_API_KEY is not set -- every ingest will 401. "
            "Set it in com.example.tools-py-vector.plist EnvironmentVariables."
        )
        return None
    llm_client = _OpenRouterLLMClient(config=LLMConfig(
        api_key=openrouter_key,
        model=llm_model,
        # small_model MUST be set: graphiti's node-summarization step runs at
        # ModelSize.small. Unset, _get_model_for_size() falls back to graphiti's
        # built-in DEFAULT_SMALL_MODEL (gpt-4.1-nano), which OpenRouter routes to
        # OpenAI/Azure -> 400 invalid_json_schema on SummarizedEntities. Default to
        # the same model as the main path so every call stays on one provider.
        small_model=cfg.get("small_model", llm_model),
        # temperature=0 here covers the non-structured (json_object) branch, which
        # uses self.temperature; the structured branch already hardcodes 0.
        temperature=0,
        base_url="https://openrouter.ai/api/v1",
    ))

    g = Graphiti(
        neo4j_uri,
        neo4j_user,
        neo4j_password,
        llm_client=llm_client,
        embedder=OpenAIEmbedder(config=OpenAIEmbedderConfig(
            api_key="ollama",
            embedding_model=embedding_model,
            embedding_dim=embedding_dim,
            base_url=_embed_host(),
        )),
        cross_encoder=_NoOpReranker(),
    )

    async def _init():
        await g.build_indices_and_constraints()

    _run(_init())
    _log.info("graphiti: connected to %s", neo4j_uri)
    return g


def _get() -> Any | None:
    """Lazy singleton -- returns None when disabled or graphiti-core missing."""
    global _graphiti
    if _graphiti is not _UNINITIALIZED:
        return _graphiti  # could be None (failed/disabled) or a live instance
    if not is_enabled():
        return None
    with _graphiti_lock:
        if _graphiti is not _UNINITIALIZED:
            return _graphiti
        _graphiti = _build()
    return _graphiti


def ingest(
    text: str,
    name: str,
    group_id: str | None = None,
    reference_time: datetime | None = None,
) -> None:
    """Synchronously ingest a text episode into the knowledge graph.

    Runs add_episode() to completion. Callers that want fire-and-forget
    should dispatch this in a daemon thread (see vec-server /graph/ingest).

    ``reference_time`` sets the ``valid_at`` of facts graphiti extracts. Pass
    the originating turn time so facts are dated when they were said, not when
    the ingest happened to fire (#767). Defaults to now (UTC) when absent.
    """
    g = _get()
    if g is None:
        return

    if not group_id:
        group_id = _cfg().get("group_id", "jarvis")

    ref_time = reference_time or datetime.now(tz=UTC)

    from graphiti_core.nodes import EpisodeType  # type: ignore[import]

    async def _add():
        await g.add_episode(
            name=name,
            episode_body=text,
            source_description="jarvis-conversation",
            reference_time=ref_time,
            source=EpisodeType.message,
            group_id=group_id,
            custom_extraction_instructions=(
                "The user in this conversation is Alex Example. "
                "References to 'Alex', 'the user', 'User', and 'Sir' all refer to Alex Example. "
                "Always use 'Alex Example' as the entity name when creating nodes for the user. "
                "Jarvis is the AI assistant."
            ),
        )

    import time as _time

    # Retry loop: back off on transient RateLimitError or subprocess TimeoutError.
    # Never retry QuotaExhaustedError -- that is a hard monthly cap, not transient.
    # Backoff schedule: 4s, 8s, 30s (three attempts total).
    # Pattern mirrors store.py _generate_tags for consistency.
    _MAX_RETRIES = 3
    _BACKOFF = [4, 8, 30]

    import json as _json

    ingest_timeout = int(_cfg().get("ingest_timeout", 300))
    for attempt in range(_MAX_RETRIES):
        try:
            _run(_add(), timeout=ingest_timeout)
            return
        except QuotaExhaustedError:
            raise  # hard cap -- let vec-server circuit breaker handle this
        except (_json.JSONDecodeError, IndexError) as exc:
            # JSON decode failure = LLM returned malformed structured output.
            # IndexError = dedup/entity resolution returned out-of-range index.
            # Neither is transient -- retrying the same prompt won't help; skip.
            _log.warning(
                "graph_ingest: non-retriable structured-output error for %r -- "
                "skipping (attempt %d/%d): %s: %s",
                name, attempt + 1, _MAX_RETRIES, type(exc).__name__, exc,
            )
            return
        except RateLimitError as exc:
            if attempt < _MAX_RETRIES - 1:
                wait = _BACKOFF[attempt]
                _log.warning(
                    "graph_ingest: rate limited for '%s' (attempt %d/%d) -- "
                    "retrying in %ds: %s",
                    name, attempt + 1, _MAX_RETRIES, wait, exc,
                )
                _time.sleep(wait)
                continue
            # Exhausted retries: re-raise so vec-server can open the timed backoff.
            raise
        except Exception as exc:
            if attempt < _MAX_RETRIES - 1:
                wait = _BACKOFF[attempt]
                _log.warning(
                    "graph_ingest: transient error for '%s' (attempt %d/%d) -- "
                    "retrying in %ds: %s",
                    name, attempt + 1, _MAX_RETRIES, wait, exc,
                )
                _time.sleep(wait)
                continue
            _log.warning(
                "graph_ingest: entity/edge error for %r after %d attempts: %s: %s",
                name, _MAX_RETRIES, type(exc).__name__, exc or "(empty)",
            )


def recall(
    query: str, group_id: str | None = None, n: int = 10, as_of: str | None = None
) -> list[dict]:
    """Search the knowledge graph; returns list of entity-edge fact dicts.

    Args:
        query: Search query string.
        group_id: Graphiti group to scope the search to.
        n: Maximum number of results to return.
        as_of: Optional ISO datetime string. When provided, passed as
            ``reference_time`` to Graphiti so the search reflects the graph
            state at that point in time.
    """
    g = _get()
    if g is None:
        return []

    if not group_id:
        group_id = _cfg().get("group_id", "jarvis")

    reference_time: datetime | None = None
    if as_of is not None:
        try:
            reference_time = datetime.fromisoformat(as_of)
        except (ValueError, TypeError):
            _log.warning("graph recall: invalid as_of value %r -- ignoring", as_of)

    async def _search():
        kwargs: dict = {"group_ids": [group_id], "num_results": n}
        if reference_time is not None:
            kwargs["reference_time"] = reference_time
        edges = await g.search(query, **kwargs)

        # Batch resolve source/target UUIDs to entity names in a single Neo4j round-trip.
        # g.search() returns list[EntityEdge] which carries UUIDs only -- no node objects.
        uuids = {e.source_node_uuid for e in edges} | {e.target_node_uuid for e in edges}
        node_map: dict[str, str] = {}
        if uuids:
            records, _, _ = await g.driver.execute_query(
                "MATCH (n:Entity) WHERE n.uuid IN $uuids RETURN n.uuid AS uuid, n.name AS name",
                uuids=list(uuids),
                routing_="r",
            )
            node_map = {rec["uuid"]: rec["name"] for rec in records}

        out = []
        for r in edges:
            out.append(
                {
                    "fact": r.fact,
                    "source_node": getattr(r, "source_node_uuid", None),
                    "target_node": getattr(r, "target_node_uuid", None),
                    "source_name": node_map.get(r.source_node_uuid),
                    "target_name": node_map.get(r.target_node_uuid),
                    "created_at": (
                        str(r.created_at)
                        if getattr(r, "created_at", None) is not None
                        else None
                    ),
                    "valid_at": (
                        str(r.valid_at)
                        if getattr(r, "valid_at", None) is not None
                        else None
                    ),
                }
            )
        return out

    try:
        return _run(_search())
    except Exception as exc:
        _log.warning(
            "graph recall: search failed -- returning empty: %s: %s",
            type(exc).__name__, exc,
        )
        return []
