"""Identity file loader.

Assembles the system prompt prefix from the harness/identity/*.md files.
Uses mtime-based cache invalidation -- no watchdog dependency needed.
"""
from __future__ import annotations

from pathlib import Path


class _IdentityLoader:
    def __init__(self, files: list[Path] | None = None) -> None:
        # When files is None, paths are derived lazily from extensions.active().principal.
        # Pass a list explicitly to pin specific paths (used in tests).
        self._files: list[Path] | None = files
        self._cached_prefix: str = ""
        self._cached_mtimes: tuple[float, ...] = ()

    def _get_file_paths(self) -> list[Path]:
        if self._files is not None:
            return self._files
        identity_dir = Path(__file__).parent
        return [
            identity_dir / "SOUL.md",
            identity_dir / "BEHAVIOR.md",
            identity_dir / "MISSION.md",
            identity_dir / "GOALS.md",
            identity_dir / "PROJECTS.md",
        ]

    def _reload(self) -> None:
        files = self._get_file_paths()
        parts: list[str] = []
        for path in files:
            if path.exists():
                parts.append(path.read_text().strip())
        self._cached_prefix = "\n\n".join(parts)
        self._cached_mtimes = tuple(
            p.stat().st_mtime for p in files if p.exists()
        )

    def get_prefix(self) -> str:
        """Return the assembled identity prefix, refreshing when any file changes."""
        files = self._get_file_paths()
        mtimes = tuple(p.stat().st_mtime for p in files if p.exists())
        if mtimes != self._cached_mtimes:
            self._reload()
        return self._cached_prefix


_loader = _IdentityLoader()


def get_prefix() -> str:
    """Return the concatenated identity file prefix, refreshed on file change."""
    return _loader.get_prefix()
