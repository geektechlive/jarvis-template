"""Tests for the recency gate and fingerprint normalization in scripts/log-patrol.py.

These pin the two behaviors that stop the patrol from re-filing stale errors as
if they were live (jarvis#829/#830):

  1. Timestamp parsing + recency gating -- old lines and frozen files are dropped.
  2. Headline normalization -- two occurrences of the same error (differing only
     in session id / retry counter / timestamp) collapse to one fingerprint, so
     dedup actually holds across occurrences.
"""

import importlib.util
import os
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

_SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "log-patrol.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("log_patrol", _SCRIPT)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


lp = _load_module()


# --- _parse_line_ts ---------------------------------------------------------


def test_parse_naive_local_timestamp_is_aware():
    # vec-server asctime shape: naive local time, no tz suffix
    line = "2026-06-20 08:35:02 [WARNING] harness.memory.graph graph_ingest: boom"
    ts = lp._parse_line_ts(line)
    assert ts is not None
    assert ts.tzinfo is not None  # localized + converted to UTC


def test_parse_json_utc_timestamp():
    line = '{"time":"2026-06-20T13:35:02Z","level":"error","msg":"x"}'
    assert lp._parse_line_ts(line) == datetime(2026, 6, 20, 13, 35, 2, tzinfo=UTC)


def test_parse_bracketed_timestamp():
    assert lp._parse_line_ts("[2026-06-20 08:35:02] something") is not None


def test_parse_returns_none_when_no_timestamp():
    assert lp._parse_line_ts("[WARNING] no timestamp on this line") is None


# --- _normalize_headline / _fingerprint -------------------------------------


def test_normalize_collapses_session_attempt_retry_and_timestamp():
    a = (
        "2026-06-20 08:35:02 [WARNING] graph_ingest: transient error for "
        "'jarvis-t1' (attempt 1/3) -- retrying in 8s: 2 validation errors for ExtractedEdges"
    )
    b = (
        "2026-06-19 21:17:44 [WARNING] graph_ingest: transient error for "
        "'4d1d6ccc-t2' (attempt 3/3) -- retrying in 2s: 2 validation errors for ExtractedEdges"
    )
    assert lp._normalize_headline(a) == lp._normalize_headline(b)


def test_fingerprint_stable_across_occurrences():
    a = "transient error for 'jarvis-t1' (attempt 1/3) -- retrying in 8s: boom"
    b = "transient error for 'jarvis-t9' (attempt 2/3) -- retrying in 4s: boom"
    assert lp._fingerprint("vec-server", a) == lp._fingerprint("vec-server", b)


def test_fingerprint_distinguishes_different_errors():
    a = "transient error for 'jarvis-t1': boom"
    b = "transient error for 'jarvis-t1': totally different failure"
    assert lp._fingerprint("vec-server", a) != lp._fingerprint("vec-server", b)


# --- _scan_file recency behavior --------------------------------------------


def _write(tmp_path, name, content, age_seconds=0):
    p = tmp_path / name
    p.write_text(content)
    if age_seconds:
        t = time.time() - age_seconds
        os.utime(p, (t, t))
    return str(p)


def test_scan_skips_stale_file_and_reseeds_cursor(tmp_path):
    # File last written 48h ago, well outside the 6h default window.
    path = _write(tmp_path, "vector.error.log", "2020-01-01 00:00:00 [ERROR] old boom\n",
                  age_seconds=48 * 3600)
    state = {"cursors": {path: 0}}  # cursor behind EOF -> would normally scan
    out = lp._scan_file("vec-server", path, state)
    assert out == []
    assert state["cursors"][path] == os.path.getsize(path)  # reseeded to EOF


def test_scan_drops_old_lines_keeps_recent(tmp_path):
    old = (datetime.now() - timedelta(hours=48)).strftime("%Y-%m-%d %H:%M:%S")
    new = (datetime.now() - timedelta(minutes=5)).strftime("%Y-%m-%d %H:%M:%S")
    content = f"{old} [ERROR] stale boom alpha\n{new} [ERROR] live boom bravo\n"
    path = _write(tmp_path, "vector.error.log", content)  # fresh mtime
    state = {"cursors": {path: 0}}
    headlines = [h for h, _ in lp._scan_file("vec-server", path, state)]
    assert any("bravo" in h for h in headlines)
    assert not any("alpha" in h for h in headlines)


def test_scan_keeps_undateable_line_in_active_file(tmp_path):
    # No parseable timestamp, but the file is fresh -> the line is genuinely new.
    path = _write(tmp_path, "discord-bot.error.log", "[ERROR] no timestamp but live\n")
    state = {"cursors": {path: 0}}
    headlines = [h for h, _ in lp._scan_file("discord-bot", path, state)]
    assert any("live" in h for h in headlines)
