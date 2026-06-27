"""Episodic memory — structured conversation history in SQLite."""
from __future__ import annotations

import json
import logging
import os
import sqlite3
import uuid
from collections.abc import Generator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path

log = logging.getLogger(__name__)


def _db_path() -> str:
    raw = os.environ.get("AGENT_DATA_DIR", "~/.jarvis")
    path = Path(raw).expanduser()
    path.mkdir(parents=True, exist_ok=True)
    return str(path / "conversations.db")


@contextmanager
def _connect() -> Generator[sqlite3.Connection, None, None]:
    """Open a SQLite connection, yield it, commit on success, always close.

    busy_timeout=5000 gives writers 5s to wait through a competing write
    instead of failing immediately with `database is locked` -- previously
    the threaded vec-server handlers could collide on remember/log_event.
    journal_mode=WAL is set once in init_db() and persists for the file.

    Explicit close in finally prevents fd exhaustion under launchd, which
    inherits a low ulimit-n and cannot rely on GC to reclaim WAL handles.
    """
    conn = sqlite3.connect(_db_path())
    conn.execute("PRAGMA busy_timeout = 5000")
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> None:
    """Create tables if they don't exist."""
    with _connect() as conn:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA synchronous = NORMAL")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS messages (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                session   TEXT    NOT NULL,
                role      TEXT    NOT NULL,
                content   TEXT    NOT NULL,
                ts        TEXT    NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS agent_events (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                session   TEXT    NOT NULL,
                event     TEXT    NOT NULL,
                detail    TEXT,
                ts        TEXT    NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS actions (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                action        TEXT    NOT NULL,
                tier          TEXT    NOT NULL,
                payload       TEXT,
                state         TEXT    NOT NULL DEFAULT 'Proposed',
                rollback_data TEXT,
                ts            TEXT    NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS memories_meta (
                chroma_id        TEXT PRIMARY KEY,
                confidence       REAL    NOT NULL DEFAULT 1.0,
                trust_score      REAL    NOT NULL DEFAULT 1.0,
                source           TEXT    NOT NULL DEFAULT 'manual',
                collection       TEXT    NOT NULL DEFAULT 'knowledge',
                tags             TEXT    NOT NULL DEFAULT '[]',
                created_at       TEXT    NOT NULL,
                last_accessed_at TEXT,
                access_count     INTEGER NOT NULL DEFAULT 0,
                superseded_by    TEXT,
                contradicts      TEXT,
                ttl_days         INTEGER
            )
        """)
        conn.execute("""
            CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
            USING fts5(chroma_id UNINDEXED, collection UNINDEXED, content,
                       tokenize='porter ascii')
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS goals (
                id                INTEGER PRIMARY KEY AUTOINCREMENT,
                intent            TEXT    NOT NULL,
                cadence           TEXT    NOT NULL DEFAULT 'daily',
                owner_staff_id    TEXT    NOT NULL,
                status            TEXT    NOT NULL DEFAULT 'proposed',
                budget_tool_calls INTEGER NOT NULL DEFAULT 5,
                budget_minutes    INTEGER NOT NULL DEFAULT 30,
                last_run_at       TEXT,
                next_run_at       TEXT,
                created_at        TEXT    NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS goal_runs (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                goal_id      INTEGER NOT NULL REFERENCES goals(id),
                started_at   TEXT    NOT NULL,
                completed_at TEXT,
                iterations   INTEGER NOT NULL DEFAULT 0,
                status       TEXT    NOT NULL DEFAULT 'running',
                result_text  TEXT,
                error        TEXT
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS perf_metrics (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                phase      TEXT    NOT NULL,
                latency_ms REAL    NOT NULL,
                session    TEXT    NOT NULL DEFAULT 'default',
                metadata   TEXT,
                created_at TEXT    NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS processed_mail (
                source           TEXT    NOT NULL,
                message_id       TEXT    NOT NULL,
                uid              TEXT,
                folder           TEXT,
                ingested_at      TEXT    NOT NULL,
                triage_decision  TEXT,
                fact_count       INTEGER NOT NULL DEFAULT 0,
                tier             TEXT    NOT NULL DEFAULT 'knowledge',
                message_date     TEXT,
                PRIMARY KEY (source, message_id)
            )
        """)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_processed_mail_ingested "
            "ON processed_mail (ingested_at)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_perf_phase ON perf_metrics (phase, created_at)"
        )
        # Hot-path indexes. All queries that filter by these columns scan the
        # whole table without these. Idempotent via IF NOT EXISTS so existing
        # databases pick them up on next init.
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages (session, id)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_agent_events_session_event_id "
            "ON agent_events (session, event, id)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_agent_events_event_ts "
            "ON agent_events (event, ts)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_actions_state ON actions (state, ts)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_goals_status_next ON goals (status, next_run_at)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_goal_runs_goal_id ON goal_runs (goal_id, started_at)"
        )
        # Partial index for superseded_ids() -- runs on every recall to filter
        # out soft-deleted memories. Without this, every recall scans
        # memories_meta. Partial form keeps the index tiny since the vast
        # majority of rows have superseded_by IS NULL.
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_memories_meta_superseded "
            "ON memories_meta (collection, superseded_by) "
            "WHERE superseded_by IS NOT NULL"
        )
        conn.execute("""
            CREATE TABLE IF NOT EXISTS external_actions_audit (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                goal_id      INTEGER NOT NULL REFERENCES goals(id),
                goal_run_id  INTEGER NOT NULL REFERENCES goal_runs(id),
                intent       TEXT    NOT NULL,
                result_text  TEXT,
                started_at   TEXT    NOT NULL,
                completed_at TEXT
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS processed_imessages (
                guid            TEXT PRIMARY KEY,
                rowid           INTEGER,
                sender          TEXT,
                processed_at    TEXT NOT NULL,
                triage_decision TEXT
            )
        """)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_external_audit_goal_id "
            "ON external_actions_audit (goal_id, started_at)"
        )
        conn.execute("""
            CREATE TABLE IF NOT EXISTS matters (
                id          TEXT PRIMARY KEY,
                name        TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                created_at  TEXT NOT NULL,
                status      TEXT NOT NULL DEFAULT 'open'
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS matter_items (
                id          TEXT PRIMARY KEY,
                matter_id   TEXT NOT NULL REFERENCES matters(id),
                item_type   TEXT NOT NULL,
                item_ref    TEXT NOT NULL,
                added_at    TEXT NOT NULL
            )
        """)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_matter_items_matter_id "
            "ON matter_items (matter_id)"
        )
        # Schema migration: add source_actor and keywords columns (idempotent)
        for ddl in [
            (
                "ALTER TABLE memories_meta ADD COLUMN source_actor "
                "TEXT NOT NULL DEFAULT 'jarvis_inference'"
            ),
            "ALTER TABLE memories_meta ADD COLUMN keywords TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE goals ADD COLUMN goal_type TEXT NOT NULL DEFAULT 'write'",
            # Auto-retry-with-cap for autonomy goals (TS-owned logic; mirrored here
            # so a Python-created DB carries the column too).
            (
                "ALTER TABLE goals ADD COLUMN consecutive_failures "
                "INTEGER NOT NULL DEFAULT 0"
            ),
            # Bi-temporal validity (#82): when the fact was true vs. when we believed it
            "ALTER TABLE memories_meta ADD COLUMN valid_from TEXT",
            "ALTER TABLE memories_meta ADD COLUMN valid_until TEXT",
            "ALTER TABLE memories_meta ADD COLUMN known_from TEXT",
            "ALTER TABLE memories_meta ADD COLUMN known_until TEXT",
            # TTL support (#144): mark entries with explicit expiration dates
            "ALTER TABLE memories_meta ADD COLUMN ttl_days INTEGER",
        ]:
            try:
                conn.execute(ddl)
            except sqlite3.OperationalError:
                pass  # column already exists
        conn.commit()


def log_message(role: str, content: str, session: str = "default") -> int:
    """Insert a message row and return its id so callers can correlate turns."""
    with _connect() as conn:
        cursor = conn.execute(
            "INSERT INTO messages (session, role, content, ts) VALUES (?, ?, ?, ?)",
            (session, role, content, datetime.now(UTC).isoformat()),
        )
        conn.commit()
        return cursor.lastrowid or 0


def recent_messages(n: int = 10, session: str = "default") -> list[dict]:
    """Return the last n messages for a session, oldest first."""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT role, content, ts FROM messages WHERE session = ? ORDER BY id DESC LIMIT ?",
            (session, n),
        ).fetchall()
    return [{"role": r[0], "content": r[1], "ts": r[2]} for r in reversed(rows)]


def recent_messages_all_sessions(n: int = 100) -> list[dict]:
    """Return the last n messages across all sessions, oldest first."""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT role, content, ts FROM messages ORDER BY id DESC LIMIT ?",
            (n,),
        ).fetchall()
    return [{"role": r[0], "content": r[1], "ts": r[2]} for r in reversed(rows)]


def log_event(
    event: str,
    detail: str | dict | None = None,
    session: str = "default",
) -> int:
    """Insert an event row and return its id. Detail may be a string or a JSON-serializable dict."""
    if isinstance(detail, dict):
        detail = json.dumps(detail)
    with _connect() as conn:
        cursor = conn.execute(
            "INSERT INTO agent_events (session, event, detail, ts) VALUES (?, ?, ?, ?)",
            (session, event, detail, datetime.now(UTC).isoformat()),
        )
        conn.commit()
        return cursor.lastrowid or 0


def last_event(session: str, event_type: str) -> dict | None:
    """Return the most recent event of the given type for a session, or None."""
    with _connect() as conn:
        row = conn.execute(
            "SELECT id, event, detail, ts FROM agent_events "
            "WHERE session = ? AND event = ? ORDER BY id DESC LIMIT 1",
            (session, event_type),
        ).fetchone()
    if not row:
        return None
    return _row_to_event(row)


def events_since(event_id: int, session: str, event_type: str | None = None) -> list[dict]:
    """Return events with id > event_id for a session, oldest first."""
    with _connect() as conn:
        if event_type:
            rows = conn.execute(
                "SELECT id, event, detail, ts FROM agent_events "
                "WHERE session = ? AND event = ? AND id > ? ORDER BY id ASC",
                (session, event_type, event_id),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT id, event, detail, ts FROM agent_events "
                "WHERE session = ? AND id > ? ORDER BY id ASC",
                (session, event_id),
            ).fetchall()
    return [_row_to_event(r) for r in rows]


def recent_events(
    event_type: str | None = None,
    n: int = 10,
    session: str | None = None,
) -> list[dict]:
    """Return the last n events, newest first. Optionally filter by event_type and session."""
    with _connect() as conn:
        if event_type and session:
            rows = conn.execute(
                "SELECT id, event, detail, ts FROM agent_events "
                "WHERE event = ? AND session = ? ORDER BY id DESC LIMIT ?",
                (event_type, session, n),
            ).fetchall()
        elif event_type:
            rows = conn.execute(
                "SELECT id, event, detail, ts FROM agent_events "
                "WHERE event = ? ORDER BY id DESC LIMIT ?",
                (event_type, n),
            ).fetchall()
        elif session:
            rows = conn.execute(
                "SELECT id, event, detail, ts FROM agent_events "
                "WHERE session = ? ORDER BY id DESC LIMIT ?",
                (session, n),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT id, event, detail, ts FROM agent_events ORDER BY id DESC LIMIT ?",
                (n,),
            ).fetchall()
    return [_row_to_event(r) for r in rows]


def messages_since(turn_id: int, session: str = "default") -> list[dict]:
    """Return messages with id > turn_id for a session, oldest first."""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT id, role, content, ts FROM messages "
            "WHERE session = ? AND id > ? ORDER BY id ASC",
            (session, turn_id),
        ).fetchall()
    return [{"id": r[0], "role": r[1], "content": r[2], "ts": r[3]} for r in rows]


def known_sessions() -> list[str]:
    """Return distinct session names ever logged. Used by daemon startup scan."""
    with _connect() as conn:
        rows = conn.execute("SELECT DISTINCT session FROM messages").fetchall()
    return [r[0] for r in rows]


def messages_in_window(window_days: int = 7) -> dict[str, list[dict]]:
    """Return messages per session from the last window_days, oldest-first per session."""
    cutoff_ts = (datetime.now(UTC) - timedelta(days=window_days)).isoformat()
    with _connect() as conn:
        rows = conn.execute(
            "SELECT session, role, content, ts FROM messages WHERE ts > ? ORDER BY id ASC",
            (cutoff_ts,),
        ).fetchall()
    result: dict[str, list[dict]] = {}
    for session, role, content, ts in rows:
        result.setdefault(session, []).append({"role": role, "content": content, "ts": ts})
    return result


def delete_messages_before(session: str, cutoff_ts: str) -> int:
    """Delete messages for a session older than cutoff_ts. Returns count deleted."""
    with _connect() as conn:
        cursor = conn.execute(
            "DELETE FROM messages WHERE session = ? AND ts < ?",
            (session, cutoff_ts),
        )
        conn.commit()
        return cursor.rowcount


def recalled_ids_in_window(window_days: int = 90) -> set[str]:
    """Return all doc IDs that appeared in a recall_hit event in the last window_days.

    Used by decay_knowledge to determine which entries are active.
    """
    cutoff_ts = (datetime.now(UTC) - timedelta(days=window_days)).isoformat()
    with _connect() as conn:
        rows = conn.execute(
            "SELECT detail FROM agent_events WHERE event = 'recall_hit' AND ts > ?",
            (cutoff_ts,),
        ).fetchall()
    recalled: set[str] = set()
    for (detail_str,) in rows:
        if not detail_str:
            continue
        try:
            detail = json.loads(detail_str)
            ids = detail.get("ids") or []
            recalled.update(str(i) for i in ids)
        except (json.JSONDecodeError, AttributeError):
            continue
    return recalled


def propose_action(action: str, tier: str, payload: dict | None = None) -> int:
    """Insert a Proposed action row and return its id."""
    payload_json = json.dumps(payload) if payload else None
    with _connect() as conn:
        cursor = conn.execute(
            "INSERT INTO actions (action, tier, payload, state, ts)"
            " VALUES (?, ?, ?, 'Proposed', ?)",
            (action, tier, payload_json, datetime.now(UTC).isoformat()),
        )
        conn.commit()
        return cursor.lastrowid or 0


def resolve_action(
    action_id: int,
    state: str,
    rollback_data: dict | None = None,
) -> None:
    """Update action state. state must be one of: Approved, Executed, Rejected, RolledBack."""
    rollback_json = json.dumps(rollback_data) if rollback_data else None
    with _connect() as conn:
        conn.execute(
            "UPDATE actions SET state = ?, rollback_data = ? WHERE id = ?",
            (state, rollback_json, action_id),
        )
        conn.commit()


def get_action(action_id: int) -> dict | None:
    """Return an action row by id, or None if not found."""
    with _connect() as conn:
        row = conn.execute(
            "SELECT id, action, tier, payload, state, rollback_data, ts FROM actions WHERE id = ?",
            (action_id,),
        ).fetchone()
    return _row_to_action(row) if row else None


def pending_actions() -> list[dict]:
    """Return all Proposed actions, oldest first."""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT id, action, tier, payload, state, rollback_data, ts FROM actions "
            "WHERE state = 'Proposed' ORDER BY id ASC",
        ).fetchall()
    return [_row_to_action(r) for r in rows]


def _row_to_action(row: tuple) -> dict:
    rid, action, tier, payload, state, rollback_data, ts = row
    return {
        "id": rid,
        "action": action,
        "tier": tier,
        "payload": json.loads(payload) if payload else None,
        "state": state,
        "rollback_data": json.loads(rollback_data) if rollback_data else None,
        "ts": ts,
    }


def _row_to_event(row: tuple) -> dict:
    rid, event, detail, ts = row
    parsed_detail: str | dict | None = detail
    if detail and isinstance(detail, str):
        try:
            parsed_detail = json.loads(detail)
        except (json.JSONDecodeError, ValueError):
            parsed_detail = detail
    return {"id": rid, "event": event, "detail": parsed_detail, "ts": ts}


# ---------------------------------------------------------------------------
# Provenance — memories_meta + FTS5
# ---------------------------------------------------------------------------


def upsert_memory_meta(
    chroma_id: str,
    confidence: float = 1.0,
    trust_score: float = 1.0,
    source: str = "manual",
    collection: str = "knowledge",
    tags: list[str] | None = None,
    source_actor: str = "jarvis_inference",
    keywords: str = "",
    created_at: str | None = None,
    valid_from: str | None = None,
    valid_until: str | None = None,
    known_from: str | None = None,
    known_until: str | None = None,
    ttl_days: int | None = None,
) -> None:
    """Insert or update a memories_meta row. Does not touch access_count or superseded_by.

    Pass created_at to preserve the original content date (e.g. email received_at) rather
    than defaulting to ingest time. Used by bulk mail ingestion to keep age_days accurate.

    Bi-temporal columns (all optional):
      valid_from/valid_until: when the fact was true in the real world.
      known_from/known_until: when Jarvis believed the fact (defaults to created_at/NULL).

    ttl_days (optional): when set, this entry will expire and be pruned after ttl_days
    have elapsed since created_at. Used for ephemeral sources like RSS feeds.
    """
    tags_json = json.dumps(tags or [])
    timestamp = created_at if created_at else datetime.now(UTC).isoformat()
    kf = known_from if known_from else timestamp
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO memories_meta
                (chroma_id, confidence, trust_score, source, collection, tags, created_at,
                 source_actor, keywords, valid_from, valid_until, known_from, known_until,
                 ttl_days)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(chroma_id) DO UPDATE SET
                confidence=excluded.confidence,
                trust_score=excluded.trust_score,
                source=excluded.source,
                collection=excluded.collection,
                tags=excluded.tags,
                source_actor=excluded.source_actor,
                keywords=excluded.keywords,
                valid_from=COALESCE(excluded.valid_from, valid_from),
                valid_until=COALESCE(excluded.valid_until, valid_until),
                known_from=COALESCE(excluded.known_from, known_from),
                known_until=COALESCE(excluded.known_until, known_until),
                ttl_days=COALESCE(excluded.ttl_days, ttl_days)
            """,
            (chroma_id, confidence, trust_score, source, collection, tags_json, timestamp,
             source_actor, keywords, valid_from, valid_until, kf, known_until, ttl_days),
        )
        conn.commit()


# Column order is shared by get_memory_meta and get_memory_meta_bulk so the
# two never drift; _row_to_meta maps a row tuple in this exact order to a dict.
_MEMORY_META_COLUMNS = (
    "chroma_id, confidence, trust_score, source, collection, tags, "
    "created_at, last_accessed_at, access_count, superseded_by, contradicts, "
    "source_actor, keywords, valid_from, valid_until, known_from, known_until, "
    "ttl_days"
)

# Max chroma_ids per IN(...) clause. SQLite's default variable limit is 999 on
# older builds; 500 stays well under it while keeping the round-trip count low.
_BULK_META_CHUNK = 500


def _row_to_meta(row: tuple) -> dict:
    """Map a memories_meta row (in _MEMORY_META_COLUMNS order) to a dict."""
    return {
        "chroma_id": row[0],
        "confidence": row[1],
        "trust_score": row[2],
        "source": row[3],
        "collection": row[4],
        "tags": json.loads(row[5]) if row[5] else [],
        "created_at": row[6],
        "last_accessed_at": row[7],
        "access_count": row[8],
        "superseded_by": row[9],
        "contradicts": row[10],
        "source_actor": row[11] if len(row) > 11 else "jarvis_inference",
        "keywords": row[12] if len(row) > 12 else "",
        "valid_from": row[13] if len(row) > 13 else None,
        "valid_until": row[14] if len(row) > 14 else None,
        "known_from": row[15] if len(row) > 15 else None,
        "known_until": row[16] if len(row) > 16 else None,
        "ttl_days": row[17] if len(row) > 17 else None,
    }


def get_memory_meta(chroma_id: str) -> dict | None:
    """Return the memories_meta row for chroma_id, or None if not found."""
    with _connect() as conn:
        row = conn.execute(
            f"SELECT {_MEMORY_META_COLUMNS} FROM memories_meta WHERE chroma_id = ?",
            (chroma_id,),
        ).fetchone()
    return _row_to_meta(row) if row else None


def get_memory_meta_bulk(chroma_ids: list[str]) -> dict[str, dict]:
    """Return {chroma_id: meta} for the given ids in a single connection.

    Batch form of get_memory_meta: one _connect() and one SELECT per chunk of
    up to _BULK_META_CHUNK ids, instead of a connection-open + single-row query
    per id. Ids with no row are simply absent from the result. Used by the
    consolidation decay/TTL loops, which previously called get_memory_meta once
    per entry over up to 1000 entries.
    """
    if not chroma_ids:
        return {}
    out: dict[str, dict] = {}
    with _connect() as conn:
        for start in range(0, len(chroma_ids), _BULK_META_CHUNK):
            chunk = chroma_ids[start : start + _BULK_META_CHUNK]
            placeholders = ",".join("?" * len(chunk))
            rows = conn.execute(
                f"SELECT {_MEMORY_META_COLUMNS} FROM memories_meta "
                f"WHERE chroma_id IN ({placeholders})",
                chunk,
            ).fetchall()
            for row in rows:
                out[row[0]] = _row_to_meta(row)
    return out


def bump_access(chroma_id: str) -> None:
    """Increment access_count and update last_accessed_at. Lazy-creates a row for legacy entries."""
    now = datetime.now(UTC).isoformat()
    with _connect() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO memories_meta "
            "(chroma_id, confidence, trust_score, source, collection,"
            " tags, created_at, access_count) "
            "VALUES (?, 0.5, 1.0, 'legacy', 'knowledge', '[]', ?, 0)",
            (chroma_id, now),
        )
        conn.execute(
            "UPDATE memories_meta SET access_count = access_count + 1, last_accessed_at = ? "
            "WHERE chroma_id = ?",
            (now, chroma_id),
        )
        conn.commit()


def decay_confidence(chroma_id: str, delta: float = 0.05) -> float:
    """Decrement confidence by delta (floor 0.0). Returns new confidence value."""
    with _connect() as conn:
        conn.execute(
            "UPDATE memories_meta SET confidence = MAX(0.0, confidence - ?) WHERE chroma_id = ?",
            (delta, chroma_id),
        )
        row = conn.execute(
            "SELECT confidence FROM memories_meta WHERE chroma_id = ?",
            (chroma_id,),
        ).fetchone()
        conn.commit()
    return float(row[0]) if row else 0.0


def set_superseded(chroma_id: str, superseded_by: str = "decay") -> None:
    """Mark a memory as superseded. Superseded entries are excluded from default recall."""
    with _connect() as conn:
        conn.execute(
            "UPDATE memories_meta SET superseded_by = ? WHERE chroma_id = ?",
            (superseded_by, chroma_id),
        )
        conn.commit()


def set_contradicts(chroma_id: str, contradicts_id: str) -> None:
    """Record that ``chroma_id`` (the kept entry) contradicts ``contradicts_id`` (the
    archived one). jarvis#807: the contradicts column was defined but never populated,
    so contradiction provenance was invisible. Populated by the consolidation pass."""
    with _connect() as conn:
        conn.execute(
            "UPDATE memories_meta SET contradicts = ? WHERE chroma_id = ?",
            (contradicts_id, chroma_id),
        )
        conn.commit()


def mark_superseded_if_unset(chroma_ids: list[str], superseded_by: str = "forgotten") -> int:
    """Mark memories superseded ONLY where not already superseded. Returns rows updated.

    Called by the ``forget*`` delete paths (jarvis#803) so deleting a vector never
    leaves a dangling 'active' (superseded_by IS NULL) meta row. Crucially this does
    NOT overwrite an existing reason -- e.g. the decay path sets superseded_by='decay'
    before _archive_entry calls forget(), and that label must survive.
    """
    ids = [c for c in chroma_ids if c]
    if not ids:
        return 0
    placeholders = ",".join("?" * len(ids))
    with _connect() as conn:
        cur = conn.execute(
            f"UPDATE memories_meta SET superseded_by = ? "  # noqa: S608 - placeholders are count-built, values bound
            f"WHERE chroma_id IN ({placeholders}) "
            f"AND (superseded_by IS NULL OR superseded_by = '')",
            (superseded_by, *ids),
        )
        conn.commit()
        return cur.rowcount


def superseded_ids(collection: str = "knowledge") -> set[str]:
    """Return chroma_ids that have been superseded (soft-deleted). Used to filter recall results."""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT chroma_id FROM memories_meta "
            "WHERE superseded_by IS NOT NULL AND collection = ?",
            (collection,),
        ).fetchall()
    return {r[0] for r in rows}


def beliefs_at(
    dt: datetime,
    collection: str = "knowledge",
) -> list[str]:
    """Return chroma_ids of memories Jarvis believed to be true at the given datetime.

    A memory qualifies if all four conditions hold:
    - known_from <= dt  (we had recorded it by then; NULL means "always known")
    - known_until is NULL or known_until > dt  (we still believed it then)
    - valid_from is NULL or valid_from <= dt   (the fact was valid in the real world then)
    - valid_until is NULL or valid_until > dt  (the fact had not yet expired)

    Superseded entries are excluded. Use this for historical queries:
    "What did Jarvis believe about X on 2026-03-15?"
    """
    dt_iso = dt.isoformat()
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT chroma_id FROM memories_meta
            WHERE collection = ?
              AND superseded_by IS NULL
              AND (known_from IS NULL OR known_from <= ?)
              AND (known_until IS NULL OR known_until > ?)
              AND (valid_from IS NULL OR valid_from <= ?)
              AND (valid_until IS NULL OR valid_until > ?)
            """,
            (collection, dt_iso, dt_iso, dt_iso, dt_iso),
        ).fetchall()
    return [r[0] for r in rows]


def index_memory(chroma_id: str, collection: str, content: str) -> None:
    """Insert or replace a memory in the FTS5 index."""
    with _connect() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO memories_fts (chroma_id, collection, content) VALUES (?, ?, ?)",
            (chroma_id, collection, content),
        )
        conn.commit()


def fts_search(query: str, collection: str | None = None, limit: int = 10) -> list[dict]:
    """Full-text search over stored memories. Returns list of {chroma_id, content} dicts."""
    with _connect() as conn:
        if collection:
            rows = conn.execute(
                "SELECT f.chroma_id, f.content "
                "FROM memories_fts f "
                "LEFT JOIN memories_meta m ON f.chroma_id = m.chroma_id "
                "WHERE memories_fts MATCH ? AND f.collection = ? "
                "AND (m.superseded_by IS NULL OR m.chroma_id IS NULL) "
                "ORDER BY rank LIMIT ?",
                (query, collection, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT f.chroma_id, f.content "
                "FROM memories_fts f "
                "LEFT JOIN memories_meta m ON f.chroma_id = m.chroma_id "
                "WHERE memories_fts MATCH ? "
                "AND (m.superseded_by IS NULL OR m.chroma_id IS NULL) "
                "ORDER BY rank LIMIT ?",
                (query, limit),
            ).fetchall()
    return [{"chroma_id": r[0], "content": r[1]} for r in rows]


def delete_fts_memory(chroma_id: str) -> None:
    """Remove a memory from the FTS5 index."""
    with _connect() as conn:
        conn.execute("DELETE FROM memories_fts WHERE chroma_id = ?", (chroma_id,))
        conn.commit()


def fts_missing_ids(collection: str = "knowledge", limit: int = 500) -> list[str]:
    """chroma_ids that are active in memories_meta but absent from memories_fts.

    jarvis#836: the FTS write in remember() is fail-silent, so a transient failure
    orphans a fact from FTS recall permanently. This reconstructs the backfill
    work-list from existing tables (no separate retry queue needed). Superseded
    rows are excluded -- they were deliberately removed from FTS.
    """
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT m.chroma_id FROM memories_meta m
            WHERE m.collection = ?
              AND m.superseded_by IS NULL
              AND NOT EXISTS (
                  SELECT 1 FROM memories_fts f WHERE f.chroma_id = m.chroma_id
              )
            LIMIT ?
            """,
            (collection, limit),
        ).fetchall()
    return [r[0] for r in rows]


def cold_archive_candidates(cutoff_ts: str) -> list[dict]:
    """Return archive-collection entries eligible for cold Parquet export.

    Criteria: collection='archive', access_count=0, created_at < cutoff_ts,
    superseded_by IS NULL.
    Returns list of dicts with keys: chroma_id, collection, created_at, confidence.
    """
    with _connect() as conn:
        rows = conn.execute(
            "SELECT chroma_id, collection, created_at, confidence "
            "FROM memories_meta "
            "WHERE collection = 'archive' "
            "  AND access_count = 0 "
            "  AND created_at < ? "
            "  AND superseded_by IS NULL",
            (cutoff_ts,),
        ).fetchall()
    return [
        {"chroma_id": r[0], "collection": r[1], "created_at": r[2], "confidence": r[3]}
        for r in rows
    ]


def orphaned_meta_candidates(confidence_max: float, cutoff_ts: str) -> list[str]:
    """Return chroma_ids of orphaned memories_meta rows eligible for deletion.

    Criteria: superseded_by IS NOT NULL, confidence < confidence_max,
    access_count = 0, created_at < cutoff_ts.
    These rows no longer have a corresponding ChromaDB entry; deleting them
    cleans up the metadata table without touching ChromaDB.
    """
    with _connect() as conn:
        rows = conn.execute(
            "SELECT chroma_id FROM memories_meta "
            "WHERE superseded_by IS NOT NULL "
            "  AND confidence < ? "
            "  AND access_count = 0 "
            "  AND created_at < ?",
            (confidence_max, cutoff_ts),
        ).fetchall()
    return [r[0] for r in rows]


def delete_memory_meta(chroma_id: str) -> None:
    """Delete a memories_meta row and its FTS5 entry."""
    with _connect() as conn:
        conn.execute("DELETE FROM memories_meta WHERE chroma_id = ?", (chroma_id,))
        conn.execute("DELETE FROM memories_fts WHERE chroma_id = ?", (chroma_id,))
        conn.commit()


def tag_match(query_tokens: list[str], collection: str = "knowledge", limit: int = 5) -> list[str]:
    """Return chroma_ids whose tags or keywords overlap with any query token.

    Used as Stage 1 pre-filter before FTS5/vector recall. Returns at most ``limit``
    IDs from non-superseded rows in the given collection.
    """
    if not query_tokens:
        return []
    conditions = " OR ".join("(tags LIKE ? OR keywords LIKE ?)" for _ in query_tokens)
    str_params: list[str] = []
    for token in query_tokens:
        str_params.extend([f"%{token}%", f"%{token}%"])
    str_params.append(collection)
    with _connect() as conn:
        rows = conn.execute(
            f"SELECT chroma_id FROM memories_meta "  # noqa: S608
            f"WHERE ({conditions}) AND collection = ? AND superseded_by IS NULL "
            f"LIMIT ?",
            (*str_params, limit),
        ).fetchall()
    return [row[0] for row in rows]


# ---------------------------------------------------------------------------
# Goals + goal runs (W4 always-on autonomy)
# ---------------------------------------------------------------------------


def create_goal(
    intent: str,
    owner_staff_id: str,
    cadence: str = "daily",
    budget_tool_calls: int = 5,
    budget_minutes: int = 30,
) -> int:
    """Insert a new goal row with status='proposed'. Returns the new goal id."""
    now = datetime.now(UTC).isoformat()
    with _connect() as conn:
        cursor = conn.execute(
            "INSERT INTO goals "
            "(intent, cadence, owner_staff_id, status,"
            " budget_tool_calls, budget_minutes, created_at)"
            " VALUES (?, ?, ?, 'proposed', ?, ?, ?)",
            (intent, cadence, owner_staff_id, budget_tool_calls, budget_minutes, now),
        )
        conn.commit()
        return cursor.lastrowid or 0


def get_goal(goal_id: int) -> dict | None:
    """Return a goal row by id, or None if not found."""
    with _connect() as conn:
        row = conn.execute(
            "SELECT id, intent, cadence, owner_staff_id, status, budget_tool_calls, "
            "budget_minutes, last_run_at, next_run_at, created_at, goal_type "
            "FROM goals WHERE id = ?",
            (goal_id,),
        ).fetchone()
    return _row_to_goal(row) if row else None


def list_goals(status: str | None = None) -> list[dict]:
    """Return all goals, optionally filtered by status. Ordered by id ASC."""
    with _connect() as conn:
        if status:
            rows = conn.execute(
                "SELECT id, intent, cadence, owner_staff_id, status, budget_tool_calls, "
                "budget_minutes, last_run_at, next_run_at, created_at, goal_type "
                "FROM goals WHERE status = ? ORDER BY id ASC",
                (status,),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT id, intent, cadence, owner_staff_id, status, budget_tool_calls, "
                "budget_minutes, last_run_at, next_run_at, created_at, goal_type "
                "FROM goals ORDER BY id ASC",
            ).fetchall()
    return [_row_to_goal(r) for r in rows]


def update_goal(goal_id: int, **fields: str | int | None) -> None:
    """Update arbitrary columns on a goal row. Only known columns are written."""
    allowed = {
        "intent", "cadence", "owner_staff_id", "status",
        "budget_tool_calls", "budget_minutes", "last_run_at", "next_run_at",
        "goal_type",
    }
    updates = {k: v for k, v in fields.items() if k in allowed}
    if not updates:
        return
    set_clause = ", ".join(f"{k} = ?" for k in updates)
    values = list(updates.values()) + [goal_id]
    with _connect() as conn:
        conn.execute(f"UPDATE goals SET {set_clause} WHERE id = ?", values)  # noqa: S608
        conn.commit()


def goals_due_now() -> list[dict]:
    """Return active goals whose next_run_at is NULL or <= now (UTC)."""
    now = datetime.now(UTC).isoformat()
    with _connect() as conn:
        rows = conn.execute(
            "SELECT id, intent, cadence, owner_staff_id, status, budget_tool_calls, "
            "budget_minutes, last_run_at, next_run_at, created_at, goal_type "
            "FROM goals WHERE status = 'active' "
            "AND (next_run_at IS NULL OR next_run_at <= ?)"
            "ORDER BY id ASC",
            (now,),
        ).fetchall()
    return [_row_to_goal(r) for r in rows]


def log_goal_run(goal_id: int) -> int:
    """Insert a new goal_run row with status='running'. Returns the run id."""
    now = datetime.now(UTC).isoformat()
    with _connect() as conn:
        cursor = conn.execute(
            "INSERT INTO goal_runs (goal_id, started_at, status) VALUES (?, ?, 'running')",
            (goal_id, now),
        )
        conn.commit()
        return cursor.lastrowid or 0


def update_goal_run(
    run_id: int,
    status: str,
    iterations: int = 0,
    result_text: str | None = None,
    error: str | None = None,
) -> None:
    """Mark a goal_run as completed or blocked."""
    now = datetime.now(UTC).isoformat()
    with _connect() as conn:
        conn.execute(
            "UPDATE goal_runs SET status=?, iterations=?, result_text=?, error=?, completed_at=? "
            "WHERE id=?",
            (status, iterations, result_text, error, now, run_id),
        )
        conn.commit()


def goal_runs_today(window_hours: int = 24) -> int:
    """Return the count of goal runs started within the last window_hours."""
    cutoff = (datetime.now(UTC) - timedelta(hours=window_hours)).isoformat()
    with _connect() as conn:
        row = conn.execute(
            "SELECT COUNT(*) FROM goal_runs WHERE started_at >= ?",
            (cutoff,),
        ).fetchone()
    return int(row[0]) if row else 0


def last_message_ts() -> str | None:
    """Return the ISO timestamp of the most recent message across all sessions, or None."""
    with _connect() as conn:
        row = conn.execute(
            "SELECT ts FROM messages ORDER BY id DESC LIMIT 1",
        ).fetchone()
    return row[0] if row else None


def _row_to_goal(row: tuple) -> dict:
    (
        rid, intent, cadence, owner, status, budget_calls,
        budget_mins, last_run, next_run, created, goal_type,
    ) = row
    return {
        "id": rid,
        "intent": intent,
        "cadence": cadence,
        "owner_staff_id": owner,
        "status": status,
        "budget_tool_calls": budget_calls,
        "budget_minutes": budget_mins,
        "last_run_at": last_run,
        "next_run_at": next_run,
        "created_at": created,
        "goal_type": goal_type,
    }


def log_external_audit(
    goal_id: int,
    goal_run_id: int,
    intent: str,
    started_at: str,
    result_text: str | None = None,
    completed_at: str | None = None,
) -> int:
    """Insert an external_actions_audit row. Returns the new row id."""
    with _connect() as conn:
        cur = conn.execute(
            "INSERT INTO external_actions_audit "
            "(goal_id, goal_run_id, intent, result_text, started_at, completed_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (goal_id, goal_run_id, intent, result_text, started_at, completed_at),
        )
        conn.commit()
        return cur.lastrowid or 0


def update_external_audit(audit_id: int, result_text: str, completed_at: str) -> None:
    """Update result_text and completed_at on an external_actions_audit row."""
    with _connect() as conn:
        conn.execute(
            "UPDATE external_actions_audit SET result_text = ?, completed_at = ? WHERE id = ?",
            (result_text, completed_at, audit_id),
        )
        conn.commit()


# ---------------------------------------------------------------------------
# Performance metrics (W6)
# ---------------------------------------------------------------------------


def record_perf(
    phase: str,
    latency_ms: float,
    session: str = "default",
    metadata: dict | None = None,
) -> None:
    """Record a latency measurement for a named phase.

    Silently swallows all errors -- perf recording must never break a user turn.
    """
    try:
        meta_json = json.dumps(metadata) if metadata else None
        with _connect() as conn:
            conn.execute(
                "INSERT INTO perf_metrics (phase, latency_ms, session, metadata, created_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (phase, latency_ms, session, meta_json, datetime.now(UTC).isoformat()),
            )
            conn.commit()
    except Exception:
        log.debug("record_perf failed", exc_info=True)


def perf_summary(
    phase: str | None = None,
    since_hours: int = 24,
) -> list[dict]:
    """Return P50/P95/P99 latency stats per phase for the given window.

    When phase is None, returns stats for all phases. Results are sorted by
    phase name for stable output.
    """
    cutoff = (datetime.now(UTC) - timedelta(hours=since_hours)).isoformat()
    with _connect() as conn:
        if phase:
            rows = conn.execute(
                "SELECT phase, latency_ms FROM perf_metrics "
                "WHERE phase = ? AND created_at >= ? ORDER BY latency_ms",
                (phase, cutoff),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT phase, latency_ms FROM perf_metrics "
                "WHERE created_at >= ? ORDER BY phase, latency_ms",
                (cutoff,),
            ).fetchall()

    from collections import defaultdict
    buckets: dict[str, list[float]] = defaultdict(list)
    for p, ms in rows:
        buckets[p].append(ms)

    results = []
    for p in sorted(buckets):
        vals = buckets[p]
        n = len(vals)
        results.append({
            "phase": p,
            "count": n,
            "p50_ms": _percentile(vals, 50),
            "p95_ms": _percentile(vals, 95),
            "p99_ms": _percentile(vals, 99),
        })
    return results


def _percentile(sorted_vals: list[float], pct: int) -> float:
    """Return the pct-th percentile of a sorted list. Returns 0.0 for empty lists."""
    if not sorted_vals:
        return 0.0
    idx = max(0, int(len(sorted_vals) * pct / 100) - 1)
    return round(sorted_vals[min(idx, len(sorted_vals) - 1)], 1)


# ---------------------------------------------------------------------------
# processed_mail — bulk-ingest dedup registry
# ---------------------------------------------------------------------------


def mark_mail_processed(
    source: str,
    message_id: str,
    *,
    uid: str | None = None,
    folder: str | None = None,
    triage_decision: str | None = None,
    fact_count: int = 0,
    tier: str = "knowledge",
    message_date: str | None = None,
) -> None:
    """Record that an email has been ingested. Idempotent (PK collision = no-op).

    ``tier`` is the memory destination: ``knowledge`` for <12mo and 12-24mo,
    ``archive`` for 24+mo mail. ``triage_decision`` is the triage classifier
    output (``suppress``/``batch``/``notify``/``question``/``review``) or
    ``"skipped"`` when the message was filtered before triage.
    """
    with _connect() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO processed_mail "
            "(source, message_id, uid, folder, ingested_at, triage_decision, "
            " fact_count, tier, message_date) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                source,
                message_id,
                uid,
                folder,
                datetime.now(UTC).isoformat(),
                triage_decision,
                fact_count,
                tier,
                message_date,
            ),
        )
        conn.commit()


def is_mail_processed(source: str, message_id: str) -> bool:
    """Return True if (source, message_id) has been ingested before."""
    with _connect() as conn:
        row = conn.execute(
            "SELECT 1 FROM processed_mail WHERE source = ? AND message_id = ?",
            (source, message_id),
        ).fetchone()
    return row is not None


def processed_mail_count(source: str | None = None) -> int:
    """Return the count of processed-mail rows, optionally scoped by source."""
    with _connect() as conn:
        if source:
            row = conn.execute(
                "SELECT COUNT(*) FROM processed_mail WHERE source = ?",
                (source,),
            ).fetchone()
        else:
            row = conn.execute("SELECT COUNT(*) FROM processed_mail").fetchone()
    return int(row[0]) if row else 0


def processed_mail_stats() -> dict:
    """Return aggregate counts by triage_decision and tier for reporting."""
    with _connect() as conn:
        by_decision = conn.execute(
            "SELECT triage_decision, COUNT(*) FROM processed_mail "
            "GROUP BY triage_decision"
        ).fetchall()
        by_tier = conn.execute(
            "SELECT tier, COUNT(*) FROM processed_mail GROUP BY tier"
        ).fetchall()
        total_facts = conn.execute(
            "SELECT COALESCE(SUM(fact_count), 0) FROM processed_mail"
        ).fetchone()
    return {
        "by_decision": {d or "unknown": c for d, c in by_decision},
        "by_tier": {t or "unknown": c for t, c in by_tier},
        "total_facts": int(total_facts[0]) if total_facts else 0,
    }


# processed_imessages — iMessage/SMS inbound dedup registry
# ---------------------------------------------------------------------------


def is_imessage_processed(guid: str) -> bool:
    """Return True if this message guid has already been processed."""
    with _connect() as conn:
        row = conn.execute(
            "SELECT 1 FROM processed_imessages WHERE guid = ?", (guid,)
        ).fetchone()
    return row is not None


def mark_imessage_processed(
    guid: str,
    rowid: int,
    sender: str,
    triage_decision: str = "unknown",
) -> None:
    """Record that a message has been processed. Idempotent (guid PK = no-op on collision)."""
    with _connect() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO processed_imessages "
            "(guid, rowid, sender, processed_at, triage_decision) "
            "VALUES (?, ?, ?, ?, ?)",
            (guid, rowid, sender, datetime.now(UTC).isoformat(), triage_decision),
        )
        conn.commit()


