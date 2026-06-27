"""Tests for tools-py/vector-store/server.py.

ChromaDB, Ollama, and VectorStore are all mocked -- no external services required.
The HTTP server is spun up on port 0 (OS picks) for each test via a pytest fixture.
"""
from __future__ import annotations

import importlib.util
import json
import sys
import threading
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# Load the server module once at import time (importlib, no __init__.py).
# ---------------------------------------------------------------------------

def _load_server():
    spec = importlib.util.spec_from_file_location(
        "vecstore_server",
        Path(__file__).parent.parent / "tools-py/vector-store/server.py",
    )
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    sys.modules["vecstore_server"] = mod
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


SERVER_MOD = _load_server()


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------

def _post(port: int, path: str, body: dict) -> tuple[int, dict]:
    conn = HTTPConnection("127.0.0.1", port)
    payload = json.dumps(body).encode()
    conn.request(
        "POST",
        path,
        body=payload,
        headers={"Content-Type": "application/json", "Content-Length": str(len(payload))},
    )
    resp = conn.getresponse()
    data = json.loads(resp.read())
    conn.close()
    return resp.status, data


def _get(port: int, path: str) -> tuple[int, dict]:
    conn = HTTPConnection("127.0.0.1", port)
    conn.request("GET", path)
    resp = conn.getresponse()
    data = json.loads(resp.read())
    conn.close()
    return resp.status, data


# ---------------------------------------------------------------------------
# Fixture
# ---------------------------------------------------------------------------

@pytest.fixture
def server():
    mod = SERVER_MOD
    mock_store = MagicMock()
    # Prevent real backfill threads from calling _generate_tags (returns truthy
    # MagicMock by default which then gets iterated and may log warnings).
    mock_store._generate_tags.return_value = []
    with patch.object(mod, "store", return_value=mock_store):
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), mod.Handler)
        t = threading.Thread(target=httpd.serve_forever, daemon=True)
        t.start()
        port = httpd.server_address[1]
        yield port, mock_store
        httpd.shutdown()


# ---------------------------------------------------------------------------
# POST /recall
# ---------------------------------------------------------------------------

def test_recall_returns_results(server) -> None:
    # Arrange
    port, mock_store = server
    mock_store.recall.return_value = [{"text": "hi"}]

    # Act
    status, data = _post(port, "/recall", {"query": "hello", "collection": "knowledge", "n": 3})

    # Assert
    assert status == 200
    assert data["results"] == [{"text": "hi"}]
    assert "elapsed_ms" in data


def test_recall_missing_query_returns_400(server) -> None:
    port, _ = server
    status, data = _post(port, "/recall", {})
    assert status == 400
    assert "error" in data


def test_recall_n_too_large_returns_400(server) -> None:
    port, _ = server
    status, data = _post(port, "/recall", {"query": "x", "n": 999})
    assert status == 400
    assert "error" in data


def test_recall_n_not_integer_returns_400(server) -> None:
    port, _ = server
    status, data = _post(port, "/recall", {"query": "x", "n": "bad"})
    assert status == 400
    assert "error" in data


# ---------------------------------------------------------------------------
# POST /remember
# ---------------------------------------------------------------------------

def test_remember_returns_doc_id(server) -> None:
    port, mock_store = server
    mock_store.remember.return_value = "abc123"

    status, data = _post(port, "/remember", {"text": "hello", "collection": "knowledge"})

    assert status == 200
    assert data["id"] == "abc123"


def test_remember_missing_text_returns_400(server) -> None:
    port, _ = server
    status, data = _post(port, "/remember", {})
    assert status == 400
    assert "error" in data


def test_remember_value_error_returns_422(server) -> None:
    port, mock_store = server
    mock_store.remember.side_effect = ValueError("too long")

    status, data = _post(port, "/remember", {"text": "hello"})

    assert status == 422
    assert "too long" in data["error"]


def test_remember_spawns_backfill_thread(server) -> None:
    port, mock_store = server
    mock_store.remember.return_value = "doc99"

    # Patch threading inside the server module so we can intercept Thread creation.
    mock_thread_instance = MagicMock()
    mock_thread_cls = MagicMock(return_value=mock_thread_instance)
    with patch.object(SERVER_MOD, "threading") as mock_threading:
        # ThreadingHTTPServer uses threading internally; preserve the Event/Lock
        # attributes used by serve_forever (already running in background thread).
        mock_threading.Thread = mock_thread_cls
        mock_threading.Lock = threading.Lock

        status, data = _post(port, "/remember", {"text": "background test"})

    assert status == 200
    mock_thread_cls.assert_called_once()
    mock_thread_instance.start.assert_called_once()


# ---------------------------------------------------------------------------
# POST /forget
# ---------------------------------------------------------------------------

def test_forget_deletes_matching_entry(server) -> None:
    port, mock_store = server
    mock_store.recall_with_ids.return_value = [("id1", "text")]

    status, data = _post(port, "/forget", {"text": "foo"})

    assert status == 200
    assert data["deleted"] is True
    assert data["id"] == "id1"


