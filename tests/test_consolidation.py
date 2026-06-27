"""Tests for harness.consolidation — cross-session memory consolidation.

All tests run without Ollama or ChromaDB. VectorStore is monkeypatched to a
MagicMock; _chat_by_backend is patched at harness.consolidation._chat_by_backend.
"""
from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from harness.consolidation import (
    ConsolidationResult,
    _llm_call,
    _load_config,
    _parse_stored_at,
    _prune_expired_ttl,
    consolidate_cross_session,
    decay_knowledge,
    deduplicate_preferences,
    recall_stats,
    reflect_memories,
    run_all,
    summarize_sessions,
)
from harness.memory.store import MemoryEntry

FIXTURES = Path(__file__).parent / "fixtures" / "consolidation"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def temp_data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENT_DATA_DIR", str(tmp_path))
    from harness.memory import episodic
    episodic.init_db()


def _make_store(
    remember_return: str = "doc-abc-123",
    find_similar_return: str | None = None,
    list_entries_return: list | None = None,
    recall_with_ids_return: list | None = None,
) -> MagicMock:
    store = MagicMock()
    store.remember.return_value = remember_return
    store.find_similar.return_value = find_similar_return
    store.list_entries.return_value = list_entries_return or []
    # decay_knowledge pages the whole collection via list_entries_page (#858);
    # return all entries on the first page (loop stops as <500 < page size).
    store.list_entries_page.return_value = list_entries_return or []
    store.recall_with_ids.return_value = recall_with_ids_return or []
    store.forget_by_filter.return_value = 0
    store.backfill_fts.return_value = {"checked": 0, "reindexed": 0, "failed": 0}
    return store


def _make_entry(
    doc_id: str = "aaa",
    text: str = "Alex prefers Python",
    source: str = "learning",
    stored_at: str = "2026-01-01T00:00:00+00:00",
    metadata: dict | None = None,
) -> MemoryEntry:
    return MemoryEntry(
        id=doc_id,
        text=text,
        source=source,
        stored_at=stored_at,
        metadata=metadata or {"source": source, "stored_at": stored_at},
    )


# ---------------------------------------------------------------------------
# _load_config
# ---------------------------------------------------------------------------

def test_load_config_returns_dict():
    cfg = _load_config()
    assert isinstance(cfg, dict)
    assert "window_days" in cfg
    assert "dedup_threshold" in cfg
    assert cfg["delete_summarized_messages"] is False


# ---------------------------------------------------------------------------
# summarize_sessions
# ---------------------------------------------------------------------------

@patch("harness.consolidation._chat_by_backend")
def test_summarize_sessions_stores_summaries(mock_chat, tmp_path, monkeypatch):
    monkeypatch.setenv("AGENT_DATA_DIR", str(tmp_path))
    mock_chat.return_value = "Alex worked on the Astro migration."

    store = _make_store()

    # Seed messages_in_window by inserting directly into episodic
    from harness.memory import episodic
    episodic.init_db()
    for msg in [
        ("user", "Working on <your-org> Astro migration"),
        ("assistant", "I can help"),
        ("user", "Using custom CSS"),
    ]:
        episodic.log_message(msg[0], msg[1], session="session_a")

    result = summarize_sessions(store, window_days=30)

    assert result >= 1
    store.remember.assert_called_once()
    call_kwargs = store.remember.call_args
    assert (
        "session_a" in call_kwargs.kwargs.get("source", "")
        or "session:session_a" in str(call_kwargs)
    )


@patch("harness.consolidation._chat_by_backend")
def test_summarize_sessions_skips_already_summarized(mock_chat, tmp_path, monkeypatch):
    monkeypatch.setenv("AGENT_DATA_DIR", str(tmp_path))
    mock_chat.return_value = "Summary text"

    from harness.memory import episodic
    episodic.init_db()
    episodic.log_message("user", "Hello", session="ses1")
    episodic.log_message("assistant", "Hi", session="ses1")
    # Mark as already summarized
    episodic.log_event("session_summarized", {"session": "ses1"}, session="consolidation")

    store = _make_store()
    result = summarize_sessions(store, window_days=30)

    assert result == 0
    store.remember.assert_not_called()