# ---------------------------------------------------------------------------
# Matters
# ---------------------------------------------------------------------------


def create_matter(name: str, description: str = "") -> str:
    """Create a new matter. Returns the new matter ID."""
    matter_id = str(uuid.uuid4())
    now = datetime.now(UTC).isoformat()
    sql = (
        "INSERT INTO matters (id, name, description, created_at, status) "
        "VALUES (?, ?, ?, ?, 'open')"
    )
    with _connect() as conn:
        conn.execute(sql, (matter_id, name, description, now))
        conn.commit()
    return matter_id


def _matter_row(r: tuple) -> dict:  # type: ignore[type-arg]
    return {
        "id": r[0],
        "name": r[1],
        "description": r[2],
        "created_at": r[3],
        "status": r[4],
    }


def list_matters(status: str | None = None) -> list[dict]:
    """Return all matters, optionally filtered by status ('open'|'closed')."""
    with _connect() as conn:
        if status:
            rows = conn.execute(
                "SELECT id, name, description, created_at, status "
                "FROM matters WHERE status = ? ORDER BY created_at DESC",
                (status,),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT id, name, description, created_at, status "
                "FROM matters ORDER BY created_at DESC"
            ).fetchall()
    return [_matter_row(r) for r in rows]


def get_matter(matter_id: str) -> dict | None:
    """Return a matter by ID, or None if not found."""
    with _connect() as conn:
        row = conn.execute(
            "SELECT id, name, description, created_at, status "
            "FROM matters WHERE id = ?",
            (matter_id,),
        ).fetchone()
    if not row:
        return None
    return _matter_row(row)


