"""Minimal test extension -- one specialist, no dossiers, redirects research routing.

Usage:
    python -m harness --extension extensions/test_minimal.py

Acceptance: ask a research-shaped question and it routes to test_specialist,
not the default researcher. Without --extension, routing is unchanged.
"""
from __future__ import annotations

from pathlib import Path

from harness.extensions import Extension, Principal, StaffSpec

EXTENSION = Extension(
    principal=Principal(name="Jarvis"),  # keeps default identity files
    staff=(
        StaffSpec(
            id="test_specialist",
            title="Test Specialist",
            model_key="default",
            system_prompt_template=(
                "You are the Test Specialist. "
                "You report to Jarvis, the principal's chief of staff. "
                "He will re-speak your output. Be precise; tone is his job, not yours. "
                "Answer questions about testing and quality assurance."
            ),
            specialties=("testing", "quality assurance", "test coverage"),
            when_to_call=("test this", "run tests for", "research"),
            status="active",
        ),
    ),
    action_aliases={"research": "test_specialist"},
    source_path=Path(__file__),
)
