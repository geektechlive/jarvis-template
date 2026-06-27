#!/usr/bin/env python3
"""
notes-read -- search and list notes from Notes.app via the local SQLite store.

Reads directly from ~/Library/Group Containers/group.com.apple.notes/NoteStore.sqlite.
No AppleScript or Notes.app process needed -- works in any session context.

Usage:
  notes-read.py [query]              -- search notes by title or snippet
  notes-read.py --recent N           -- return N most recently modified notes (default 10)
  notes-read.py --folder FOLDER      -- filter by folder name (substring match)

Output: JSON array of {id, title, snippet, folder, modifiedDate}
"""

import argparse
import json
import sqlite3
import sys
from datetime import UTC, datetime
from pathlib import Path

NOTES_DB = (
    Path.home() / "Library" / "Group Containers" / "group.com.apple.notes" / "NoteStore.sqlite"
)

# Apple's CoreData epoch starts 2001-01-01 (978307200 seconds after Unix epoch)
APPLE_EPOCH_OFFSET = 978307200


def apple_ts_to_iso(apple_ts: float | None) -> str | None:
    if apple_ts is None:
        return None
    try:
        unix_ts = apple_ts + APPLE_EPOCH_OFFSET
        dt = datetime.fromtimestamp(unix_ts, tz=UTC)
        return dt.strftime("%Y-%m-%dT%H:%M:%SZ")
    except (ValueError, OSError):
        return None


def open_db() -> sqlite3.Connection:
    if not NOTES_DB.exists():
        sys.exit(f"notes-read: NoteStore.sqlite not found at {NOTES_DB}")
    # Open in immutable mode to avoid locking conflicts with Notes.app
    uri = f"file:{NOTES_DB}?immutable=1"
    try:
        conn = sqlite3.connect(uri, uri=True)
        conn.row_factory = sqlite3.Row
        return conn
    except sqlite3.OperationalError:
        # Fallback: try read-only mode
        try:
            conn = sqlite3.connect(f"file:{NOTES_DB}?mode=ro", uri=True)
            conn.row_factory = sqlite3.Row
            return conn
        except sqlite3.OperationalError as e:
            sys.exit(f"notes-read: cannot open NoteStore.sqlite: {e}")


def query_notes(
    conn: sqlite3.Connection,
    search: str | None = None,
    folder_filter: str | None = None,
    limit: int = 10,
) -> list[dict]:  # type: ignore[type-arg]
    """
    Query notes from ZICCLOUDSYNCINGOBJECT.
    Z_ENT=12 is ICNote (verified on macOS 26).
    Uses ZTITLE and ZSNIPPET for text content (ZMERGEABLEDATA is protobuf-encoded).
    """
    params: list[object] = []
    where_clauses: list[str] = [
        "n.Z_ENT = 12",
        "n.ZMARKEDFORDELETION IS NOT 1",
    ]

    if search:
        where_clauses.append(
            "(LOWER(COALESCE(n.ZTITLE,'')) LIKE ? OR LOWER(COALESCE(n.ZSNIPPET,'')) LIKE ?)"
        )
        like = f"%{search.lower()}%"
        params.extend([like, like])

    if folder_filter:
        where_clauses.append("LOWER(COALESCE(f.ZTITLE,'')) LIKE ?")
        params.append(f"%{folder_filter.lower()}%")

    where_sql = " AND ".join(where_clauses)
    params.append(limit)

    sql = f"""
        SELECT
            n.Z_PK          AS id,
            COALESCE(n.ZTITLE, '') AS title,
            COALESCE(n.ZSNIPPET, '') AS snippet,
            COALESCE(f.ZTITLE, '') AS folder,
            n.ZMODIFICATIONDATE1 AS modified_ts
        FROM ZICCLOUDSYNCINGOBJECT n
        LEFT JOIN ZICCLOUDSYNCINGOBJECT f ON f.Z_PK = n.ZFOLDER
        WHERE {where_sql}
        ORDER BY n.ZMODIFICATIONDATE1 DESC
        LIMIT ?
    """

    cursor = conn.execute(sql, params)
    results: list[dict] = []  # type: ignore[type-arg]
    for row in cursor.fetchall():
        modified_raw = row["modified_ts"]
        results.append({
            "id": row["id"],
            "title": row["title"],
            "snippet": row["snippet"],
            "folder": row["folder"],
            "modifiedDate": apple_ts_to_iso(
                float(modified_raw) if modified_raw is not None else None
            ),
        })
    return results


def main() -> None:
    parser = argparse.ArgumentParser(description="Read Notes.app notes via local SQLite")
    parser.add_argument("query", nargs="?", default="", help="Search term (title or snippet)")
    parser.add_argument(
        "--recent", type=int, default=10, help="Number of recent notes to return (default 10)"
    )
    parser.add_argument("--folder", default="", help="Filter by folder name (substring match)")

    args = parser.parse_args()

    conn = open_db()
    try:
        results = query_notes(
            conn,
            search=args.query or None,
            folder_filter=args.folder or None,
            limit=args.recent,
        )
    finally:
        conn.close()

    print(json.dumps(results, ensure_ascii=False))


if __name__ == "__main__":
    main()
