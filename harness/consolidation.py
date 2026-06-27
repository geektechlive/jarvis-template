"""Cross-session memory consolidation.

Four jobs that run nightly at 02:00 (or on demand via /consolidate):
  1. summarize_sessions        -- one narrative per session → knowledge
  2. consolidate_cross_session -- synthesize cross-session themes → user_profile
  3. deduplicate_preferences   -- merge near-identical user_profile entries
  4. decay_knowledge           -- move stale knowledge entries to archive

Configuration: harness/config/consolidation.yaml

All four functions are idempotent. Crashing mid-run is safe: partial work is
logged and the next run resumes where it left off via event-based bookkeeping.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import yaml

from harness.memory import episodic
from harness.memory.store import (
    MemoryEntry,
    VectorStore,
    _chat_by_backend,
    _llm_circuit,
)

# Network-level errors that indicate Ollama is unreachable (not a model logic error)
OLLAMA_ERRORS = (ConnectionError, TimeoutError, OSError)

# Tracks _llm_call timeouts within a single run_all() invocation. Reset at the
# start of run_all() and surfaced into ConsolidationResult.errors at the end so
# /consolidate callers see degraded runs instead of silent zero-work returns.
_llm_timeout_count = 0

# Circuit breaking is delegated to the process-wide _llm_circuit in store.py,
# shared with the memory write-path helpers (tagging, importance, HyDE). The
# chat backend's health is one fact; consolidation and writes back off together.


def _reset_llm_timeouts() -> int:
    """Read-and-zero the module-level timeout counter."""
    global _llm_timeout_count
    n = _llm_timeout_count
    _llm_timeout_count = 0
    return n




def _load_models_config() -> dict:
    """Load harness/config/models.yaml. Returns {} on any failure."""
    try:
        import yaml
        config_path = Path(__file__).parent / "config" / "models.yaml"
        with open(config_path) as f:
            return yaml.safe_load(f) or {}
    except Exception:
        return {}

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

def _load_config() -> dict:
    cfg_path = Path(__file__).parent / "config" / "consolidation.yaml"
    with open(cfg_path) as f:
        return (yaml.safe_load(f) or {}).get("consolidation", {})


def _load_integrations_config() -> dict:
    """Load harness/config/integrations.yaml. Returns {} on any failure."""
    try:
        cfg_path = Path(__file__).parent / "config" / "integrations.yaml"
        with open(cfg_path) as f:
            return (yaml.safe_load(f) or {}).get("memory", {})
    except Exception:
        return {}


# ---------------------------------------------------------------------------
# Result dataclass
# ---------------------------------------------------------------------------

@dataclass
class ConsolidationResult:
    sessions_summarized: int = 0
    cross_session_facts_stored: int = 0
    preferences_merged: int = 0
    entries_archived: int = 0
    task_memory_purged: int = 0
    memories_reflected: int = 0
    ttl_expired_purged: int = 0
    cold_archived: int = 0
    fts_backfilled: int = 0
    errors: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# LLM helpers
# ---------------------------------------------------------------------------

_SESSION_SUMMARY_PROMPT = """\
Summarize this conversation session in 2-4 sentences. Focus on what the user \
worked on, decided, or learned. Be specific and factual. Do not editorialize.

Conversation:
{conversation}

Summary:"""

_CROSS_SESSION_PROMPT = """\
You are reading a set of recent session summaries from a personal AI assistant. \
Extract 3-5 durable cross-session themes, preferences, or decisions that appear \
across multiple sessions.

Only include patterns that span more than one session. Skip single-session facts. \
Skip generic observations.

Format: a numbered list, one item per line. Example:
1. Alex is actively migrating the <your-org> site to Astro
2. Alex prefers dark, editorial design aesthetics over clean minimal

Session summaries:
{summaries}

Cross-session themes/preferences:"""

_MERGE_PROMPT = """\
These are {n} near-identical memory entries that should be merged into one \
canonical statement. Combine them into a single precise statement that captures \
all nuance.

One sentence only. No extra commentary.

Entries:
{entries}

Merged:"""

_CONTRADICTION_PROMPT = """\
Do these two memory entries contradict each other? Answer only "yes" or "no".

Entry A: {entry_a}
Entry B: {entry_b}

Answer:"""

_REFLECT_PROMPT = """\
Review these related memory entries. They are similar enough to be connected but \
distinct enough that deduplication did not merge them.

Determine if combining them produces a single more precise and complete fact that \
captures all important nuance.

If yes, write ONE improved sentence. Do not lose specific details.
If the entries should stay separate, respond ONLY with: NO_IMPROVEMENT

Related entries:
{entries}