def test_forget_no_match_returns_deleted_false(server) -> None:
    port, mock_store = server
    mock_store.recall_with_ids.return_value = []

    status, data = _post(port, "/forget", {"text": "nope"})

    assert status == 200
    assert data["deleted"] is False


def test_forget_missing_text_returns_400(server) -> None:
    port, _ = server
    status, data = _post(port, "/forget", {})
    assert status == 400
    assert "error" in data


# ---------------------------------------------------------------------------
# POST /consolidate
# ---------------------------------------------------------------------------

def test_consolidate_runs_and_returns_result(server) -> None:
    port, mock_store = server
    mock_result = SimpleNamespace(
        sessions_summarized=1,
        cross_session_facts_stored=2,
        preferences_merged=0,
        entries_archived=3,
        errors=[],
    )
    with patch.object(SERVER_MOD, "consolidation") as mock_consolidation:
        mock_consolidation.run_all.return_value = mock_result
        status, data = _post(port, "/consolidate", {})

    assert status == 200
    assert data["sessions_summarized"] == 1


# ---------------------------------------------------------------------------
# GET /health
# ---------------------------------------------------------------------------

def test_health_ok(server) -> None:
    port, mock_store = server
    # No side_effect means heartbeat() and _ef() return normally.
    status, data = _get(port, "/health")
    assert status == 200
    assert data["status"] == "ok"


def test_health_chromadb_down_returns_503(server) -> None:
    port, mock_store = server
    mock_store._client.heartbeat.side_effect = Exception("chroma down")

    status, data = _get(port, "/health")

    assert status == 503
    assert data["component"] == "chromadb"


def test_health_ollama_down_returns_503(server) -> None:
    port, mock_store = server
    mock_store._client.heartbeat.return_value = None  # heartbeat ok
    mock_store._ef.side_effect = Exception("ollama down")

    status, data = _get(port, "/health")

    assert status == 503
    assert data["component"] == "ollama-embed"


# ---------------------------------------------------------------------------
# GET /probe (external dependency latency)
# ---------------------------------------------------------------------------

def test_probe_returns_per_dependency_latency(server) -> None:
    port, mock_store = server
    # graph disabled -> graph_ok is None (not applicable); chroma + embed ok.
    with patch.object(SERVER_MOD.graph_client, "is_enabled", return_value=False):
        status, data = _get(port, "/probe")
    assert status == 200
    assert data["chroma_ok"] is True
    assert data["embed_ok"] is True
    assert isinstance(data["chroma_ms"], (int, float))
    assert isinstance(data["embed_ms"], (int, float))
    assert data["graph_ok"] is None  # disabled == not applicable


def test_probe_reports_chroma_down_without_failing(server) -> None:
    port, mock_store = server
    mock_store._client.heartbeat.side_effect = Exception("chroma down")
    with patch.object(SERVER_MOD.graph_client, "is_enabled", return_value=False):
        status, data = _get(port, "/probe")
    # /probe always returns 200; the component carries the failure.
    assert status == 200
    assert data["chroma_ok"] is False
    assert data["chroma_ms"] is None
    assert data["embed_ok"] is True


def test_probe_times_graph_when_enabled(server) -> None:
    port, mock_store = server
    with patch.object(SERVER_MOD.graph_client, "is_enabled", return_value=True), \
         patch.object(SERVER_MOD.graph_client, "ping", return_value=True):
        status, data = _get(port, "/probe")
    assert status == 200
    assert data["graph_ok"] is True
    assert isinstance(data["graph_ms"], (int, float))


# ---------------------------------------------------------------------------
# GET /integrity (jarvis#811a)
# ---------------------------------------------------------------------------

def test_integrity_reports_dangling_and_coverage(server, tmp_path, monkeypatch) -> None:
    port, mock_store = server
    monkeypatch.setenv("AGENT_DATA_DIR", str(tmp_path))
    from harness.memory import episodic

    episodic.init_db()
    # v1: active + has a live vector; v2: active but NO vector (dangling); v3: superseded
    episodic.upsert_memory_meta("v1", confidence=1.0, source="learning", collection="knowledge")
    episodic.upsert_memory_meta("v2", confidence=1.0, source="learning", collection="knowledge")
    episodic.upsert_memory_meta("v3", confidence=1.0, source="learning", collection="knowledge")
    episodic.set_superseded("v3", superseded_by="decay")
    episodic.index_memory("v1", "knowledge", "hello world")  # one FTS row

    fake_col = MagicMock()
    fake_col.name = "knowledge"
    fake_col.get.return_value = {"ids": ["v1"]}  # chroma only has v1 live
    mock_store._client.list_collections.return_value = [fake_col]

    status, data = _get(port, "/integrity")

    assert status == 200
    assert data["active_meta"] == 2       # v1, v2
    assert data["live_vectors"] == 1      # v1
    assert data["dangling_active"] == 1   # v2 active but no vector
    assert data["superseded"] == 1        # v3
    assert data["fts_rows"] == 1
    assert data["fts_coverage_pct"] == 100.0  # 1 fts / 1 live vector


