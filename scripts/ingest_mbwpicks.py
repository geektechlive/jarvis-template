#!/usr/bin/env python3
"""Bulk-ingest one year of MBW Picks posts into the agent knowledge base.

Run on the Mac Mini after deploying:
    uv run python scripts/ingest_mbwpicks.py

Each episode is stored as a compact memory entry containing all picks,
hosts, and links so the agent can answer questions like:
  "what did Andy Ihnatko recommend this year?"
  "any video editing picks from MBW?"
  "what was picked on episode 1018?"
"""
from __future__ import annotations

import sys
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import httpx
from bs4 import BeautifulSoup
from dotenv import load_dotenv

load_dotenv()

from harness.memory.store import MAX_MEMORY_CHARS, VectorStore  # noqa: E402

BASE_URL = "https://www.mbwpicks.com"
CUTOFF = datetime.now(UTC) - timedelta(days=365)
REQUEST_DELAY = 0.6  # seconds — be a polite guest
MAX_PAGES = 10


def _get(url: str) -> httpx.Response:
    return httpx.get(url, timeout=15, follow_redirects=True, headers={
        "User-Agent": "Jarvis/1.0 (personal knowledge ingest)",
    })


def collect_posts() -> list[tuple[str, str, datetime | None]]:
    """Walk listing pages and return (title, url, date) for all posts within cutoff."""
    posts: list[tuple[str, str, datetime | None]] = []

    for page in range(1, MAX_PAGES + 1):
        url = BASE_URL if page == 1 else f"{BASE_URL}/page/{page}/"
        print(f"  Page {page}: {url}")

        try:
            r = _get(url)
            r.raise_for_status()
        except Exception as exc:
            print(f"    Failed: {exc}")
            break

        soup = BeautifulSoup(r.text, "html.parser")
        articles = soup.find_all("article")
        if not articles:
            print("    No articles found — stopping.")
            break

        reached_cutoff = False
        for article in articles:
            heading = article.find("h2") or article.find("h1")
            if not heading:
                continue
            link = heading.find("a")
            if not link:
                continue

            post_url: str = link.get("href", "")
            title: str = link.get_text(strip=True)

            time_el = article.find("time")
            post_date: datetime | None = None
            if time_el:
                raw = time_el.get("datetime", "")
                try:
                    post_date = datetime.fromisoformat(raw.replace("Z", "+00:00"))
                except ValueError:
                    pass

            if post_date and post_date < CUTOFF:
                reached_cutoff = True
                break

            posts.append((title, post_url, post_date))

        if reached_cutoff:
            print("    Hit year cutoff — stopping pagination.")
            break

        time.sleep(REQUEST_DELAY)

    return posts


def fetch_post_text(url: str) -> str:
    """Fetch a post page and return clean text content."""
    try:
        r = _get(url)
        r.raise_for_status()
    except Exception as exc:
        print(f"    Fetch failed: {exc}")
        return ""

    soup = BeautifulSoup(r.text, "html.parser")
    content = (
        soup.find("div", class_="entry-content")
        or soup.find("div", class_="post-content")
        or soup.find("article")
    )
    if not content:
        return ""

    for tag in content.find_all(["script", "style", "nav", "aside", "footer"]):
        tag.decompose()

    return content.get_text(separator="\n", strip=True)


def build_entry(title: str, url: str, date: datetime | None, body: str) -> list[str]:
    """Build one or more memory entries (split if body exceeds cap)."""
    date_str = date.strftime("%B %d, %Y") if date else "unknown date"
    header = f"MBW Picks — {title} ({date_str})\nURL: {url}\n\n"
    body_budget = MAX_MEMORY_CHARS - len(header) - 10  # small safety margin

    if len(body) <= body_budget:
        return [header + body]

    # Split into chunks
    entries: list[str] = []
    chunks = [body[i:i + body_budget] for i in range(0, len(body), body_budget)]
    for idx, chunk in enumerate(chunks, 1):
        suffix = f" (part {idx}/{len(chunks)})"
        entries.append(header.rstrip() + suffix + "\n\n" + chunk)
    return entries


def main() -> None:
    store = VectorStore()

    print("Collecting post listing (up to one year back)...")
    posts = collect_posts()
    print(f"\nFound {len(posts)} posts. Fetching content...\n")

    stored = skipped = errors = 0

    for title, url, date in posts:
        date_str = date.strftime("%Y-%m-%d") if date else "?"
        print(f"  [{date_str}] {title}")

        body = fetch_post_text(url)
        if not body:
            print("    (no content — skipped)")
            skipped += 1
            time.sleep(REQUEST_DELAY)
            continue

        entries = build_entry(title, url, date, body)
        for entry in entries:
            try:
                store.remember(entry, collection="knowledge", source="mbwpicks")
                stored += 1
            except ValueError as exc:
                print(f"    Skipped: {exc}")
                skipped += 1

        time.sleep(REQUEST_DELAY)

    print(f"\n{'='*50}")
    print(f"Done. Stored: {stored}  Skipped: {skipped}  Errors: {errors}")
    print(f"Total posts processed: {len(posts)}")
    print("\nYou can now ask the agent questions like:")
    print('  "what did Leo Laporte pick last month?"')
    print('  "any picks for note-taking apps from MBW?"')
    print('  "what was picked on episode 1018?"')


if __name__ == "__main__":
    main()
