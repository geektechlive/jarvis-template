"""voice-tts tool server.

HTTP server exposing /speak endpoint backed by harness/audio.py.
Runs on port 9877. Called fire-and-forget from the Jarvis TS extension turn_end.
Voice plays on the host running this server (the Mini for always-on; dev machine
for local sessions).

Threaded: synthesis can take seconds and afplay was previously holding the only
request thread for the duration of playback. Each request now runs on its own
thread; afplay itself is fire-and-forget (see audio._play).

Start: uv run python tools-py/voice-tts/server.py
"""

import json
import logging
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import audio  # noqa: E402


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args: object) -> None:
        pass

    def _send_json(self, code: int, body: dict) -> None:
        payload = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _read_body(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length > 0 else b"{}"
        return json.loads(raw)

    def do_GET(self) -> None:
        if self.path == "/health":
            self._handle_health()
        else:
            self._send_json(404, {"error": "not found"})

    def _handle_health(self) -> None:
        """Honest health probe: confirms voice.yaml loads and the configured
        backend can be lazily resolved. Returns 503 on either failure so a
        watchdog can detect a broken voice service rather than seeing 200 OK."""
        try:
            cfg = audio._load_config()
            # Resolve backend lazily; this verifies imports and config keys
            # without actually synthesising audio.
            audio._get_backend(cfg)
            self._send_json(200, {"status": "ok", "backend": cfg.get("backend", "say")})
        except Exception as exc:
            self._send_json(503, {"status": "error", "detail": str(exc)})

    def do_POST(self) -> None:
        if self.path == "/speak":
            self._handle_speak()
        else:
            self._send_json(404, {"error": "not found"})

    def _handle_speak(self) -> None:
        try:
            body = self._read_body()
        except Exception as exc:
            self._send_json(400, {"error": f"bad request: {exc}"})
            return

        text = body.get("text", "")
        if not text:
            self._send_json(400, {"error": "text required"})
            return

        urgency = body.get("urgency", "normal")

        try:
            result = audio.speak(text, urgency=urgency)
            self._send_json(200, {"ok": True, "backend": result.backend if result else None})
        except Exception as exc:
            self._send_json(500, {"error": str(exc)})


_log = logging.getLogger(__name__)


def main() -> None:
    # Logs to stderr (-> voice.error.log), the stream Alloy tails. Keep it WARN+ so the
    # error stream means "something is wrong"; INFO/DEBUG don't belong in the error log.
    logging.basicConfig(
        level=logging.WARNING,
        format="[%(levelname)s] %(name)s %(message)s",
    )
    port = 9877
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True
    _log.info("voice-tts: listening on http://127.0.0.1:%s", port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    server.server_close()


if __name__ == "__main__":
    main()