# ---------------------------------------------------------------------------
# consolidate_cross_session
# ---------------------------------------------------------------------------

@patch("harness.consolidation._chat_by_backend")
def test_consolidate_cross_session_stores_themes(mock_chat):
    mock_chat.return_value = (
        "1. Alex consistently prefers custom CSS\n2. Alex is focused on Astro migration"
    )

    entries = [
        _make_entry("s1", "Session A summary", metadata={
            "type": "session_summary", "session": "a",
            "stored_at": "2026-04-20T00:00:00+00:00", "source": "session:a",
        }),
        _make_entry("s2", "Session B summary", metadata={
            "type": "session_summary", "session": "b",
            "stored_at": "2026-04-21T00:00:00+00:00", "source": "session:b",
        }),
    ]
    # Both entries are recent (stored_at in window) — monkeypatch stored_at
    recent = (datetime.now(UTC) - timedelta(days=5)).isoformat()
    for e in entries:
        e.stored_at = recent

    store = _make_store(list_entries_return=entries)
    store.find_similar.return_value = None  # no duplicates

    count = consolidate_cross_session(store, window_days=30)

    assert count == 2
    assert store.remember.call_count == 2


@patch("harness.consolidation._chat_by_backend")
def test_consolidate_cross_session_skips_when_too_few_summaries(mock_chat):
    store = _make_store(list_entries_return=[
        _make_entry("s1", "Only one summary", metadata={"type": "session_summary", "session": "a"}),
    ])
    count = consolidate_cross_session(store, window_days=30)
    assert count == 0
    mock_chat.assert_not_called()


# ---------------------------------------------------------------------------
# deduplicate_preferences
# ---------------------------------------------------------------------------

@patch("harness.consolidation._chat_by_backend")
def test_deduplicate_preferences_merges_cluster(mock_chat):
    mock_chat.return_value = "Alex uses custom CSS, never Tailwind."

    entry_a = _make_entry("id-a", "Alex prefers custom CSS")
    entry_b = _make_entry("id-b", "Alex does not use Tailwind")

    store = _make_store(
        list_entries_return=[entry_a, entry_b],
        recall_with_ids_return=[("id-b", entry_b.text)],
    )

    merged = deduplicate_preferences(store, threshold=0.8)

    assert merged == 2  # both entries in cluster
    store.remember.assert_called_once()
    store.forget_by_ids.assert_called_once_with(
        ["id-a", "id-b"], collection="user_profile", reason="dedup_merge"
    )


@patch("harness.consolidation._chat_by_backend")
def test_deduplicate_preferences_no_cluster(mock_chat):
    entry = _make_entry("id-a", "Alex prefers Python")

    store = _make_store(
        list_entries_return=[entry],
        recall_with_ids_return=[],
    )

    merged = deduplicate_preferences(store, threshold=0.92)

    assert merged == 0
    store.remember.assert_not_called()
    store.forget_by_ids.assert_not_called()


# ---------------------------------------------------------------------------
# decay_knowledge
# ---------------------------------------------------------------------------

