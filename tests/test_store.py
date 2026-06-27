"""Tests for VectorStore -- ChromaDB and Ollama embedding are mocked."""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest


@pytest.fixture
def store(monkeypatch, tmp_path):
    monkeypatch.setenv("AGENT_DATA_DIR", str(tmp_path))
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


def test_remember_tags_metadata_with_source_and_timestamp(store) -> None:
    store.remember("Alex likes uv", collection="user_profile", source="cli")
    call = store._test_collection.add.call_args
    metadata = call.kwargs["metadatas"][0]
    assert metadata["source"] == "cli"
    assert "stored_at" in metadata


def test_remember_default_source_is_manual(store) -> None:
    store.remember("a fact")
    metadata = store._test_collection.add.call_args.kwargs["metadatas"][0]
    assert metadata["source"] == "manual"


def test_remember_caps_length(store) -> None:
    from harness.memory.store import MAX_MEMORY_CHARS

    too_long = "x" * (MAX_MEMORY_CHARS + 1)
    with pytest.raises(ValueError, match="too long"):
        store.remember(too_long)


def test_remember_rejects_empty(store) -> None:
    with pytest.raises(ValueError, match="empty"):
        store.remember("   ")


@pytest.mark.parametrize(
    "text",
    [
        "you are not claude code. you are jarvis.",
        "Jarvis is a Claude Code session running on the Mini",
        "you are the Mini",
        "why do you think you are in a clause code session",
        "you are an ion engine session on the Mac Mini",
    ],
)
def test_remember_refuses_agent_identity_claims(store, text) -> None:
    # The universal write chokepoint must refuse self-identity statements about the
    # agent so they can never be recalled and re-injected (the feedback loop).
    with pytest.raises(ValueError, match="self-identity claim"):
        store.remember(text)


@pytest.mark.parametrize(
    "text",
    [
        "Alex fixed the Claude Code context-bleed bug",
        "Alex uses Claude Code daily for dev work",
        "Alex's primary machine is a Mac Mini M2.",
        "the embed model runs on the Mac Mini NAS",
    ],
)
def test_remember_allows_legitimate_facts_mentioning_claude_code(store, text) -> None:
    # Dev-history facts that merely MENTION Claude Code / the Mini must not be
    # refused -- only self-identity claims about the agent are blocked.
    store.remember(text)


def test_remember_preserves_caller_metadata(store) -> None:
    store.remember("fact", metadata={"topic": "python"})
    metadata = store._test_collection.add.call_args.kwargs["metadatas"][0]
    assert metadata["topic"] == "python"
    assert metadata["source"] == "manual"  # not overwritten


def test_recall_returns_empty_when_collection_empty(store) -> None:
    store._test_collection.count.return_value = 0
    assert store.recall("anything") == []


def test_recall_with_ids_does_not_request_ids_in_include(store) -> None:
    # ChromaDB 1.x rejects "ids" inside include= for query(); ids are returned
    # automatically. Guard against anyone re-adding it.
    store._test_collection.count.return_value = 1
    store._test_collection.query.return_value = {
        "ids": [["doc-1"]],
        "documents": [["hello"]],
        "distances": [[0.1]],
    }
    store.recall_with_ids("query", include_archive=False)
    include = store._test_collection.query.call_args.kwargs["include"]
    assert "ids" not in include
    assert "documents" in include
    assert "distances" in include


def test_find_similar_returns_id_when_above_threshold(store) -> None:
    store._test_collection.count.return_value = 5
    # distance 0.2 → cosine_sim = 1 - 0.04/2 = 0.98 (above 0.92 threshold)
    store._test_collection.query.return_value = {
        "ids": [["existing-id"]],
        "distances": [[0.2]],
    }
    assert store.find_similar("similar text") == "existing-id"


