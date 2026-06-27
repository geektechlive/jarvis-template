#!/usr/bin/env python3
"""Backfill memories_meta.created_at from ChromaDB received_at metadata.

Run this once after applying the episodic.py timestamp fix to repair already-ingested
mail entries that have ingest time as created_at instead of the original email date.

The ChromaDB metadata for every mail entry includes received_at (the original email
date). This script reads that value and patches the SQLite memories_meta.created_at
so that age_days reflects actual email age, not ingest age.

Usage (on Mini):
    /opt/homebrew/bin/uv run python scripts/backfill-mail-timestamps.py [--dry-run]
"""

from __future__ import annotations

import argparse
import os
import sqlite3
import sys
from collections.abc import Generator
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

import chromadb

# ---------------------------------------------------------------------------
# Paths (mirrors store.py / episodic.py)
# ---------------------------------------------------------------------------

def _data_dir() -> Path:
    raw = os.environ.get("AGENT_DATA_DIR", "~/.jarvis")
    return Path(raw).expanduser()


def _db_path() -> str:
    return str(_data_dir() / "conversations.db")


def _chroma_dir() -> str:
    return str(_data_dir() / "chroma")


@contextmanager
def _connect() -> Generator[sqlite3.Connection, None, None]:
    conn = sqlite3.connect(_db_path())
    try:
        yield conn
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Core backfill
# ---------------------------------------------------------------------------

def backfill(dry_run: bool = False) -> None:
    chroma = chromadb.PersistentClient(path=_chroma_dir())
    collections_to_scan = ["knowledge", "archive"]

    updated = 0
    skipped_no_received_at = 0
    skipped_already_correct = 0
    errors = 0

    for col_name in collections_to_scan:
        try:
            col = chroma.get_collection(col_name)
        except Exception:
            print(f"[skip] collection '{col_name}' does not exist", flush=True)
            continue

        # Fetch all mail-sourced docs. ChromaDB where clause uses $contains for prefix match.
        # We query both "mail" and "mail-aging" sources.
        for source_prefix in ("mail", "mail-aging", "mail-archive"):
            try:
                result = col.get(
                    where={"source": {"$eq": source_prefix}},
                    include=["metadatas"],
                )
            except Exception as e:
                print(f"[warn] query failed for {col_name}/{source_prefix}: {e}", flush=True)
                errors += 1
                continue

            ids = result.get("ids", [])
            metadatas = result.get("metadatas", []) or []
            print(f"[info] {col_name}/{source_prefix}: {len(ids)} entries", flush=True)

            for chroma_id, meta in zip(ids, metadatas):
                received_at = meta.get("received_at") if meta else None
                if not received_at:
                    skipped_no_received_at += 1
                    continue

                # Check current created_at
                with _connect() as conn:
                    row = conn.execute(
                        "SELECT created_at FROM memories_meta WHERE chroma_id = ?",
                        (chroma_id,),
                    ).fetchone()

                if not row:
                    skipped_no_received_at += 1
                    continue

                current_created_at = row[0]

                # Parse both dates and compare at day granularity
                # to avoid re-patching correct entries
                try:
                    current_dt = datetime.fromisoformat(current_created_at.replace("Z", "+00:00"))
                    received_dt = datetime.fromisoformat(received_at.replace("Z", "+00:00"))
                except ValueError:
                    errors += 1
                    continue

                # If already within 1 day of the email date, skip (already correct or close enough)
                delta_days = abs((current_dt - received_dt).days)
                if delta_days <= 1:
                    skipped_already_correct += 1
                    continue

                if dry_run:
                    print(
                        f"[dry-run] would update {chroma_id[:12]}... "
                        f"{current_created_at[:10]} → {received_at[:10]} "
                        f"(delta {delta_days}d)",
                        flush=True,
                    )
                    updated += 1
                    continue

                with _connect() as conn:
                    conn.execute(
                        "UPDATE memories_meta SET created_at = ? WHERE chroma_id = ?",
                        (received_at, chroma_id),
                    )
                    conn.commit()

                updated += 1
                if updated % 50 == 0:
                    print(f"[progress] {updated} entries updated so far...", flush=True)

    print(flush=True)
    mode = "dry-run" if dry_run else "live"
    print(f"[done] backfill complete ({mode})", flush=True)
    print(f"  updated:              {updated}", flush=True)
    print(f"  skipped (no date):    {skipped_no_received_at}", flush=True)
    print(f"  skipped (correct):    {skipped_already_correct}", flush=True)
    print(f"  errors:               {errors}", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print what would be updated without writing to the database.",
    )
    args = parser.parse_args()

    if not args.dry_run:
        print("[warn] running in LIVE mode -- updates will be written to memories_meta", flush=True)
        print("[warn] pass --dry-run to preview changes first", flush=True)
        print(flush=True)

    try:
        backfill(dry_run=args.dry_run)
    except KeyboardInterrupt:
        print("\n[interrupted]", flush=True)
        sys.exit(1)