def test_decay_archives_low_confidence_entries(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENT_DATA_DIR", str(tmp_path))
    from harness.memory import episodic
    episodic.init_db()

    # Pre-populate memories_meta with confidence just above archive threshold so one
    # decay cycle (- 0.05) pushes stale-id below 0.2 and triggers archive.
    episodic.upsert_memory_meta(
        "stale-id", confidence=0.22, source="manual", collection="knowledge"
    )

    entry_stale = _make_entry("stale-id", "Old knowledge nobody queries")
    entry_active = _make_entry("active-id", "Frequently recalled knowledge")

    # Log a recall_hit for only the active entry
    episodic.log_event(
        "recall_hit",
        {"collection": "knowledge", "ids": ["active-id"]},
        session="recall",
    )

    store = _make_store(list_entries_return=[entry_stale, entry_active])

    archived = decay_knowledge(store, unused_days=1, contradiction_check=False)

    assert archived == 1
    store.remember.assert_called_once()  # stale entry copied to archive
    store.forget.assert_called_once_with("stale-id", collection="knowledge", reason="archived")


def test_decay_decrements_confidence_without_archiving(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENT_DATA_DIR", str(tmp_path))
    from harness.memory import episodic
    episodic.init_db()

    # Entry with moderate confidence -- will be decremented but not archived
    episodic.upsert_memory_meta("mid-id", confidence=0.5, source="manual", collection="knowledge")

    entry = _make_entry("mid-id", "Medium confidence knowledge")
    store = _make_store(list_entries_return=[entry])
    # No recall_hit logged, so entry is stale

    archived = decay_knowledge(store, unused_days=1, contradiction_check=False)

    assert archived == 0
    store.forget.assert_not_called()
    meta = episodic.get_memory_meta("mid-id")
    assert meta is not None
    assert abs(meta["confidence"] - 0.45) < 0.001


def test_decay_skips_session_summaries(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENT_DATA_DIR", str(tmp_path))
    from harness.memory import episodic
    episodic.init_db()

    summary_entry = _make_entry(
        "sum-id",
        "Session summary text",
        metadata={"type": "session_summary", "source": "session:foo"},
    )
    store = _make_store(list_entries_return=[summary_entry])

    archived = decay_knowledge(store, unused_days=1, contradiction_check=False)

    assert archived == 0
    store.forget.assert_not_called()


# ---------------------------------------------------------------------------
# recall_stats
# ---------------------------------------------------------------------------

def test_recall_stats_returns_top_entries(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENT_DATA_DIR", str(tmp_path))
    from harness.memory import episodic
    episodic.init_db()

    episodic.log_event(
        "recall_hit", {"collection": "knowledge", "ids": ["aaa", "bbb"]}, session="recall"
    )
    episodic.log_event(
        "recall_hit", {"collection": "knowledge", "ids": ["aaa"]}, session="recall"
    )
    episodic.log_event(
        "recall_hit", {"collection": "user_profile", "ids": ["ccc"]}, session="recall"
    )

    stats = recall_stats(n=5)

    assert len(stats) >= 2
    top = stats[0]
    assert top["id"] == "aaa"
    assert top["count"] == 2


def test_recall_stats_empty(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENT_DATA_DIR", str(tmp_path))
    from harness.memory import episodic
    episodic.init_db()

    stats = recall_stats()
    assert stats == []


# ---------------------------------------------------------------------------
# run_all
# ---------------------------------------------------------------------------

@patch("harness.consolidation.summarize_sessions")
@patch("harness.consolidation.consolidate_cross_session")
@patch("harness.consolidation.deduplicate_preferences")
@patch("harness.consolidation.decay_knowledge")
def test_run_all_returns_result(mock_decay, mock_dedup, mock_cross, mock_summarize):
    mock_summarize.return_value = 3
    mock_cross.return_value = 2
    mock_dedup.return_value = 1
    mock_decay.return_value = 4

    store = _make_store()
    result = run_all(store)

    assert isinstance(result, ConsolidationResult)
    assert result.sessions_summarized == 3
    assert result.cross_session_facts_stored == 2
    assert result.preferences_merged == 1
    assert result.entries_archived == 4
    assert result.errors == []


@patch("harness.consolidation.summarize_sessions", side_effect=RuntimeError("boom"))
@patch("harness.consolidation.consolidate_cross_session", return_value=0)
@patch("harness.consolidation.deduplicate_preferences", return_value=0)
@patch("harness.consolidation.decay_knowledge", return_value=0)
def test_run_all_captures_errors(mock_decay, mock_dedup, mock_cross, mock_summarize):
    store = _make_store()
    result = run_all(store)

    assert len(result.errors) == 1
    assert "summarize_sessions" in result.errors[0]


# ---------------------------------------------------------------------------
# Fixture files exist and are valid JSON
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("fname", ["session_a.json", "session_b.json", "session_c.json"])
def test_fixture_files_valid(fname):
    path = FIXTURES / fname
    assert path.exists(), f"Missing fixture: {path}"
    data = json.loads(path.read_text())
    assert isinstance(data, list)
    assert len(data) >= 2
    for msg in data:
        assert "role" in msg
        assert "content" in msg


# ---------------------------------------------------------------------------
# #33 bug fixes
# ---------------------------------------------------------------------------

@patch("harness.consolidation._chat_by_backend")
@patch("harness.consolidation._load_models_config")
def test_llm_call_fallback_when_extraction_key_missing(mock_cfg, mock_chat):
    """#33A: missing 'extraction' key must not raise KeyError."""
    mock_cfg.return_value = {}  # no 'extraction' key
    mock_chat.return_value = "summary text"

    result = _llm_call("test prompt")
    # Should not raise and should return the LLM output using the fallback model
    assert result == "summary text"
    mock_chat.assert_called_once()
    # _chat_by_backend(backend, model, prompt, timeout) — model is args[1]
    called_model = mock_chat.call_args.args[1]
    assert called_model == "gemma3:27b"


def test_recall_stats_returns_list_under_busy_db(tmp_path, monkeypatch):
    """#33B: recall_stats returns a list even on an empty db (regression for raw-connect crash)."""
    monkeypatch.setenv("AGENT_DATA_DIR", str(tmp_path))
    from harness.memory import episodic as ep
    ep.init_db()

    result = recall_stats(n=5)

    assert isinstance(result, list)


def test_parse_stored_at_handles_naive_timestamp():
    """#33C: naive timestamps get UTC attached so comparisons don't raise."""
    dt = _parse_stored_at("2025-01-01T00:00:00")
    assert dt.tzinfo is not None
    assert dt.tzinfo == UTC


def test_parse_stored_at_handles_aware_timestamp():
    """#33C: timezone-aware timestamps pass through unchanged."""
    dt = _parse_stored_at("2025-01-01T00:00:00+05:30")
    assert dt.tzinfo is not None


def test_parse_stored_at_handles_malformed():
    """#33C: malformed timestamps return a safe minimum datetime."""
    dt = _parse_stored_at("not-a-date")
    assert dt.tzinfo == UTC


@patch("harness.consolidation._chat_by_backend")
def test_deduplicate_preferences_keeps_originals_on_external_collision(mock_chat):
    """#33D: when merged text collides with an external entry, originals are kept."""
    mock_chat.return_value = "Alex uses custom CSS, never Tailwind."

    entry_a = _make_entry("id-a", "Alex prefers custom CSS")
    entry_b = _make_entry("id-b", "Alex does not use Tailwind")

    # find_similar returns an external entry ID (not in the cluster)
    store = _make_store(
        remember_return="doc-abc-123",
        find_similar_return="external-id-999",
        list_entries_return=[entry_a, entry_b],
        recall_with_ids_return=[("id-b", entry_b.text)],
    )

    deduplicate_preferences(store, threshold=0.8)

    store.remember.assert_not_called()
    store.forget_by_ids.assert_not_called()


# ---------------------------------------------------------------------------
# reflect_memories (#12 — hindsight pass)
# ---------------------------------------------------------------------------


@patch("harness.consolidation._chat_by_backend")
def test_reflect_memories_synthesises_related_cluster(mock_chat):
    mock_chat.return_value = (
        "Alex consistently uses dark mode with Ghostty as his primary terminal."
    )

    entry_a = _make_entry("ra-a", "Alex prefers dark mode in all UIs")
    entry_b = _make_entry("ra-b", "Alex uses Ghostty terminal with dark theme")

    store = _make_store(
        list_entries_return=[entry_a, entry_b],
        find_similar_return=None,
    )
    # First call: band query (min_relevance=0.55) → returns the pair.
    # Second call: near-dupe exclusion (min_relevance=0.87) → returns empty.
    store.recall_with_ids.side_effect = [[("ra-b", entry_b.text)], []]

    improved = reflect_memories(store, collection="knowledge")

    assert improved == 2  # both originals replaced
    store.remember.assert_called_once()
    call_kwargs = store.remember.call_args
    assert call_kwargs.kwargs.get("source") == "reflect_pass"
    store.forget_by_ids.assert_called_once_with(["ra-a", "ra-b"], collection="knowledge")


@patch("harness.consolidation._chat_by_backend")
def test_reflect_memories_skips_when_llm_returns_no_improvement(mock_chat):
    mock_chat.return_value = "NO_IMPROVEMENT"

    entry_a = _make_entry("nb-a", "Alex likes Python")
    entry_b = _make_entry("nb-b", "Alex uses Go for the ion daemon")

    store = _make_store(
        list_entries_return=[entry_a, entry_b],
        recall_with_ids_return=[("nb-b", entry_b.text)],
    )

    improved = reflect_memories(store, collection="knowledge")

    assert improved == 0
    store.remember.assert_not_called()
    store.forget_by_ids.assert_not_called()


@patch("harness.consolidation._chat_by_backend")
def test_reflect_memories_skips_on_external_collision(mock_chat):
    mock_chat.return_value = "Alex uses dark mode everywhere."

    entry_a = _make_entry("col-a", "Alex prefers dark mode")
    entry_b = _make_entry("col-b", "Alex sets dark mode in Ghostty")

    store = _make_store(
        list_entries_return=[entry_a, entry_b],
        recall_with_ids_return=[("col-b", entry_b.text)],
        find_similar_return="external-collision-id",
    )

    improved = reflect_memories(store, collection="knowledge")

    assert improved == 0
    store.remember.assert_not_called()


@patch("harness.consolidation._chat_by_backend")
def test_reflect_memories_respects_max_clusters(mock_chat):
    mock_chat.return_value = "NO_IMPROVEMENT"

    entries = [_make_entry(f"mc-{i}", f"Fact number {i}") for i in range(10)]
    store = _make_store(
        list_entries_return=entries,
        recall_with_ids_return=[("mc-1", "Fact number 1")],
    )

    reflect_memories(store, collection="knowledge", max_clusters=3)

    assert mock_chat.call_count <= 3


def test_reflect_memories_empty_store_returns_zero():
    store = _make_store(list_entries_return=[])
    improved = reflect_memories(store, collection="knowledge")
    assert improved == 0


@patch("harness.consolidation.summarize_sessions")
@patch("harness.consolidation.consolidate_cross_session")
@patch("harness.consolidation.deduplicate_preferences")
@patch("harness.consolidation.decay_knowledge")
@patch("harness.consolidation.reflect_memories")
def test_run_all_includes_memories_reflected(
    mock_reflect, mock_decay, mock_dedup, mock_cross, mock_summarize
):
    mock_summarize.return_value = 1
    mock_cross.return_value = 0
    mock_dedup.return_value = 0
    mock_decay.return_value = 0
    mock_reflect.return_value = 4

    store = _make_store()
    result = run_all(store)

    assert result.memories_reflected == 4
    mock_reflect.assert_called_once_with(store)


# ---------------------------------------------------------------------------
# TTL pruning (_prune_expired_ttl)
# ---------------------------------------------------------------------------


def test_prune_expired_ttl_deletes_expired_entries(tmp_path, monkeypatch):
    """Test that entries with ttl_days set are pruned when expired."""
    monkeypatch.setenv("AGENT_DATA_DIR", str(tmp_path))
    from harness.memory import episodic

    episodic.init_db()

    # Create a mock store with entries that have TTL metadata
    now = datetime.now(UTC)
    five_days_ago = now - timedelta(days=5)
    thirty_days_ago = now - timedelta(days=30)
    ninety_days_ago = now - timedelta(days=90)

    store = MagicMock()

    # Entry 1: TTL 30 days, created 5 days ago -> should NOT be pruned
    entry_1 = _make_entry(
        doc_id="entry-1",
        text="Recent RSS item",
        source="rss",
        stored_at=five_days_ago.isoformat(),
    )

    # Entry 2: TTL 30 days, created 90 days ago -> SHOULD be pruned
    entry_2 = _make_entry(
        doc_id="entry-2",
        text="Old RSS item",
        source="rss",
        stored_at=ninety_days_ago.isoformat(),
    )

    # Entry 3: TTL 7 days, created 30 days ago -> SHOULD be pruned
    entry_3 = _make_entry(
        doc_id="entry-3",
        text="Very old RSS item",
        source="rss",
        stored_at=thirty_days_ago.isoformat(),
    )

    # list_entries is called once per collection: knowledge, news, archive, agent_memories.
    # Only return entries for the first call, empty for the rest.
    store.list_entries.side_effect = [[entry_1, entry_2, entry_3], [], [], []]
    store.forget.return_value = None

    # Mock episodic to return TTL metadata (the code reads via get_memory_meta_bulk).
    # created_at drives expiry -- the prune reads it from the SQLite meta row, NOT
    # from entry.stored_at (which for TS-written rows is a non-ISO stamped string).
    bulk_meta = {
        "entry-1": {"ttl_days": 30, "created_at": five_days_ago.isoformat()},
        "entry-2": {"ttl_days": 30, "created_at": ninety_days_ago.isoformat()},
        "entry-3": {"ttl_days": 7, "created_at": thirty_days_ago.isoformat()},
    }
    with patch("harness.consolidation.episodic.get_memory_meta_bulk", return_value=bulk_meta):
        purged = _prune_expired_ttl(store, default_ttl_days=30)

    # Entry 2 and 3 should be pruned (only entries with explicit ttl_days expire)
    assert purged == 2
    assert store.forget.call_count == 2
    # Verify the right entries were forgotten, labeled ttl_expired (jarvis#803)
    forget_calls = [call[0][0] for call in store.forget.call_args_list]
    assert "entry-2" in forget_calls
    assert "entry-3" in forget_calls
    for call in store.forget.call_args_list:
        assert call.kwargs.get("reason") == "ttl_expired"


def test_prune_expired_ttl_uses_created_at_not_stamped_stored_at():
    """jarvis#850 regression: TS-written rows store stored_at as a non-ISO stamped
    string ("[YYYY-MM-DD HH:MM TZ] <text>"). The prune must read created_at from the
    SQLite meta row instead -- otherwise fromisoformat raises and the entry (and its
    TTL) is silently skipped, leaving the news/feed TTL purely decorative."""
    store = MagicMock()
    now = datetime.now(UTC)
    ninety_days_ago = now - timedelta(days=90)

    # stored_at is the caller-stamped string that fromisoformat CANNOT parse.
    entry = _make_entry(
        doc_id="news-1",
        text="[technology] Some headline: a description",
        source="feed:the-verge",
        stored_at="[2026-03-01 09:15 CST] [technology] Some headline: a description",
    )
    store.list_entries.side_effect = [[entry], [], [], []]
    store.forget.return_value = None

    # The meta row carries a real UTC ISO created_at 90 days old + a 14-day TTL.
    bulk_meta = {"news-1": {"ttl_days": 14, "created_at": ninety_days_ago.isoformat()}}
    with patch("harness.consolidation.episodic.get_memory_meta_bulk", return_value=bulk_meta):
        purged = _prune_expired_ttl(store, default_ttl_days=30)

    assert purged == 1
    store.forget.assert_called_once()
    assert store.forget.call_args.kwargs.get("reason") == "ttl_expired"


def test_prune_expired_ttl_no_ttl_fields_returns_zero():
    """Entries without an explicit ttl_days are durable and never pruned (jarvis#822)."""
    store = MagicMock()
    # Entry with recent date (5 days ago)
    now = datetime.now(UTC)
    recent_date = now - timedelta(days=5)
    entry = _make_entry(
        doc_id="no-ttl",
        text="Entry without TTL",
        stored_at=recent_date.isoformat(),
    )
    # Side effect for 3 collection calls: knowledge, archive, agent_memories
    store.list_entries.side_effect = [[entry], [], [], []]

    with patch("harness.consolidation.episodic.get_memory_meta_bulk", return_value={}):
        purged = _prune_expired_ttl(store, default_ttl_days=30)

    assert purged == 0
    store.forget.assert_not_called()


def test_prune_expired_ttl_does_not_purge_untagged_durable_entries():
    """jarvis#822: an OLD untagged entry must NOT be purged. The prior code applied
    the 30-day default to every untagged row, silently deleting durable knowledge.
    The documented contract (integrations.yaml) is: no ttl_days field => not pruned."""
    now = datetime.now(UTC)
    old_date = now - timedelta(days=50)

    store = MagicMock()
    entry = _make_entry(
        doc_id="durable-fact",
        text="A durable learned fact, 50 days old",
        stored_at=old_date.isoformat(),
    )
    store.list_entries.side_effect = [[entry], [], [], []]

    # No ttl_days in metadata -> must be treated as durable, not expired
    with patch("harness.consolidation.episodic.get_memory_meta_bulk", return_value={}):
        purged = _prune_expired_ttl(store, default_ttl_days=30)

    assert purged == 0
    store.forget.assert_not_called()
