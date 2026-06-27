#!/usr/bin/env python3
"""One-time reconciliation for jarvis#803: mark dangling-active memories_meta rows
superseded so they stop inflating active counts and polluting recall.

A "dangling-active" row has superseded_by IS NULL/'' but no live ChromaDB vector --
the residue of pre-fix forget*/TTL deletes that didn't supersede. The P0 diagnosis
(#802) established genuine content loss is ~0 (merges + re-learned duplicates), so
this is a safe cleanup, not a recovery.

Usage:
  python scripts/reconcile_dangling_memory.py            # dry-run (default)
  python scripts/reconcile_dangling_memory.py --apply    # write superseded_by='reconciled'
"""
from __future__ import annotations

import argparse
import os
import sqlite3
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, os.path.expanduser("~/Jarvis"))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import chromadb  # noqa: E402

RECONCILE_LABEL = "reconciled"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="write changes (default: dry-run)")
    args = ap.parse_args()

    data = Path(os.environ.get("AGENT_DATA_DIR", "~/.jarvis")).expanduser()
    db_path = str(data / "conversations.db")
    chroma_path = str(data / "chroma")

    client = chromadb.PersistentClient(path=chroma_path)
    live: set[str] = set()
    for col in client.list_collections():
        live |= set((col.get(include=[]).get("ids")) or [])

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT chroma_id, collection, source FROM memories_meta "
        "WHERE superseded_by IS NULL OR superseded_by = ''"
    ).fetchall()
    dangling = [r for r in rows if r["chroma_id"] not in live]

    print(f"live vectors: {len(live)}")
    print(f"active meta rows: {len(rows)}")
    print(f"dangling-active rows to reconcile: {len(dangling)}")
    by_coll = Counter(r["collection"] for r in dangling)
    print(f"  by collection: {dict(by_coll)}")

    if not args.apply:
        print("\nDRY-RUN. Re-run with --apply to set superseded_by='reconciled'.")
        conn.close()
        return 0

    ids = [r["chroma_id"] for r in dangling]
    updated = 0
    BATCH = 500
    for i in range(0, len(ids), BATCH):
        chunk = ids[i : i + BATCH]
        ph = ",".join("?" * len(chunk))
        cur = conn.execute(
            f"UPDATE memories_meta SET superseded_by = ? "  # noqa: S608 - count-built placeholders
            f"WHERE chroma_id IN ({ph}) AND (superseded_by IS NULL OR superseded_by = '')",
            (RECONCILE_LABEL, *chunk),
        )
        updated += cur.rowcount
    conn.commit()
    conn.close()
    print(f"\nAPPLIED: marked {updated} rows superseded_by='{RECONCILE_LABEL}'.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
