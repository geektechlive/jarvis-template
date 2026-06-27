"""Tests for episodic memory — uses a temp DB, no Ollama required."""
from datetime import UTC, datetime, timedelta

import pytest

from harness.memory import episodic


@pytest.fixture(autouse=True)
def temp_data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENT_DATA_DIR", str(tmp_path))
    episodic.init_db()


def test_log_and_retrieve() -> None:
    episodic.log_message("user", "Hello agent", session="test")
    episodic.log_message("assistant", "Hello Alex", session="test")
    msgs = episodic.recent_messages(n=10, session="test")
    assert len(msgs) == 2
    assert msgs[0]["role"] == "user"
    assert msgs[1]["role"] == "assistant"


def test_session_isolation() -> None:
    episodic.log_message("user", "session A message", session="A")
    episodic.log_message("user", "session B message", session="B")
    a_msgs = episodic.recent_messages(session="A")
    b_msgs = episodic.recent_messages(session="B")
    assert len(a_msgs) == 1
    assert len(b_msgs) == 1
    assert a_msgs[0]["content"] == "session A message"


def test_recency_limit() -> None:
    for i in range(20):
        episodic.log_message("user", f"message {i}", session="limit")
    msgs = episodic.recent_messages(n=5, session="limit")
    assert len(msgs) == 5
    assert msgs[-1]["content"] == "message 19"


def test_log_event() -> None:
    episodic.log_event("panel_started", detail="topic: AI", session="test")


def test_log_event_dict_detail_round_trips() -> None:
    episodic.log_event(
        "extraction",
        detail={"last_turn_id": 12, "facts_added": 3},
        session="dict-test",
    )
    event = episodic.last_event(session="dict-test", event_type="extraction")
    assert event is not None
    assert event["detail"] == {"last_turn_id": 12, "facts_added": 3}


def test_last_event_returns_none_when_missing() -> None:
    assert episodic.last_event(session="never-used", event_type="extraction") is None


def test_events_since_returns_in_order() -> None:
    e1 = episodic.log_event("test", detail="one", session="es")
    episodic.log_event("test", detail="two", session="es")
    episodic.log_event("test", detail="three", session="es")
    after = episodic.events_since(e1, session="es", event_type="test")
    assert [e["detail"] for e in after] == ["two", "three"]


def test_messages_since_returns_only_newer() -> None:
    id_a = episodic.log_message("user", "alpha", session="ms")
    episodic.log_message("assistant", "bravo", session="ms")
    episodic.log_message("user", "charlie", session="ms")
    rows = episodic.messages_since(id_a, session="ms")
    contents = [r["content"] for r in rows]
    assert contents == ["bravo", "charlie"]


def test_known_sessions_lists_distinct() -> None:
    episodic.log_message("user", "x", session="alpha")
    episodic.log_message("user", "y", session="beta")
    episodic.log_message("user", "z", session="alpha")
    sessions = set(episodic.known_sessions())
    assert {"alpha", "beta"}.issubset(sessions)


# ---------------------------------------------------------------------------
# goal_type column tests
# ---------------------------------------------------------------------------


def test_goal_type_defaults_to_write() -> None:
    goal_id = episodic.create_goal("do something", owner_staff_id="jarvis")
    goal = episodic.get_goal(goal_id)
    assert goal is not None
    assert goal["goal_type"] == "write"


def test_goal_type_column_is_queryable() -> None:
    goal_id = episodic.create_goal("send an email", owner_staff_id="jarvis")
    episodic.update_goal(goal_id, goal_type="external")
    goal = episodic.get_goal(goal_id)
    assert goal is not None
    assert goal["goal_type"] == "external"


def test_goals_due_now_includes_goal_type() -> None:
    goal_id = episodic.create_goal("check calendar", owner_staff_id="jarvis")
    episodic.update_goal(goal_id, status="active", goal_type="read")
    due = episodic.goals_due_now()
    match = next((g for g in due if g["id"] == goal_id), None)
    assert match is not None
    assert match["goal_type"] == "read"


# ---------------------------------------------------------------------------
# external_actions_audit round-trip tests
# ---------------------------------------------------------------------------


def _make_goal_and_run() -> tuple[int, int]:
    """Helper: create a goal + run row and return (goal_id, run_id)."""
    goal_id = episodic.create_goal("deploy service", owner_staff_id="jarvis")
    run_id = episodic.log_goal_run(goal_id)
    return goal_id, run_id


def test_log_external_audit_returns_positive_id() -> None:
    goal_id, run_id = _make_goal_and_run()
    audit_id = episodic.log_external_audit(
        goal_id=goal_id,
        goal_run_id=run_id,
        intent="deploy service",
        started_at="2026-05-15T10:00:00+00:00",
    )
    assert isinstance(audit_id, int)
    assert audit_id > 0


