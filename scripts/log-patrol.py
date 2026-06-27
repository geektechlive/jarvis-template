#!/usr/bin/env python3
# SCRIPT: log-patrol.py
# PURPOSE: Scan Jarvis subsystem logs for new errors, open GitHub issues,
#          and send Discord notifications.
# STATE: ~/.jarvis-log-patrol-state.json (cursors, dedup fingerprints, rate limits)
# RUNS: every 120s via com.example.jarvis.log-patrol LaunchAgent

import hashlib
import json
import os
import re
import subprocess
import sys
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

LOG_TARGETS = [
    ("vec-server",  "/Users/<username>/Jarvis/logs/vector.error.log"),
    ("discord-bot", "/Users/<username>/Jarvis/logs/discord-bot.error.log"),
    ("ion",         "/Users/<username>/Jarvis/logs/ion.log"),
    ("imessage",    "/Users/<username>/Jarvis/logs/imessage.error.log"),
]

STATE_FILE = Path.home() / ".jarvis-log-patrol-state.json"
REPO = "<your-org>/jarvis"
GH_LABELS = "bug,jarvis-auto,jarvis-patrol"

# Rate limit: max issues per subsystem per clock-hour
RATE_LIMIT_PER_HOUR = 3

# Dedup window: skip fingerprints seen within this many seconds
DEDUP_WINDOW_SEC = 86400  # 24 hours

# Recency gate: ignore any error whose own timestamp (or, when the line carries
# no parseable timestamp, the log file's mtime) is older than this many hours.
# This is the guard that stops a historical error -- e.g. a graph_ingest failure
# that stopped days ago -- from being re-filed as if it were live (jarvis#829/#830).
# Env-overridable so it can be widened if the patrol itself was down for a while.
PATROL_LOOKBACK_HOURS = int(os.environ.get("PATROL_LOOKBACK_HOURS", "6"))

_PATH_ENV = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/Users/<username>/bin"

# ---------------------------------------------------------------------------
# Error detection patterns
# ---------------------------------------------------------------------------

# JSON-structured log lines from ion
_JSON_ERROR_RE = re.compile(r'"level"\s*:\s*"error"', re.IGNORECASE)

# Plain-text log lines (Python/shell)
_PLAIN_ERROR_RE = re.compile(
    r'(?:^ERROR\b|^CRITICAL\b|\bERROR\b|\bCRITICAL\b)', re.MULTILINE
)

_TRACEBACK_RE = re.compile(r'^Traceback \(most recent call last\)', re.MULTILINE)

# Heuristic: a "new log entry" starts with a timestamp-like prefix
_TIMESTAMP_RE = re.compile(
    r'^\d{4}-\d{2}-\d{2}|^\[20\d{2}|^\d{2}:\d{2}:\d{2}|^\{.*"time"'
)


def _is_error_line(line: str) -> bool:
    """Return True if this line is an error."""
    if _JSON_ERROR_RE.search(line):
        return True
    if _PLAIN_ERROR_RE.search(line):
        return True
    if _TRACEBACK_RE.match(line):
        return True
    return False


def _extract_headline(line: str) -> str:
    """
    Try to pull a clean headline from the line.
    For JSON log lines, extract the 'message' or 'msg' field.
    Otherwise return the raw line stripped.
    """
    stripped = line.strip()
    if stripped.startswith("{"):
        try:
            obj = json.loads(stripped)
            msg = obj.get("message") or obj.get("msg") or obj.get("error") or ""
            if msg:
                return str(msg)[:200]
        except (json.JSONDecodeError, TypeError):
            pass
    return stripped[:200]


# ---------------------------------------------------------------------------
# Recency + fingerprint normalization
# ---------------------------------------------------------------------------

# An ISO-ish timestamp at the very start of a line (optionally bracketed): the
# shape emitted by Python asctime ("2026-06-20 08:35:02") and ion/JSON logs
# ("2026-06-20T08:35:02Z" / "...+00:00"). Fractional seconds and tz are optional.
_LEADING_TS_RE = re.compile(
    r"^\[?(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:[.,]\d+)?(Z|[+-]\d{2}:?\d{2})?"
)
# A "time":"..." field inside a JSON log line (ion).
_JSON_TS_RE = re.compile(r'"time"\s*:\s*"([^"]+)"')

# Volatile tokens that make two occurrences of the SAME underlying error look
# unique to the fingerprint -- which is how a recurring graph_ingest failure
# slipped the 24h dedup window and got re-filed (jarvis#829/#830). Stripped
# before hashing so repeat occurrences collapse to one fingerprint.
_SESSION_ID_RE = re.compile(r"\b[\w-]+-t\d+\b", re.IGNORECASE)  # jarvis-t1, 4d1d6ccc-t2
_ATTEMPT_RE = re.compile(r"\battempt\s+\d+/\d+\b", re.IGNORECASE)
_RETRY_RE = re.compile(r"\bretrying in \d+s\b", re.IGNORECASE)


