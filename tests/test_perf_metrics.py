"""Tests for perf_metrics table and helpers (W6)."""
from __future__ import annotations

import pytest

from harness.memory import episodic


@pytest.fixture()
def tmp_db(tmp_path, monkeypatch):
    """Isolate each test to its own fresh SQLite database."""
    monkeypatch.setenv("AGENT_DATA_DIR", str(tmp_path))
    episodic.init_db()
    return tmp_path


def test_record_perf_inserts_row(tmp_db) -> None:
    episodic.record_perf("intent", 42.5, session="test")
    stats = episodic.perf_summary(phase="intent", since_hours=1)
    assert len(stats) == 1
    assert stats[0]["phase"] == "intent"
    assert stats[0]["count"] == 1
    assert stats[0]["p50_ms"] == 42.5


def test_record_perf_with_metadata(tmp_db) -> None:
    episodic.record_perf("recall", 100.0, metadata={"collection": "knowledge"})
    stats = episodic.perf_summary(phase="recall", since_hours=1)
    assert stats[0]["count"] == 1


def test_perf_summary_no_rows_returns_empty(tmp_db) -> None:
    stats = episodic.perf_summary(since_hours=1)
    assert stats == []


def test_perf_summary_all_phases(tmp_db) -> None:
    episodic.record_perf("intent", 50.0)
    episodic.record_perf("recall", 200.0)
    episodic.record_perf("chat", 3000.0)
    stats = episodic.perf_summary(since_hours=1)
    phases = {s["phase"] for s in stats}
    assert phases == {"intent", "recall", "chat"}


def test_perf_summary_percentiles(tmp_db) -> None:
    # Insert 100 measurements to get meaningful percentiles
    for i in range(1, 101):
        episodic.record_perf("chat", float(i))
    stats = episodic.perf_summary(phase="chat", since_hours=1)
    assert len(stats) == 1
    s = stats[0]
    assert s["count"] == 100
    assert s["p50_ms"] == 50.0
    assert s["p95_ms"] == 95.0
    assert s["p99_ms"] == 99.0


def test_record_perf_swallows_errors(tmp_db, monkeypatch) -> None:
    """record_perf must never raise even if the DB is broken."""
    monkeypatch.setenv("AGENT_DATA_DIR", "/nonexistent/path/that/does/not/exist")
    # Must not raise
    episodic.record_perf("intent", 10.0)


def test_percentile_empty_list() -> None:
    from harness.memory.episodic import _percentile
    assert _percentile([], 50) == 0.0


def test_perf_summary_phase_filter(tmp_db) -> None:
    episodic.record_perf("intent", 10.0)
    episodic.record_perf("recall", 20.0)
    stats = episodic.perf_summary(phase="intent", since_hours=1)
    assert len(stats) == 1
    assert stats[0]["phase"] == "intent"
