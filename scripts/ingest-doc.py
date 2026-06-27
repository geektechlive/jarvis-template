#!/usr/bin/env python3
"""Ingest a document (PDF or text file) into Jarvis semantic memory.

Extracts text from a file, splits it into chunks under the vec-server's
per-entry character cap, and POSTs each chunk to the vec-server /remember
endpoint. This is the sanctioned way to ingest a document -- the ingest_document
ion tool shells out to this script, and staff should call it rather than
hand-writing an ingest script.

Usage:
    ingest-doc <path> [--collection knowledge] [--document NAME] [--source SRC]
                      [--vec-url http://localhost:9876]

PDF extraction requires the optional `pdf` extra: `uv sync --extra pdf`.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.request
from pathlib import Path

# Stay safely under the vec-server's 1500-char per-entry cap (it returns 422
# above the limit). Matches the chunk size used by earlier ad-hoc ingests.
MAX_CHARS = 1400
DEFAULT_VEC_URL = os.environ.get("VEC_SERVER", "http://localhost:9876")


def slugify(name: str) -> str:
    """Lowercase, underscore-separated slug usable as a memory `source` tag."""
    slug = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")
    return slug or "document"


def extract_text(path: Path) -> str:
    """Return the document's text. PDFs go through pypdf; everything else is
    read as UTF-8 text."""
    if path.suffix.lower() == ".pdf":
        return _extract_pdf(path)
    return path.read_text(encoding="utf-8", errors="replace")


def _extract_pdf(path: Path) -> str:
    try:
        from pypdf import PdfReader
    except ImportError as exc:
        raise SystemExit(
            "pypdf is not installed. Run: uv sync --extra pdf"
        ) from exc
    reader = PdfReader(str(path))
    pages = [page.extract_text() or "" for page in reader.pages]
    return "\n\n".join(pages)


def split_text(text: str, max_chars: int = MAX_CHARS) -> list[str]:
    """Pack paragraphs into chunks of at most `max_chars`, splitting an
    oversized paragraph on line boundaries as a fallback."""
    chunks: list[str] = []
    current = ""
    for raw_para in text.split("\n\n"):
        para = raw_para.strip()
        if not para:
            continue
        if len(para) > max_chars:
            if current:
                chunks.append(current)
                current = ""
            current = _flush_long_paragraph(para, chunks, max_chars)
        elif len(current) + len(para) + 2 > max_chars:
            if current:
                chunks.append(current)
            current = para
        else:
            current = f"{current}\n\n{para}" if current else para
    if current:
        chunks.append(current)
    return chunks


def _flush_long_paragraph(para: str, chunks: list[str], max_chars: int) -> str:
    """Split a single paragraph longer than max_chars on line boundaries.
    Appends all complete chunks to `chunks` and returns the trailing remainder."""
    sub = ""
    for line in para.split("\n"):
        if len(sub) + len(line) + 1 > max_chars:
            if sub:
                chunks.append(sub)
            sub = line
        else:
            sub = f"{sub}\n{line}" if sub else line
    return sub


def post_chunk(
    vec_url: str,
    text: str,
    *,
    collection: str,
    source: str,
    document: str,
    chunk_idx: int,
) -> bool:
    """POST one chunk to /remember. Returns True on HTTP 200."""
    payload = {
        "text": text,
        "collection": collection,
        "source": source,
        "source_actor": "document_ingest",
        "metadata": {
            "document": document,
            "chunk": chunk_idx,
            "type": "document",
        },
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{vec_url}/remember",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return response.status == 200
    except Exception as exc:
        print(f"  ERROR: {exc}")
        return False


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Ingest a document into memory.")
    parser.add_argument("path", help="Path to the PDF or text file to ingest.")
    parser.add_argument(
        "--collection", default="knowledge", help="Target memory collection."
    )
    parser.add_argument(
        "--document", default=None, help="Document name (default: file stem)."
    )
    parser.add_argument(
        "--source", default=None, help="Memory source tag (default: slug of document)."
    )
    parser.add_argument(
        "--vec-url", default=DEFAULT_VEC_URL, help="vec-server base URL."
    )
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    path = Path(args.path).expanduser()
    if not path.is_file():
        print(f"error: file not found: {path}", file=sys.stderr)
        return 1

    document = args.document or path.stem
    source = args.source or slugify(document)

    text = extract_text(path)
    if not text.strip():
        print(f"error: no extractable text in {path}", file=sys.stderr)
        return 1

    chunks = split_text(text)
    print(
        f"Ingesting '{document}' into '{args.collection}' "
        f"({len(chunks)} chunks, source={source})..."
    )
    stored = 0
    for idx, chunk in enumerate(chunks):
        print(f"  chunk {idx} ({len(chunk)} chars)...", end=" ", flush=True)
        ok = post_chunk(
            args.vec_url,
            chunk,
            collection=args.collection,
            source=source,
            document=document,
            chunk_idx=idx,
        )
        print("ok" if ok else "FAILED")
        stored += int(ok)

    print(f"\nDone: {stored}/{len(chunks)} chunks ingested.")
    return 0 if stored == len(chunks) else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
