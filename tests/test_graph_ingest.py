"""Unit tests for graph.ingest reference_time threading (#767).

ingest() imports graphiti_core.nodes.EpisodeType, which ships only with the
``graph`` extra (uv sync --extra graph). The keep-list ``make check`` runs
without extras, so these tests skip when graphiti_core is absent (mirrors the
guard in test_graph_repair.py).
"""

import importlib.util
from datetime import UTC, datetime

import pytest

from harness.memory import graph

needs_graphiti = pytest.mark.skipif(
    importlib.util.find_spec("graphiti_core") is None,
    reason="graphiti_core not installed (graph extra)",
)


class _FakeGraphiti:
    """Captures the kwargs passed to add_episode so the test can assert on
    reference_time without a real Neo4j / LLM round-trip."""

    def __init__(self) -> None:
        self.captured: dict = {}

    async def add_episode(self, **kwargs: object) -> None:
        self.captured = kwargs


@needs_graphiti
def test_ingest_forwards_explicit_reference_time(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = _FakeGraphiti()
    monkeypatch.setattr(graph, "_get", lambda: fake)
    monkeypatch.setattr(graph, "_cfg", lambda: {"group_id": "jarvis", "ingest_timeout": 30})

    ref = datetime(2026, 6, 1, 12, 0, tzinfo=UTC)
    graph.ingest("Alex likes coffee", name="ep-1", reference_time=ref)

    assert fake.captured["reference_time"] == ref


@needs_graphiti
def test_ingest_defaults_to_utc_now_when_absent(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = _FakeGraphiti()
    monkeypatch.setattr(graph, "_get", lambda: fake)
    monkeypatch.setattr(graph, "_cfg", lambda: {"group_id": "jarvis", "ingest_timeout": 30})

    before = datetime.now(tz=UTC)
    graph.ingest("Alex likes tea", name="ep-2")
    after = datetime.now(tz=UTC)

    ref = fake.captured["reference_time"]
    assert isinstance(ref, datetime)
    assert ref.tzinfo is not None  # defaults to tz-aware UTC, not naive
    assert before <= ref <= after
