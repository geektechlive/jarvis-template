"""Tests for the processed_mail bulk-ingest dedup registry."""
from __future__ import annotations

import pytest

from harness.memory import episodic


@pytest.fixture(autouse=True)
def temp_db(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENT_DATA_DIR", str(tmp_path))
    episodic.init_db()


def test_mark_then_is_processed_roundtrip():
    assert episodic.is_mail_processed("gmail", "msg-1") is False
    episodic.mark_mail_processed(
        "gmail", "msg-1",
        uid="123",
        folder="INBOX",
        triage_decision="notify",
        fact_count=3,
        tier="knowledge",
    )
    assert episodic.is_mail_processed("gmail", "msg-1") is True


def test_mark_is_idempotent():
    episodic.mark_mail_processed("gmail", "msg-1", fact_count=2)
    # Second mark with different fact_count: PK conflict → INSERT OR IGNORE
    episodic.mark_mail_processed("gmail", "msg-1", fact_count=99)
    assert episodic.processed_mail_count() == 1


def test_different_sources_same_message_id_are_distinct():
    episodic.mark_mail_processed("gmail", "abc", fact_count=1)
    episodic.mark_mail_processed("icloud", "abc", fact_count=2)
    assert episodic.processed_mail_count() == 2
    assert episodic.processed_mail_count(source="gmail") == 1
    assert episodic.processed_mail_count(source="icloud") == 1


def test_processed_mail_stats_aggregates():
    episodic.mark_mail_processed(
        "gmail", "m1", triage_decision="notify", fact_count=3, tier="knowledge",
    )
    episodic.mark_mail_processed(
        "gmail", "m2", triage_decision="notify", fact_count=1, tier="knowledge",
    )
    episodic.mark_mail_processed(
        "gmail", "m3", triage_decision="suppress", fact_count=0, tier="knowledge",
    )
    episodic.mark_mail_processed(
        "icloud", "m4", triage_decision="batch", fact_count=2, tier="archive",
    )

    stats = episodic.processed_mail_stats()
    assert stats["by_decision"]["notify"] == 2
    assert stats["by_decision"]["suppress"] == 1
    assert stats["by_decision"]["batch"] == 1
    assert stats["by_tier"]["knowledge"] == 3
    assert stats["by_tier"]["archive"] == 1
    assert stats["total_facts"] == 6


def test_unprocessed_returns_zero_counts():
    stats = episodic.processed_mail_stats()
    assert stats["by_decision"] == {}
    assert stats["by_tier"] == {}
    assert stats["total_facts"] == 0
