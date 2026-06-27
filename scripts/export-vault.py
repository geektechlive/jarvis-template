#!/usr/bin/env python3
"""export-vault -- export all three ChromaDB memory collections to iCloud-backed markdown.

Calls the vec-server /vault_export endpoint (POST) so all DB access stays
server-side and avoids concurrent ChromaDB access from a second process.

Output directory:
  ~/Library/Mobile Documents/com~apple~CloudDocs/Jarvis/memory/

Output files:
  user_profile.md
  knowledge.md
  agent_memories.md

Usage:
  uv run --project ~/Jarvis python scripts/export-vault.py
  uv run --project ~/Jarvis python scripts/export-vault.py --server http://127.0.0.1:9876
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from datetime import UTC, datetime
from pathlib import Path

COLLECTIONS: list[tuple[str, str]] = [
    ("user_profile", "Personal Profile"),
    ("knowledge", "Knowledge"),
    ("agent_memories", "Agent Memories"),
]

OUTPUT_DIR = (
    Path.home() / "Library" / "Mobile Documents" / "com~apple~CloudDocs" / "Jarvis" / "memory"
)


def _fetch_vault(server: str) -> dict[str, list[dict]]:
    """POST /vault_export and return the collections dict."""
    url = f"{server}/vault_export"
    req = urllib.request.Request(
        url,
        data=b"{}",
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        body = json.loads(resp.read().decode())
    if "error" in body:
        raise RuntimeError(f"vault_export error: {body['error']}")
    return body["collections"]  # type: ignore[return-value]


def _format_md(col_name: str, title: str, rows: list[dict]) -> str:
    """Render a collection's rows as markdown."""
    now_utc = datetime.now(UTC).strftime("%Y-%m-%d %H:%M UTC")
    count = len(rows)
    lines: list[str] = [
        f"# {title}",
        f"_Updated {now_utc} - {count} entries_",
        "",
    ]
    for row in rows:
        text = (row.get("text") or "").strip()
        if not text:
            continue
        stored_at = row.get("stored_at") or ""
        date_str = stored_at[:10] if len(stored_at) >= 10 else ""
        confidence = row.get("confidence")
        # Only append confidence when it is meaningfully below default (0.95).
        if isinstance(confidence, float) and confidence < 0.95:
            annotation = (
                f"_({date_str}, conf {confidence:.2f})_"
                if date_str
                else f"_(conf {confidence:.2f})_"
            )
        else:
            annotation = f"_({date_str})_" if date_str else ""
        entry = f"- {text}  {annotation}" if annotation else f"- {text}"
        lines.append(entry)
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description="Export memory vault to iCloud markdown.")
    parser.add_argument(
        "--server",
        default="http://127.0.0.1:9876",
        help="vec-server base URL (default: http://127.0.0.1:9876)",
    )
    parser.add_argument(
        "--output-dir",
        default=str(OUTPUT_DIR),
        help="Output directory path (default: iCloud Jarvis/memory)",
    )
    args = parser.parse_args()

    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    try:
        collections = _fetch_vault(args.server)
    except Exception as exc:
        print(f"export-vault: fetch failed: {exc}", file=sys.stderr)
        return 1

    for col_name, title in COLLECTIONS:
        rows = collections.get(col_name, [])
        md = _format_md(col_name, title, rows)
        out_path = out_dir / f"{col_name}.md"
        out_path.write_text(md, encoding="utf-8")
        print(f"export-vault: wrote {out_path} ({len(rows)} entries)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