def _parse_line_ts(line: str) -> datetime | None:
    """
    Extract a timestamp from a log line as an aware UTC datetime, or None when
    the line carries no parseable timestamp. A naive timestamp (vec-server's
    local-time asctime) is interpreted in the system local tz -- on the Mini that
    is America/Chicago, the same tz the patrol runs in -- then converted to UTC.
    """
    raw: str | None = None
    jm = _JSON_TS_RE.search(line)
    if jm:
        raw = jm.group(1)
    else:
        lm = _LEADING_TS_RE.match(line)
        if lm:
            tz = lm.group(3) or ""
            raw = f"{lm.group(1)}T{lm.group(2)}{tz}"
    if not raw:
        return None
    raw = raw.replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(raw)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.astimezone()  # naive -> system-local aware
    return dt.astimezone(UTC)


def _normalize_headline(headline: str) -> str:
    """Strip volatile tokens (leading timestamp, per-turn session id, retry
    counters) so two occurrences of the same error fingerprint identically."""
    s = headline
    m = _LEADING_TS_RE.match(s)
    if m:
        s = s[m.end():].lstrip(" ]")
    s = _SESSION_ID_RE.sub("<session>", s)
    s = _ATTEMPT_RE.sub("attempt <n>", s)
    s = _RETRY_RE.sub("retrying", s)
    return re.sub(r"\s+", " ", s).strip()


# ---------------------------------------------------------------------------
# State management
# ---------------------------------------------------------------------------

def _load_state() -> dict:
    try:
        text = STATE_FILE.read_text()
        return json.loads(text)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _save_state(state: dict) -> None:
    STATE_FILE.write_text(json.dumps(state, indent=2))


def _prune_state(state: dict) -> None:
    """Remove stale seen entries and old rate-limit hour buckets."""
    now = time.time()
    cutoff = now - DEDUP_WINDOW_SEC
    seen = state.get("seen", {})
    state["seen"] = {fp: ts for fp, ts in seen.items() if ts > cutoff}

    current_hour = datetime.now(UTC).strftime("%Y%m%d%H")
    rate = state.get("rate", {})
    for subsystem, buckets in rate.items():
        rate[subsystem] = {h: c for h, c in buckets.items() if h >= current_hour}
    state["rate"] = rate


# ---------------------------------------------------------------------------
# Fingerprinting
# ---------------------------------------------------------------------------

def _fingerprint(subsystem: str, headline: str) -> str:
    key = f"{subsystem}:{_normalize_headline(headline)[:120]}"
    return hashlib.sha256(key.encode()).hexdigest()[:16]


# ---------------------------------------------------------------------------
# GitHub + Discord integration
# ---------------------------------------------------------------------------

def _run_silent(cmd: list[str]) -> tuple[int, str, str]:
    """Run a command, return (returncode, stdout, stderr)."""
    env = {**os.environ, "PATH": _PATH_ENV}
    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        env=env,
        timeout=30,
    )
    return result.returncode, result.stdout.strip(), result.stderr.strip()


def _open_github_issue(subsystem: str, headline: str, context: str) -> bool:
    """Open a GitHub issue. Returns True on success."""
    title = f"error({subsystem}): {headline[:80]}"
    body = (
        f"**Subsystem:** `{subsystem}`\n\n**Context:**\n```\n{context}\n```\n\n"
        "*Opened automatically by log-patrol.*"
    )
    rc, out, err = _run_silent([
        "gh", "issue", "create",
        "--repo", REPO,
        "--title", title,
        "--body", body,
        "--label", GH_LABELS,
    ])
    if rc != 0:
        print(f"[log-patrol] WARN: gh issue create failed (rc={rc}): {err}", file=sys.stderr)
        return False
    print(f"[log-patrol] GitHub issue opened: {out.splitlines()[0] if out else '(no URL)'}")
    return True


def _send_discord(subsystem: str, headline: str) -> bool:
    """Send a Discord notification via jarvis-notify. Returns True on success."""
    notify_bin = os.path.expanduser("~/bin/jarvis-notify")
    rc, _out, err = _run_silent([notify_bin, "log_error", subsystem, headline[:100]])
    if rc != 0:
        print(f"[log-patrol] WARN: jarvis-notify failed (rc={rc}): {err}", file=sys.stderr)
        return False
    return True


# ---------------------------------------------------------------------------
# Log file scanning
# ---------------------------------------------------------------------------

