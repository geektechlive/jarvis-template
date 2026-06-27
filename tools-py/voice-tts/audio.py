"""Audio dispatcher -- synthesize and play text through the configured TTS backend.

Runs AFTER voice.respeak() (text persona pass). The caller in the TS extension fires this
on a daemon thread so it never blocks the UI. Falls back gracefully to text-only
on any error.

Backend selection is lazy (first speak() call). Use reset_backend() after a
/voice backend switch to force re-init.
"""
from __future__ import annotations

import hashlib
import logging
import os
import subprocess
import tempfile
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

logger = logging.getLogger(__name__)

# voice.yaml lives in harness/config/ at the repo root
_VOICE_YAML = Path(__file__).parent.parent.parent / "harness" / "config" / "voice.yaml"

_backend: Any = None
_config: dict | None = None

# Tracks afplay Popen handles so finished playbacks can be reaped. _play()
# fires fire-and-forget for fast return, but without poll()/wait() the OS
# leaves the parent (this server) responsible for the zombie. Reaping on
# the next _play() is sufficient because TTS volume is bursty, not steady.
_open_handles: list[subprocess.Popen] = []
_open_handles_lock = threading.Lock()


@dataclass
class AudioResult:
    ok: bool
    backend: str
    char_count: int
    cache_hit: bool
    error: str | None = None


def _load_config() -> dict:
    global _config
    if _config is None:
        with open(_VOICE_YAML) as f:
            loaded = yaml.safe_load(f)
        _config = loaded if isinstance(loaded, dict) else {}
    return _config


def _cache_dir() -> Path:
    base = Path(os.environ.get("AGENT_DATA_DIR", "~/.jarvis")).expanduser()
    d = base / "cache" / "voice"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _cache_key(text: str, backend_name: str, voice_id: str) -> str:
    raw = f"{text}|{backend_name}|{voice_id}"
    return hashlib.sha256(raw.encode()).hexdigest()


def _get_backend(cfg: dict) -> Any:
    global _backend
    if _backend is not None:
        return _backend
    name = cfg.get("backend", "say")
    if name == "say":
        from audio_backends.say import SayBackend
        _backend = SayBackend(cfg.get("say") or {})
    elif name == "local_model":
        try:
            import mlx_audio  # type: ignore[import]  # noqa: F401
            from audio_backends.local_model import LocalModelBackend
            _backend = LocalModelBackend(cfg.get("local_model") or {})
        except ImportError:
            logger.warning("mlx-audio not installed; falling back to say backend")
            from audio_backends.say import SayBackend
            _backend = SayBackend(cfg.get("say") or {})
    elif name == "elevenlabs":
        from audio_backends.elevenlabs import ElevenLabsBackend
        _backend = ElevenLabsBackend(cfg.get("elevenlabs") or {})
    else:
        raise ValueError(f"Unknown voice backend: {name!r}")
    return _backend


def save_config(cfg: dict) -> None:
    """Atomically write cfg to voice.yaml and update the in-memory cache."""
    global _config
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".yaml", dir=_VOICE_YAML.parent, delete=False
    ) as f:
        yaml.safe_dump(cfg, f)
        tmp = Path(f.name)
    os.replace(tmp, _VOICE_YAML)
    _config = cfg


def set_enabled(enabled: bool) -> dict:
    """Toggle voice on/off, persist to disk, and force backend re-init."""
    global _backend
    cfg = _load_config()
    cfg["enabled"] = enabled
    save_config(cfg)
    _backend = None
    return cfg


def set_backend(name: str) -> dict:
    """Switch TTS backend, persist to disk, and force backend re-init."""
    global _backend
    cfg = _load_config()
    cfg["backend"] = name
    save_config(cfg)
    _backend = None
    return cfg


def reset_backend() -> None:
    """Force backend re-init on next speak() call (use after config change)."""
    global _backend, _config
    _backend = None
    _config = None


