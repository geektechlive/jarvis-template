#!/usr/bin/env python3
"""One-time FTS backfill (jarvis#804): index live vectors that have no memories_fts
row, restoring the hybrid recall router's FTS-first path.

The write path (store._remember_locked -> episodic.index_memory) indexes FTS for
every new write, and failures are now visible (embed_write_failure, #811c). This
fills the historical gap: ~647 vectors written before FTS indexing existed (or
whose FTS insert silently failed pre-#811c) have a vector but no FTS row, leaving
coverage near 53%.

Usage:
  python scripts/backfill_fts.py            # dry-run (default)
  python scripts/backfill_fts.py --apply    # index the missing rows
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

from harness.memory import episodic  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="index missing rows (default: dry-run)")
    args = ap.parse_args()

    data = Path(os.environ.get("AGENT_DATA_DIR", "~/.jarvis")).expanduser()
    episodic.init_db()

    client = chromadb.PersistentClient(path=str(data / "chroma"))
    conn = sqlite3.connect(str(data / "conversations.db"))
    fts = {r[0] for r in conn.execute("SELECT chroma_id FROM memories_fts")}
    conn.close()

    to_index: list[tuple[str, str, str]] = []  # (chroma_id, collection, document)
    live = 0
    for col in client.list_collections():
        got = col.get(include=["documents"])
        ids = got.get("ids") or []
        docs = got.get("documents") or []
        for cid, doc in zip(ids, docs):
            live += 1
            if cid not in fts and doc:
                to_index.append((cid, col.name, doc))

    print(f"live vectors: {live} | fts rows: {len(fts)} | missing fts: {len(to_index)}")
    print("  by collection:", dict(Counter(c for _, c, _ in to_index)))

    if not args.apply:
        print("\nDRY-RUN. Re-run with --apply to backfill.")
        return 0

    indexed = 0
    for cid, coll, doc in to_index:
        try:
            episodic.index_memory(cid, coll, doc)
            indexed += 1
        except Exception as exc:  # noqa: BLE001 - best-effort per row
            print(f"  failed {cid[:8]} ({coll}): {exc}", file=sys.stderr)
    print(f"\nAPPLIED: indexed {indexed} FTS rows.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