# ---------------------------------------------------------------------------
# GET /list
# ---------------------------------------------------------------------------

def test_list_returns_entries(server) -> None:
    port, mock_store = server
    entry = MagicMock()
    entry.id = "x1"
    entry.text = "hello world"
    entry.source = "manual"
    entry.stored_at = "2026-01-01"
    mock_store.list_entries.return_value = [entry]

    status, data = _get(port, "/list?collection=knowledge&limit=5")

    assert status == 200
    assert len(data["entries"]) == 1
    assert data["entries"][0]["id"] == "x1"
    assert data["entries"][0]["text"] == "hello world"


def test_list_invalid_limit_returns_400(server) -> None:
    port, _ = server
    status, data = _get(port, "/list?limit=abc")
    assert status == 400
    assert "error" in data


# ---------------------------------------------------------------------------
# GET /stats
# ---------------------------------------------------------------------------

def test_stats_returns_hits(server) -> None:
    port, _ = server
    with patch.object(SERVER_MOD, "consolidation") as mock_consolidation:
        mock_consolidation.recall_stats.return_value = [{"text": "x", "count": 5}]
        status, data = _get(port, "/stats")

    assert status == 200
    assert "hits" in data
    assert data["hits"] == [{"text": "x", "count": 5}]


# ---------------------------------------------------------------------------
# Unknown paths
# ---------------------------------------------------------------------------

def test_unknown_post_returns_404(server) -> None:
    port, _ = server
    status, data = _post(port, "/nonexistent", {})
    assert status == 404


def test_unknown_get_returns_404(server) -> None:
    port, _ = server
    status, data = _get(port, "/nonexistent")
    assert status == 404


# ---------------------------------------------------------------------------
# Direct call: _backfill_tags_locked
# ---------------------------------------------------------------------------

def test_backfill_tags_acquires_write_lock() -> None:
    # Arrange
    mod = SERVER_MOD
    mock_store = MagicMock()
    tags = ["tag1", "tag2"]
    mock_store._generate_tags.return_value = tags

    # Simulate col.get() returning existing metadata.
    mock_col = MagicMock()
    mock_col.get.return_value = {"metadatas": [{"confidence": 0.7, "source": "manual"}]}
    mock_store._cols.__getitem__.return_value = mock_col

    doc_id = "doc-abc"
    text = "some remembered text"
    collection = "knowledge"

    # Patch out the episodic import so no SQLite is needed.
    with patch.dict(sys.modules, {"harness.memory.episodic": MagicMock()}):
        # Act
        mod._backfill_tags_locked(mock_store, doc_id, text, collection)

    # Assert: tags were generated (with max_attempts=1 -- backfill is best-effort)
    # and ChromaDB was updated with a tags key.
    mock_store._generate_tags.assert_called_once_with(text, max_attempts=1)
    mock_col.update.assert_called_once()
    update_kwargs = mock_col.update.call_args
    if update_kwargs.args:
        meta_arg = update_kwargs.kwargs.get("metadatas") or update_kwargs.args[1]
    else:
        meta_arg = update_kwargs.kwargs["metadatas"]
    assert meta_arg[0]["tags"] == json.dumps(tags)


# ---------------------------------------------------------------------------
# Threaded-server robustness: malformed body + concurrency
# ---------------------------------------------------------------------------


def _post_raw(port: int, path: str, raw: bytes) -> tuple[int, dict]:
    """POST a raw (possibly non-JSON) body, bypassing the json-encoding _post."""
    conn = HTTPConnection("127.0.0.1", port)
    conn.request(
        "POST",
        path,
        body=raw,
        headers={"Content-Type": "application/json", "Content-Length": str(len(raw))},
    )
    resp = conn.getresponse()
    data = json.loads(resp.read())
    conn.close()
    return resp.status, data


def test_malformed_json_body_returns_400(server) -> None:
    """A malformed body is rejected with 400 by do_POST's guard -- the request
    thread must not crash (pins the behavior verified live during Tier 1)."""
    port, mock_store = server

    status, data = _post_raw(port, "/recall", b"{not valid json")

    assert status == 400
    assert "error" in data

    # Server thread survived: a well-formed request still works afterwards.
    mock_store.recall.return_value = []
    ok_status, _ = _post(port, "/recall", {"query": "x", "n": 1})
    assert ok_status == 200


def test_concurrent_requests_all_succeed(server) -> None:
    """Fire many overlapping /recall requests at the ThreadingHTTPServer and
    confirm every one returns 200 -- exercises the thread-safe singleton store
    access the module docstring promises."""
    import concurrent.futures

    port, mock_store = server
    mock_store.recall.return_value = [{"text": "ok"}]

    def one() -> int:
        status, _ = _post(port, "/recall", {"query": "concurrent", "n": 1})
        return status

    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
        statuses = list(pool.map(lambda _: one(), range(24)))

    assert statuses == [200] * 24
