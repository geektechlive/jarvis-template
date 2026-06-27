"""Tests for the identity file loader."""
from __future__ import annotations

import os
from pathlib import Path


def test_get_prefix_returns_non_empty_string() -> None:
    from harness.identity import loader
    prefix = loader.get_prefix()
    assert isinstance(prefix, str)
    assert len(prefix) > 100


def test_get_prefix_includes_soul_content() -> None:
    """Prefix must include content from SOUL.md."""
    from harness.identity import loader
    prefix = loader.get_prefix()
    assert "Jarvis" in prefix
    assert "Memory Honesty" in prefix


def test_get_prefix_includes_behavior_content() -> None:
    """Prefix must include BEHAVIOR.md content."""
    from harness.identity import loader
    prefix = loader.get_prefix()
    assert "Delegation" in prefix


def test_get_prefix_includes_mission_content() -> None:
    """Prefix must include MISSION.md content."""
    from harness.identity import loader
    prefix = loader.get_prefix()
    assert "chief of staff" in prefix or "Mission" in prefix


def test_get_prefix_reloads_on_mtime_change(tmp_path: Path) -> None:
    """Loader must reload content when a file's mtime changes."""
    from harness.identity.loader import _IdentityLoader

    # Write a temp identity file
    tmp_file = tmp_path / "SOUL.md"
    tmp_file.write_text("# Soul\nOriginal content.\n\n## Memory Honesty\nBe honest.")

    # Create a fresh loader instance pointing at our temp file
    test_loader = _IdentityLoader()
    test_loader._files = [tmp_file]

    first = test_loader.get_prefix()
    assert "Original content" in first

    # Ensure mtime changes by touching with a future timestamp
    new_mtime = tmp_file.stat().st_mtime + 1.0
    os.utime(tmp_file, (new_mtime, new_mtime))
    tmp_file.write_text("# Soul\nUpdated content.\n\n## Memory Honesty\nStill honest.")

    second = test_loader.get_prefix()
    assert "Updated content" in second
    assert second != first


def test_get_prefix_stable_without_changes() -> None:
    """Loader must return the same string on repeated calls when nothing changed."""
    from harness.identity import loader
    first = loader.get_prefix()
    second = loader.get_prefix()
    assert first == second
