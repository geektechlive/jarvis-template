"""Kokoro TTS backend via mlx-audio (Apple Silicon MLX).

Model: mlx-community/Kokoro-82M-bf16 (bm_george by default).
Install: uv sync --extra voice
"""
from __future__ import annotations

import io
from typing import Any


class LocalModelBackend:
    """Kokoro TTS via mlx-audio. Lazy-loads the model on first synthesize() call."""

    _MODEL_REPO = "mlx-community/Kokoro-82M-bf16"
    _SAMPLE_RATE = 24000

    def __init__(self, cfg: dict) -> None:
        self._cfg = cfg
        self._voice: str = cfg.get("voice", "bm_george")
        self._speed: float = float(cfg.get("speed", 1.0))
        self._model: Any = None

    def voice_id(self) -> str:
        return self._voice

    def file_ext(self) -> str:
        return "wav"

    def synthesize(self, text: str) -> bytes:
        import numpy as np  # type: ignore[import]
        import soundfile as sf  # type: ignore[import]

        if self._model is None:
            self._model = self._load_model()

        buf = io.BytesIO()
        for result in self._model.generate(
            text=text,
            voice=self._voice,
            speed=self._speed,
            lang_code=self._lang_code(),
        ):
            audio_np = np.array(result.audio)
            sf.write(buf, audio_np, samplerate=self._SAMPLE_RATE, format="WAV", subtype="PCM_16")
            break

        return buf.getvalue()

    def _load_model(self) -> Any:
        from mlx_audio.tts.utils import load_model  # type: ignore[import]
        return load_model(self._MODEL_REPO)

    def _lang_code(self) -> str:
        # voice prefix determines language: bm/bf=British, am/af=American, jf=Japanese, etc.
        return self._voice[0] if self._voice else "b"