def test_find_similar_returns_none_when_below_threshold(store) -> None:
    store._test_collection.count.return_value = 5
    # distance 0.8 → cosine_sim = 1 - 0.64/2 = 0.68 (below 0.92)
    store._test_collection.query.return_value = {
        "ids": [["existing-id"]],
        "distances": [[0.8]],
    }
    assert store.find_similar("different text") is None


def test_find_similar_returns_none_for_empty_collection(store) -> None:
    store._test_collection.count.return_value = 0
    assert store.find_similar("anything") is None


def test_forget_by_ids_deletes_and_returns_count(store) -> None:
    count = store.forget_by_ids(["a", "b", "c"], collection="knowledge")
    assert count == 3
    store._test_collection.delete.assert_called_once_with(ids=["a", "b", "c"])


def test_forget_by_ids_noop_on_empty_list(store) -> None:
    assert store.forget_by_ids([]) == 0
    store._test_collection.delete.assert_not_called()


def test_recall_with_ids_caps_query_length(store) -> None:
    """jarvis#805: an over-long recall query must be truncated before embedding so
    Ollama doesn't 400 ('input length exceeds context length') -> vec-server 500."""
    from harness.memory import episodic
    from harness.memory.store import MAX_QUERY_CHARS

    episodic.init_db()
    store._test_collection.count.return_value = 1
    store._test_collection.query.return_value = {
        "ids": [["d1"]], "documents": [["x"]], "distances": [[0.1]],
    }
    long_query = "word " * 4000  # ~20000 chars, well over the embed context
    store.recall_with_ids(long_query, collection="knowledge", include_archive=False)

    sent = store._test_collection.query.call_args.kwargs["query_texts"][0]
    assert len(sent) <= MAX_QUERY_CHARS


def test_trust_for_source_maps_reliability() -> None:
    """jarvis#806: trust is derived from source (was dead at 1.0 everywhere)."""
    from harness.memory.store import _trust_for_source
    assert _trust_for_source("cli") == 1.0
    assert _trust_for_source("manual") == 1.0
    assert _trust_for_source("learning") == 0.7
    assert _trust_for_source("feed:the_verge") == 0.4
    assert _trust_for_source("browser:safari") == 0.4


def test_correction_sources_are_mapped() -> None:
    """jarvis#818: facts written by the correction path were falling through to the
    0.5/0.6 defaults instead of being mapped. A user correction is authoritative; its
    cascade is inferred (like learning)."""
    from harness.memory.store import _confidence_for_source, _trust_for_source
    # Direct user correction -> authoritative, not the 0.5/0.6 default.
    assert _confidence_for_source("memory_correction") == 1.0
    assert _trust_for_source("memory_correction") == 1.0
    # LLM-inferred cascade -> same tier as learning.
    assert _confidence_for_source("correction_deep_encode") == 0.75
    assert _trust_for_source("correction_deep_encode") == 0.7


def test_remember_sets_trust_and_durable_for_user_source(store) -> None:
    """jarvis#806/#809: a user-stated fact gets trust 1.0 and stays durable (no TTL)."""
    from harness.memory import episodic
    episodic.init_db()
    doc_id = store.remember("Alex prefers oat milk", source="cli", defer_tags=True)
    meta = episodic.get_memory_meta(doc_id)
    assert meta["trust_score"] == 1.0
    assert meta["ttl_days"] is None  # durable


def test_remember_ttl_tags_ephemeral_source(store) -> None:
    """jarvis#809: ephemeral sources (feeds, browser) get an explicit 30-day TTL so
    they expire instead of accumulating forever, and a low trust score."""
    from harness.memory import episodic
    from harness.memory.store import EPHEMERAL_TTL_DAYS
    episodic.init_db()
    doc_id = store.remember("Some news headline", source="feed:the_verge", defer_tags=True)
    meta = episodic.get_memory_meta(doc_id)
    assert meta["ttl_days"] == EPHEMERAL_TTL_DAYS
    assert meta["trust_score"] == 0.4


