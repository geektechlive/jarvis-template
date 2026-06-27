"""Tests for cross-encoder rerank -- sentence-transformers is mocked throughout."""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest  # noqa: F401

# ---------------------------------------------------------------------------
# _should_use_fts
# ---------------------------------------------------------------------------

def test_should_use_fts_returns_true_for_quoted_query():
    from harness.memory.store import _should_use_fts
    assert _should_use_fts('"dark mode"') is True


def test_should_use_fts_returns_false_for_plain_query():
    from harness.memory.store import _should_use_fts
    assert _should_use_fts("what is dark mode") is False


# ---------------------------------------------------------------------------
# _rerank_enabled
# ---------------------------------------------------------------------------

def test_rerank_enabled_returns_false_by_default():
    from harness.memory.store import _rerank_enabled
    # Default models.yaml has rerank_enabled: false
    assert _rerank_enabled() is False


def test_rerank_enabled_patch_returns_true():
    with patch("harness.memory.store._rerank_enabled", return_value=True):
        from harness.memory.store import _rerank_enabled as fn
        assert fn() is True


# ---------------------------------------------------------------------------
# _rerank_results
# ---------------------------------------------------------------------------

def _mock_encoder_module(mock_encoder: MagicMock) -> MagicMock:
    """Build a sys.modules-compatible mock for sentence_transformers."""
    module = MagicMock()
    module.CrossEncoder = lambda *a, **k: mock_encoder
    return module


def test_rerank_results_orders_by_score():
    import harness.memory.store as store_mod

    store_mod._CROSS_ENCODER = None
    candidates = [("id-1", "low relevance text"), ("id-2", "highly relevant answer")]
    mock_encoder = MagicMock()
    mock_encoder.predict.return_value = [0.2, 0.9]

    with patch.dict("sys.modules", {"sentence_transformers": _mock_encoder_module(mock_encoder)}):
        store_mod._CROSS_ENCODER = None
        result = store_mod._rerank_results("relevant query", candidates, threshold=0.1)

    # id-2 (score 0.9) should come before id-1 (score 0.2)
    assert result[0][0] == "id-2"
    assert result[1][0] == "id-1"


def test_rerank_results_filters_below_threshold():
    import harness.memory.store as store_mod

    store_mod._CROSS_ENCODER = None
    candidates = [("id-1", "low score"), ("id-2", "good score")]
    mock_encoder = MagicMock()
    mock_encoder.predict.return_value = [0.1, 0.8]

    with patch.dict("sys.modules", {"sentence_transformers": _mock_encoder_module(mock_encoder)}):
        store_mod._CROSS_ENCODER = None
        result = store_mod._rerank_results("query", candidates, threshold=0.5)

    # id-1 score 0.1 < 0.5 should be filtered out
    assert len(result) == 1
    assert result[0][0] == "id-2"


def test_rerank_results_falls_back_when_import_fails():
    import harness.memory.store as store_mod

    store_mod._CROSS_ENCODER = None
    candidates = [("id-1", "text one"), ("id-2", "text two")]
    with patch.dict("sys.modules", {"sentence_transformers": None}):
        result = store_mod._rerank_results("query", candidates)

    assert result == candidates


def test_rerank_results_falls_back_on_predict_exception():
    import harness.memory.store as store_mod

    store_mod._CROSS_ENCODER = None
    candidates = [("id-1", "text one"), ("id-2", "text two")]
    mock_encoder = MagicMock()
    mock_encoder.predict.side_effect = RuntimeError("model error")

    with patch.dict("sys.modules", {"sentence_transformers": _mock_encoder_module(mock_encoder)}):
        store_mod._CROSS_ENCODER = None
        result = store_mod._rerank_results("query", candidates)

    assert result == candidates


# ---------------------------------------------------------------------------
# recall_with_ids uses rerank when enabled
# ---------------------------------------------------------------------------

@pytest.fixture
def store_with_rerank(monkeypatch, tmp_path):
    monkeypatch.setenv("AGENT_DATA_DIR", str(tmp_path))
    from harness.memory import episodic
    episodic.init_db()
    fake_collection = MagicMock()
    fake_collection.count.return_value = 2
    fake_collection.query.return_value = {
        "ids": [["id-a", "id-b"]],
        "documents": [["less relevant", "more relevant"]],
        "distances": [[0.3, 0.2]],
    }
    fake_chroma = MagicMock()
    fake_chroma.get_or_create_collection.return_value = fake_collection
    rerank_return = [("id-b", "more relevant"), ("id-a", "less relevant")]
    with (
        patch("harness.memory.store.chromadb.PersistentClient", return_value=fake_chroma),
        patch("harness.memory.store.OllamaEmbeddingFunction"),
        patch("harness.memory.store._rerank_enabled", return_value=True),
        patch("harness.memory.store._rerank_results", return_value=rerank_return),
    ):
        from harness.memory.store import VectorStore
        yield VectorStore()


def test_recall_with_ids_applies_rerank_when_enabled(store_with_rerank):
    results = store_with_rerank.recall_with_ids("a relevant query")
    # rerank mock returns id-b first
    assert results[0][0] == "id-b"