def speak(text: str, urgency: str = "normal") -> AudioResult:
    """Synthesize and play text. Safe to call from any thread."""
    cfg = _load_config()
    if not cfg.get("enabled", False):
        return AudioResult(ok=False, backend="disabled", char_count=0, cache_hit=False)

    backend_name = cfg.get("backend", "say")
    try:
        b = _get_backend(cfg)
        vid = b.voice_id()
        key = _cache_key(text, backend_name, vid)
        ext = b.file_ext()
        cache_path = _cache_dir() / f"{key}.{ext}"

        if cache_path.exists():
            _play(cache_path)
            return AudioResult(
                ok=True, backend=backend_name, char_count=len(text), cache_hit=True
            )

        audio_bytes = b.synthesize(text)
        cache_path.write_bytes(audio_bytes)
        _play(cache_path)
        return AudioResult(
            ok=True, backend=backend_name, char_count=len(text), cache_hit=False
        )
    except Exception as exc:
        logger.warning("audio.speak [%s]: %s", backend_name, exc)
        return AudioResult(
            ok=False,
            backend=backend_name,
            char_count=len(text),
            cache_hit=False,
            error=str(exc),
        )


def _reap_finished() -> None:
    """Drop Popen handles whose process has exited. Called at the top of
    _play() so a steady cadence of TTS keeps the handle list bounded."""
    with _open_handles_lock:
        _open_handles[:] = [p for p in _open_handles if p.poll() is None]


def _play(path: Path) -> None:
    """Play audio file fire-and-forget. macOS afplay handles aiff/wav/mp3.

    Uses Popen (not run) so the caller's request thread returns immediately.
    A long TTS response otherwise tied up a server worker for 10-30s of
    playback. The only caller (server.py /speak) is itself fire-and-forget
    from the TS extension, so completion semantics are unimportant.

    Tracks the Popen handle so _reap_finished() can drop it once afplay
    exits — without that, the OS keeps a zombie per playback.
    """
    _reap_finished()
    proc = subprocess.Popen(  # noqa: S603 — fixed argv, no shell, trusted path
        ["afplay", str(path)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    with _open_handles_lock:
        _open_handles.append(proc)


def clear_cache() -> int:
    """Delete all cached audio files. Returns count removed."""
    d = _cache_dir()
    count = 0
    for f in d.iterdir():
        f.unlink()
        count += 1
    return count


def voice_status(cfg: dict | None = None) -> str:
    """One-line status string for TUI subtitle."""
    if cfg is None:
        cfg = _load_config()
    if not cfg.get("enabled", False):
        return "voice: off"
    return f"voice: on ({cfg.get('backend', 'say')})"


def precache(cfg: dict | None = None) -> int:
    """Synthesize and cache all phrases in voice.yaml::precache. Returns count cached."""
    if cfg is None:
        cfg = _load_config()
    phrases: list[str] = cfg.get("precache") or []
    cached = 0
    for phrase in phrases:
        result = speak(phrase)
        if result.ok:
            cached += 1
    return cached


def usage_summary() -> str:
    """Return a usage report for the active backend."""
    cfg = _load_config()
    backend_name = cfg.get("backend", "say")
    enabled = cfg.get("enabled", False)
    cache_count = sum(1 for _ in _cache_dir().iterdir()) if _cache_dir().exists() else 0
    lines = [
        f"Voice: {'on' if enabled else 'off'}  backend: {backend_name}",
        f"Cache entries: {cache_count}",
    ]
    if backend_name == "elevenlabs" and enabled:
        from audio_backends.elevenlabs import _read_chars_used
        used = _read_chars_used()
        budget = (cfg.get("elevenlabs") or {}).get("monthly_char_budget", 100000)
        lines.append(f"ElevenLabs chars this month: {used} / {budget}")
    elif backend_name == "local_model" and enabled:
        voice_name = (cfg.get("local_model") or {}).get("voice", "bm_george")
        lines.append(f"Kokoro voice: {voice_name}")
    return "\n".join(lines)