def test_update_external_audit_round_trip() -> None:
    goal_id, run_id = _make_goal_and_run()
    audit_id = episodic.log_external_audit(
        goal_id=goal_id,
        goal_run_id=run_id,
        intent="push commit to main",
        started_at="2026-05-15T10:00:00+00:00",
    )
    episodic.update_external_audit(
        audit_id=audit_id,
        result_text="Pushed 3 commits.",
        completed_at="2026-05-15T10:01:00+00:00",
    )
    # Re-read via a direct query to verify persistence
    import os
    import sqlite3
    from pathlib import Path

    db_path = str(Path(os.environ["AGENT_DATA_DIR"]) / "conversations.db")
    conn = sqlite3.connect(db_path)
    row = conn.execute(
        "SELECT result_text, completed_at FROM external_actions_audit WHERE id = ?",
        (audit_id,),
    ).fetchone()
    conn.close()
    assert row is not None
    assert row[0] == "Pushed 3 commits."
    assert row[1] == "2026-05-15T10:01:00+00:00"


# ---------------------------------------------------------------------------
# beliefs_at — bi-temporal validity (#82)
# ---------------------------------------------------------------------------


def _store_fact(
    chroma_id: str,
    valid_from: str | None = None,
    valid_until: str | None = None,
    known_from: str | None = None,
    known_until: str | None = None,
    collection: str = "knowledge",
) -> None:
    episodic.upsert_memory_meta(
        chroma_id,
        confidence=1.0,
        collection=collection,
        valid_from=valid_from,
        valid_until=valid_until,
        known_from=known_from,
        known_until=known_until,
    )


def test_beliefs_at_includes_always_valid_entry() -> None:
    _store_fact("fact-no-bounds")
    now = datetime.now(UTC)
    ids = episodic.beliefs_at(now)
    assert "fact-no-bounds" in ids


def test_beliefs_at_includes_entry_within_valid_window() -> None:
    t_past = (datetime.now(UTC) - timedelta(days=10)).isoformat()
    t_future = (datetime.now(UTC) + timedelta(days=10)).isoformat()
    _store_fact("fact-bounded", valid_from=t_past, valid_until=t_future)
    ids = episodic.beliefs_at(datetime.now(UTC))
    assert "fact-bounded" in ids


def test_beliefs_at_excludes_entry_after_valid_until() -> None:
    t_past_from = (datetime.now(UTC) - timedelta(days=20)).isoformat()
    t_past_until = (datetime.now(UTC) - timedelta(days=5)).isoformat()
    _store_fact("fact-expired", valid_from=t_past_from, valid_until=t_past_until)
    ids = episodic.beliefs_at(datetime.now(UTC))
    assert "fact-expired" not in ids


def test_beliefs_at_excludes_entry_before_known_from() -> None:
    t_future = (datetime.now(UTC) + timedelta(days=5)).isoformat()
    _store_fact("fact-future-known", known_from=t_future)
    ids = episodic.beliefs_at(datetime.now(UTC))
    assert "fact-future-known" not in ids


def test_beliefs_at_excludes_superseded_entry() -> None:
    _store_fact("fact-superseded")
    episodic.set_superseded("fact-superseded", superseded_by="decay")
    ids = episodic.beliefs_at(datetime.now(UTC))
    assert "fact-superseded" not in ids


def test_beliefs_at_at_specific_past_date() -> None:
    t_2026_jan = "2026-01-01T00:00:00+00:00"
    t_2026_apr = "2026-04-01T00:00:00+00:00"
    t_2026_jun = "2026-06-01T00:00:00+00:00"
    # Explicit known_from so the query is not blocked by the default (now).
    _store_fact(
        "fact-q1-q2", valid_from=t_2026_jan, valid_until=t_2026_jun, known_from=t_2026_jan
    )
    _store_fact(
        "fact-q2-only", valid_from=t_2026_apr, valid_until=t_2026_jun, known_from=t_2026_apr
    )

    jan_ids = episodic.beliefs_at(datetime(2026, 2, 1, tzinfo=UTC))
    may_ids = episodic.beliefs_at(datetime(2026, 5, 1, tzinfo=UTC))

    assert "fact-q1-q2" in jan_ids
    assert "fact-q2-only" not in jan_ids
    assert "fact-q1-q2" in may_ids
    assert "fact-q2-only" in may_ids