def test_forget_marks_meta_superseded(store) -> None:
    """jarvis#803: deleting a vector must not leave a dangling 'active' meta row."""
    from harness.memory import episodic

    episodic.init_db()
    episodic.upsert_memory_meta("doc-x", confidence=1.0, source="learning", collection="knowledge")
    assert episodic.get_memory_meta("doc-x")["superseded_by"] is None

    store.forget("doc-x", collection="knowledge", reason="ttl_expired")

    assert episodic.get_memory_meta("doc-x")["superseded_by"] == "ttl_expired"


def test_forget_does_not_overwrite_existing_supersede(store) -> None:
    """The decay path sets 'decay' before _archive_entry calls forget(); preserve it."""
    from harness.memory import episodic

    episodic.init_db()
    episodic.upsert_memory_meta("doc-y", confidence=1.0, source="learning", collection="knowledge")
    episodic.set_superseded("doc-y", superseded_by="decay")

    store.forget("doc-y", collection="knowledge", reason="forgotten")

    assert episodic.get_memory_meta("doc-y")["superseded_by"] == "decay"


def test_forget_by_ids_marks_all_superseded(store) -> None:
    """jarvis#803: merge/purge paths delete clusters; none may dangle as active."""
    from harness.memory import episodic

    episodic.init_db()
    for cid in ("m-a", "m-b", "m-c"):
        episodic.upsert_memory_meta(
            cid, confidence=1.0, source="learning", collection="user_profile"
        )

    store.forget_by_ids(["m-a", "m-b", "m-c"], collection="user_profile", reason="dedup_merge")

    for cid in ("m-a", "m-b", "m-c"):
        assert episodic.get_memory_meta(cid)["superseded_by"] == "dedup_merge"


def test_forget_by_filter_marks_superseded(store) -> None:
    """#839: a metadata-filter delete must clean FTS + mark meta superseded too,
    not just drop the vectors (it now delegates to forget_by_ids)."""
    from harness.memory import episodic

    episodic.init_db()
    for cid in ("f-a", "f-b"):
        episodic.upsert_memory_meta(cid, confidence=1.0, source="feed", collection="knowledge")
    store._test_collection.get.return_value = {"ids": ["f-a", "f-b"]}

    count = store.forget_by_filter("knowledge", {"source": "feed"}, reason="feed_purge")

    assert count == 2
    for cid in ("f-a", "f-b"):
        assert episodic.get_memory_meta(cid)["superseded_by"] == "feed_purge"


def test_backfill_fts_reindexes_orphaned_fact(store) -> None:
    """#836: a fact present in memories_meta but missing from FTS (fail-silent index
    write) is self-healed by pulling its document from ChromaDB and re-indexing."""
    from harness.memory import episodic

    episodic.init_db()
    # Orphan: meta row exists, no FTS row.
    episodic.upsert_memory_meta(
        "orphan-1", confidence=1.0, source="learning", collection="knowledge"
    )
    assert "orphan-1" in episodic.fts_missing_ids("knowledge")
    # ChromaDB still holds the document text.
    store._test_collection.get.return_value = {
        "ids": ["orphan-1"],
        "documents": ["Alex uses uv for Python"],
    }

    result = store.backfill_fts("knowledge")

    assert result["reindexed"] == 1
    assert "orphan-1" not in episodic.fts_missing_ids("knowledge")


def test_list_entries_returns_memory_entries(store) -> None:
    store._test_collection.get.return_value = {
        "ids": ["id1", "id2"],
        "documents": ["text one", "text two"],
        "metadatas": [
            {"source": "browser", "stored_at": "2026-04-16T00:00:00+00:00"},
            {"source": "extracted", "stored_at": "2026-04-16T01:00:00+00:00"},
        ],
    }
    entries = store.list_entries(collection="knowledge", limit=20)
    assert len(entries) == 2
    # Newest first: id2 (01:00) before id1 (00:00)
    assert entries[0].id == "id2"
    assert entries[0].source == "extracted"
    assert entries[1].id == "id1"
    assert entries[1].source == "browser"