Improved fact (or NO_IMPROVEMENT):"""


def _llm_call(prompt: str) -> str:
    """Single LLM call using the extraction model. Returns empty string on failure.

    90s timeout prevents an unresponsive provider from hanging the consolidation
    job indefinitely. Backend is read from models.yaml extraction.backend so
    switching the extraction role (e.g. from cli to openrouter) is reflected here
    automatically. cli/ollama unknown backends fall back to Ollama.

    Circuit breaker: delegated to the shared _llm_circuit (store.py). After
    enough consecutive failures across consolidation and the write-path helpers
    it opens and all calls return "" immediately until the cooldown elapses.
    Resets on any successful response.
    """
    global _llm_timeout_count
    if _llm_circuit.is_open():
        log.info("consolidation: shared LLM circuit open, skipping LLM call")
        return ""
    cfg = _load_models_config().get("extraction", {"model": "gemma3:27b"})
    model = cfg.get("model", "gemma3:27b")
    backend = cfg.get("backend", "ollama")
    try:
        result = _chat_by_backend(backend, model, prompt, timeout=90)
        _llm_circuit.record_success()
        return result
    except httpx.TimeoutException as e:
        _llm_timeout_count += 1
        _llm_circuit.record_failure()
        log.warning("consolidation _llm_call timed out after 90s: %s", e)
        return ""
    except httpx.RequestError as e:
        # ConnectError, NetworkError, etc. -- treat same as timeout for circuit purposes.
        _llm_timeout_count += 1
        _llm_circuit.record_failure()
        log.warning("provider unreachable during consolidation (request error): %s", e)
        return ""
    except OLLAMA_ERRORS as e:
        log.warning("provider unreachable during consolidation: %s", e)
        _llm_circuit.record_failure()
        return ""
    except Exception as e:
        log.debug("LLM call failed: %s", e)
        return ""


def _parse_stored_at(s: str) -> datetime:
    """Parse a stored_at ISO string to an aware datetime for safe comparison.

    Entries written before timezone support may be naive; attach UTC so
    comparisons never raise TypeError on mixed-aware vs naive datetimes.
    """
    try:
        dt = datetime.fromisoformat(s)
        return dt if dt.tzinfo else dt.replace(tzinfo=UTC)
    except ValueError:
        return datetime.min.replace(tzinfo=UTC)


def _parse_list(text: str) -> list[str]:
    """Parse a numbered or bullet list from model output."""
    results: list[str] = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        if len(line) >= 3 and line[0].isdigit() and line[1] == "." and line[2] == " ":
            results.append(line[3:].strip())
        elif line.startswith("- "):
            results.append(line[2:].strip())
    return results


# ---------------------------------------------------------------------------
# 1. summarize_sessions
# ---------------------------------------------------------------------------

def summarize_sessions(store: VectorStore, window_days: int | None = None) -> int:
    """Generate a 2-4 sentence narrative for each unsummarized session in window.

    Stores the summary in knowledge with source="session:{session_id}" and
    metadata type="session_summary". Logs session_summarized event so the
    function is idempotent.

    Optionally deletes raw messages for sessions summarized more than
    message_retention_days ago when delete_summarized_messages is enabled.

    Returns count of sessions newly summarized.
    """
    cfg = _load_config()
    if window_days is None:
        window_days = int(cfg.get("window_days", 7))

    episodic.init_db()
    sessions_by_msg = episodic.messages_in_window(window_days=window_days)
    if not sessions_by_msg:
        return 0

    already_summarized: set[str] = set()
    for ev in episodic.recent_events(event_type="session_summarized", n=1000):
        detail = ev.get("detail") or {}
        if isinstance(detail, dict):
            sid = detail.get("session")
            if sid:
                already_summarized.add(str(sid))

    count = 0
    for session, messages in sessions_by_msg.items():
        if session in already_summarized:
            continue
        if len(messages) < 2:
            continue

        conversation = "\n".join(
            f"{m['role'].upper()}: {m['content'][:300]}" for m in messages[:40]
        )
        prompt = _SESSION_SUMMARY_PROMPT.format(conversation=conversation)
        summary = _llm_call(prompt)
        if not summary:
            continue
        if len(summary) > 1500:
            summary = summary[:1497] + "..."

        try:
            store.remember(
                summary,
                collection="knowledge",
                source=f"session:{session}",
                metadata={"type": "session_summary", "session": session},
            )
        except ValueError as e:
            log.debug("summarize_sessions: skipping session %s: %s", session, e)
            continue

        episodic.log_event(
            "session_summarized",
            {"session": session, "message_count": len(messages)},
            session="consolidation",
        )
        count += 1

        # Optionally delete raw messages for very old summarized sessions
        delete_enabled = bool(cfg.get("delete_summarized_messages", False))
        if delete_enabled:
            retention_days = int(cfg.get("message_retention_days", 30))
            cutoff = (datetime.now(UTC) - timedelta(days=retention_days)).isoformat()
            deleted = episodic.delete_messages_before(session, cutoff)
            if deleted:
                log.info("Pruned %d old messages from session %s", deleted, session)

    return count


# ---------------------------------------------------------------------------
# 2. consolidate_cross_session
# ---------------------------------------------------------------------------

def consolidate_cross_session(store: VectorStore, window_days: int | None = None) -> int:
    """Synthesize cross-session themes from recent session summaries.

    Reads session summaries from knowledge (created by summarize_sessions),
    asks the LLM to extract recurring cross-session themes, and stores them
    in user_profile tagged source="consolidation".

    Returns count of new facts stored.
    """
    cfg = _load_config()
    if window_days is None:
        window_days = int(cfg.get("window_days", 7))

    episodic.init_db()

    # Gather recent session summaries
    summaries = store.list_entries(
        collection="knowledge",
        limit=50,
        where={"type": {"$eq": "session_summary"}},
    )
    cutoff_ts = (datetime.now(UTC) - timedelta(days=window_days)).isoformat()
    recent = [s for s in summaries if s.stored_at >= cutoff_ts]
    if len(recent) < 2:
        return 0

    # Deduplicate session ids represented
    session_ids = list({s.metadata.get("session", "") for s in recent if s.metadata.get("session")})

    summaries_text = "\n".join(
        f"[{i + 1}] ({s.metadata.get('session', '?')}) {s.text}" for i, s in enumerate(recent[:20])
    )
    prompt = _CROSS_SESSION_PROMPT.format(summaries=summaries_text)
    raw = _llm_call(prompt)
    if not raw:
        return 0

    facts = _parse_list(raw)
    stored_ids: list[str] = []
    for fact in facts:
        fact = fact.strip()
        if not fact or len(fact) > 1500:
            continue
        existing = store.find_similar(fact, collection="user_profile")
        if existing is not None:
            continue
        try:
            doc_id = store.remember(
                fact,
                collection="user_profile",
                source="consolidation",
                metadata={"type": "cross_session", "sessions": ",".join(session_ids)},
            )
            stored_ids.append(doc_id)
        except ValueError as e:
            log.debug("consolidate_cross_session: skipping fact: %s", e)

    if stored_ids:
        episodic.log_event(
            "cross_session_complete",
            {"facts_stored": len(stored_ids), "sessions": session_ids},
            session="consolidation",
        )

    return len(stored_ids)


# ---------------------------------------------------------------------------
# 3. deduplicate_preferences
# ---------------------------------------------------------------------------

def deduplicate_preferences(
    store: VectorStore,
    collection: str = "user_profile",
    threshold: float | None = None,
) -> int:
    """Merge near-duplicate entries in a collection.

    Greedy clustering: for each unprocessed entry, find all entries above
    threshold similarity, merge the cluster via LLM into one canonical
    statement, write the merged entry, delete the originals.

    Returns count of original entries replaced (merged groups * cluster_size).
    """
    cfg = _load_config()
    if threshold is None:
        threshold = float(cfg.get("dedup_threshold", 0.92))

    episodic.init_db()
    entries = store.list_entries(collection=collection, limit=500)
    if len(entries) < 2:
        return 0

    processed_ids: set[str] = set()
    merged_count = 0

    for entry in entries:
        if entry.id in processed_ids:
            continue

        # Find similar entries above threshold (excluding self).
        # include_archive=False keeps decay/dedup passes scoped to the live
        # collection; we never want consolidation to fold an archive entry
        # back into a fresh cluster.
        pairs = store.recall_with_ids(
            entry.text,
            collection=collection,
            n=10,
            min_relevance=threshold,
            recency_boost=False,
            include_archive=False,
        )
        cluster_pairs = [
            (eid, text) for eid, text in pairs
            if eid != entry.id and eid not in processed_ids
        ]
        # Lexical complement: vector clustering can rank an identically-worded
        # duplicate below threshold. Fold in FTS-surfaced lexical duplicates
        # (strict token-overlap confirmed) so they get merged too. The Jaccard
        # gate inside find_lexical_duplicates prevents merging mere keyword-sharers.
        seen_ids = {entry.id} | {eid for eid, _ in cluster_pairs} | processed_ids
        for eid, text in store.find_lexical_duplicates(
            entry.text, collection, exclude_id=entry.id
        ):
            if eid not in seen_ids:
                cluster_pairs.append((eid, text))
                seen_ids.add(eid)
        if not cluster_pairs:
            processed_ids.add(entry.id)
            continue

        # Build cluster: anchor entry + similar entries
        cluster_ids = [entry.id] + [eid for eid, _ in cluster_pairs]
        cluster_texts = [entry.text] + [text for _, text in cluster_pairs]

        # LLM merge
        entries_text = "\n".join(f"- {t}" for t in cluster_texts)
        merged = _llm_call(
            _MERGE_PROMPT.format(n=len(cluster_texts), entries=entries_text)
        )
        if not merged or len(merged) > 1500:
            processed_ids.update(cluster_ids)
            continue

        # Guard: if the merged text is near-identical to an external entry (not
        # in this cluster), the dedup-on-write guard will skip the write but we
        # would still delete originals. Keep originals in that case.
        collision = store.find_similar(merged, collection=collection, threshold=0.95)
        if collision and collision not in set(cluster_ids):
            log.warning(
                "deduplicate_preferences: merged text collides with existing entry %s"
                " -- keeping originals",
                collision[:8],
            )
            processed_ids.update(cluster_ids)
            continue

        # Write merged entry first, then delete originals (safe on crash)
        try:
            store.remember(
                merged,
                collection=collection,
                source="dedup_merge",
                metadata={"type": "merged", "merged_from": ",".join(cluster_ids[:10])},
            )
        except ValueError as e:
            log.debug("deduplicate_preferences: merge write failed: %s", e)
            processed_ids.update(cluster_ids)
            continue

        store.forget_by_ids(cluster_ids, collection=collection, reason="dedup_merge")
        episodic.log_event(
            "preference_merged",
            {"merged_from": cluster_ids, "merged_text": merged[:200]},
            session="consolidation",
        )
        merged_count += len(cluster_ids)
        processed_ids.update(cluster_ids)

    return merged_count


# ---------------------------------------------------------------------------
# 4. decay_knowledge
# ---------------------------------------------------------------------------

_DECAY_ARCHIVE_THRESHOLD = 0.2
_DECAY_DELTA = 0.05


def decay_knowledge(
    store: VectorStore,
    unused_days: int | None = None,
    contradiction_check: bool | None = None,
) -> int:
    """Confidence-based decay for stale knowledge entries.

    Entries not recalled within unused_days have their confidence decremented
    by _DECAY_DELTA each cycle. When confidence falls below _DECAY_ARCHIVE_THRESHOLD
    the entry is archived (copied to the archive collection and removed from
    knowledge). Session summaries are never decayed.

    Returns count of entries archived this cycle.
    """
    cfg = _load_config()
    if unused_days is None:
        unused_days = int(cfg.get("decay_unused_days", 90))
    if contradiction_check is None:
        contradiction_check = bool(cfg.get("decay_contradiction_check", False))

    episodic.init_db()
    recalled_ids = episodic.recalled_ids_in_window(window_days=unused_days)

    archived = 0

    # #858: page through the ENTIRE knowledge collection rather than only the
    # newest 1000. list_entries caps at `limit` and returns newest-first, so the
    # OLDEST entries -- exactly the ones most likely to be stale -- were never
    # decayed once the collection exceeded 1000 rows. Materialize the full scan
    # BEFORE any archiving below, so deleting entries does not shift an
    # offset-based page window mid-iteration and silently skip rows.
    _DECAY_PAGE = 500
    knowledge_entries: list[MemoryEntry] = []
    _offset = 0
    while True:
        _page = store.list_entries_page(
            collection="knowledge", limit=_DECAY_PAGE, offset=_offset
        )
        if not _page:
            break
        knowledge_entries.extend(_page)
        if len(_page) < _DECAY_PAGE:
            break
        _offset += _DECAY_PAGE
    # Batch-fetch all metas up front (one query) instead of one per entry.
    metas = episodic.get_memory_meta_bulk([e.id for e in knowledge_entries if e.id])
    for entry in knowledge_entries:
        if entry.metadata.get("type") == "session_summary":
            continue
        if entry.id in recalled_ids:
            continue

        # Ensure a memories_meta row exists (lazy-create for legacy entries)
        if entry.id not in metas:
            episodic.upsert_memory_meta(
                entry.id,
                confidence=0.5,
                source=entry.source or "legacy",
                collection="knowledge",
            )

        new_confidence = episodic.decay_confidence(entry.id, delta=_DECAY_DELTA)
        if new_confidence < _DECAY_ARCHIVE_THRESHOLD:
            episodic.set_superseded(entry.id, superseded_by="decay")
            archived += _archive_entry(store, entry, collection="knowledge")

    # Contradiction check on user_profile (optional, off by default)
    if contradiction_check:
        archived += _contradiction_pass(store)

    if archived:
        episodic.log_event(
            "decay_complete",
            {"archived": archived, "unused_days": unused_days},
            session="consolidation",
        )

    return archived


def _purge_task_memory(store: VectorStore, days_old: int = 7) -> int:
    """Delete task_memory entries older than days_old days. Returns count deleted."""
    cutoff = datetime.now(UTC) - timedelta(days=days_old)
    col = store._cols["task_memory"]  # noqa: SLF001
    result = col.get(include=["metadatas"])
    ids: list[str] = result.get("ids") or []
    metas: list = result.get("metadatas") or []
    old_ids: list[str] = []
    for doc_id, meta in zip(ids, metas, strict=False):
        raw = (meta or {}).get("stored_at", "")
        if not raw:
            continue
        try:
            entry_dt = datetime.fromisoformat(str(raw))
            if entry_dt.tzinfo is None:
                entry_dt = entry_dt.replace(tzinfo=UTC)
            if entry_dt < cutoff:
                old_ids.append(doc_id)
        except (ValueError, AttributeError):
            pass
    if old_ids:
        store.forget_by_ids(old_ids, collection="task_memory", reason="ttl_expired")
    return len(old_ids)


def _prune_expired_ttl(store: VectorStore, default_ttl_days: int = 30) -> int:
    """Delete entries from all collections where created_at + ttl_days has expired.

    TTL is read from memories_meta.ttl_days field (if present) or defaults to
    default_ttl_days. Only entries with a stored/created_at timestamp are checked.
    Returns count of entries purged.

    Typical sources for TTL-tagged items: RSS feeds, web-scraped content, etc.
    This function is fail-soft: errors on individual entries are logged but do
    not prevent scanning remaining entries.
    """
    episodic.init_db()
    now = datetime.now(UTC)
    purged = 0

    # Read integrations.yaml memory.ttl_days (optional fallback to default)
    integrations_cfg = _load_integrations_config()
    ttl_days = integrations_cfg.get("ttl_days", default_ttl_days)

    for collection in ["knowledge", "news", "archive", "agent_memories"]:
        try:
            entries = store.list_entries(collection=collection, limit=1000)
        except Exception:
            log.debug("Failed to list entries in collection %s", collection)
            continue

        # Batch-fetch all metas for this collection up front (one query) instead
        # of one per entry. Fail-soft: on error, every entry falls back to the
        # config default TTL, same as the prior per-entry except path.
        try:
            metas = episodic.get_memory_meta_bulk([e.id for e in entries if e.id])
        except Exception:
            log.debug("Failed to bulk-fetch TTL metadata for collection %s", collection)
            metas = {}

        for entry in entries:
            if not entry.id or not entry.stored_at:
                continue

            # Read TTL from episodic metadata. Only entries that carry an explicit
            # ttl_days are pruned (jarvis#822). Untagged entries are durable -- this
            # honors the documented contract in integrations.yaml ("Entries without a
            # ttl_days field are NOT subject to TTL pruning"). The prior code applied
            # the 30-day default to every untagged row, silently deleting durable
            # knowledge after 30 days and re-learning it (churn + dangling rows).
            meta = metas.get(entry.id)
            entry_ttl_days = meta.get("ttl_days") if meta else None
            if entry_ttl_days is None:
                continue

            # Parse created_at from the SQLite memories_meta row (a real UTC ISO
            # string). NOT entry.stored_at: for TS-written entries that ChromaDB
            # field is the caller-stamped "[YYYY-MM-DD HH:MM TZ] <text>" string,
            # which fromisoformat cannot parse -- it would raise here and skip every
            # TTL-tagged entry, leaving the TTL purely decorative (jarvis#850).
            # meta is guaranteed non-None here (entry_ttl_days came from it above).
            created_raw = meta.get("created_at") if meta else None
            try:
                created_dt = datetime.fromisoformat(str(created_raw))
                if created_dt.tzinfo is None:
                    created_dt = created_dt.replace(tzinfo=UTC)
            except (ValueError, AttributeError):
                continue

            # Check if expired
            expires_at = created_dt + timedelta(days=entry_ttl_days)
            if now >= expires_at:
                try:
                    store.forget(entry.id, collection=collection, reason="ttl_expired")
                    purged += 1
                except Exception as e:
                    log.debug(
                        "Failed to delete expired entry %s from %s: %s",
                        entry.id,
                        collection,
                        e,
                    )

    if purged:
        try:
            episodic.log_event(
                "ttl_pruned",
                {"count": purged, "default_ttl_days": ttl_days},
                session="consolidation",
            )
        except Exception:
            pass

    return purged


def _archive_entry(store: VectorStore, entry, collection: str, reason: str = "archived") -> int:
    """Copy entry to archive collection and delete from source. Returns 1 on success.

    ``reason`` labels the superseded meta row. The decay path pre-sets 'decay' before
    calling this, so that label is preserved (mark_superseded_if_unset won't overwrite)."""
    try:
        store.remember(
            entry.text,
            collection="archive",
            source=f"archived:{collection}",
            metadata={
                **entry.metadata,
                "archived_from": collection,
                "archived_at": datetime.now(UTC).isoformat(),
            },
        )
        store.forget(entry.id, collection=collection, reason=reason)
        return 1
    except Exception as e:
        log.debug("_archive_entry failed for %s: %s", entry.id, e)
        return 0


def _contradiction_pass(store: VectorStore) -> int:
    """Find contradicted user_profile entries, archive the older one, and RECORD the
    contradiction (jarvis#807). Previously this ran but left no trace: the contradicts
    column stayed empty and no event fired, so "no contradictions found" was unknowable
    from "none looked for". Now the surviving entry's contradicts column points at the
    archived id and a contradiction_detected event is emitted. Cap raised 100 -> 500."""
    all_entries = store.list_entries(collection="user_profile", limit=500)
    entry_by_id = {e.id: e for e in all_entries}
    checked_pairs: set[frozenset] = set()
    archived_ids: set[str] = set()
    archived = 0

    for entry in all_entries:
        if entry.id in archived_ids:
            continue
        pairs = store.recall_with_ids(
            entry.text,
            collection="user_profile",
            n=5,
            min_relevance=0.6,
            recency_boost=False,
            include_archive=False,
        )
        for other_id, other_text in pairs:
            if other_id == entry.id or other_id in archived_ids:
                continue
            pair_key = frozenset({entry.id, other_id})
            if pair_key in checked_pairs:
                continue
            checked_pairs.add(pair_key)

            answer = _llm_call(
                _CONTRADICTION_PROMPT.format(entry_a=entry.text, entry_b=other_text)
            ).lower().strip()
            if not answer.startswith("yes"):
                continue

            # Archive the older entry (lower stored_at timestamp)
            other_entry = entry_by_id.get(other_id)
            if other_entry is None:
                continue
            older = (
                entry
                if _parse_stored_at(entry.stored_at) <= _parse_stored_at(other_entry.stored_at)
                else other_entry
            )
            survivor = other_entry if older is entry else entry
            if older.id in archived_ids:
                continue
            archived += _archive_entry(store, older, "user_profile", reason="contradicted")
            archived_ids.add(older.id)
            # jarvis#807: record the contradiction so it's queryable + observable.
            try:
                episodic.set_contradicts(survivor.id, older.id)
                episodic.log_event(
                    "contradiction_detected",
                    {
                        "kept": survivor.id,
                        "archived": older.id,
                        "kept_text": survivor.text[:120],
                        "archived_text": older.text[:120],
                    },
                    session="consolidation",
                )
            except Exception as e:
                log.debug("contradiction_pass: failed to record %s: %s", older.id, e)

    return archived


# ---------------------------------------------------------------------------
# 5. reflect_memories  (hindsight pass — #12)
# ---------------------------------------------------------------------------

# Similarity range below dedup threshold: entries that are related but not
# near-identical. dedup handles >= DEFAULT_DEDUP_THRESHOLD; this pass handles
# the 0.55-0.87 band where synthesis often adds precision without data loss.
_REFLECT_SIM_MIN = 0.55
_REFLECT_SIM_MAX = 0.87


def reflect_memories(
    store: VectorStore,
    collection: str = "knowledge",
    max_clusters: int = 15,
) -> int:
    """Hindsight pass: synthesise related-but-distinct entries into more precise facts.

    For up to max_clusters groups of 2-3 entries with similarity in [_REFLECT_SIM_MIN,
    _REFLECT_SIM_MAX], asks the LLM whether a combined formulation would be more
    useful. If the LLM returns an improvement (not "NO_IMPROVEMENT") and it passes
    the dedup guard, the synthesis is stored and the originals are superseded.

    Returns the count of original entries replaced.
    """
    episodic.init_db()
    entries = store.list_entries(collection=collection, limit=500)
    if len(entries) < 2:
        return 0

    processed_ids: set[str] = set()
    improved = 0
    clusters_tried = 0

    for entry in entries:
        if clusters_tried >= max_clusters:
            break
        if entry.id in processed_ids:
            continue

        pairs = store.recall_with_ids(
            entry.text,
            collection=collection,
            n=3,
            min_relevance=_REFLECT_SIM_MIN,
            recency_boost=False,
            include_archive=False,
        )
        # Exclude near-duplicates (>= _REFLECT_SIM_MAX) -- dedup owns that band.
        near_dupe_ids = {
            eid
            for eid, _ in store.recall_with_ids(
                entry.text,
                collection=collection,
                n=10,
                min_relevance=_REFLECT_SIM_MAX,
                recency_boost=False,
                include_archive=False,
            )
        }
        band_pairs = [
            (eid, text) for eid, text in pairs
            if eid != entry.id
            and eid not in processed_ids
            and eid not in near_dupe_ids
        ]
        if not band_pairs:
            processed_ids.add(entry.id)
            continue

        # Cap cluster at 2 neighbours to limit prompt length
        cluster_ids = [entry.id] + [eid for eid, _ in band_pairs[:2]]
        cluster_texts = [entry.text] + [text for _, text in band_pairs[:2]]
        clusters_tried += 1

        entries_text = "\n".join(f"- {t}" for t in cluster_texts)
        synthesis = _llm_call(_REFLECT_PROMPT.format(entries=entries_text)).strip()

        if not synthesis or synthesis.upper().startswith("NO_IMPROVEMENT"):
            processed_ids.update(cluster_ids)
            continue
        if len(synthesis) > 1500:
            processed_ids.update(cluster_ids)
            continue

        # Guard: synthesis must not collide with an entry outside the cluster
        collision = store.find_similar(synthesis, collection=collection, threshold=0.95)
        if collision and collision not in set(cluster_ids):
            log.debug(
                "reflect_memories: synthesis collides with external entry %s -- skipping",
                collision[:8],
            )
            processed_ids.update(cluster_ids)
            continue

        try:
            store.remember(
                synthesis,
                collection=collection,
                source="reflect_pass",
                metadata={
                    "type": "reflected",
                    "reflected_from": ",".join(cluster_ids[:10]),
                },
            )
        except ValueError as e:
            log.debug("reflect_memories: synthesis write failed: %s", e)
            processed_ids.update(cluster_ids)
            continue

        for cid in cluster_ids:
            episodic.set_superseded(cid, superseded_by="reflect_pass")
        try:
            store.forget_by_ids(cluster_ids, collection=collection)
        except Exception as e:
            log.warning(
                "reflect_memories: forget_by_ids failed after set_superseded"
                " -- SQLite/ChromaDB state may diverge for %s: %s",
                cluster_ids,
                e,
            )

        episodic.log_event(
            "memory_reflected",
            {"reflected_from": cluster_ids, "synthesis": synthesis[:200]},
            session="consolidation",
        )
        improved += len(cluster_ids)
        processed_ids.update(cluster_ids)

    return improved


# ---------------------------------------------------------------------------
# Cold archive (Phase 5C)
# ---------------------------------------------------------------------------

_COLD_ARCHIVE_AGE_DAYS = 90
_ORPHANED_META_CONFIDENCE_MAX = 0.1


def archive_to_cold(store: VectorStore, nas_path: Path | None = None, dry_run: bool = False) -> int:
    """Export cold ChromaDB archive entries to Parquet on the NAS, then delete them.

    Two passes:
      1. archive-collection ChromaDB entries (age > 90d, access_count=0) →
         write to monthly Parquet shard on NAS → delete from ChromaDB + memories_meta
      2. orphaned memories_meta rows (superseded_by IS NOT NULL, confidence<0.1,
         access_count=0, age>90d) → delete metadata only (no ChromaDB entries remain)

    Skips silently when NAS path is not mounted. Returns total count deleted (or
    candidate count when dry_run=True without modifying anything).

    When dry_run=True both passes run to identify candidates but the Parquet write
    and all deletes are skipped. Returns the count of rows that would be archived.
    """
    try:
        import duckdb
    except ImportError:
        log.warning("archive_to_cold: duckdb not installed -- skipping")
        return 0

    if nas_path is None:
        cfg = _load_integrations_config()
        raw_path = cfg.get("cold_archive_path", "")
        if not raw_path:
            log.debug("archive_to_cold: cold_archive_path not configured -- skipping")
            return 0
        nas_path = Path(raw_path).expanduser()

    if not nas_path.exists():
        log.debug("archive_to_cold: NAS path %s not mounted -- skipping", nas_path)
        return 0

    cutoff = (datetime.now(UTC) - timedelta(days=_COLD_ARCHIVE_AGE_DAYS)).isoformat()
    deleted = 0

    # --- Pass 1: export ChromaDB archive entries to Parquet ---
    candidates = episodic.cold_archive_candidates(cutoff)
    if candidates:
        rows_to_export = []
        for meta in candidates:
            chroma_id = meta["chroma_id"]
            try:
                entries = store.list_entries("archive", limit=1, where={"id": chroma_id})
            except Exception:
                entries = []
            if not entries:
                # ChromaDB entry already gone; only metadata remains
                episodic.delete_memory_meta(chroma_id)
                deleted += 1
                continue
            entry = entries[0]
            rows_to_export.append(
                {
                    "chroma_id": chroma_id,
                    "text": entry.text,
                    "source": entry.source or "",
                    "stored_at": entry.stored_at or meta["created_at"],
                    "confidence": meta["confidence"],
                    "exported_at": datetime.now(UTC).isoformat(),
                }
            )

        if rows_to_export:
            if dry_run:
                log.info(
                    "archive_to_cold: dry_run -- would export %d rows to Parquet (skipping write)",
                    len(rows_to_export),
                )
                deleted += len(rows_to_export)
            else:
                # Fetch embedding vectors from ChromaDB so cold recall can use
                # cosine similarity instead of substring search.
                ids_to_embed = [r["chroma_id"] for r in rows_to_export]
                try:
                    embeddings = store.get_embeddings_by_ids(ids_to_embed, collection="archive")
                except Exception as exc:
                    log.warning("archive_to_cold: could not fetch embeddings: %s", exc)
                    embeddings = {}
                for row in rows_to_export:
                    row["embedding"] = embeddings.get(row["chroma_id"])

                month_dir = nas_path / datetime.now(UTC).strftime("%Y-%m")
                month_dir.mkdir(parents=True, exist_ok=True)
                parquet_path = month_dir / f"facts-{datetime.now(UTC).strftime('%Y%m%d')}.parquet"

                try:
                    con = duckdb.connect()
                    con.execute(
                        "CREATE TABLE cold AS SELECT * FROM ?",
                        [rows_to_export],
                    )
                    # Append if file already exists (same-day re-runs)
                    if parquet_path.exists():
                        con.execute(
                            f"COPY (SELECT * FROM cold) TO '{parquet_path}' "  # noqa: S608
                            "(FORMAT PARQUET, APPEND_MODE TRUE)"
                        )
                    else:
                        con.execute(
                            f"COPY cold TO '{parquet_path}' (FORMAT PARQUET)"  # noqa: S608
                        )
                    con.close()
                except Exception as exc:
                    log.error("archive_to_cold: Parquet write failed: %s", exc)
                    return deleted

                # Confirmed write -- now delete from ChromaDB + metadata
                ids_written = [r["chroma_id"] for r in rows_to_export]
                try:
                    store.forget_by_ids(ids_written, collection="archive")
                except Exception as exc:
                    log.error("archive_to_cold: forget_by_ids failed after write: %s", exc)
                    return deleted

                for cid in ids_written:
                    episodic.delete_memory_meta(cid)
                deleted += len(ids_written)

                episodic.log_event(
                    "cold_archive_exported",
                    {"count": len(ids_written), "path": str(parquet_path)},
                    session="consolidation",
                )

    # --- Pass 2: orphaned metadata-only rows ---
    orphaned = episodic.orphaned_meta_candidates(_ORPHANED_META_CONFIDENCE_MAX, cutoff)
    if dry_run:
        if orphaned:
            log.info(
                "archive_to_cold: dry_run -- would clean %d orphaned metadata rows"
                " (skipping delete)",
                len(orphaned),
            )
        deleted += len(orphaned)
    else:
        for cid in orphaned:
            episodic.delete_memory_meta(cid)
            deleted += 1

        if orphaned:
            episodic.log_event(
                "cold_archive_meta_cleaned",
                {"count": len(orphaned)},
                session="consolidation",
            )

    return deleted


# ---------------------------------------------------------------------------
# Top-level runner
# ---------------------------------------------------------------------------

def run_all(store: VectorStore) -> ConsolidationResult:
    """Run all four consolidation jobs and return a summary result.

    Errors in any job are caught and logged — the others still run.
    """
    result = ConsolidationResult()
    episodic.init_db()
    episodic.log_event("consolidation_started", {}, session="consolidation")
    _reset_llm_timeouts()

    try:
        result.sessions_summarized = summarize_sessions(store)
    except Exception as e:
        msg = f"summarize_sessions failed: {e}"
        log.error(msg)
        result.errors.append(msg)

    try:
        result.cross_session_facts_stored = consolidate_cross_session(store)
    except Exception as e:
        msg = f"consolidate_cross_session failed: {e}"
        log.error(msg)
        result.errors.append(msg)

    try:
        result.preferences_merged = deduplicate_preferences(store)
    except Exception as e:
        msg = f"deduplicate_preferences failed: {e}"
        log.error(msg)
        result.errors.append(msg)

    try:
        result.entries_archived = decay_knowledge(store)
    except Exception as e:
        msg = f"decay_knowledge failed: {e}"
        log.error(msg)
        result.errors.append(msg)

    try:
        result.task_memory_purged = _purge_task_memory(store)
    except Exception as e:
        msg = f"_purge_task_memory failed: {e}"
        log.error(msg)
        result.errors.append(msg)

    try:
        result.ttl_expired_purged = _prune_expired_ttl(store)
    except Exception as e:
        msg = f"_prune_expired_ttl failed: {e}"
        log.error(msg)
        result.errors.append(msg)

    try:
        result.memories_reflected = reflect_memories(store)
    except Exception as e:
        msg = f"reflect_memories failed: {e}"
        log.error(msg)
        result.errors.append(msg)

    try:
        result.cold_archived = archive_to_cold(store)
    except Exception as e:
        msg = f"archive_to_cold failed: {e}"
        log.error(msg)
        result.errors.append(msg)

    # jarvis#836: self-heal facts orphaned from FTS by a fail-silent index write.
    try:
        backfilled = 0
        for _coll in ("knowledge", "user_profile", "agent_memories", "procedural"):
            backfilled += store.backfill_fts(_coll).get("reindexed", 0)
        result.fts_backfilled = backfilled
    except Exception as e:
        msg = f"backfill_fts failed: {e}"
        log.error(msg)
        result.errors.append(msg)

    timeouts = _reset_llm_timeouts()
    if timeouts > 0:
        result.errors.append(f"_llm_call timed out {timeouts} times")

    episodic.log_event(
        "consolidation_completed",
        {
            "sessions_summarized": result.sessions_summarized,
            "cross_session_facts": result.cross_session_facts_stored,
            "preferences_merged": result.preferences_merged,
            "entries_archived": result.entries_archived,
            "task_memory_purged": result.task_memory_purged,
            "ttl_expired_purged": result.ttl_expired_purged,
            "memories_reflected": result.memories_reflected,
            "cold_archived": result.cold_archived,
            "fts_backfilled": result.fts_backfilled,
            "errors": len(result.errors),
            "llm_timeouts": timeouts,
        },
        session="consolidation",
    )
    return result


# ---------------------------------------------------------------------------
# Recall stats helper (for /recall-stats)
# ---------------------------------------------------------------------------

def recall_stats(n: int = 20) -> list[dict]:
    """Return the top n most-recalled doc IDs with hit counts.

    Each entry: {"id": str, "count": int, "first_seen": str}
    """
    episodic.init_db()
    with episodic._connect() as conn:
        rows = conn.execute(
            "SELECT detail FROM agent_events WHERE event = 'recall_hit'",
        ).fetchall()

    counts: dict[str, int] = {}
    for (detail_str,) in rows:
        if not detail_str:
            continue
        try:
            import json
            ids = json.loads(detail_str).get("ids") or []
            for doc_id in ids:
                counts[str(doc_id)] = counts.get(str(doc_id), 0) + 1
        except Exception:
            continue

    sorted_ids = sorted(counts.items(), key=lambda kv: kv[1], reverse=True)[:n]
    return [{"id": doc_id, "count": cnt} for doc_id, cnt in sorted_ids]
