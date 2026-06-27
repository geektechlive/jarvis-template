"""apple-foundation tool server.

HTTP front for the `afm` Swift helper, which is the only thing that can touch
Apple's on-device Foundation Models (a Swift-only framework). This server spawns
`afm` once, keeps it warm (the model loads on first use), serialises access, and
exposes it over HTTP so the Python/TS harness can call on-device inference the
same way it calls the vector server.

Endpoints:
  GET  /health         -> {"ok": bool, "availability": str, "pid": int|null}
  POST /generate       -> {prompt, instructions?}                -> {"ok","content"}
  POST /generate_typed -> {prompt, schema, instructions?}        -> {"ok","content"}
       (content for /generate_typed is a JSON string the caller parses; schema is
        {"properties":[{"name","type":"string|string[]|number|boolean","enum"?,"description"?}]})

Runs on port 9878 (override with AFM_PORT). The afm binary path is AFM_BIN, else
the release build next to this file.

Start: uv run python tools-py/apple-foundation/server.py
"""

from __future__ import annotations

import json
import logging
import os
import select
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

_log = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

PORT = int(os.environ.get("AFM_PORT", "9878"))
_HERE = Path(__file__).parent
AFM_BIN = os.environ.get("AFM_BIN", str(_HERE / ".build" / "release" / "afm"))
_DEFAULT_LOG = str(_HERE.parent.parent / "logs" / "apple-foundation.afm.log")
_STDERR_LOG = Path(os.environ.get("AFM_LOG", _DEFAULT_LOG))

# Single afm subprocess, serialised by a lock. The on-device model processes one
# request at a time anyway, so a lock (not a pool) is the right model.
_proc: subprocess.Popen | None = None
_proc_lock = threading.Lock()
_buf = b""
_id_counter = 0


def _next_id() -> str:
    global _id_counter
    _id_counter += 1
    return str(_id_counter)


def _spawn() -> None:
    """(Re)spawn the afm subprocess. Caller must hold _proc_lock."""
    global _proc, _buf
    _buf = b""
    _STDERR_LOG.parent.mkdir(parents=True, exist_ok=True)
    err = open(_STDERR_LOG, "ab")  # noqa: SIM115 -- lives for the process lifetime
    _proc = subprocess.Popen(
        [AFM_BIN],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=err,
        bufsize=0,
    )
    _log.info("afm spawned pid=%s bin=%s", _proc.pid, AFM_BIN)


def _readline(timeout: float) -> bytes:
    """Read one newline-terminated line from afm stdout, with a timeout.

    Access is serialised by _proc_lock, so a single shared buffer is safe. Uses
    select() + os.read() on the raw fd (Popen opened unbuffered).
    """
    global _buf
    assert _proc is not None and _proc.stdout is not None
    fd = _proc.stdout.fileno()
    deadline = time.monotonic() + timeout
    while b"\n" not in _buf:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("afm read timeout")
        ready, _, _ = select.select([fd], [], [], remaining)
        if not ready:
            raise TimeoutError("afm read timeout")
        chunk = os.read(fd, 65536)
        if not chunk:
            raise BrokenPipeError("afm stdout closed")
        _buf += chunk
    line, _, _buf = _buf.partition(b"\n")
    return line


def call_afm(req: dict, timeout: float = 60.0) -> dict:
    """Send one request to afm and return its parsed response. Respawns on death."""
    with _proc_lock:
        if _proc is None or _proc.poll() is not None:
            _spawn()
        assert _proc is not None and _proc.stdin is not None
        try:
            _proc.stdin.write((json.dumps(req) + "\n").encode())
            _proc.stdin.flush()
            line = _readline(timeout)
        except (BrokenPipeError, TimeoutError, OSError) as exc:
            _log.warning("afm call failed (%s); respawning", exc)
            try:
                if _proc:
                    _proc.kill()
            except Exception:
                pass
            _spawn()
            raise
    return json.loads(line)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args) -> None:  # silence default stderr access log
        pass

    def _send(self, code: int, obj: dict) -> None:
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        return json.loads(self.rfile.read(length))

    def do_GET(self) -> None:
        if self.path != "/health":
            self._send(404, {"error": "not found"})
            return
        try:
            resp = call_afm({"id": _next_id(), "mode": "health"}, timeout=15)
            ok = resp.get("ok") is True
            pid = _proc.pid if _proc else None
            avail = resp.get("content") or resp.get("error")
            self._send(200 if ok else 503, {"ok": ok, "availability": avail, "pid": pid})
        except Exception as exc:
            self._send(503, {"ok": False, "availability": str(exc), "pid": None})

    def do_POST(self) -> None:
        try:
            body = self._body()
        except Exception as exc:
            self._send(400, {"ok": False, "error": f"bad json: {exc}"})
            return

        if self.path == "/generate":
            prompt = (body.get("prompt") or "").strip()
            if not prompt:
                self._send(400, {"ok": False, "error": "prompt required"})
                return
            req = {
                "id": _next_id(),
                "mode": "generate",
                "prompt": prompt,
                "instructions": body.get("instructions", ""),
            }
        elif self.path == "/generate_typed":
            prompt = (body.get("prompt") or "").strip()
            schema = body.get("schema")
            if not prompt or not schema:
                self._send(400, {"ok": False, "error": "prompt and schema required"})
                return
            req = {
                "id": _next_id(),
                "mode": "generate_typed",
                "prompt": prompt,
                "instructions": body.get("instructions", ""),
                "schema": schema,
            }
        else:
            self._send(404, {"ok": False, "error": "not found"})
            return

        try:
            resp = call_afm(req, timeout=float(body.get("timeout", 60)))
            self._send(200 if resp.get("ok") else 502, resp)
        except Exception as exc:
            # Hard failure -> 502 so the harness falls back to its prior backend.
            self._send(502, {"ok": False, "error": str(exc)})


def main() -> None:
    with _proc_lock:
        _spawn()
    _log.info("apple-foundation server listening on 127.0.0.1:%s", PORT)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