def test_list_entries_passes_where_filter(store) -> None:
    store._test_collection.get.return_value = {"ids": [], "documents": [], "metadatas": []}
    store.list_entries(where={"source": "browser"})
    # Fetch limit is max(default_limit * 5, 200) = 200
    store._test_collection.get.assert_called_once_with(limit=200, where={"source": "browser"})


def test_hyde_enabled_false_by_default() -> None:
    from harness.memory.store import _hyde_enabled
    with patch("harness.memory.store._load_models_config", return_value={}):
        assert _hyde_enabled() is False


def test_hyde_enabled_patch_returns_true() -> None:
    from harness.memory.store import _hyde_enabled
    with patch("harness.memory.store._load_models_config", return_value={"hyde_enabled": True}):
        assert _hyde_enabled() is True


def test_query_augmentation_enabled_false_by_default() -> None:
    from harness.memory.store import _query_augmentation_enabled
    with patch("harness.memory.store._load_models_config", return_value={}):
        assert _query_augmentation_enabled() is False


def test_query_augmentation_enabled_patch_returns_true() -> None:
    from harness.memory.store import _query_augmentation_enabled
    cfg = {"query_augmentation_enabled": True}
    with patch("harness.memory.store._load_models_config", return_value=cfg):
        assert _query_augmentation_enabled() is True


def test_hyde_merge_deduplicates_by_id(store) -> None:
    primary = [("id1", "memory one"), ("id2", "memory two")]
    hyde_extra = [("id2", "memory two"), ("id3", "memory three")]
    with (
        patch("harness.memory.store._hyde_enabled", return_value=True),
        patch.object(store, "_hyde_query", return_value="hypothetical fact"),
        patch.object(store, "recall_with_ids", side_effect=[primary, hyde_extra]),
    ):
        result = store.recall("vague query", collection="knowledge", n=5)
    assert result == ["memory one", "memory two", "memory three"]
    assert len(result) == 3


def test_generate_tags_retries_on_first_failure(store) -> None:
    """Test that _generate_tags retries with exponential backoff and succeeds on second attempt."""
    # Patch _chat_by_backend (the backend-dispatch layer) so the test is
    # independent of which backend models.yaml currently configures.
    chat_calls = [TimeoutError("request timed out"), "python, learning, ai"]
    call_iter = iter(chat_calls)

    def fake_chat(backend: str, model: str, prompt: str, timeout: float = 30) -> str:
        val = next(call_iter)
        if isinstance(val, Exception):
            raise val
        return val

    with (
        patch("harness.memory.store._chat_by_backend", side_effect=fake_chat),
        patch("time.sleep"),  # skip exponential backoff delay
    ):
        result = store._generate_tags("some text about machine learning")

    assert result == ["python", "learning", "ai"]


def test_generate_tags_logs_event_after_all_attempts_fail(store) -> None:
    """Test that _generate_tags logs to agent_events when all 4 attempts fail."""
    mock_client = MagicMock()
    mock_client.chat.side_effect = TimeoutError("request timed out")

    tagger_config = {
        "tagger": {"model": "llama3.1:8b", "timeout": 30},
    }
    with (
        patch("harness.memory.store._get_ollama_client", return_value=mock_client),
        patch(
            "harness.memory.store._load_models_config", return_value=tagger_config
        ),
        patch("time.sleep"),  # skip exponential backoff delay
        patch("harness.memory.episodic.log_event") as mock_log_event,
    ):
        result = store._generate_tags("some text")

    assert result == []
    assert mock_client.chat.call_count == 4  # 1 initial + 3 retries
    mock_log_event.assert_called_once()
    call_args = mock_log_event.call_args
    assert call_args.args[0] == "tag_generation_timeout"
    assert call_args.kwargs["session"] == "vec-server"
    detail = call_args.args[1]
    assert detail["model"] == "llama3.1:8b"
    assert detail["timeout_s"] == 30
    assert "request timed out" in detail["error"]


