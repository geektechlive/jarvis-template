#!/usr/bin/env python3
"""Claude Code session ingest — push session data to Jarvis memory.

Two modes (auto-detected):
  Dev machine: reads ~/.claude/usage-data/session-meta/ + facets/ (processed summaries)
  Mini:        reads ~/.claude/projects/**/*.jsonl (raw transcripts, no usage-data present)

Idempotent: every session_id is recorded in ~/.jarvis/claude-ingest.db
and skipped on re-runs. Safe to interrupt and resume.

Usage:
    ./claude-code-ingest.py               # process new sessions
    ./claude-code-ingest.py --dry-run     # print what would be posted, no writes
    ./claude-code-ingest.py --smoke-test  # post one entry and verify recall

Env:
    MINI_HOST            host:port of vec-server (default: <mac-mini-ip>:9876)
    CLAUDE_USAGE_DIR     override ~/.claude/usage-data path
    CLAUDE_PROJECTS_DIR  override ~/.claude/projects path (jsonl fallback)
    CLAUDE_INGEST_DB     override ~/.jarvis/claude-ingest.db path
"""
from __future__ import annotations

import argparse
import json
import os
import socket
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import UTC, datetime
from pathlib import Path

_MINI_SSH_HOST = os.environ.get("MINI_SSH_HOST", "")
_MINI_HOST = os.environ.get("MINI_HOST", "<mac-mini-ip>:9876")

# VEC_SERVER and _tunnel_proc are resolved at startup in main()
VEC_SERVER = f"http://{_MINI_HOST}"
_tunnel_proc: subprocess.Popen | None = None


def _open_ssh_tunnel(ssh_host: str, remote_port: int = 9876) -> tuple[int, subprocess.Popen]:
    """Open an SSH tunnel. Returns (local_port, process). Caller must terminate process."""
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

CLAUDE_USAGE_DIR = Path(os.environ.get("CLAUDE_USAGE_DIR", Path.home() / ".claude" / "usage-data"))
SESSION_META_DIR = CLAUDE_USAGE_DIR / "session-meta"
FACETS_DIR = CLAUDE_USAGE_DIR / "facets"

CLAUDE_PROJECTS_DIR = Path(
    os.environ.get("CLAUDE_PROJECTS_DIR", Path.home() / ".claude" / "projects")
)

INGEST_DB = Path(
    os.environ.get("CLAUDE_INGEST_DB", Path.home() / ".jarvis" / "claude-ingest.db")
)

# Session with this project_path suffix → agent_memories; all others → episodic_journal
JARVIS_PROJECT_SUFFIX = "Jarvis"

# Meta-knowledge sentinel — written once, never re-written
_META_SENTINEL = "__insights_meta__"

_META_TEXT = (
    "Claude Code /insights is a built-in command that aggregates session data from "
    "~/.claude/usage-data/ -- session-meta for quantitative stats (duration, tool "
    "counts, token usage, commits) and facets for LLM-digested goal/outcome/summary "
    "per session. Jarvis ingests this data daily via claude-code-ingest.py pushing "
    "from the dev machine to Mini's vec server. Recall includes Alex's work patterns, "
    "project velocity, goal outcomes, and friction points across all projects."
)


# ---------------------------------------------------------------------------
# SQLite dedup
# ---------------------------------------------------------------------------


def _open_db() -> sqlite3.Connection:
    INGEST_DB.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(INGEST_DB))
    conn.execute(
        "CREATE TABLE IF NOT EXISTS processed_sessions "
        "(session_id TEXT PRIMARY KEY, processed_at TEXT NOT NULL)"
    )
    conn.commit()
    return conn


def _is_processed(conn: sqlite3.Connection, session_id: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM processed_sessions WHERE session_id = ?", (session_id,)
    ).fetchone()
    return row is not None


def _mark_processed(conn: sqlite3.Connection, session_id: str) -> None:
    conn.execute(
        "INSERT OR IGNORE INTO processed_sessions (session_id, processed_at) VALUES (?, ?)",
        (session_id, datetime.now(UTC).isoformat()),
    )
    conn.commit()


# ---------------------------------------------------------------------------
# Vec server
# ---------------------------------------------------------------------------


