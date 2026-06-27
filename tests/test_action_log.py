"""Tests for the actions table in episodic.py — state machine and persistence."""
from __future__ import annotations

import os
import tempfile
from unittest.mock import patch

import pytest

os.environ.setdefault("AGENT_DATA_DIR", tempfile.mkdtemp())

from harness.memory import episodic


@pytest.fixture(autouse=True)
def fresh_db(tmp_path):
    with patch.dict(os.environ, {"AGENT_DATA_DIR": str(tmp_path)}):
        episodic.init_db()
        yield


class TestActionLog:
    def test_propose_returns_id(self, tmp_path):
        with patch.dict(os.environ, {"AGENT_DATA_DIR": str(tmp_path)}):
            episodic.init_db()
            action_id = episodic.propose_action("send_email", "HIGH", {"to": "a@b.com"})
        assert isinstance(action_id, int)
        assert action_id > 0

    def test_proposed_state_is_default(self, tmp_path):
        with patch.dict(os.environ, {"AGENT_DATA_DIR": str(tmp_path)}):
            episodic.init_db()
            action_id = episodic.propose_action("send_email", "HIGH")
            action = episodic.get_action(action_id)
        assert action is not None
        assert action["state"] == "Proposed"

    def test_payload_round_trips(self, tmp_path):
        payload = {"to": "test@example.com", "subject": "Hello"}
        with patch.dict(os.environ, {"AGENT_DATA_DIR": str(tmp_path)}):
            episodic.init_db()
            action_id = episodic.propose_action("send_email", "HIGH", payload)
            action = episodic.get_action(action_id)
        assert action["payload"] == payload

    def test_null_payload_stored(self, tmp_path):
        with patch.dict(os.environ, {"AGENT_DATA_DIR": str(tmp_path)}):
            episodic.init_db()
            action_id = episodic.propose_action("send_email", "HIGH", None)
            action = episodic.get_action(action_id)
        assert action["payload"] is None

    def test_resolve_approved(self, tmp_path):
        with patch.dict(os.environ, {"AGENT_DATA_DIR": str(tmp_path)}):
            episodic.init_db()
            action_id = episodic.propose_action("send_email", "HIGH")
            episodic.resolve_action(action_id, "Approved")
            action = episodic.get_action(action_id)
        assert action["state"] == "Approved"

    def test_resolve_rejected(self, tmp_path):
        with patch.dict(os.environ, {"AGENT_DATA_DIR": str(tmp_path)}):
            episodic.init_db()
            action_id = episodic.propose_action("send_email", "HIGH")
            episodic.resolve_action(action_id, "Rejected")
            action = episodic.get_action(action_id)
        assert action["state"] == "Rejected"

    def test_resolve_with_rollback_data(self, tmp_path):
        rollback = {"previous_content": "old content"}
        with patch.dict(os.environ, {"AGENT_DATA_DIR": str(tmp_path)}):
            episodic.init_db()
            action_id = episodic.propose_action("edit_repo_file", "MEDIUM")
            episodic.resolve_action(action_id, "RolledBack", rollback_data=rollback)
            action = episodic.get_action(action_id)
        assert action["state"] == "RolledBack"
        assert action["rollback_data"] == rollback

    def test_get_action_returns_none_for_missing(self, tmp_path):
        with patch.dict(os.environ, {"AGENT_DATA_DIR": str(tmp_path)}):
            episodic.init_db()
            result = episodic.get_action(99999)
        assert result is None

    def test_pending_actions_only_proposed(self, tmp_path):
        with patch.dict(os.environ, {"AGENT_DATA_DIR": str(tmp_path)}):
            episodic.init_db()
            id1 = episodic.propose_action("send_email", "HIGH")
            id2 = episodic.propose_action("write_calendar", "HIGH")
            episodic.resolve_action(id1, "Approved")
            pending = episodic.pending_actions()
        ids = [a["id"] for a in pending]
        assert id1 not in ids
        assert id2 in ids

    def test_pending_actions_oldest_first(self, tmp_path):
        with patch.dict(os.environ, {"AGENT_DATA_DIR": str(tmp_path)}):
            episodic.init_db()
            id1 = episodic.propose_action("action_a", "HIGH")
            id2 = episodic.propose_action("action_b", "HIGH")
            pending = episodic.pending_actions()
        assert pending[0]["id"] == id1
        assert pending[1]["id"] == id2

    def test_actions_table_independent_of_agent_events(self, tmp_path):
        with patch.dict(os.environ, {"AGENT_DATA_DIR": str(tmp_path)}):
            episodic.init_db()
            episodic.log_event("some_event", {"x": 1})
            episodic.propose_action("send_email", "HIGH")
            pending = episodic.pending_actions()
        assert len(pending) == 1
        assert pending[0]["action"] == "send_email"

    def test_init_db_idempotent(self, tmp_path):
        with patch.dict(os.environ, {"AGENT_DATA_DIR": str(tmp_path)}):
            episodic.init_db()
            action_id = episodic.propose_action("send_email", "HIGH")
            # Re-running init_db must not drop existing rows
            episodic.init_db()
            action = episodic.get_action(action_id)
        assert action is not None
        assert action["state"] == "Proposed"
