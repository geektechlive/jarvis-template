"""Tests for archive fallback in recall.

The archive Chroma collection is the cold-storage destination for entries that
decay below the confidence threshold. These tests verify that:

1. When the primary collection returns fewer than n hits, recall tops up from
   archive and prefixes those results with ``[archive] ``.
2. When the primary collection is full, archive is not queried.
3. ``include_archive=False`` disables the fallback (used by consolidation).
4. Archive results bypass the ``superseded_ids`` filter -- archive entries are
   deliberately marked superseded by decay, and surfacing them is the point.
5. Querying the ``archive`` collection directly does not recursively top up
   from itself.
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest


@pytest.fixture
def archive_store(monkeypatch, tmp_path):
    """VectorStore with per-collection mocks so knowledge and archive differ."""
    monkeypatch.setenv("AGENT_DATA_DIR", str(tmp_path))
    from harness.memory import episodic
    episodic.init_db()

    cols: dict[str, MagicMock] = {}

    def factory(name: str, *args, **kwargs):
        if name not in cols:
            m = MagicMock(name=f"col-{name}")
            m.count.return_value = 0
            cols[name] = m
        return cols[name]

    fake_chroma = MagicMock()
    fake_chroma.get_or_create_collection.side_effect = factory

    with (
        patch("harness.memory.store.chromadb.PersistentClient", return_value=fake_chroma),
        patch("harness.memory.store.OllamaEmbeddingFunction"),
    ):
        from harness.memory.store import VectorStore
        s = VectorStore()
        s._cols_map = cols  # type: ignore[attr-defined]
        yield s


def test_archive_hit_is_prefixed_when_primary_thin(archive_store):
    cols = archive_store._cols_map
    cols["knowledge"].count.return_value = 1
    cols["knowledge"].query.return_value = {
        "ids": [["k1"]],
        "documents": [["fresh fact"]],
        "distances": [[0.2]],
    }
    cols["archive"].count.return_value = 1
    cols["archive"].query.return_value = {
        "ids": [["a1"]],
        "documents": [["old fact"]],
        "distances": [[0.3]],
    }
    pairs = archive_store.recall_with_ids("query", collection="knowledge", n=5)
    texts = [text for _, text in pairs]
    assert "fresh fact" in texts
    assert any(t.startswith("[archive] ") and "old fact" in t for t in texts)


def test_archive_not_searched_when_primary_full(archive_store):
    cols = archive_store._cols_map
    cols["knowledge"].count.return_value = 3
    cols["knowledge"].query.return_value = {
        "ids": [["k1", "k2", "k3"]],
        "documents": [["doc1", "doc2", "doc3"]],
        "distances": [[0.1, 0.2, 0.3]],
    }
    cols["archive"].count.return_value = 10
    pairs = archive_store.recall_with_ids("query", collection="knowledge", n=3)
    assert len(pairs) == 3
    assert not any(text.startswith("[archive]") for _, text in pairs)
    cols["archive"].query.assert_not_called()


def test_archive_disabled_when_include_archive_false(archive_store):
    cols = archive_store._cols_map
    cols["knowledge"].count.return_value = 0
    cols["archive"].count.return_value = 5
    pairs = archive_store.recall_with_ids(
        "query", collection="knowledge", n=5, include_archive=False,
    )
    assert pairs == []
    cols["archive"].query.assert_not_called()


def test_archive_surfaces_even_when_superseded(archive_store):
    """Archive entries are marked superseded_by='decay' by design.

    The recall path must not exclude them on that basis when sourced from archive.
    """
    from harness.memory import episodic
    episodic.upsert_memory_meta(
        "a1", confidence=0.1, source="manual", collection="archive",
    )
    episodic.set_superseded("a1", superseded_by="decay")

    cols = archive_store._cols_map
    cols["knowledge"].count.return_value = 0
    cols["archive"].count.return_value = 1
    cols["archive"].query.return_value = {
        "ids": [["a1"]],
        "documents": [["important old fact"]],
        "distances": [[0.2]],
    }
    pairs = archive_store.recall_with_ids("query", collection="knowledge", n=5)
    texts = [text for _, text in pairs]
    assert len(texts) == 1
    assert texts[0].startswith("[archive] ")
    assert "important old fact" in texts[0]


def test_querying_archive_collection_does_not_recurse(archive_store):
    cols = archive_store._cols_map
    cols["archive"].count.return_value = 1
    cols["archive"].query.return_value = {
        "ids": [["a1"]],
        "documents": [["old fact"]],
        "distances": [[0.2]],
    }
    pairs = archive_store.recall_with_ids("query", collection="archive", n=5)
    assert cols["archive"].query.call_count == 1
    texts = [text for _, text in pairs]
    assert texts == ["old fact"]


def test_archive_min_relevance_excludes_weak_matches(archive_store):
    cols = archive_store._cols_map
    cols["knowledge"].count.return_value = 0
    cols["archive"].count.return_value = 1
    # distance 1.5 → cosine ≈ -0.125 → far below min_relevance=0.25
    cols["archive"].query.return_value = {
        "ids": [["weak"]],
        "documents": [["barely related"]],
        "distances": [[1.5]],
    }
    pairs = archive_store.recall_with_ids("query", collection="knowledge", n=5)
    assert pairs == []


def test_recall_strings_include_archive_prefix(archive_store):
    """recall() returns plain strings; verify the [archive] prefix propagates."""
    cols = archive_store._cols_map
    cols["knowledge"].count.return_value = 0
    cols["archive"].count.return_value = 1
    cols["archive"].query.return_value = {
        "ids": [["a1"]],
        "documents": [["old fact"]],
        "distances": [[0.2]],
    }
    results = archive_store.recall("query", collection="knowledge", n=5)
    assert any(r.startswith("[archive] ") for r in results)


def test_fts_recall_tops_up_from_archive(archive_store, monkeypatch):
    """When FTS on the primary collection returns < n hits, top up from archive."""
    from harness.memory import episodic

    def fake_fts_search(query, collection=None, limit=10):
        if collection == "knowledge":
            return [{"chroma_id": "k1", "content": "primary hit"}]
        if collection == "archive":
            return [{"chroma_id": "a1", "content": "long-term hit"}]
        return []

    monkeypatch.setattr(episodic, "fts_search", fake_fts_search)
    monkeypatch.setattr(episodic, "superseded_ids", lambda collection="knowledge": set())

    results = archive_store._fts_recall('"quoted phrase"', collection="knowledge", n=5)
    assert "primary hit" in results
    assert any(r.startswith("[archive] ") and "long-term hit" in r for r in results)