def _post_remember(
    text: str,
    collection: str,
    source: str,
    source_actor: str,
    metadata: dict,
    timeout: float = 20.0,
    retries: int = 3,
    delay: float = 5.0,
) -> bool:
    payload = json.dumps({
        "text": text[:1500],
        "collection": collection,
        "source": source,
        "source_actor": source_actor,
        "metadata": metadata,
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{VEC_SERVER}/remember",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    last_exc: Exception = RuntimeError("no attempts")
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310
                return resp.status < 400
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            last_exc = exc
            if attempt < retries - 1:
                time.sleep(delay)
    print(f"  remember failed after {retries} attempts: {last_exc}", file=sys.stderr)
    return False


def _post_recall(query: str, collection: str, n: int = 1) -> list[dict]:
    payload = json.dumps({"query": query, "collection": collection, "n": n}).encode("utf-8")
    req = urllib.request.Request(
        f"{VEC_SERVER}/recall",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:  # noqa: S310
            data = json.loads(resp.read().decode("utf-8"))
            if isinstance(data, dict):
                return data.get("results", [])
            return data
    except Exception:
        return []


# ---------------------------------------------------------------------------
# Session parsing
# ---------------------------------------------------------------------------


def _load_session_meta(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _load_facets(session_id: str) -> dict | None:
    p = FACETS_DIR / f"{session_id}.json"
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _project_name(project_path: str | None) -> str:
    if not project_path:
        return "unknown"
    return Path(project_path).name or "unknown"


def _is_jarvis_session(project_path: str | None) -> bool:
    if not project_path:
        return False
    return JARVIS_PROJECT_SUFFIX in project_path


def _top_tools(tool_counts: dict, n: int = 3) -> str:
    if not tool_counts:
        return ""
    top = sorted(tool_counts.items(), key=lambda kv: kv[1], reverse=True)[:n]
    return ", ".join(name for name, _ in top)


def _build_entry(meta: dict, facets: dict | None) -> tuple[str, dict]:
    """Return (text, metadata) for a session."""
    session_id = meta.get("session_id", "")
    project_path = meta.get("project_path", "")
    project = _project_name(project_path)
    duration = meta.get("duration_minutes", 0)
    commits = meta.get("git_commits", 0)
    lines_added = meta.get("lines_added", 0)
    session_type = meta.get("session_type") or "coding"
    start_time = meta.get("start_time", "")
    date_str = start_time[:10] if start_time else ""

    if facets:
        summary = facets.get("brief_summary", "").strip()
        goal = facets.get("underlying_goal", "").strip()
        outcome = facets.get("outcome", "").strip()
        friction = facets.get("friction_detail", "").strip()

        parts = [f"Claude Code session on {project}"]
        if date_str:
            parts[0] += f" ({date_str})"
        parts.append(f": {summary}" if summary else ".")
        if goal:
            parts.append(f" Goal: {goal}.")
        if outcome:
            parts.append(f" Outcome: {outcome}.")
        if duration or commits:
            stats = []
            if duration:
                stats.append(f"{duration}min")
            if commits:
                stats.append(f"{commits} commits")
            parts.append(f" Duration: {', '.join(stats)}.")
        if friction:
            parts.append(f" Friction: {friction}")
        text = "".join(parts)
    else:
        tools_str = _top_tools(meta.get("tool_counts", {}))
        parts = [f"Claude Code session on {project}"]
        if date_str:
            parts[0] += f" ({date_str})"
        parts.append(f": {session_type} session, {duration}min.")
        if commits:
            parts.append(f" {commits} commits, {lines_added} lines added.")
        if tools_str:
            parts.append(f" Top tools: {tools_str}.")
        text = "".join(parts)

    metadata = {
        "project_name": project,
        "project_path": project_path,
        "session_id": session_id,
        "date": date_str,
        "outcome": facets.get("outcome", "") if facets else "",
        "session_type": session_type,
        "has_facets": facets is not None,
    }
    return text[:1500], metadata


# ---------------------------------------------------------------------------
# Meta-knowledge
# ---------------------------------------------------------------------------


def _ensure_meta_knowledge(conn: sqlite3.Connection, dry_run: bool) -> None:
    if _is_processed(conn, _META_SENTINEL):
        return
    if dry_run:
        print(f"[DRY-RUN] meta-knowledge → knowledge:\n  {_META_TEXT[:120]}...")
        return
    ok = _post_remember(
        _META_TEXT,
        collection="knowledge",
        source="manual",
        source_actor="ingest",
        metadata={"kind": "system_meta", "component": "claude_code_insights"},
    )
    if ok:
        _mark_processed(conn, _META_SENTINEL)
        print("meta-knowledge written to knowledge collection")
    else:
        print("meta-knowledge write failed (will retry next run)", file=sys.stderr)


# ---------------------------------------------------------------------------
# JSONL fallback (Mini — no usage-data present)
# ---------------------------------------------------------------------------


def _decode_project_path(dir_name: str) -> str:
    """Convert '-Users-<username>-Jarvis' → '/Users/<username>/Jarvis'."""
    return dir_name.replace("-", "/")


def _extract_jsonl_session(path: Path, project_path: str) -> tuple[str, dict] | None:
    user_messages: list[str] = []
    assistant_snippets: list[str] = []
    date_str = ""
    try:
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            if not line.strip():
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not date_str and entry.get("timestamp"):
                date_str = entry["timestamp"][:10]
            if entry.get("type") == "user":
                msg = entry.get("message", {})
                if isinstance(msg, dict) and msg.get("role") == "user":
                    content = msg.get("content", "")
                    if isinstance(content, str) and len(content) > 20:
                        user_messages.append(content[:300])
                    elif isinstance(content, list):
                        for block in content:
                            if isinstance(block, dict) and block.get("type") == "text":
                                text = block.get("text", "")
                                if len(text) > 20:
                                    user_messages.append(text[:300])
                                    break
            elif entry.get("type") == "assistant":
                msg = entry.get("message", {})
                if isinstance(msg, dict):
                    for block in (msg.get("content") or []):
                        if isinstance(block, dict) and block.get("type") == "text":
                            text = block.get("text", "").strip()
                            if len(text) > 20:
                                assistant_snippets.append(text[:200])
                                break
    except OSError:
        return None
    if not user_messages:
        return None
    project = _project_name(project_path)
    parts = [f"Jarvis session on {project}"]
    if date_str:
        parts[0] += f" ({date_str})"
    parts.append(f": {user_messages[0][:200]}")
    if len(user_messages) > 1:
        parts.append(f" [{len(user_messages)} exchanges]")
    if assistant_snippets:
        parts.append(f" Response: {assistant_snippets[0][:150]}")
    text = " ".join(parts)
    metadata = {
        "project_name": project,
        "project_path": project_path,
        "session_id": path.stem,
        "date": date_str,
        "outcome": "",
        "session_type": "conversation",
        "has_facets": False,
        "source_format": "jsonl",
    }
    return text[:1500], metadata


def _ingest_jsonl_sessions(conn: sqlite3.Connection, args: argparse.Namespace) -> None:
    if not CLAUDE_PROJECTS_DIR.exists():
        print(f"claude-code-ingest: projects dir not found: {CLAUDE_PROJECTS_DIR}", file=sys.stderr)
        sys.exit(1)
    processed = skipped = errors = total = 0
    for project_dir in sorted(CLAUDE_PROJECTS_DIR.iterdir()):
        if not project_dir.is_dir():
            continue
        project_path = _decode_project_path(project_dir.name)
        collection = "agent_memories" if _is_jarvis_session(project_path) else "episodic_journal"
        for jsonl_file in sorted(project_dir.glob("*.jsonl")):
            total += 1
            session_id = jsonl_file.stem
            if _is_processed(conn, session_id):
                skipped += 1
                continue
            result = _extract_jsonl_session(jsonl_file, project_path)
            if not result:
                # No extractable user content (e.g. /private/tmp temp sessions).
                # This is normal control flow, not an error -- keep it off stderr
                # and only surface per-skip detail under --dry-run. The aggregate
                # skipped count is printed to stdout at the end of this function.
                skipped += 1
                if args.dry_run:
                    print(
                        f"claude-code-ingest: skip {session_id[:12]} ({project_path})"
                    )
                continue
            text, metadata = result
            if args.dry_run:
                print(
                    f"[DRY-RUN] {session_id[:8]}... → {collection}"
                    f" ({metadata['project_name']}): {text[:100]}..."
                )
                _mark_processed(conn, session_id)
                processed += 1
                continue
            ok = _post_remember(
                text,
                collection=collection,
                source="claude-code",
                source_actor="ingest",
                metadata=metadata,
            )
            if ok:
                _mark_processed(conn, session_id)
                processed += 1
            else:
                errors += 1
                print(
                    f"claude-code-ingest: post failed {session_id[:12]} ({project_path})",
                    file=sys.stderr,
                )
    conn.close()
    print(
        f"claude-code-ingest (jsonl):"
        f" processed={processed} skipped={skipped} errors={errors} (total={total})"
    )


def _ingest_usage_data_sessions(conn: sqlite3.Connection, args: argparse.Namespace) -> None:
    session_files = sorted(SESSION_META_DIR.glob("*.json"))
    processed = skipped = errors = 0
    for path in session_files:
        meta = _load_session_meta(path)
        if not meta:
            errors += 1
            continue
        session_id = meta.get("session_id", path.stem)
        if _is_processed(conn, session_id):
            skipped += 1
            continue
        facets = _load_facets(session_id)
        text, metadata = _build_entry(meta, facets)
        is_jarvis = _is_jarvis_session(meta.get("project_path"))
        collection = "agent_memories" if is_jarvis else "episodic_journal"
        if args.dry_run:
            project = metadata["project_name"]
            print(f"[DRY-RUN] {session_id[:8]}... → {collection} ({project}): {text[:100]}...")
            _mark_processed(conn, session_id)
            processed += 1
            continue
        ok = _post_remember(
            text,
            collection=collection,
            source="claude-code",
            source_actor="ingest",
            metadata=metadata,
        )
        if ok:
            _mark_processed(conn, session_id)
            processed += 1
        else:
            errors += 1
    conn.close()
    print(
        f"claude-code-ingest:"
        f" processed={processed} skipped={skipped} errors={errors} (total={len(session_files)})"
    )


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    global VEC_SERVER, _tunnel_proc

    parser = argparse.ArgumentParser(description="Ingest Claude Code sessions into Jarvis memory")
    parser.add_argument("--dry-run", action="store_true", help="Print entries without writing")
    parser.add_argument(
        "--smoke-test", action="store_true", help="Write one entry and verify recall"
    )
    args = parser.parse_args()

    if _MINI_SSH_HOST and not args.dry_run:
        local_port, _tunnel_proc = _open_ssh_tunnel(_MINI_SSH_HOST)
        VEC_SERVER = f"http://127.0.0.1:{local_port}"

    try:
        _main(args)
    finally:
        if _tunnel_proc is not None:
            _tunnel_proc.terminate()


def _main(args: argparse.Namespace) -> None:
    conn = _open_db()
    _ensure_meta_knowledge(conn, dry_run=args.dry_run)

    if args.smoke_test:
        _run_smoke_test(conn)
        return

    if SESSION_META_DIR.exists():
        _ingest_usage_data_sessions(conn, args)
    else:
        _ingest_jsonl_sessions(conn, args)


def _run_smoke_test(conn: sqlite3.Connection) -> None:
    smoke_id = "__smoke_test__"

    if _is_processed(conn, smoke_id):
        conn.execute("DELETE FROM processed_sessions WHERE session_id = ?", (smoke_id,))
        conn.commit()

    ts = datetime.now(UTC).strftime("%Y%m%dT%H%M%S")
    text = (
        f"Claude Code smoke test session on Jarvis (smoke-test-{ts}): verified push pipeline."
    )
    ok = _post_remember(
        text,
        collection="episodic_journal",
        source="claude-code",
        source_actor="ingest",
        metadata={"project_name": "Jarvis", "session_id": smoke_id, "kind": "smoke_test"},
    )
    if not ok:
        print("claude-code-ingest smoke-test: FAIL (POST failed)", file=sys.stderr)
        conn.close()
        sys.exit(1)

    time.sleep(1)
    results = _post_recall("Claude Code smoke test session Jarvis", "episodic_journal", n=3)
    found = any("smoke" in str(r).lower() for r in results)

    if found:
        print("claude-code-ingest smoke-test: PASS")
        print(f"  recalled: {str(results[0])[:120]}...")
        _mark_processed(conn, smoke_id)
    else:
        print("claude-code-ingest smoke-test: FAIL (entry not recalled)", file=sys.stderr)
        conn.close()
        sys.exit(1)

    conn.close()


if __name__ == "__main__":
    main()
