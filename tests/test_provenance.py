"""Tests for memories_meta provenance table and write-through from VectorStore.remember()."""
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
# memories_meta CRUD
# ---------------------------------------------------------------------------

def test_upsert_and_get_memory_meta():
    episodic.upsert_memory_meta(
        "doc-1", confidence=0.8, source="cli", collection="knowledge", tags=["python"]
    )
    meta = episodic.get_memory_meta("doc-1")
    assert meta is not None
    assert meta["chroma_id"] == "doc-1"
    assert abs(meta["confidence"] - 0.8) < 0.001
    assert meta["source"] == "cli"
    assert meta["collection"] == "knowledge"
    assert meta["tags"] == ["python"]
    assert meta["access_count"] == 0
    assert meta["superseded_by"] is None


def test_upsert_is_idempotent():
    episodic.upsert_memory_meta("doc-2", confidence=1.0, source="tui", collection="user_profile")
    episodic.upsert_memory_meta(
        "doc-2", confidence=0.5, source="learning", collection="user_profile"
    )
    meta = episodic.get_memory_meta("doc-2")
    # Second call updates confidence and source
    assert abs(meta["confidence"] - 0.5) < 0.001
    assert meta["source"] == "learning"


def test_get_memory_meta_returns_none_for_unknown():
    assert episodic.get_memory_meta("no-such-id") is None


def test_bump_access_increments_count():
    episodic.upsert_memory_meta("doc-3", confidence=1.0, source="manual", collection="knowledge")
    episodic.bump_access("doc-3")
    episodic.bump_access("doc-3")
    meta = episodic.get_memory_meta("doc-3")
    assert meta["access_count"] == 2
    assert meta["last_accessed_at"] is not None


def test_bump_access_lazy_creates_row_for_legacy_entry():
    # No prior upsert — bump_access should create a row with default confidence
    episodic.bump_access("legacy-id")
    meta = episodic.get_memory_meta("legacy-id")
    assert meta is not None
    assert meta["access_count"] == 1
    assert abs(meta["confidence"] - 0.5) < 0.001


def test_set_superseded_marks_entry():
    episodic.upsert_memory_meta("doc-4", confidence=1.0, source="cli", collection="knowledge")
    episodic.set_superseded("doc-4", superseded_by="decay")
    meta = episodic.get_memory_meta("doc-4")
    assert meta["superseded_by"] == "decay"


def test_superseded_ids_returns_marked_entries():
    episodic.upsert_memory_meta("sup-1", confidence=1.0, source="cli", collection="knowledge")
    episodic.upsert_memory_meta("sup-2", confidence=1.0, source="cli", collection="knowledge")
    episodic.upsert_memory_meta("active", confidence=1.0, source="cli", collection="knowledge")
    episodic.set_superseded("sup-1")
    episodic.set_superseded("sup-2")
    ids = episodic.superseded_ids(collection="knowledge")
    assert "sup-1" in ids
    assert "sup-2" in ids
    assert "active" not in ids


def test_superseded_ids_filters_by_collection():
    episodic.upsert_memory_meta("k1", confidence=1.0, source="cli", collection="knowledge")
    episodic.upsert_memory_meta("u1", confidence=1.0, source="cli", collection="user_profile")
    episodic.set_superseded("k1")
    episodic.set_superseded("u1")
    knowledge_ids = episodic.superseded_ids(collection="knowledge")
    assert "k1" in knowledge_ids
    assert "u1" not in knowledge_ids


# ---------------------------------------------------------------------------
# Confidence write-through from VectorStore.remember()
# ---------------------------------------------------------------------------

def test_remember_writes_provenance_row(store):
    store._test_collection.count.return_value = 0
    doc_id = store.remember("user prefers dark mode", collection="user_profile", source="cli")
    meta = episodic.get_memory_meta(doc_id)
    assert meta is not None
    assert abs(meta["confidence"] - 1.0) < 0.001  # cli → 1.0
    assert meta["source"] == "cli"
    assert meta["collection"] == "user_profile"


def test_remember_confidence_for_mail_source(store):
    store._test_collection.count.return_value = 0
    doc_id = store.remember(
        "newsletter from noreply@foo.com", collection="knowledge", source="mail:apple"
    )
    meta = episodic.get_memory_meta(doc_id)
    assert meta is not None
    assert abs(meta["confidence"] - 0.5) < 0.001


def test_remember_confidence_for_browser_source(store):
    store._test_collection.count.return_value = 0
    doc_id = store.remember("visited python.org", collection="knowledge", source="browser:safari")
    meta = episodic.get_memory_meta(doc_id)
    assert meta is not None
    assert abs(meta["confidence"] - 0.3) < 0.001


def test_remember_confidence_for_learning_source(store):
    store._test_collection.count.return_value = 0
    doc_id = store.remember("user uses vim", collection="user_profile", source="learning")
    meta = episodic.get_memory_meta(doc_id)
    assert meta is not None
    assert abs(meta["confidence"] - 0.75) < 0.001


def test_remember_returns_existing_id_on_near_duplicate(store):
    # Simulate near-duplicate detection: _find_near_duplicate returns an existing id
    store._test_collection.count.return_value = 3
    # distance 0.2 → cosine = 1 - 0.04/2 = 0.98 ≥ 0.85
    store._test_collection.query.return_value = {
        "ids": [["existing-id"]],
        "distances": [[0.2]],
    }
    result_id = store.remember("nearly identical fact", source="cli")
    assert result_id == "existing-id"
    # ChromaDB.add should NOT have been called (no new insert)
    store._test_collection.add.assert_not_called()