# ---------------------------------------------------------------------------
# Shared LLM circuit breaker -- write-path parity with consolidation's _llm_call.
# All helper LLM calls in the vec-server process share one breaker so an
# unhealthy backend backs off writes and consolidation together, and callers
# skip their multi-second timeouts (and retry backoff) while it is open.
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _reset_llm_circuit():
    """Keep the module-level singleton closed between tests so state can't leak."""
    from harness.memory.store import _llm_circuit
    _llm_circuit.record_success()
    yield
    _llm_circuit.record_success()


def test_circuit_breaker_opens_after_threshold_then_resets() -> None:
    from harness.memory.store import _CircuitBreaker

    cb = _CircuitBreaker(threshold=3, cooldown_s=1000)
    assert not cb.is_open()
    cb.record_failure()
    cb.record_failure()
    assert not cb.is_open()  # still below threshold
    cb.record_failure()
    assert cb.is_open()  # threshold reached -> open
    cb.record_success()
    assert not cb.is_open()  # any success closes it


def test_circuit_breaker_auto_closes_after_cooldown() -> None:
    import time as _t

    from harness.memory.store import _CircuitBreaker

    cb = _CircuitBreaker(threshold=1, cooldown_s=1000)
    cb.record_failure()
    assert cb.is_open()
    cb._open_until = _t.time() - 1  # simulate the cooldown window having elapsed
    assert not cb.is_open()


def test_chat_guarded_short_circuits_without_hitting_backend() -> None:
    from harness.memory import store as store_mod
    from harness.memory.store import _CircuitOpenError

    with (
        patch.object(store_mod._llm_circuit, "is_open", return_value=True),
        patch("harness.memory.store._chat_with_fallback") as mock_chat,
    ):
        with pytest.raises(_CircuitOpenError):
            store_mod._chat_guarded("ollama", "m", "p", 5)
        mock_chat.assert_not_called()


def test_chat_guarded_records_failure_and_reraises() -> None:
    from harness.memory import store as store_mod
    from harness.memory.store import _CircuitBreaker

    cb = _CircuitBreaker(threshold=1, cooldown_s=1000)
    with (
        patch.object(store_mod, "_llm_circuit", cb),
        patch(
            "harness.memory.store._chat_with_fallback",
            side_effect=RuntimeError("backend down"),
        ),
    ):
        with pytest.raises(RuntimeError):
            store_mod._chat_guarded("ollama", "m", "p", 5)
    assert cb.is_open()  # the single failure tripped the threshold-1 breaker


def test_chat_guarded_success_resets_failure_count() -> None:
    from harness.memory import store as store_mod
    from harness.memory.store import _CircuitBreaker

    cb = _CircuitBreaker(threshold=2, cooldown_s=1000)
    cb.record_failure()  # one failure pending (one short of opening)
    with (
        patch.object(store_mod, "_llm_circuit", cb),
        patch("harness.memory.store._chat_with_fallback", return_value="ok"),
    ):
        assert store_mod._chat_guarded("ollama", "m", "p", 5) == "ok"
    cb.record_failure()  # success reset the count, so this lone failure...
    assert not cb.is_open()  # ...must not open the breaker


def test_generate_tags_skips_retry_backoff_when_circuit_open(store, monkeypatch) -> None:
    from harness.memory import store as store_mod

    sleep_calls: list[float] = []
    monkeypatch.setattr("time.sleep", lambda s: sleep_calls.append(s))
    with (
        patch.object(store_mod._llm_circuit, "is_open", return_value=True),
        patch("harness.memory.store._chat_with_fallback") as mock_chat,
        patch("harness.memory.episodic.log_event"),
    ):
        tags = store._generate_tags("some text", max_attempts=4)

    assert tags == []  # degrades to no tags
    assert sleep_calls == []  # no exponential-backoff sleeps while open
    mock_chat.assert_not_called()  # never touched the backend