def _scan_file(
    subsystem: str,
    path: str,
    state: dict,
) -> list[tuple[str, str]]:
    """
    Scan a single log file from the stored cursor.
    Returns a list of (headline, context_block) tuples for new errors.
    Updates state['cursors'] in place.
    """
    cursors = state.setdefault("cursors", {})

    # Handle missing log file gracefully
    try:
        file_size = os.path.getsize(path)
    except FileNotFoundError:
        # File doesn't exist yet — seed cursor at 0 so we're ready when it appears
        if path not in cursors:
            cursors[path] = 0
        return []
    except OSError as exc:
        print(f"[log-patrol] WARN: cannot stat {path}: {exc}", file=sys.stderr)
        return []

    # Recency gate (file level): a log not written within the lookback window has
    # no live errors. Skip it, and re-seed the cursor to EOF so a later
    # reactivation starts fresh and never re-scans the now-stale gap. This alone
    # stops the frozen-log re-file that reopened jarvis#829/#830.
    try:
        stale = (time.time() - os.path.getmtime(path)) > PATROL_LOOKBACK_HOURS * 3600
    except OSError:
        stale = False
    if stale:
        cursors[path] = file_size
        return []

    # Cold-start: seed at current EOF so we only watch NEW errors
    if path not in cursors:
        cursors[path] = file_size
        return []

    stored_cursor = cursors[path]

    # Log rotation: file is smaller than our cursor
    if file_size < stored_cursor:
        print(
            f"[log-patrol] INFO: {path} appears rotated"
            f" (size {file_size} < cursor {stored_cursor}); resetting"
        )
        stored_cursor = 0

    if stored_cursor >= file_size:
        # No new data
        return []

    try:
        with open(path, errors="replace") as f:
            f.seek(stored_cursor)
            new_content = f.read()
            new_cursor = f.tell()
    except OSError as exc:
        print(f"[log-patrol] WARN: cannot read {path}: {exc}", file=sys.stderr)
        return []

    cursors[path] = new_cursor

    # Parse lines, collect error blocks
    lines = new_content.splitlines()
    errors_found: list[tuple[str, str]] = []
    now_utc = datetime.now(UTC)
    lookback = timedelta(hours=PATROL_LOOKBACK_HOURS)

    i = 0
    while i < len(lines):
        line = lines[i]
        if _is_error_line(line):
            # Recency gate (line level): a freshly-written file can still contain
            # old lines (e.g. after a rotation reset re-scans from byte 0). Drop
            # any error whose own timestamp is older than the window. Lines with
            # no parseable timestamp pass -- the file-mtime gate above already
            # vouched the file is active.
            line_ts = _parse_line_ts(line)
            if line_ts is not None and (now_utc - line_ts) > lookback:
                i += 1
                continue
            headline = _extract_headline(line)
            # Capture up to 10 lines of context
            context_lines = [lines[i]]
            j = i + 1
            captured = 1
            while j < len(lines) and captured < 10:
                # Stop if the next line looks like a new log entry (different event)
                if _TIMESTAMP_RE.match(lines[j]) and j > i + 1:
                    break
                context_lines.append(lines[j])
                j += 1
                captured += 1
            context_block = "\n".join(context_lines)
            errors_found.append((headline, context_block))
            i = j
        else:
            i += 1

    return errors_found


# ---------------------------------------------------------------------------
# Main patrol loop
# ---------------------------------------------------------------------------

def _current_hour() -> str:
    return datetime.now(UTC).strftime("%Y%m%d%H")


def patrol() -> None:
    state = _load_state()
    _prune_state(state)

    seen = state.setdefault("seen", {})
    rate = state.setdefault("rate", {})
    hour = _current_hour()

    for subsystem, log_path in LOG_TARGETS:
        try:
            errors = _scan_file(subsystem, log_path, state)
        except Exception as exc:
            print(f"[log-patrol] ERROR scanning {subsystem} ({log_path}): {exc}", file=sys.stderr)
            continue

        for headline, context in errors:
            fp = _fingerprint(subsystem, headline)

            # Dedup check
            if fp in seen:
                continue

            # Rate check
            sub_rate = rate.setdefault(subsystem, {})
            count_this_hour = sub_rate.get(hour, 0)
            if count_this_hour >= RATE_LIMIT_PER_HOUR:
                print(
                    f"[log-patrol] rate-limited {subsystem}"
                    f" ({count_this_hour}/{RATE_LIMIT_PER_HOUR} this hour)",
                    file=sys.stderr,
                )
                continue

            # Record before calling out (idempotent on partial failure)
            seen[fp] = time.time()
            sub_rate[hour] = count_this_hour + 1

            print(f"[log-patrol] new error in {subsystem}: {headline[:100]}")

            # Open GitHub issue (non-fatal on failure)
            try:
                _open_github_issue(subsystem, headline, context)
            except Exception as exc:
                print(f"[log-patrol] WARN: gh issue failed: {exc}", file=sys.stderr)

            # Send Discord notification (non-fatal on failure)
            try:
                _send_discord(subsystem, headline)
            except Exception as exc:
                print(f"[log-patrol] WARN: discord notify failed: {exc}", file=sys.stderr)

    _save_state(state)


if __name__ == "__main__":
    patrol()