def get_matter_by_name(name: str) -> dict | None:
    """Return the most recent open matter with this name (case-insensitive), or None."""
    with _connect() as conn:
        row = conn.execute(
            "SELECT id, name, description, created_at, status FROM matters "
            "WHERE lower(name) = lower(?) AND status = 'open' "
            "ORDER BY created_at DESC LIMIT 1",
            (name,),
        ).fetchone()
    if not row:
        return None
    return _matter_row(row)


def add_matter_item(matter_id: str, item_type: str, item_ref: str) -> str:
    """Add an item to a matter. Returns the new item ID."""
    item_id = str(uuid.uuid4())
    now = datetime.now(UTC).isoformat()
    sql = (
        "INSERT INTO matter_items (id, matter_id, item_type, item_ref, added_at) "
        "VALUES (?, ?, ?, ?, ?)"
    )
    with _connect() as conn:
        conn.execute(sql, (item_id, matter_id, item_type, item_ref, now))
        conn.commit()
    return item_id


def list_matter_items(matter_id: str) -> list[dict]:
    """Return all items for a matter, newest first."""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT id, item_type, item_ref, added_at FROM matter_items "
            "WHERE matter_id = ? ORDER BY added_at DESC",
            (matter_id,),
        ).fetchall()
    return [{"id": r[0], "item_type": r[1], "item_ref": r[2], "added_at": r[3]} for r in rows]


def close_matter(matter_id: str) -> bool:
    """Close a matter. Returns True if found and closed."""
    with _connect() as conn:
        cur = conn.execute(
            "UPDATE matters SET status = 'closed' WHERE id = ? AND status = 'open'",
            (matter_id,),
        )
        conn.commit()
    return cur.rowcount > 0
