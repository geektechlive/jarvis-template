"""Tests for FTS5 full-text search in episodic memory and store hybrid routing."""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from harness.memory import episodic


@pytest.fixture(autouse=True)
def temp_db(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENT_DATA_DIR", str(tmp_path))
    episodic.init_db()


@pytest.fixture
def store(monkeypatch, tmp_path):
    monkeypatch.setenv("AGENT_DATA_DIR", str(tmp_path))
    episodic.init_db()
    fake_collection = MagicMock()
    fake_collection.count.return_value = 0
    fake_chroma = MagicMock()
    fake_chroma.get_or_create_collection.return_value = fake_collection
    with (
        patch("harness.memory.store.chromadb.PersistentClient", return_value=fake_chroma),
        patch("harness.memory.store.OllamaEmbeddingFunction"),
    ):
        from harness.memory.store import VectorStore
        s = VectorStore()
        s._test_collection = fake_collection
        yield s


# ---------------------------------------------------------------------------
# FTS5 index CRUD (episodic level)
# ---------------------------------------------------------------------------

def test_index_and_search_memory():
    episodic.index_memory("doc-1", "knowledge", "Python is a dynamically typed language")
    hits = episodic.fts_search('"Python"', collection="knowledge")
    assert len(hits) == 1
    assert hits[0]["chroma_id"] == "doc-1"
    assert "Python" in hits[0]["content"]


def test_fts_search_no_results_for_unknown_term():
    episodic.index_memory("doc-2", "knowledge", "Go is a statically typed language")
    hits = episodic.fts_search('"Haskell"', collection="knowledge")
    assert hits == []


def test_fts_search_filters_by_collection():
    episodic.index_memory("doc-k", "knowledge", "dark mode preference")
    episodic.index_memory("doc-u", "user_profile", "dark mode preference")
    knowledge_hits = episodic.fts_search('"dark"', collection="knowledge")
    user_hits = episodic.fts_search('"dark"', collection="user_profile")
    assert len(knowledge_hits) == 1
    assert knowledge_hits[0]["chroma_id"] == "doc-k"
    assert len(user_hits) == 1
    assert user_hits[0]["chroma_id"] == "doc-u"


def test_fts_search_no_collection_filter_returns_all():
    episodic.index_memory("doc-a", "knowledge", "serverless deployment")
    episodic.index_memory("doc-b", "user_profile", "serverless deployment")
    hits = episodic.fts_search('"serverless"')
    chroma_ids = {h["chroma_id"] for h in hits}
    assert "doc-a" in chroma_ids
    assert "doc-b" in chroma_ids


def test_delete_fts_memory_removes_from_index():
    episodic.index_memory("doc-del", "knowledge", "entry to delete")
    episodic.delete_fts_memory("doc-del")
    hits = episodic.fts_search('"delete"', collection="knowledge")
    assert hits == []


def test_fts_search_respects_limit():
    for i in range(5):
        episodic.index_memory(f"bulk-{i}", "knowledge", f"python tip number {i}")
    hits = episodic.fts_search('"python"', collection="knowledge", limit=3)
    assert len(hits) <= 3


# ---------------------------------------------------------------------------
# Hybrid routing in VectorStore.recall()
# ---------------------------------------------------------------------------

def test_recall_uses_fts_for_quoted_query(store):
    episodic.index_memory("fts-doc", "knowledge", "dark mode is the best setting")
    hits = store._fts_recall('"dark mode"', collection="knowledge", n=5)
    assert any("dark mode" in h for h in hits)


def test_should_use_fts_triggers_on_quoted_string():
    from harness.memory.store import _should_use_fts
    assert _should_use_fts('"dark mode"') is True
    assert _should_use_fts("dark mode") is False
    assert _should_use_fts('what did I say about "Python"?') is True


def test_fts_or_query_keeps_two_char_tokens():
    """jarvis#808: 2-char names/initials (Jo, AJ) must survive into the FTS query;
    only 1-char tokens are dropped."""
    from harness.memory.store import _fts_or_query
    q = _fts_or_query("did Jo and AJ meet x")
    assert '"Jo"' in q
    assert '"AJ"' in q
    assert '"x"' not in q  # 1-char token dropped


def test_recall_falls_back_to_vector_when_fts_empty(store):
    # No FTS entries, but quoted query → should fall back to vector
    store._test_collection.count.return_value = 1
    store._test_collection.query.return_value = {
        "ids": [["vec-id"]],
        "documents": [["vector result"]],
        "distances": [[0.1]],
    }
    results = store.recall(
        '"nonexistent phrase"', collection="knowledge", include_archive=False,
    )
    assert results == ["vector result"]


def test_recall_prefers_fts_over_vector_when_fts_has_results(store):
    episodic.index_memory("fts-hit", "knowledge", "dark mode is a popular setting")
    store._test_collection.count.return_value = 1
    results = store.recall('"dark mode"', collection="knowledge", recency_boost=False)
    # FTS returned a result, so vector query should not be called
    store._test_collection.query.assert_not_called()
    assert any("dark mode" in r for r in results)


def test_forget_removes_entry_from_fts(store):
    episodic.index_memory("forget-doc", "knowledge", "content to forget")
    store.forget("forget-doc", collection="knowledge")
    hits = episodic.fts_search('"forget"', collection="knowledge")
    assert hits == []


def test_forget_by_ids_removes_entries_from_fts(store):
    episodic.index_memory("del-1", "knowledge", "first entry to delete")
    episodic.index_memory("del-2", "knowledge", "second entry to delete")
    store.forget_by_ids(["del-1", "del-2"], collection="knowledge")
    hits = episodic.fts_search('"first entry"', collection="knowledge")
    assert hits == []