def test_beliefs_at_respects_collection_filter() -> None:
    _store_fact("fact-knowledge", collection="knowledge")
    _store_fact("fact-profile", collection="user_profile")
    k_ids = episodic.beliefs_at(datetime.now(UTC), collection="knowledge")
    p_ids = episodic.beliefs_at(datetime.now(UTC), collection="user_profile")
    assert "fact-knowledge" in k_ids
    assert "fact-knowledge" not in p_ids
    assert "fact-profile" in p_ids
    assert "fact-profile" not in k_ids


def test_upsert_memory_meta_persists_bi_temporal_fields() -> None:
    t_from = "2026-01-01T00:00:00+00:00"
    t_until = "2026-12-31T23:59:59+00:00"
    episodic.upsert_memory_meta(
        "bt-test",
        valid_from=t_from,
        valid_until=t_until,
        known_from=t_from,
    )
    meta = episodic.get_memory_meta("bt-test")
    assert meta is not None
    assert meta["valid_from"] == t_from
    assert meta["valid_until"] == t_until
    assert meta["known_from"] == t_from
    assert meta["known_until"] is None


def test_upsert_memory_meta_does_not_clobber_ttl_days_on_reupsert() -> None:
    """jarvis#850 regression: a later upsert that omits ttl_days (e.g. the tag
    backfill thread in vec-server, which re-upserts tags+importance only) must NOT
    wipe an existing TTL. Before the COALESCE fix, the ON CONFLICT clause set
    ttl_days=excluded.ttl_days (None), so every ephemeral row lost its TTL right
    after the initial write and never expired."""
    # Initial write carries a 14-day TTL (mirrors a feed/news write).
    episodic.upsert_memory_meta("ttl-keep", confidence=0.5, source="feed:verge", ttl_days=14)
    assert episodic.get_memory_meta("ttl-keep")["ttl_days"] == 14

    # Tag backfill re-upserts the same id WITHOUT ttl_days (defaults to None).
    episodic.upsert_memory_meta("ttl-keep", confidence=0.5, source="feed:verge", tags=["ai"])
    meta = episodic.get_memory_meta("ttl-keep")
    assert meta["ttl_days"] == 14, "tag backfill must not clear the TTL"
    assert meta["tags"] == ["ai"]

    # An explicit new ttl_days still overwrites (e.g. re-classification).
    episodic.upsert_memory_meta("ttl-keep", confidence=0.5, source="feed:verge", ttl_days=7)
    assert episodic.get_memory_meta("ttl-keep")["ttl_days"] == 7


# ---------------------------------------------------------------------------
# get_memory_meta_bulk -- batch form used by consolidation decay/TTL loops
# ---------------------------------------------------------------------------


def test_get_memory_meta_bulk_returns_present_and_omits_absent() -> None:
    episodic.upsert_memory_meta("bulk-a", confidence=0.4, ttl_days=7)
    episodic.upsert_memory_meta("bulk-b", confidence=0.6)

    result = episodic.get_memory_meta_bulk(["bulk-a", "bulk-b", "bulk-missing"])

    assert set(result) == {"bulk-a", "bulk-b"}  # absent id omitted, no error
    assert result["bulk-a"]["ttl_days"] == 7
    assert result["bulk-a"]["confidence"] == 0.4
    assert result["bulk-b"]["confidence"] == 0.6


def test_get_memory_meta_bulk_matches_single_getter() -> None:
    episodic.upsert_memory_meta("parity-1", confidence=0.3, source="cli", ttl_days=14)

    bulk = episodic.get_memory_meta_bulk(["parity-1"])["parity-1"]
    single = episodic.get_memory_meta("parity-1")

    assert bulk == single  # shared _row_to_meta keeps the two in lock-step


def test_get_memory_meta_bulk_empty_list_returns_empty_dict() -> None:
    assert episodic.get_memory_meta_bulk([]) == {}


def test_get_memory_meta_bulk_handles_more_than_chunk_size() -> None:
    # Exceed _BULK_META_CHUNK so the IN(...) query is split across chunks.
    n = episodic._BULK_META_CHUNK + 25
    ids = [f"chunk-{i}" for i in range(n)]
    for cid in ids:
        episodic.upsert_memory_meta(cid, confidence=0.5)

    result = episodic.get_memory_meta_bulk(ids)

    assert len(result) == n
    assert all(cid in result for cid in ids)


def test_set_contradicts_records_provenance() -> None:
    """jarvis#807: contradicts column was defined but never populated. set_contradicts
    records that the kept entry contradicts the archived one."""
    episodic.upsert_memory_meta("kept", confidence=1.0, source="learning")
    episodic.upsert_memory_meta("archived", confidence=1.0, source="learning")
    assert episodic.get_memory_meta("kept")["contradicts"] is None

    episodic.set_contradicts("kept", "archived")

    assert episodic.get_memory_meta("kept")["contradicts"] == "archived"
