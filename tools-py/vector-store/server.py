"""vector-store tool server.

HTTP server wrapping VectorStore.recall() and .remember() for consumption
by the Jarvis TypeScript extension. Runs on port 9876.

Threaded: a single slow request (e.g. an embedding call during a model swap)
must not block every other recall/remember at the socket. Each request runs
in its own thread; ChromaDB's PersistentClient and the per-call SQLite
connections in harness/memory/episodic.py are thread-safe.

Start: uv run python tools-py/vector-store/server.py
"""

import json
import logging
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# Make harness importable from the repo root.
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from harness import consolidation  # noqa: E402
from harness.memory import graph as graph_client  # noqa: E402
from harness.memory.store import VectorStore  # noqa: E402

_store: VectorStore | None = None
_store_lock = threading.Lock()


def store() -> VectorStore:
    """Return the singleton VectorStore. Thread-safe."""
    global _store
    if _store is None:
        with _store_lock:
            if _store is None:
                _store = VectorStore()
    return _store


# vec-server logs to stderr (-> vector.error.log), the stream Alloy tails for monitoring.
# That stream must mean "something is wrong", so the level is WARNING: only WARN/ERROR/
# CRITICAL are emitted. Operational/INFO activity is sourced elsewhere (ion-engine.log,
# agent_events), not from this service's error stream. (WARNING at the root also drops
# the chatty third-party INFO logs — httpx, chromadb, neo4j, etc.)
# Lines are timestamped (local time, matching the Mini's America/Chicago tz) so
# downstream consumers -- chiefly scripts/log-patrol.py -- can gate on recency and
# never re-file a stale historical error as if it were live (jarvis#829/#830).
logging.basicConfig(
    level=logging.WARNING,
    format="%(asctime)s [%(levelname)s] %(name)s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)

_log = logging.getLogger(__name__)

# Suppress graphiti-core internal warnings that are intentional "skip and log"
# behavior, not actionable errors. These fire when the LLM produces imperfect
# structured output (out-of-range dedup index, edge referencing an unextracted
# entity). Demoting from WARNING to DEBUG keeps vector.error.log clean while
# preserving the behavior (graphiti still skips the bad edge/index correctly).
class _GraphitiNoiseFilter(logging.Filter):
    _PATTERNS = (
        'LLM returned invalid duplicate_facts idx values',
        'Target entity not found in nodes for edge relation',
        'Could not find source or target node for extracted edge',
        'entity not found for edge relation',
        'Source entity not found',
        'Target entity not found',
    )
    def filter(self, record: logging.LogRecord) -> bool:
        msg = record.getMessage()
        if any(p in msg for p in self._PATTERNS):
            record.levelno = logging.DEBUG
            record.levelname = 'DEBUG'
        return True

logging.getLogger('graphiti_core').addFilter(_GraphitiNoiseFilter())

# Issue #222: increased from 3 to 8 to reduce contention at high ingestion rates.
# Each backfill thread does one tag-generation LLM call (5s timeout) plus two
# store writes. Eight concurrent threads saturate the Ollama queue without
# blocking the HTTP server.
_backfill_semaphore = threading.BoundedSemaphore(8)

# Bounded pending-backfill queue: entries here are attempted once the semaphore
# has a free slot. Capped at 200 to prevent unbounded memory growth under sustained load.
_backfill_queue: list[tuple[str, str, str]] = []
_backfill_queue_lock = threading.Lock()
_BACKFILL_QUEUE_MAX = 200

# Circuit breaker for Graphiti ingest: once the org monthly quota is hit, skip
# all subsequent ingest calls for the lifetime of the process rather than firing
# redundant subprocesses that will all fail with 429.
_graph_quota_exhausted: bool = False
_graph_quota_exhausted_lock = threading.Lock()
_graph_quota_exhausted_at: float = 0.0  # Unix timestamp when circuit tripped
_QUOTA_AUTO_RESET_SECS: int = 86_400  # 24h: try once per day to see if billing cycle reset

# Timed backoff for transient HTTP 429 rate limits. Unlike the permanent quota
# circuit, this resets automatically once the backoff period expires. Stored as
# a Unix timestamp; ingest is skipped while time.time() < _graph_rate_limited_until.
_graph_rate_limited_until: float = 0.0
_graph_rate_limited_lock = threading.Lock()
_GRAPH_RATE_LIMIT_BACKOFF_SECS = 300  # 5-minute pause after exhausting retries

# Semaphore limiting concurrent Graphiti ingest threads. Each thread spawns a
# claude-haiku subprocess for entity extraction; without a cap, a large session
# (71+ turns) fires 71 simultaneous subprocesses and exhausts the monthly quota.
_graph_ingest_semaphore = threading.BoundedSemaphore(3)


def _drain_backfill_queue() -> None:
    """Dequeue one pending backfill item and launch it if a slot is free."""
    with _backfill_queue_lock:
        if not _backfill_queue:
            return
        if not _backfill_semaphore.acquire(blocking=False):
            return
        doc_id, text, collection = _backfill_queue.pop(0)
    threading.Thread(
        target=_backfill_tags,
        args=(doc_id, text, collection),
        daemon=True,
    ).start()


def _backfill_tags(doc_id: str, text: str, collection: str) -> None:
    """Generate tags for a deferred entry and patch them into both stores.

    Runs in a background daemon thread after the HTTP response has been sent.
    Failures are logged as warnings rather than swallowed silently so that
    persistent Ollama contention shows up in the vector-store error log.
    """
    try:
        s = store()
        # Acquire the per-collection write lock before touching ChromaDB or SQLite.
        # Uses the same two-lock pattern as VectorStore.remember() so that a
        # concurrent remember() call cannot race with this background metadata patch.
        with s._write_locks_lock:
            if collection not in s._write_locks:
                s._write_locks[collection] = threading.Lock()
        # Safe to read s._write_locks[collection] here because locks are
        # only ever added, never removed -- same assumption as VectorStore.remember().
        with s._write_locks[collection]:
            _backfill_tags_locked(s, doc_id, text, collection)
    except Exception as exc:
        _log.warning("backfill_tags: failed for %s: %s", doc_id, exc)
    finally:
        _backfill_semaphore.release()
        # After releasing, drain one item from the queue so queued requests
        # are processed in FIFO order rather than silently dropped.
        _drain_backfill_queue()


def _backfill_tags_locked(s: "VectorStore", doc_id: str, text: str, collection: str) -> None:
    # max_attempts=1: backfill is best-effort. Retrying with exponential backoff
    # while holding a semaphore slot starves other queued backfills under load.
    tags = s._generate_tags(text, max_attempts=1)

    # #435: rate importance in the background thread so writes from the TS
    # harness (which always use defer_tags=True) get real importance scores
    # instead of the neutral default of 5. Mirrors the defer_tags pattern:
    # store().remember() defers the work; this thread does it after the HTTP
    # response has already been sent.
    importance = s._rate_importance(text)

    # ChromaDB update replaces metadata entirely -- fetch existing first.
    col = s._cols[collection]
    result = col.get(ids=[doc_id], include=["metadatas"])
    existing_metas = result.get("metadatas") or [{}]
    meta = dict(existing_metas[0] or {})
    if tags:
        meta["tags"] = json.dumps(tags)
    meta["importance"] = importance
    col.update(ids=[doc_id], metadatas=[meta])

    if not tags:
        # Nothing more to write to SQLite -- importance lives only in ChromaDB metadata.
        return

    # Patch SQLite tags column without disturbing confidence/source/collection.
    # init_db() runs the ttl_days migration (and all others) idempotently so that
    # backfill_tags never hits a missing-column error on a pre-migration database
    # (#428).
    try:
        from harness.memory import episodic
        episodic.init_db()
        episodic.upsert_memory_meta(
            doc_id,
            confidence=float(meta.get("confidence", 0.5)),  # type: ignore[arg-type]  # ChromaDB metadata union includes SparseVector; value is always float
            source=str(meta.get("source", "jarvis-ts")),
            collection=collection,
            tags=tags,
        )
    except Exception as _e:
        _log.warning("backfill_tags: episodic update failed for %s: %s", doc_id, _e)


_safari_lock = threading.Lock()


def _ensure_safari_seen_table() -> None:
    """Idempotently create the safari_seen table for ambient ingest dedup."""
    from harness.memory import episodic
    with episodic._connect() as conn:  # noqa: SLF001
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS safari_seen (
                url        TEXT NOT NULL,
                host       TEXT NOT NULL,
                first_seen TEXT NOT NULL,
                PRIMARY KEY (url, host)
            )
            """
        )


_ensure_safari_seen_table()


def _ingest_safari_payload(
    host: str,
    history_items: list,
    tabs: list,
) -> tuple[int, int]:
    """Dedupe and write ambient_safari events. Returns (ingested, deduped)."""
    from datetime import UTC, datetime

    from harness.memory import episodic

    with _safari_lock:
        now_iso = datetime.now(UTC).isoformat()
        ingested = 0
        deduped = 0
        novel_items: list[dict] = []

        # Pass 1: determine novel URLs and commit safari_seen inserts before any
        # episodic writes. Commit and explicitly close before Pass 2 to release
        # the WAL exclusive-writer slot so the episodic writes don't deadlock.
        # Use episodic._connect() to ensure consistent pragma setup (journal_mode=WAL,
        # busy_timeout=5000, etc.) instead of raw sqlite3.connect().
        with episodic._connect() as conn_p1:  # noqa: SLF001
            for item in history_items:
                if not isinstance(item, dict):
                    continue
                url = str(item.get("url", ""))[:500]
                title = str(item.get("title", ""))[:300]
                visit_ts = str(item.get("visit_ts", now_iso))[:64]
                if not url:
                    continue
                cur = conn_p1.execute(
                    "SELECT 1 FROM safari_seen WHERE url = ? AND host = ?",
                    (url, host),
                )
                if cur.fetchone():
                    deduped += 1
                    continue
                conn_p1.execute(
                    "INSERT INTO safari_seen (url, host, first_seen) VALUES (?, ?, ?)",
                    (url, host, now_iso),
                )
                novel_items.append({"url": url, "title": title, "visit_ts": visit_ts})
                ingested += 1

        # Pass 2: episodic writes after the raw conn is closed and its lock released.
        for novel in novel_items:
            episodic.log_event(
                "ambient_safari",
                {"url": novel["url"], "title": novel["title"],
                 "visit_ts": novel["visit_ts"], "host": host, "kind": "history"},
                session="ambient",
            )

        # Tabs are written every pulse (snapshot of "what's open right now") but
        # only as a single rolling event per host so morning brief can read the
        # latest snapshot without scanning all history.
        if tabs:
            tab_payload = []
            for tab in tabs[:50]:
                if not isinstance(tab, dict):
                    continue
                tab_payload.append({
                    "url": str(tab.get("url", ""))[:500],
                    "title": str(tab.get("title", ""))[:300],
                })
            episodic.log_event(
                "ambient_safari_tabs",
                {"host": host, "tabs": tab_payload, "captured_at": now_iso},
                session="ambient",
            )

        return ingested, deduped


def _embed_query(query: str) -> list[float] | None:
    """Embed a query string using the Ollama embed model. Returns None on failure."""
    try:
        import ollama
        embed_host = os.environ.get(
            "OLLAMA_EMBED_HOST", os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434")
        )
        client = ollama.Client(host=embed_host, timeout=10.0)
        resp = client.embeddings(model="nomic-embed-text", prompt=query)
        return list(resp["embedding"])
    except Exception:
        return None


def _cold_archive_search(query: str, limit: int = 5) -> list[dict]:
    """Search cold Parquet archives on the NAS for ``query``.

    Uses cosine similarity when embedding vectors are present in the Parquet
    schema (entries archived after the vector schema was introduced). Falls
    back to ILIKE substring search for older schema-less entries or when
    Ollama is unreachable.

    Returns an empty list if NAS is not mounted, duckdb is not installed,
    or no archive files exist yet. Never raises — callers treat this as
    best-effort enrichment.
    """
    try:
        import duckdb

        from harness.consolidation import _load_integrations_config

        cfg = _load_integrations_config()
        raw_path = cfg.get("cold_archive_path", "")
        if not raw_path:
            return []
        archive_root = Path(raw_path).expanduser()
        if not archive_root.parent.exists() or not archive_root.exists():
            return []
        parquet_glob = str(archive_root / "**" / "*.parquet")

        # Prefer vector search; fall back to substring if embedding unavailable.
        query_vec = _embed_query(query)

        con = duckdb.connect()
        try:
            if query_vec is not None:
                # Vector path: cosine similarity over stored embeddings.
                # Rows without embeddings (old schema) are excluded by the WHERE clause
                # but caught by the ILIKE fallback below if they exist.
                rows = con.execute(
                    "SELECT chroma_id, text, source, stored_at, confidence, "
                    "list_cosine_similarity(embedding, ?) AS score "
                    "FROM read_parquet(?, union_by_name=true) "  # noqa: S608
                    "WHERE embedding IS NOT NULL "
                    "ORDER BY score DESC "
                    "LIMIT ?",
                    [query_vec, parquet_glob, limit],
                ).fetchall()
                # If no rows had embeddings, fall through to ILIKE.
                if not rows:
                    query_vec = None
            if query_vec is None:
                rows = con.execute(
                    "SELECT chroma_id, text, source, stored_at, confidence, NULL AS score "
                    "FROM read_parquet(?, union_by_name=true) "  # noqa: S608
                    "WHERE text ILIKE ? "
                    "ORDER BY stored_at DESC "
                    "LIMIT ?",
                    [parquet_glob, f"%{query}%", limit],
                ).fetchall()
        finally:
            con.close()

        return [
            {
                "chroma_id": r[0],
                "text": r[1],
                "source": r[2],
                "stored_at": r[3],
                "confidence": r[4],
                "cold_archive": True,
            }
            for r in rows
        ]
    except Exception:
        return []


class Handler(BaseHTTPRequestHandler):
    def log_message(self, _fmt: str, *_args: object) -> None:  # pyright: ignore[reportUnusedParameter]
        pass  # suppress default access log noise

    def _send_json(self, code: int, body: dict) -> None:
        payload = json.dumps(body).encode()
        try:
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _read_body(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length > 0 else b"{}"
        return json.loads(raw)

    def _parse_int(
        self, value: object, default: int, name: str, lo: int, hi: int
    ) -> int | None:
        """Coerce an HTTP-supplied value to a bounded int. Sends 400 and returns
        None on failure; caller must check and bail."""
        raw = default if value is None else value
        try:
            v = int(raw)  # type: ignore[arg-type]  # HTTP value is str|int at runtime; object annotation is intentionally broad
        except (TypeError, ValueError):
            self._send_json(400, {"error": f"{name} must be an integer"})
            return None
        if v < lo or v > hi:
            self._send_json(400, {"error": f"{name} must be between {lo} and {hi}"})
            return None
        return v

    def do_GET(self) -> None:
        if self.path == "/health":
            self._handle_health()
        elif self.path.startswith("/list"):
            self._handle_list_get()
        elif self.path == "/stats":
            self._handle_stats()
        elif self.path == "/integrity":
            self._handle_integrity()
        elif self.path == "/probe":
            self._handle_probe()
        elif self.path.startswith("/topology"):
            self._handle_topology()
        else:
            self._send_json(404, {"error": "not found"})

    def _handle_integrity(self) -> None:
        """Memory-integrity snapshot (jarvis#811a). Computed in-process where the
        chroma client is already loaded, so callers (health-probe) don't pay a
        chromadb import every cycle. Surfaces the invariant the supersede/TTL fix
        (#803/#822) guards: active meta rows == live vectors, FTS covers them.

        dangling_active should sit at 0; a non-zero/rising value means a delete
        path is again leaving meta rows without vectors. fts_coverage_pct < 100
        means FTS writes are being skipped (the drift that hid for weeks)."""
        try:
            from harness.memory import episodic

            s = store()
            live_ids: set[str] = set()
            per_collection: dict[str, int] = {}
            for col in s._client.list_collections():
                ids = (col.get(include=[]).get("ids")) or []
                per_collection[col.name] = len(ids)
                live_ids.update(ids)

            with episodic._connect() as conn:
                active = conn.execute(
                    "SELECT chroma_id FROM memories_meta "
                    "WHERE superseded_by IS NULL OR superseded_by = ''"
                ).fetchall()
                superseded_n = conn.execute(
                    "SELECT count(*) FROM memories_meta "
                    "WHERE superseded_by IS NOT NULL AND superseded_by != ''"
                ).fetchone()[0]
                fts_rows = conn.execute("SELECT count(*) FROM memories_fts").fetchone()[0]

            active_n = len(active)
            dangling = sum(1 for (cid,) in active if cid not in live_ids)
            live_n = len(live_ids)
            coverage = round(100.0 * fts_rows / live_n, 1) if live_n else 0.0
            self._send_json(
                200,
                {
                    "status": "ok",
                    "active_meta": active_n,
                    "live_vectors": live_n,
                    "dangling_active": dangling,
                    "superseded": superseded_n,
                    "fts_rows": fts_rows,
                    "fts_coverage_pct": coverage,
                    "per_collection": per_collection,
                },
            )
        except Exception as exc:
            self._send_json(503, {"status": "error", "detail": str(exc)})

    def _handle_health(self) -> None:
        """Honest health probe: confirms the singleton is constructed, ChromaDB's
        persistent client is reachable, AND the Ollama embedding endpoint
        responds. Returns 503 if any component fails -- previously embeddings
        could be down (e.g. ollama-embed daemon dead) while /health still
        reported 200, masking a fully-broken recall path."""
        try:
            s = store()
            s._client.heartbeat()
        except Exception as exc:
            self._send_json(503, {"status": "error", "component": "chromadb", "detail": str(exc)})
            return
        try:
            s._ef(["health-probe"])
        except Exception as exc:
            self._send_json(
                503,
                {"status": "error", "component": "ollama-embed", "detail": str(exc)},
            )
            return
        self._send_json(200, {"status": "ok"})

    def _handle_probe(self) -> None:
        """GET /probe -- per-dependency latency for observability.

        Times ChromaDB, the Ollama embedding endpoint, and Neo4j/Graphiti
        connectivity independently (the clients are already loaded in-process,
        so the 60s host-health probe never has to import chromadb or neo4j).
        Each component is measured in isolation: a failure yields ms=None and
        ok=False for that component but never fails the whole response. Always
        returns 200 -- the caller reads per-component ok flags."""
        result: dict[str, object] = {}

        # ChromaDB: persistent-client heartbeat round-trip.
        t0 = time.monotonic()
        try:
            store()._client.heartbeat()
            result["chroma_ms"] = round((time.monotonic() - t0) * 1000, 1)
            result["chroma_ok"] = True
        except Exception as exc:
            result["chroma_ms"] = None
            result["chroma_ok"] = False
            result["chroma_error"] = str(exc)

        # Ollama embedding endpoint: single tiny embed.
        t0 = time.monotonic()
        try:
            store()._ef(["probe"])
            result["embed_ms"] = round((time.monotonic() - t0) * 1000, 1)
            result["embed_ok"] = True
        except Exception as exc:
            result["embed_ms"] = None
            result["embed_ok"] = False
            result["embed_error"] = str(exc)

        # Neo4j / Graphiti: connectivity check (skipped when graph disabled).
        if graph_client.is_enabled():
            t0 = time.monotonic()
            try:
                ok = graph_client.ping()
                result["graph_ms"] = (
                    round((time.monotonic() - t0) * 1000, 1) if ok else None
                )
                result["graph_ok"] = bool(ok)
            except Exception as exc:
                result["graph_ms"] = None
                result["graph_ok"] = False
                result["graph_error"] = str(exc)
        else:
            result["graph_ms"] = None
            result["graph_ok"] = None  # null == not applicable (disabled)

        self._send_json(200, result)

    def do_POST(self) -> None:
        try:
            body = self._read_body()
        except Exception as exc:
            self._send_json(400, {"error": f"bad request: {exc}"})
            return

        if self.path == "/recall":
            self._handle_recall(body)
        elif self.path == "/recall_meta":
            self._handle_recall_meta(body)
        elif self.path == "/remember":
            self._handle_remember(body)
        elif self.path == "/forget":
            self._handle_forget(body)
        elif self.path == "/consolidate":
            self._handle_consolidate(body)
        elif self.path == "/vault_export":
            self._handle_vault_export()
        elif self.path == "/matters/create":
            self._handle_matters_create(body)
        elif self.path == "/matters/list":
            self._handle_matters_list(body)
        elif self.path == "/matters/show":
            self._handle_matters_show(body)
        elif self.path == "/matters/add-item":
            self._handle_matters_add_item(body)
        elif self.path == "/matters/close":
            self._handle_matters_close(body)
        elif self.path == "/ambient/safari":
            self._handle_ambient_safari(body)
        elif self.path == "/cold-archive/recall":
            self._handle_cold_archive_recall(body)
        elif self.path == "/graph/ingest":
            self._handle_graph_ingest(body)
        elif self.path == "/graph/recall":
            self._handle_graph_recall(body)
        elif self.path == "/graph/reset-circuit":
            self._handle_graph_reset_circuit()
        else:
            self._send_json(404, {"error": "not found"})

    def _handle_recall(self, body: dict) -> None:
        query = body.get("query", "")
        if not query:
            self._send_json(400, {"error": "query required"})
            return

        collection = body.get("collection", "user_profile")
        n = self._parse_int(body.get("n"), default=5, name="n", lo=1, hi=100)
        if n is None:
            return

        # #433: forward goal_ids so goal-conditioned recall filters correctly.
        goal_ids_raw = body.get("goal_ids")
        goal_ids = goal_ids_raw if isinstance(goal_ids_raw, list) else None

        t0 = time.monotonic()
        try:
            results = store().recall(query, collection=collection, n=n, goal_ids=goal_ids)
            elapsed_ms = round((time.monotonic() - t0) * 1000, 2)

            # FTS5 fallback: when hot recall returns nothing and Ollama is unreachable,
            # use full-text search so existing ChromaDB data is still reachable.
            # This prevents a GPU-contention window (gemma3:27b swap) from producing
            # zero memory context when the data is there. Collection is passed
            # explicitly per convention (raw fts_search bypasses collection filtering).
            if not results and _embed_query(query) is None:
                try:
                    from harness.memory import episodic as _ep
                    fts_query = " ".join(
                        f'"{w}"' for w in query.replace('"', "").split() if w
                    )
                    fts_hits = _ep.fts_search(fts_query, collection=collection, limit=n)
                    superseded = _ep.superseded_ids(collection=collection)
                    results = [
                        h["content"] for h in fts_hits
                        if h["chroma_id"] not in superseded
                    ]
                except Exception:
                    pass  # FTS fallback is best-effort; empty is the safe failure mode

            # Cold archive fallback: when hot recall returns nothing, search Parquet
            # shards on the NAS so older retired memories remain reachable.
            cold_results: list[dict] = []
            if not results:
                cold_results = _cold_archive_search(query, limit=n)

            self._send_json(200, {
                "results": results,
                "elapsed_ms": elapsed_ms,
                **({"cold_archive": cold_results} if cold_results else {}),
            })
        except Exception as exc:
            self._send_json(500, {"error": str(exc)})

    def _handle_recall_meta(self, body: dict) -> None:
        """POST /recall_meta — return recall results with provenance metadata.

        Same query path as /recall, but each result includes source, confidence,
        age_days, and an archived flag so the prompt pipeline can group items
        by user-stated vs inferred and surface age in the system prompt.
        """
        query = body.get("query", "")
        if not query:
            self._send_json(400, {"error": "query required"})
            return

        collection = body.get("collection", "user_profile")
        n = self._parse_int(body.get("n"), default=5, name="n", lo=1, hi=100)
        if n is None:
            return

        # #433: forward goal_ids so goal-conditioned recall_with_ids filters correctly.
        goal_ids_raw = body.get("goal_ids")
        goal_ids = goal_ids_raw if isinstance(goal_ids_raw, list) else None

        t0 = time.monotonic()
        try:
            from datetime import UTC
            from datetime import datetime as _dt

            from harness.memory import episodic
            pairs = store().recall_with_ids(query, collection=collection, n=n, goal_ids=goal_ids)
            now = _dt.now(UTC)
            results: list[dict] = []
            for chroma_id, text in pairs:
                archived = text.startswith("[archive] ")
                display_text = text[len("[archive] "):] if archived else text
                meta = episodic.get_memory_meta(chroma_id) or {}
                source = str(meta.get("source", "unknown"))
                confidence_raw = meta.get("confidence")
                confidence = (
                    float(confidence_raw) if isinstance(confidence_raw, (int, float)) else 0.5
                )
                created_at = meta.get("created_at")
                age_days: int | None = None
                if isinstance(created_at, str) and created_at:
                    try:
                        age = (now - _dt.fromisoformat(created_at)).total_seconds() / 86400.0
                        age_days = max(0, int(age))
                    except (ValueError, TypeError):
                        age_days = None
                results.append({
                    "text": display_text,
                    "source": source,
                    "confidence": confidence,
                    "age_days": age_days,
                    "archived": archived,
                })
            elapsed_ms = round((time.monotonic() - t0) * 1000, 2)
            self._send_json(200, {"results": results, "elapsed_ms": elapsed_ms})
        except Exception as exc:
            self._send_json(500, {"error": str(exc)})

    def _handle_ambient_safari(self, body: dict) -> None:
        """POST /ambient/safari — ingest Safari history + open-tab signals.

        Body schema: {host: str, history: [{url, title, visit_ts}],
                      tabs: [{url, title}]}
        Dedupes against safari_seen (per-URL+host), writes ambient_safari rows
        into agent_events for the morning brief to aggregate.
        """
        host = str(body.get("host", "unknown"))
        history_items = body.get("history") or []
        tabs = body.get("tabs") or []
        if not isinstance(history_items, list) or not isinstance(tabs, list):
            self._send_json(400, {"error": "history and tabs must be arrays"})
            return
        try:
            from harness.memory import episodic
            ingested, deduped = _ingest_safari_payload(host, history_items, tabs)
            episodic.log_event(
                "ambient_safari_pulse",
                {"host": host, "ingested": ingested, "deduped": deduped,
                 "tabs": len(tabs)},
                session="ambient",
            )
            self._send_json(200, {"ingested": ingested, "deduped": deduped})
        except Exception as exc:
            _log.warning("ambient_safari ingest failed: %s", exc)
            self._send_json(500, {"error": str(exc)})

    def _handle_remember(self, body: dict) -> None:
        if isinstance(body, str):
            try:
                body = json.loads(body)
            except json.JSONDecodeError as e:
                self._send_json(400, {"error": f"Invalid JSON body: {e}"})
                return
        if not isinstance(body, dict):
            self._send_json(400, {"error": "body must be a JSON object"})
            return
        text = body.get("text", "")
        if not text:
            self._send_json(400, {"error": "text required"})
            return

        collection = body.get("collection", "knowledge")
        source = body.get("source", "jarvis-ts")
        source_actor = body.get("source_actor", "jarvis_inference")
        metadata = body.get("metadata") or None
        # #433: extract goal_id so it is forwarded to VectorStore.remember()
        # and stored as ChromaDB metadata for goal-conditioned recall.
        goal_id_raw = body.get("goal_id")
        goal_id = str(goal_id_raw) if goal_id_raw else None

        ttl_days_raw = body.get("ttl_days")
        ttl_days = None
        if ttl_days_raw is not None:
            try:
                ttl_days = int(ttl_days_raw)
                if ttl_days <= 0:
                    ttl_days = None
            except (TypeError, ValueError):
                ttl_days = None

        try:
            # defer_tags=True: skip the slow LLM tagger so the response goes
            # back within the Node.js 3-second timeout. Tag generation runs in
            # a background daemon thread and backfills the stored entry.
            doc_id = store().remember(
                text,
                collection=collection,
                source=source,
                source_actor=source_actor,
                metadata=metadata,
                defer_tags=True,
                goal_id=goal_id,
                ttl_days=ttl_days,
            )
            self._send_json(200, {"id": doc_id})
        except ValueError as exc:
            self._send_json(422, {"error": str(exc)})
            return
        except Exception as exc:
            self._send_json(500, {"error": str(exc)})
            return

        if _backfill_semaphore.acquire(blocking=False):
            threading.Thread(
                target=_backfill_tags,
                args=(doc_id, text, collection),
                daemon=True,
            ).start()
        else:
            # Issue #222: instead of silently dropping, add to a bounded queue so
            # the backfill is attempted once a semaphore slot becomes free.
            with _backfill_queue_lock:
                if len(_backfill_queue) < _BACKFILL_QUEUE_MAX:
                    _backfill_queue.append((doc_id, text, collection))
                    _log.debug(
                        "backfill_tags: semaphore full, queued %s (depth %d)",
                        doc_id, len(_backfill_queue),
                    )
                else:
                    _log.warning(
                        "backfill_tags: queue at capacity (%d), dropping backfill for %s",
                        _BACKFILL_QUEUE_MAX, doc_id,
                    )
                    from harness.memory import episodic
                    episodic.log_event(
                        "backfill_dropped",
                        {"doc_id": doc_id, "collection": collection,
                         "queue_max": _BACKFILL_QUEUE_MAX},
                        session="ambient",
                    )


    def _handle_forget(self, body: dict) -> None:
        text = body.get("text", "")
        if not text:
            self._send_json(400, {"error": "text required"})
            return

        collection = body.get("collection", "knowledge")

        try:
            # Find the closest match by content, then delete by ID.
            pairs = store().recall_with_ids(text, collection=collection, n=1, recency_boost=False)
            if not pairs:
                self._send_json(200, {"deleted": False, "reason": "no match found"})
                return
            doc_id, _ = pairs[0]
            store().forget(doc_id, collection=collection)
            self._send_json(200, {"deleted": True, "id": doc_id})
        except Exception as exc:
            self._send_json(500, {"error": str(exc)})


    def _handle_list_get(self) -> None:
        """GET /list?collection=knowledge&limit=20 -- return recent entries."""
        from urllib.parse import parse_qs, urlparse

        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)
        collection = (params.get("collection") or ["knowledge"])[0]
        limit_raw = (params.get("limit") or [None])[0]
        limit = self._parse_int(limit_raw, default=20, name="limit", lo=1, hi=200)
        if limit is None:
            return

        try:
            entries = store().list_entries(collection=collection, limit=limit)
            self._send_json(200, {
                "collection": collection,
                "entries": [
                    {
                        "id": e.id,
                        "text": e.text[:200],
                        "source": e.source,
                        "stored_at": e.stored_at,
                    }
                    for e in entries
                ],
            })
        except Exception as exc:
            self._send_json(500, {"error": str(exc)})

    def _handle_stats(self) -> None:
        """GET /stats -- return top recall hit counts."""
        try:
            stats = consolidation.recall_stats(n=20)
            self._send_json(200, {"hits": stats})
        except Exception as exc:
            self._send_json(500, {"error": str(exc)})

    def _handle_topology(self) -> None:
        """GET /topology?hours=6 -- staff-dispatch topology for Grafana Infinity node-graph.

        Returns nodes and edges for all subagent_dispatch events in the requested
        time window. The root node (jarvis) is always present. Each dispatched agent
        appears as a staff node with an edge from jarvis. mainStat is dispatch count.

        Query params:
            hours (int, 1-168, default 6): look-back window.

        Response shape (Grafana Infinity node-graph contract):
            {
              "nodes": [
                {"id": "jarvis", "title": "Jarvis", "subTitle": "chief of staff",
                 "mainStat": <total>, "detail__role": "root"},
                {"id": "<agent>", "title": "<agent>", "subTitle": "staff",
                 "mainStat": <count>, "detail__role": "staff"},
                ...
              ],
              "edges": [
                {"id": "jarvis-><agent>", "source": "jarvis", "target": "<agent>",
                 "mainStat": <count>},
                ...
              ]
            }
        """
        from urllib.parse import parse_qs, urlparse

        from harness.memory import episodic

        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)
        hours_raw = (params.get("hours") or [None])[0]
        try:
            hours = max(1, min(168, int(hours_raw))) if hours_raw is not None else 6
        except (TypeError, ValueError):
            hours = 6
        fmt = (params.get("format") or [None])[0]

        try:
            with episodic._connect() as conn:  # noqa: SLF001
                rows = conn.execute(
                    """
                    SELECT json_extract(detail, '$.name') AS agent, COUNT(*) AS n
                    FROM agent_events
                    WHERE event = 'subagent_dispatch'
                      AND ts >= datetime('now', ?)
                      AND json_extract(detail, '$.name') IS NOT NULL
                    GROUP BY agent
                    ORDER BY n DESC
                    """,
                    (f"-{hours} hours",),
                ).fetchall()
        except Exception as exc:
            self._send_json(500, {"error": str(exc)})
            return

        nodes: list[dict] = []
        edges: list[dict] = []
        total = 0

        for agent, count in rows:
            if not agent:
                continue
            n = int(count)
            total += n
            nodes.append({
                "id": agent,
                "title": agent,
                "subTitle": "staff",
                "mainStat": n,
                "detail__role": "staff",
            })
            edges.append({
                "id": f"jarvis->{agent}",
                "source": "jarvis",
                "target": agent,
                "mainStat": n,
            })

        # Graphviz panel (grafana-graphviz-panel, Query mode) consumes a DOT
        # string column. Render the same data as a themed top-down dispatch tree.
        if fmt == "dot":
            maxc = max((nd["mainStat"] for nd in nodes), default=1) or 1

            def _esc(s: object) -> str:
                return str(s).replace("\\", "\\\\").replace('"', '\\"')

            dot = [
                "digraph jarvis {",
                '  rankdir=TB; bgcolor="transparent"; pad=0.3; nodesep=0.35; ranksep=0.6;',
                '  node [style="filled,rounded", shape=box, fontname="Helvetica",'
                ' fontcolor="#e6edf3", color="#2a2d3a", fontsize=11];',
                '  edge [color="#3a3f4b", fontcolor="#8b949e", fontname="Helvetica", fontsize=9];',
                f'  "jarvis" [label="Jarvis\\n{total} dispatches", shape=doublecircle,'
                ' fillcolor="#00d4ff", fontcolor="#0f1117"];',
            ]
            for nd in nodes:
                nm = _esc(nd["id"])
                dot.append(f'  "{nm}" [label="{nm}\\n{nd["mainStat"]}", fillcolor="#1f6feb"];')
            for nd in nodes:
                nm = _esc(nd["id"])
                pw = 1.0 + 4.0 * (nd["mainStat"] / maxc)
                dot.append(f'  "jarvis" -> "{nm}" [penwidth={pw:.1f}, label="{nd["mainStat"]}"];')
            dot.append("}")
            self._send_json(200, {"dot": "\n".join(dot)})
            return

        root_node: dict = {
            "id": "jarvis",
            "title": "Jarvis",
            "subTitle": "chief of staff",
            "mainStat": total,
            "detail__role": "root",
        }
        self._send_json(200, {"nodes": [root_node] + nodes, "edges": edges})

    def _handle_vault_export(self) -> None:
        """POST /vault_export -- return all three collections for human-readable export.

        Returns entries with full text, stored_at, and confidence (from episodic).
        Superseded entries are excluded. Sorted newest first, up to 2000 per collection.
        """
        from harness.memory import episodic

        COLLECTIONS = [
            ("user_profile", "Personal Profile"),
            ("knowledge", "Knowledge"),
            ("agent_memories", "Agent Memories"),
        ]
        LIMIT = 2000
        result: dict[str, list[dict]] = {}
        try:
            for col_name, _title in COLLECTIONS:
                sup_ids = episodic.superseded_ids(col_name)
                entries = store().list_entries(collection=col_name, limit=LIMIT)
                rows: list[dict] = []
                for e in entries:
                    if e.id in sup_ids:
                        continue
                    meta = episodic.get_memory_meta(e.id) or {}
                    confidence_raw = meta.get("confidence")
                    confidence = (
                        float(confidence_raw)
                        if isinstance(confidence_raw, (int, float))
                        else None
                    )
                    rows.append({
                        "id": e.id,
                        "text": e.text,
                        "stored_at": e.stored_at,
                        "confidence": confidence,
                    })
                result[col_name] = rows
            self._send_json(200, {"collections": result})
        except Exception as exc:
            self._send_json(500, {"error": str(exc)})

    def _handle_matters_create(self, body: dict) -> None:
        """POST /matters/create -- create a new matter."""
        from harness.memory import episodic

        name = body.get("name", "").strip()
        if not name:
            self._send_json(400, {"error": "name required"})
            return
        description = body.get("description", "")
        try:
            matter_id = episodic.create_matter(name, description)
            self._send_json(200, {"id": matter_id, "name": name})
        except Exception as exc:
            self._send_json(500, {"error": str(exc)})

    def _handle_matters_list(self, body: dict) -> None:
        """POST /matters/list -- list matters, optionally filtered by status."""
        from harness.memory import episodic

        status = body.get("status") or None
        try:
            matters = episodic.list_matters(status=status)
            self._send_json(200, {"matters": matters})
        except Exception as exc:
            self._send_json(500, {"error": str(exc)})

    def _handle_matters_show(self, body: dict) -> None:
        """POST /matters/show -- return a matter and its items."""
        from harness.memory import episodic

        matter_id = body.get("matter_id", "").strip()
        if not matter_id:
            self._send_json(400, {"error": "matter_id required"})
            return
        try:
            matter = episodic.get_matter(matter_id)
            if not matter:
                self._send_json(404, {"error": "matter not found"})
                return
            items = episodic.list_matter_items(matter_id)
            self._send_json(200, {"matter": matter, "items": items})
        except Exception as exc:
            self._send_json(500, {"error": str(exc)})

    def _handle_matters_add_item(self, body: dict) -> None:
        """POST /matters/add-item -- add an item to a matter."""
        from harness.memory import episodic

        matter_id = body.get("matter_id", "").strip()
        item_type = body.get("item_type", "").strip()
        item_ref = body.get("item_ref", "").strip()
        if not matter_id or not item_type or not item_ref:
            self._send_json(400, {"error": "matter_id, item_type, and item_ref required"})
            return
        try:
            item_id = episodic.add_matter_item(matter_id, item_type, item_ref)
            self._send_json(200, {"id": item_id})
        except Exception as exc:
            self._send_json(500, {"error": str(exc)})

    def _handle_matters_close(self, body: dict) -> None:
        """POST /matters/close -- close an open matter."""
        from harness.memory import episodic

        matter_id = body.get("matter_id", "").strip()
        if not matter_id:
            self._send_json(400, {"error": "matter_id required"})
            return
        try:
            closed = episodic.close_matter(matter_id)
            self._send_json(200, {"closed": closed})
        except Exception as exc:
            self._send_json(500, {"error": str(exc)})

    def _handle_cold_archive_recall(self, body: dict) -> None:
        """POST /cold-archive/recall -- full-text search across cold Parquet archives on NAS.

        Body: {"query": "search terms", "limit": 10}
        Returns: {"results": [{"chroma_id", "text", "source", "stored_at", "confidence"}]}
        Skips silently if NAS path is not mounted or no Parquet files exist.
        """
        query = body.get("query", "").strip()
        if not query:
            self._send_json(400, {"error": "query required"})
            return

        limit = 10
        if "limit" in body:
            try:
                limit = max(1, min(50, int(body["limit"])))
            except (TypeError, ValueError):
                pass

        try:
            from harness.consolidation import _load_integrations_config

            cfg = _load_integrations_config()
            raw_path = cfg.get("cold_archive_path", "")
            if not raw_path:
                self._send_json(200, {"results": [], "note": "cold_archive_path not configured"})
                return

            archive_root = Path(raw_path).expanduser()
            if not archive_root.parent.exists():
                self._send_json(200, {"results": [], "note": "NAS not mounted"})
                return
            if not archive_root.exists():
                self._send_json(200, {"results": [], "note": "No cold archives yet"})
                return

            results = _cold_archive_search(query, limit=limit)
            self._send_json(200, {"results": results})
        except Exception as exc:
            self._send_json(500, {"error": str(exc)})

    def _handle_graph_ingest(self, body: dict) -> None:
        """POST /graph/ingest -- fire-and-forget episode ingestion into Graphiti.

        Body: {"text": "...", "name": "episode-slug", "group_id": "jarvis"}
        Returns 202 immediately; add_episode() runs in a background daemon thread.
        Silently no-ops when graphiti.enabled is false.
        Returns 503 when the org monthly quota circuit is open.
        """
        global _graph_quota_exhausted, _graph_quota_exhausted_at
        if not graph_client.is_enabled():
            self._send_json(200, {"status": "disabled"})
            return

        if _graph_quota_exhausted:
            with _graph_quota_exhausted_lock:
                if (
                    _graph_quota_exhausted
                    and time.time() - _graph_quota_exhausted_at > _QUOTA_AUTO_RESET_SECS
                ):
                    _graph_quota_exhausted = False
                    _log.info(
                        "graph_ingest: auto-reset quota circuit after 24h -- attempting ingest"
                    )
            if _graph_quota_exhausted:  # still open after attempted reset
                _log.warning(
                    "graph_ingest: circuit open (quota exhausted); skipping %r",
                    body.get("name"),
                )
                self._send_json(
                    503, {"error": "org monthly quota exhausted; graph ingest suspended"}
                )
                return

        if _graph_rate_limited_until > 0 and time.time() < _graph_rate_limited_until:
            remaining = int(_graph_rate_limited_until - time.time())
            _log.debug(
                "graph_ingest: rate-limit backoff active (%ds remaining); skipping %r",
                remaining,
                body.get("name"),
            )
            self._send_json(503, {"error": f"rate limited; graph ingest paused for {remaining}s"})
            return

        text = body.get("text", "").strip()
        if not text:
            self._send_json(400, {"error": "text required"})
            return

        # #729: guard against None values that graphiti-core would render as the
        # string "None" in entity names, polluting the knowledge graph.
        name_raw = body.get("name")
        name = (
            str(name_raw) if name_raw and str(name_raw) != "None" else None
        ) or f"ep-{int(time.time())}"
        group_id_raw = body.get("group_id")
        group_id = (str(group_id_raw) if group_id_raw and str(group_id_raw) != "None" else None)

        # #767: optional originating-turn time for graphiti valid_at. Parse an
        # ISO-8601 string; on absence or malformed input, leave None so
        # graph.ingest() defaults to now(UTC).
        ref_time = None
        ref_raw = body.get("reference_time")
        if ref_raw and str(ref_raw) != "None":
            from datetime import datetime as _dt

            try:
                ref_time = _dt.fromisoformat(str(ref_raw))
            except ValueError:
                _log.warning("graph_ingest: ignoring malformed reference_time %r", ref_raw)

        def _bg() -> None:
            global _graph_quota_exhausted, _graph_quota_exhausted_at, _graph_rate_limited_until
            with _graph_ingest_semaphore:
                if _graph_quota_exhausted or (
                    _graph_rate_limited_until > 0 and time.time() < _graph_rate_limited_until
                ):
                    return
                try:
                    graph_client.ingest(text, name=name, group_id=group_id, reference_time=ref_time)
                except graph_client.QuotaExhaustedError as exc:
                    with _graph_quota_exhausted_lock:
                        if not _graph_quota_exhausted:
                            _graph_quota_exhausted = True
                            _graph_quota_exhausted_at = time.time()
                            _log.error(
                                "graph_ingest: org monthly quota exhausted - circuit open. "
                                "Graph memory will not be populated until the vec-server restarts "
                                "after the quota resets. Error: %s",
                                exc,
                            )
                            try:
                                from harness.memory import episodic as _ep
                                _ep.log_event(
                                    "inbox_item",
                                    {
                                        "text": (
                                            "Graph memory suspended: Claude org monthly "
                                            "usage limit hit. Graph ingest circuit is open "
                                            "-- no new entities will be stored until "
                                            "vec-server restarts after the quota resets."
                                        ),
                                        "source": "graph_ingest",
                                    },
                                    session="surface_to_inbox",
                                )
                            except Exception as _notify_exc:
                                _log.warning("graph_ingest: inbox notify failed: %s", _notify_exc)
                except graph_client.RateLimitError as exc:
                    # Transient rate limit after all retries exhausted. Open a timed
                    # backoff window rather than the permanent quota circuit. Ingest
                    # resumes automatically once the window expires.
                    with _graph_rate_limited_lock:
                        resume_at = time.time() + _GRAPH_RATE_LIMIT_BACKOFF_SECS
                        _graph_rate_limited_until = resume_at
                    _log.warning(
                        "graph_ingest: rate limited after retries for %r -- pausing ingest "
                        "for %ds (resumes ~%s). Error: %s",
                        name,
                        _GRAPH_RATE_LIMIT_BACKOFF_SECS,
                        time.strftime("%H:%M:%S", time.localtime(resume_at)),
                        exc,
                    )
                except Exception as exc:
                    _log.warning(
                        "graph_ingest: failed for %r: %s: %s",
                        name,
                        type(exc).__name__,
                        exc or "(empty)",
                    )

        threading.Thread(target=_bg, daemon=True).start()
        self._send_json(202, {"status": "queued", "name": name})

    def _handle_graph_reset_circuit(self) -> None:
        """POST /graph/reset-circuit -- manually clear the quota and rate-limit circuits.

        Localhost only; used when the Anthropic billing cycle resets mid-process-lifetime.
        """
        global _graph_quota_exhausted, _graph_quota_exhausted_at, _graph_rate_limited_until
        with _graph_quota_exhausted_lock:
            _graph_quota_exhausted = False
            _graph_quota_exhausted_at = 0.0
        with _graph_rate_limited_lock:
            _graph_rate_limited_until = 0.0
        _log.info("graph_ingest: circuits manually reset via /graph/reset-circuit")
        self._send_json(200, {"status": "reset"})

    def _handle_graph_recall(self, body: dict) -> None:
        """POST /graph/recall -- entity-edge search via Graphiti.

        Body: {"query": "...", "group_id": "jarvis", "n": 10}
        Returns: {"results": [{"fact", "source_node", "target_node", "created_at", "valid_at"}]}
        Returns empty list when graphiti.enabled is false.
        """
        if not graph_client.is_enabled():
            self._send_json(200, {"results": []})
            return

        query = body.get("query", "").strip()
        if not query:
            self._send_json(400, {"error": "query required"})
            return

        n = self._parse_int(body.get("n"), default=10, name="n", lo=1, hi=50)
        if n is None:
            return

        group_id = body.get("group_id") or None
        as_of = body.get("as_of")  # optional ISO datetime string

        try:
            results = graph_client.recall(query, group_id=group_id, n=n, as_of=as_of)
            self._send_json(200, {"results": results})
        except Exception as exc:
            self._send_json(500, {"error": str(exc)})

    def _handle_consolidate(self, body: dict) -> None:
        """POST /consolidate -- run all four consolidation jobs."""
        dry_run = bool(body.get("dry_run", False))
        try:
            result = consolidation.run_all(store())
            if dry_run:
                cold_candidates = consolidation.archive_to_cold(store(), dry_run=True)
            else:
                cold_candidates = None
        except Exception as exc:
            self._send_json(500, {"error": str(exc)})
            return
        response: dict = {
            "sessions_summarized": result.sessions_summarized,
            "cross_session_facts": result.cross_session_facts_stored,
            "preferences_merged": result.preferences_merged,
            "entries_archived": result.entries_archived,
            "errors": result.errors,
        }
        if dry_run:
            response["dry_run"] = True
            response["cold_archive_candidates"] = cold_candidates
        payload = json.dumps(response).encode()
        try:
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            pass


def main() -> None:
    port = 9876
    # Eager construction so a broken backend fails loudly at boot rather than
    # serving a misleading 200 on /health while the first real request blows up.
    try:
        store()
        from harness.memory import episodic as _ep
        _ep.init_db()
    except Exception as exc:
        _log.error("vector-store: failed to construct VectorStore: %s", exc)
        sys.exit(1)
    bind_host = os.environ.get("VEC_BIND_HOST", "127.0.0.1")
    server = ThreadingHTTPServer((bind_host, port), Handler)
    server.daemon_threads = True
    # Startup confirmation goes to stdout (vector.log), not the WARNING-level error stream.
    print(f"vector-store: listening on http://{bind_host}:{port}", file=sys.stdout, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    server.server_close()


if __name__ == "__main__":
    main()
