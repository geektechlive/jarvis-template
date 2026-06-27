#!/usr/bin/env python3
"""Safari ambient watcher.

Reads recent Safari history (last N hours) plus the current open-tab list,
redacts noise (tokens, blocklisted hosts), and POSTs the payload to the M2
vec-server's /ambient/safari endpoint.

Designed to run as a LaunchAgent on each Safari host (MacBook + M4 Mini).
Each host's payload is tagged with `host` so the M2 can attribute signals.

Usage:
    ./safari-watcher.py --hours 1
    ./safari-watcher.py --dry-run
    ./safari-watcher.py --smoke-test

Env / config:
    SAFARI_ENDPOINT     POST URL (default: http://{MINI_HOST}/ambient/safari)
    MINI_HOST           host:port of M2 vec-server (default: <mac-mini-ip>:9876)
    SAFARI_BLOCKLIST    path to extra blocklist (one domain per line)
    SAFARI_WATCH_HOURS  history lookback window (default 1h)
    SAFARI_LOG_PATH     if set, truncate this log file if it exceeds 10MB

Reads:
    ~/Library/Safari/History.db    (read-only, immutable connection)
    AppleScript: open tabs / window titles

Never touches network passwords, banking, medical, or password-manager URLs.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import socket
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Iterable
from datetime import UTC, datetime, timedelta
from pathlib import Path

# Default blocklist — never transmit URLs whose host matches any of these.
DEFAULT_BLOCKLIST = {
    # Banking / finance / brokerage
    "chase.com", "bankofamerica.com", "wellsfargo.com", "fidelity.com",
    "vanguard.com", "schwab.com", "etrade.com", "robinhood.com",
    "ally.com", "capitalone.com", "americanexpress.com",
    "discover.com", "creditkarma.com", "mint.com",
    # Health / medical
    "webmd.com", "mayoclinic.org", "healthline.com", "epicgateway.net",
    "mychart.com", "myuhc.com", "anthem.com", "aetna.com",
    "cigna.com", "kp.org", "kaiserpermanente.org",
    # Password managers
    "1password.com", "bitwarden.com", "lastpass.com", "dashlane.com",
    # Sensitive auth / admin
    "accounts.google.com", "login.microsoftonline.com", "secure.login.gov",
    "appleid.apple.com", "id.atlassian.com",
    # Adult
    "pornhub.com", "xvideos.com", "xhamster.com", "redtube.com",
}

# Match common credential/session params; we redact the value (and the query
# string entirely if it has more than one such param to be safe).
SENSITIVE_PARAM_RE = re.compile(
    r"(?:token|session|sess|sid|auth|key|api_key|password|pwd|secret|"
    r"jwt|bearer|access_token|refresh_token|otp)=",
    re.IGNORECASE,
)

_LOG_MAX_BYTES = 10 * 1024 * 1024  # 10 MB
_LOG_KEEP_LINES = 5_000


def _rotate_log_if_large(path: str | None) -> None:
    if not path:
        return
    p = Path(path)
    if not p.exists() or p.stat().st_size < _LOG_MAX_BYTES:
        return
    try:
        lines = p.read_text(encoding="utf-8", errors="replace").splitlines()
        p.write_text("\n".join(lines[-_LOG_KEEP_LINES:]) + "\n", encoding="utf-8")
    except OSError:
        pass


def _ensure_blocklist_file(path: str) -> None:
    p = Path(path).expanduser()
    if p.exists():
        return
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(
            "# Safari extra blocklist — one domain per line.\n"
            "# Lines starting with # are ignored.\n"
            "# Example: example-sensitive-site.com\n",
            encoding="utf-8",
        )
    except OSError:
        pass


def load_blocklist(extra_path: str | None) -> set[str]:
    blocklist = set(DEFAULT_BLOCKLIST)
    if not extra_path:
        return blocklist
    p = Path(extra_path).expanduser()
    if not p.exists():
        return blocklist
    try:
        for line in p.read_text(encoding="utf-8").splitlines():
            host = line.strip().lower()
            if host and not host.startswith("#"):
                blocklist.add(host)
    except OSError:
        pass
    return blocklist


def is_blocked(url: str, blocklist: set[str]) -> bool:
    try:
        host = urllib.parse.urlparse(url).hostname or ""
    except ValueError:
        return True
    host = host.lower().lstrip("www.")
    if not host:
        return True
    for entry in blocklist:
        e = entry.lower().lstrip("*.")
        if host == e or host.endswith("." + e):
            return True
    return False


def redact_url(url: str) -> str:
    """Strip credentials from query strings while preserving the path."""
    try:
        parts = urllib.parse.urlsplit(url)
    except ValueError:
        return ""
    query = parts.query or ""
    if query and SENSITIVE_PARAM_RE.search(query):
        query = ""
    netloc = parts.netloc.split("@", 1)[-1]
    return urllib.parse.urlunsplit((parts.scheme, netloc, parts.path, query, ""))


def safari_history_path() -> Path:
    return Path.home() / "Library" / "Safari" / "History.db"


# Safari stores visit times as seconds since 2001-01-01 (Apple's "core data"
# epoch). Convert to UTC ISO for the harness.
APPLE_EPOCH_OFFSET = 978_307_200.0


def apple_ts_to_iso(visit_time: float) -> str:
    return datetime.fromtimestamp(visit_time + APPLE_EPOCH_OFFSET, tz=UTC).isoformat()


def read_history(hours: int, blocklist: set[str], limit: int = 100) -> list[dict]:
    db_path = safari_history_path()
    if not db_path.exists():
        return []
    cutoff_apple = (datetime.now(UTC) - timedelta(hours=hours)).timestamp() - APPLE_EPOCH_OFFSET
    uri = f"file:{db_path}?mode=ro"

    rows: list[tuple] = []
    for attempt in range(3):
        try:
            with sqlite3.connect(uri, uri=True, timeout=2.0) as conn:
                rows = conn.execute(
                    """
                    SELECT history_items.url, history_visits.title, history_visits.visit_time
                    FROM history_items
                    JOIN history_visits ON history_items.id = history_visits.history_item
                    WHERE history_visits.visit_time >= ?
                    ORDER BY history_visits.visit_time DESC
                    LIMIT ?
                    """,
                    (cutoff_apple, limit * 2),
                ).fetchall()
            break
        except sqlite3.OperationalError:
            if attempt < 2:
                time.sleep(3)
            else:
                return []
        except sqlite3.Error:
            return []

    items: list[dict] = []
    seen_urls: set[str] = set()
    for url, title, visit_time in rows:
        if not url:
            continue
        if is_blocked(url, blocklist):
            continue
        redacted = redact_url(url)
        if not redacted or redacted in seen_urls:
            continue
        seen_urls.add(redacted)
        items.append({
            "url": redacted,
            "title": (title or "")[:200],
            "visit_ts": apple_ts_to_iso(float(visit_time or 0.0)),
        })
        if len(items) >= limit:
            break
    return items


def read_open_tabs(blocklist: set[str]) -> list[dict]:
    """Use AppleScript to enumerate open Safari tabs across windows."""
    script = (
        'tell application "Safari"\n'
        '  set output to ""\n'
        '  try\n'
        '    repeat with w in windows\n'
        '      repeat with t in tabs of w\n'
        '        set output to output & (URL of t as text) & (ASCII character 9) & (name of t as text) & linefeed\n'  # noqa: E501
        '      end repeat\n'
        '    end repeat\n'
        '  end try\n'
        '  return output\n'
        'end tell\n'
    )
    try:
        r = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True, text=True, timeout=6,
        )
        if r.returncode != 0 or not r.stdout:
            return []
    except subprocess.TimeoutExpired:
        print("safari-watcher: AppleScript timed out reading tabs", file=sys.stderr)
        return []
    except FileNotFoundError:
        return []

    tabs: list[dict] = []
    for line in r.stdout.splitlines():
        if "\t" not in line:
            continue
        url, _, title = line.partition("\t")
        url = url.strip()
        if not url or is_blocked(url, blocklist):
            continue
        redacted = redact_url(url)
        if not redacted:
            continue
        tabs.append({"url": redacted, "title": title.strip()[:200]})
        if len(tabs) >= 50:
            break
    return tabs


def cloud_tabs_path() -> Path:
    return Path.home() / "Library" / "Safari" / "CloudTabs.db"


def read_cloud_tabs(blocklist: set[str]) -> list[dict]:
    """Read currently open tabs from all iCloud-connected devices via CloudTabs.db."""
    db_path = cloud_tabs_path()
    if not db_path.exists():
        return []
    uri = f"file:{db_path}?mode=ro"
    rows: list[tuple] = []
    for attempt in range(3):
        try:
            with sqlite3.connect(uri, uri=True, timeout=2.0) as conn:
                rows = conn.execute(
                    """
                    SELECT t.url, t.title, d.device_name
                    FROM cloud_tabs t
                    JOIN cloud_tab_devices d ON t.device_uuid = d.device_uuid
                    ORDER BY d.device_name, t.position
                    """
                ).fetchall()
            break
        except sqlite3.OperationalError:
            if attempt < 2:
                time.sleep(3)
            else:
                return []
        except sqlite3.Error:
            return []

    tabs: list[dict] = []
    seen: set[str] = set()
    for url, title, device_name in rows:
        if not url or is_blocked(url, blocklist):
            continue
        redacted = redact_url(url)
        if not redacted or redacted in seen:
            continue
        seen.add(redacted)
        tabs.append({
            "url": redacted,
            "title": (title or "")[:200],
            "device": (device_name or "unknown")[:50],
        })
        if len(tabs) >= 100:
            break
    return tabs


def post_payload(endpoint: str, payload: dict, timeout: float = 30.0) -> int:
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        endpoint, data=data, method="POST",
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310
        return resp.status


def post_payload_with_retry(
    endpoint: str, payload: dict, retries: int = 3, delay: float = 5.0
) -> int:
    last_exc: Exception = RuntimeError("no attempts")
    for attempt in range(retries):
        try:
            return post_payload(endpoint, payload)
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            last_exc = exc
            if attempt < retries - 1:
                time.sleep(delay)
    raise last_exc


def hostname() -> str:
    return socket.gethostname().split(".", 1)[0]


def _open_ssh_tunnel(ssh_host: str, remote_port: int = 9876) -> tuple[int, subprocess.Popen]:
    """Open an SSH tunnel and return (local_port, process). Caller must terminate process."""
    with socket.socket() as s:
        s.bind(("", 0))
        local_port = s.getsockname()[1]
    proc = subprocess.Popen(
        ["ssh", "-N", "-o", "ExitOnForwardFailure=yes",
         "-L", f"{local_port}:127.0.0.1:{remote_port}", ssh_host],
        stderr=subprocess.DEVNULL,
    )
    for _ in range(40):
        try:
            with socket.create_connection(("127.0.0.1", local_port), timeout=0.3):
                break
        except (ConnectionRefusedError, OSError):
            time.sleep(0.1)
    return local_port, proc


def _default_endpoint() -> str:
    ssh_host = os.environ.get("MINI_SSH_HOST", "")
    if ssh_host:
        return ""  # will be resolved after tunnel opens
    mini_host = os.environ.get("MINI_HOST", "<mac-mini-ip>:9876")
    return os.environ.get("SAFARI_ENDPOINT", f"http://{mini_host}/ambient/safari")


def main(argv: Iterable[str] | None = None) -> int:
    _rotate_log_if_large(os.environ.get("SAFARI_LOG_PATH"))

    parser = argparse.ArgumentParser(description="Safari ambient watcher")
    parser.add_argument(
        "--endpoint",
        default="",
        help="POST URL for the M2 vec-server endpoint (auto-detected from env)",
    )
    parser.add_argument(
        "--hours", type=int, default=int(os.environ.get("SAFARI_WATCH_HOURS", "1")),
        help="Lookback window in hours (default 1)",
    )
    parser.add_argument(
        "--blocklist", default=os.environ.get(
            "SAFARI_BLOCKLIST",
            str(Path.home() / ".jarvis" / "safari-blocklist.txt"),
        ),
        help="Extra blocklist (one domain per line)",
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="Print payload to stdout instead of POSTing"
    )
    parser.add_argument(
        "--smoke-test", action="store_true", help="POST a synthetic URL and report pass/fail"
    )
    args = parser.parse_args(argv)

    # Resolve endpoint: explicit arg > env > SSH tunnel
    ssh_host = os.environ.get("MINI_SSH_HOST", "")
    _tunnel_proc: subprocess.Popen | None = None
    if args.endpoint:
        endpoint = args.endpoint
    elif ssh_host and not args.dry_run:
        local_port, _tunnel_proc = _open_ssh_tunnel(ssh_host)
        endpoint = f"http://127.0.0.1:{local_port}/ambient/safari"
    else:
        endpoint = _default_endpoint() or os.environ.get("SAFARI_ENDPOINT", "http://<mac-mini-ip>:9876/ambient/safari")

    try:
        return _run(args, endpoint)
    finally:
        if _tunnel_proc is not None:
            _tunnel_proc.terminate()


def _run(args: argparse.Namespace, endpoint: str) -> int:
    blocklist = load_blocklist(args.blocklist)
    _ensure_blocklist_file(args.blocklist)

    if args.smoke_test:
        test_payload = {
            "host": hostname(),
            "history": [{
                "url": "https://example.com/safari-watcher-smoke-test",
                "title": "Smoke Test",
                "visit_ts": datetime.now(UTC).isoformat(),
            }],
            "tabs": [],
        }
        try:
            status = post_payload_with_retry(endpoint, test_payload)
            result = "PASS" if status < 400 else "FAIL"
            print(f"safari-watcher smoke-test: {result} (HTTP {status})")
            return 0 if status < 400 else 1
        except Exception as exc:
            print(f"safari-watcher smoke-test: FAIL ({exc})", file=sys.stderr)
            return 1

    history = read_history(args.hours, blocklist)
    tabs = read_open_tabs(blocklist)
    cloud_tabs = read_cloud_tabs(blocklist)

    payload = {
        "host": hostname(),
        "history": history,
        "tabs": tabs,
        "cloud_tabs": cloud_tabs,
    }

    if args.dry_run:
        print(json.dumps(payload, indent=2))
        return 0

    if not history and not tabs and not cloud_tabs:
        return 0

    try:
        status = post_payload_with_retry(endpoint, payload)
        if status >= 400:
            print(f"safari-watcher: endpoint returned {status}", file=sys.stderr)
            return 1
        return 0
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        print(f"safari-watcher: post failed after retries: {exc}", file=sys.stderr)
        return 0  # exit 0 so launchd doesn't throttle; will retry next interval


if __name__ == "__main__":
    sys.exit(main())
