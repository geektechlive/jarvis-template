#!/usr/bin/env python3
"""
Scan Downloads, Documents, and iCloud Drive for files modified in the last 24h.
Output: terse markdown list — filename, location, modified time. Max 20 results.
"""

import argparse
import subprocess
from datetime import datetime, timedelta
from pathlib import Path

SEARCH_ROOTS = [
    Path.home() / "Downloads",
    Path.home() / "Documents",
    Path.home() / "Library" / "Mobile Documents",
]

EXCLUDED_NAMES = {
    ".DS_Store",
    ".localized",
    "Icon\r",
    ".Spotlight-V100",
    ".fseventsd",
}

EXCLUDED_EXTENSIONS = {".tmp", ".crdownload", ".part", ".swp"}


def mdfind_recent(root: Path, hours: int, limit: int) -> list[dict]:
    if not root.exists():
        return []

    cutoff = datetime.now() - timedelta(hours=hours)
    cutoff_str = cutoff.strftime("%Y-%m-%dT%H:%M:%S")

    cmd = [
        "mdfind",
        "-onlyin", str(root),
        f"kMDItemFSContentChangeDate >= $time.iso({cutoff_str})",
    ]

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=10,
        )
        paths = [p.strip() for p in result.stdout.splitlines() if p.strip()]
    except subprocess.TimeoutExpired:
        return []
    except Exception:
        return []

    items = []
    for p_str in paths:
        p = Path(p_str)
        if p.name in EXCLUDED_NAMES:
            continue
        if p.suffix.lower() in EXCLUDED_EXTENSIONS:
            continue
        if p.is_dir():
            continue
        try:
            mtime = datetime.fromtimestamp(p.stat().st_mtime)
        except OSError:
            continue

        # Human-readable relative location
        try:
            rel = str(p.relative_to(Path.home()))
        except ValueError:
            rel = str(p)

        items.append({"name": p.name, "path": rel, "mtime": mtime})

    items.sort(key=lambda x: x["mtime"], reverse=True)
    return items[:limit]


def format_mtime(dt: datetime) -> str:
    now = datetime.now()
    delta = now - dt
    if delta.total_seconds() < 3600:
        mins = int(delta.total_seconds() / 60)
        return f"{mins}m ago"
    if delta.total_seconds() < 86400:
        hrs = int(delta.total_seconds() / 3600)
        return f"{hrs}h ago"
    return dt.strftime("%b %d %H:%M")


def main():
    parser = argparse.ArgumentParser(description="Recent file activity report")
    parser.add_argument("--hours", type=int, default=24, help="Look back N hours (default 24)")
    parser.add_argument("--limit", type=int, default=20, help="Max results (default 20)")
    args = parser.parse_args()

    all_items: list[dict] = []
    for root in SEARCH_ROOTS:
        all_items.extend(mdfind_recent(root, args.hours, args.limit))

    # Re-sort and deduplicate across roots
    seen = set()
    deduped = []
    all_items.sort(key=lambda x: x["mtime"], reverse=True)
    for item in all_items:
        if item["path"] not in seen:
            seen.add(item["path"])
            deduped.append(item)

    deduped = deduped[: args.limit]

    if not deduped:
        print("No recent file activity.")
        return

    for item in deduped:
        age = format_mtime(item["mtime"])
        print(f"- {item['name']} ({age}) — ~/{item['path']}")


if __name__ == "__main__":
    main()
