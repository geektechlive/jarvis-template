"""Tests for confidence-based decay in episodic memory and consolidation."""
from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from harness.consolidation import _DECAY_ARCHIVE_THRESHOLD, _DECAY_DELTA, decay_knowledge
from harness.memory import episodic
from harness.memory.store import MemoryEntry


def _make_entry(
    doc_id: str = "aaa",
    text: str = "Some knowledge",
    source: str = "learning",
    metadata: dict | None = None,
) -> MemoryEntry:
    stored_at = "2026-01-01T00:00:00+00:00"
    return MemoryEntry(
        id=doc_id,
        text=text,
        source=source,
        stored_at=stored_at,
        metadata=metadata or {"source": source, "stored_at": stored_at},
    )


def _make_store(list_entries_return: list | None = None) -> MagicMock:
    store = MagicMock()
    store.remember.return_value = "archived-id"
    entries = list_entries_return or []
    store.list_entries.return_value = entries
    # decay_knowledge now pages via list_entries_page over the WHOLE collection
    # (#858). Return all entries on the first page; the loop stops because the
    # page (<500) is smaller than the page size.
    store.list_entries_page.return_value = entries
    return store


@pytest.fixture(autouse=True)
def temp_db(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENT_DATA_DIR", str(tmp_path))
    episodic.init_db()


# ---------------------------------------------------------------------------
# decay_confidence (episodic level)
# ---------------------------------------------------------------------------

def test_decay_confidence_decrements_by_delta():
    episodic.upsert_memory_meta("doc-1", confidence=0.5, source="manual", collection="knowledge")
    new_conf = episodic.decay_confidence("doc-1")
    assert abs(new_conf - (0.5 - _DECAY_DELTA)) < 0.001


def test_decay_confidence_floors_at_zero():
    episodic.upsert_memory_meta("doc-2", confidence=0.03, source="manual", collection="knowledge")
    new_conf = episodic.decay_confidence("doc-2")
    assert new_conf == 0.0


def test_decay_confidence_returns_zero_for_missing_id():
    result = episodic.decay_confidence("no-such-id")
    assert result == 0.0


def test_decay_archive_threshold_is_02():
    assert abs(_DECAY_ARCHIVE_THRESHOLD - 0.2) < 0.001


# ---------------------------------------------------------------------------
# decay_knowledge — confidence-based archival
# ---------------------------------------------------------------------------

def test_decay_archives_entry_when_confidence_below_threshold():
    episodic.upsert_memory_meta(
        "low-conf", confidence=0.22, source="manual", collection="knowledge"
    )
    entry = _make_entry("low-conf", "Stale low-confidence entry")
    store = _make_store(list_entries_return=[entry])
    # No recall_hit → stale; 0.22 - 0.05 = 0.17 < 0.2 → archive
    archived = decay_knowledge(store, unused_days=1, contradiction_check=False)
    assert archived == 1
    store.forget.assert_called_once_with("low-conf", collection="knowledge", reason="archived")


def test_decay_does_not_archive_above_threshold():
    episodic.upsert_memory_meta("mid-conf", confidence=0.5, source="manual", collection="knowledge")
    entry = _make_entry("mid-conf", "Moderate confidence entry")
    store = _make_store(list_entries_return=[entry])
    archived = decay_knowledge(store, unused_days=1, contradiction_check=False)
    assert archived == 0
    store.forget.assert_not_called()
    meta = episodic.get_memory_meta("mid-conf")
    assert abs(meta["confidence"] - 0.45) < 0.001


def test_decay_skips_recalled_entries():
    episodic.upsert_memory_meta("active", confidence=0.22, source="manual", collection="knowledge")
    episodic.log_event(
        "recall_hit", {"collection": "knowledge", "ids": ["active"]}, session="recall"
    )
    entry = _make_entry("active", "Active entry")
    store = _make_store(list_entries_return=[entry])
    archived = decay_knowledge(store, unused_days=365, contradiction_check=False)
    assert archived == 0


def test_decay_skips_session_summaries():
    episodic.upsert_memory_meta("sum-id", confidence=0.1, source="manual", collection="knowledge")
    summary = _make_entry(
        "sum-id",
        "Session summary",
        metadata={"type": "session_summary", "source": "session:x"},
    )
    store = _make_store(list_entries_return=[summary])
    archived = decay_knowledge(store, unused_days=1, contradiction_check=False)
    assert archived == 0


def test_decay_lazy_creates_meta_for_legacy_entries():
    # Entry has no memories_meta row → decay creates one with confidence=0.5
    entry = _make_entry("legacy-id", "Legacy entry without provenance")
    store = _make_store(list_entries_return=[entry])
    archived = decay_knowledge(store, unused_days=1, contradiction_check=False)
    # 0.5 - 0.05 = 0.45 ≥ 0.2 → not archived yet
    assert archived == 0
    meta = episodic.get_memory_meta("legacy-id")
    assert meta is not None
    assert abs(meta["confidence"] - 0.45) < 0.001


def test_decay_marks_superseded_before_archive():
    episodic.upsert_memory_meta("sup-id", confidence=0.19, source="manual", collection="knowledge")
    entry = _make_entry("sup-id", "About to be superseded")
    store = _make_store(list_entries_return=[entry])
    decay_knowledge(store, unused_days=1, contradiction_check=False)
    meta = episodic.get_memory_meta("sup-id")
    assert meta["superseded_by"] == "decay"


def test_decay_logs_decay_complete_event_when_archiving():
    episodic.upsert_memory_meta("log-id", confidence=0.22, source="manual", collection="knowledge")
    entry = _make_entry("log-id", "Will be archived")
    store = _make_store(list_entries_return=[entry])
    decay_knowledge(store, unused_days=1, contradiction_check=False)
    events = episodic.recent_events(event_type="decay_complete", n=5)
    assert any(e["event"] == "decay_complete" for e in events)


# ---------------------------------------------------------------------------
# superseded entries excluded from recall_with_ids
# ---------------------------------------------------------------------------

def test_superseded_entries_excluded_from_recall(monkeypatch, tmp_path):
    monkeypatch.setenv("AGENT_DATA_DIR", str(tmp_path))
    episodic.init_db()

    from unittest.mock import patch

    episodic.upsert_memory_meta("sup", confidence=0.1, source="manual", collection="knowledge")
    episodic.set_superseded("sup", superseded_by="decay")

    fake_collection = MagicMock()
    fake_collection.count.return_value = 2
    fake_collection.query.return_value = {
        "ids": [["sup", "active"]],
        "documents": [["superseded content", "active content"]],
        "distances": [[0.1, 0.15]],
    }
    fake_chroma = MagicMock()
    fake_chroma.get_or_create_collection.return_value = fake_collection

    with (
        patch("harness.memory.store.chromadb.PersistentClient", return_value=fake_chroma),
        patch("harness.memory.store.OllamaEmbeddingFunction"),
    ):
        from harness.memory.store import VectorStore
        store = VectorStore()
        # include_archive=False keeps this test focused on the superseded
        # filter for the primary collection. Archive fallback is covered by
        # tests/test_archive_recall.py.
        pairs = store.recall_with_ids(
            "some query", collection="knowledge", include_archive=False,
        )

    doc_ids = [eid for eid, _ in pairs]
    assert "sup" not in doc_ids
    assert "active" in doc_ids


def test_decay_pages_through_entries_beyond_the_first_page():
    # #858: an entry that lands on a SECOND page must still be decayed. The old
    # code fetched only the newest 1000 and never reached the oldest entries --
    # exactly the stale ones decay exists to retire. We simulate paging with a
    # full first page (>= page size, so the loop fetches again) followed by a
    # second page holding the entry under test.
    page1 = [_make_entry(f"p1-{i}") for i in range(500)]
    page2 = [_make_entry("beyond-page-1", "A stale entry past the first page")]
    store = MagicMock()
    store.remember.return_value = "archived-id"

    def _page(collection, limit, offset, **_kw):
        if offset == 0:
            return page1
        if offset == 500:
            return page2
        return []

    store.list_entries_page.side_effect = _page

    decay_knowledge(store, unused_days=1, contradiction_check=False)

    # The second-page entry got a meta row lazily created and its confidence
    # decremented -- proof the scan reached past the first page.
    meta = episodic.get_memory_meta("beyond-page-1")
    assert meta is not None
    assert abs(meta["confidence"] - 0.45) < 0.001
