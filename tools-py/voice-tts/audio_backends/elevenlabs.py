"""ElevenLabs backend -- optional paid escalation.

Requires: ELEVENLABS_API_KEY in .env and voice.yaml::elevenlabs.voice_id set.
Install: uv add 'harness[voice]'
"""
from __future__ import annotations

import logging
import os
from datetime import datetime
from pathlib import Path

logger = logging.getLogger(__name__)

_USAGE_DIR = Path.home() / ".jarvis"


def _usage_path() -> Path:
    return _USAGE_DIR / f"elevenlabs-usage-{datetime.now().strftime('%Y-%m')}.txt"


def _read_chars_used() -> int:
    p = _usage_path()
    try:
        return int(p.read_text().strip())
    except (FileNotFoundError, ValueError):
        return 0


def _write_chars_used(n: int) -> None:
    _USAGE_DIR.mkdir(parents=True, exist_ok=True)
    _usage_path().write_text(str(n))


class ElevenLabsBackend:
    def __init__(self, cfg: dict) -> None:
        self._voice_id: str = cfg.get("voice_id") or ""
        self._model: str = cfg.get("model", "eleven_turbo_v2_5")
        self._budget: int = cfg.get("monthly_char_budget", 100000)
        self._api_key = os.environ.get("ELEVENLABS_API_KEY", "")
        if not self._api_key:
            raise RuntimeError(
                "ELEVENLABS_API_KEY not set. Add it to .env to use the ElevenLabs backend."
            )
        if not self._voice_id:
            raise RuntimeError(
                "voice.yaml::elevenlabs.voice_id not set."
            )

    def voice_id(self) -> str:
        return self._voice_id

    def file_ext(self) -> str:
        return "mp3"

    def chars_used(self) -> int:
        return _read_chars_used()

    def synthesize(self, text: str) -> bytes:
        used = self.chars_used()
        remaining = self._budget - used
        if len(text) > remaining:
            raise RuntimeError(
                f"ElevenLabs monthly budget exceeded ({self._budget} chars). "
                "Switch back with /voice backend say."
            )
        try:
            from elevenlabs import ElevenLabs  # type: ignore[import-untyped]
        except ImportError as exc:
            raise RuntimeError(
                "elevenlabs SDK not installed. Run: uv add 'harness[voice]'"
            ) from exc

        client = ElevenLabs(api_key=self._api_key)
        audio_gen = client.generate(  # type: ignore[attr-defined]
            text=text,
            voice=self._voice_id,
            model=self._model,
        )
        data = b"".join(audio_gen)
        new_used = used + len(text)
        _write_chars_used(new_used)
        logger.debug(
            "elevenlabs: synthesized %d chars; %d of %d used this month",
            len(text),
            new_used,
            self._budget,
        )
        return data
