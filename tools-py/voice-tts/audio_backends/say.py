"""macOS say backend -- zero-install, free, instant British voice."""
from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path


class SayBackend:
    """Wraps macOS `say` command. Produces AIFF audio files."""

    def __init__(self, cfg: dict) -> None:
        self._voice = cfg.get("voice", "Daniel")

    def voice_id(self) -> str:
        return self._voice

    def file_ext(self) -> str:
        return "aiff"

    def synthesize(self, text: str) -> bytes:
        with tempfile.NamedTemporaryFile(suffix=".aiff", delete=False) as f:
            out_path = Path(f.name)
        try:
            subprocess.run(
                ["say", "-v", self._voice, "-o", str(out_path), text],
                check=True,
                capture_output=True,
            )
            return out_path.read_bytes()
        finally:
            out_path.unlink(missing_ok=True)
