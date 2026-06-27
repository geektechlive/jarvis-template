"""
netflix-safari.py

Fetches Netflix viewing history via Safari's authenticated session using
osascript. Primary strategy: trigger the "Download All" CSV link on the
viewing-activity page. Fallback: DOM scrape with Show-More pagination.

Requirements:
  - Safari is running on this machine
  - You are logged into Netflix in Safari

Usage:
    /opt/homebrew/bin/uv run python scripts/netflix-safari.py
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

OUTPUT_DIR = (
    Path.home()
    / "Library"
    / "Mobile Documents"
    / "com~apple~CloudDocs"
    / "Jarvis"
    / "entertainment"
)
OUTPUT_PATH = OUTPUT_DIR / "netflix-history.jsonl"
POLL_INTERVAL = 1.0
MAX_SHOW_MORE = 30


# ---------------------------------------------------------------------------
# Safari JS helpers
# ---------------------------------------------------------------------------

def run_js(js: str, timeout: int = 30) -> str:
    escaped = js.replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ")
    script = f'tell application "Safari" to do JavaScript "{escaped}" in document 1'
    result = subprocess.run(
        ["osascript", "-e", script],
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if result.returncode != 0:
        raise RuntimeError(f"AppleScript error: {result.stderr.strip()}")
    return result.stdout.strip()


def navigate_and_wait(url: str, wait: float = 5.0) -> None:
    script = f"""
tell application "Safari"
    activate
    if (count of documents) = 0 then
        make new document with properties {{URL:"{url}"}}
    else
        set URL of document 1 to "{url}"
    end if
end tell
"""
    try:
        subprocess.run(["osascript", "-e", script], capture_output=True, timeout=30)
    except subprocess.TimeoutExpired:
        print(f"Navigation timeout for {url} -- continuing anyway", file=sys.stderr)
    time.sleep(wait)


def wait_for_url(fragment: str, max_wait: float = 30.0) -> bool:
    """Poll Safari until document URL contains fragment."""
    deadline = time.time() + max_wait
    while time.time() < deadline:
        try:
            current = run_js("window.location.href")
            if fragment in current:
                return True
        except Exception:
            pass
        time.sleep(1.5)
    return False


def run_async_fetch(fetch_js: str, timeout: int = 45) -> str:
    """
    Inject a fetch() that stores result in window.__nfResult / window.__nfError,
    then poll until one is non-null.
    """
    setup = "window.__nfResult = null; window.__nfError = null; " + fetch_js
    run_js(setup)
    for _ in range(int(timeout / POLL_INTERVAL)):
        time.sleep(POLL_INTERVAL)
        check = run_js("JSON.stringify([window.__nfResult, window.__nfError])")
        if not check:
            continue
        result, error = json.loads(check)
        if error is not None:
            raise RuntimeError(f"fetch error: {error}")
        if result is not None:
            return result
    raise TimeoutError(f"async fetch timed out after {timeout}s")


# ---------------------------------------------------------------------------
# Safari download cleanup
# ---------------------------------------------------------------------------

def _safari_downloads_dir() -> Path:
    result = subprocess.run(
        ["defaults", "read", "com.apple.Safari", "DownloadsPath"],
        capture_output=True,
        text=True,
    )
    if result.returncode == 0 and result.stdout.strip():
        raw = result.stdout.strip().replace("~", str(Path.home()))
        return Path(raw)
    return Path.home() / "Downloads"


def _cleanup_new_downloads(since: float, downloads_dir: Path) -> None:
    """Delete any file that appeared in downloads_dir after `since`."""
    try:
        time.sleep(1.5)  # let the download land
        new_files = [
            f for f in downloads_dir.iterdir()
            if f.is_file() and f.stat().st_mtime >= since
        ]
        for f in new_files:
            f.unlink()
            print(f"Cleaned up download: {f.name}", file=sys.stderr)
    except Exception as e:
        print(f"Cleanup warning: {e}", file=sys.stderr)


# ---------------------------------------------------------------------------
# Strategy 1: Download All CSV
# ---------------------------------------------------------------------------

_BLOB_INTERCEPT_JS = r"""
window.__nfResult = null;
window.__nfError = null;
(function() {
    var _orig = URL.createObjectURL;
    URL.createObjectURL = function(blob) {
        var url = _orig.call(URL, blob);
        if (blob && blob.size > 500) {
            var reader = new FileReader();
            reader.onload = function(e) {
                var text = e.target.result || '';
                if (text.length > 100) window.__nfResult = text;
            };
            reader.readAsText(blob);
        }
        return url;
    };
    var dl = Array.from(document.querySelectorAll('a')).find(function(a) {
        return /download all/i.test(a.textContent.trim());
    });
    if (dl) { dl.click(); } else { window.__nfError = 'no-download-all-link'; }
})();
"""


def try_download_all() -> list[dict] | None:
    """Click the Download All button and intercept the Blob it creates."""
    print("Trying Download All (Blob intercept)...", file=sys.stderr)
    downloads_dir = _safari_downloads_dir()
    before = time.time()
    run_js(_BLOB_INTERCEPT_JS)

    for _ in range(30):
        time.sleep(1.0)
        check = run_js("JSON.stringify([window.__nfResult, window.__nfError])")
        if not check:
            continue
        result, error = json.loads(check)
        if error is not None:
            print(f"Download All: {error}", file=sys.stderr)
            return None
        if result is not None:
            print(f"Download All captured {len(result)} bytes.", file=sys.stderr)
            _cleanup_new_downloads(before, downloads_dir)
            return _parse_csv(result)

    print("Download All timed out -- falling back to DOM scrape.", file=sys.stderr)
    return None


def _parse_csv(csv_text: str) -> list[dict] | None:
    lines = csv_text.strip().splitlines()
    if len(lines) < 2:
        print("CSV was empty or header-only.", file=sys.stderr)
        return None
    header = lines[0].strip().lower()
    if "title" not in header:
        print(f"CSV header not recognised: {lines[0][:80]}", file=sys.stderr)
        return None

    fetched_at = datetime.now(tz=UTC).isoformat()
    items: list[dict] = []
    for line in lines[1:]:
        line = line.strip().strip('"')
        if not line:
            continue
        parts = line.split('","')
        if len(parts) < 2:
            continue
        title = parts[0].lstrip('"')
        date_raw = parts[1].rstrip('"')
        series_title, episode_title = _parse_title(title)
        items.append({
            "videoId": None,
            "title": title,
            "seriesTitle": series_title,
            "episodeTitle": episode_title,
            "date": _parse_date(date_raw),
            "durationSecs": 0,
            "percentWatched": 0,
            "fetchedAt": fetched_at,
        })
    print(f"CSV: {len(items)} items.", file=sys.stderr)
    return items if items else None


# ---------------------------------------------------------------------------
# Strategy 2: DOM scraping with Show-More pagination
# ---------------------------------------------------------------------------

_SCRAPE_JS = r"""
(function() {
    var items = [];
    var seen = {};
    var datePattern = /^\d{1,2}\/\d{1,2}\/\d{2,4}$/;

    var allEls = document.querySelectorAll('td, li, div, span');
    for (var i = 0; i < allEls.length; i++) {
        var el = allEls[i];
        if (el.childElementCount > 0) continue;
        var text = el.textContent.trim();
        if (!datePattern.test(text)) continue;

        var row = el;
        for (var j = 0; j < 7; j++) {
            row = row.parentElement;
            if (!row) break;
            var links = Array.from(row.querySelectorAll('a')).filter(function(a) {
                var t = a.textContent.trim();
                return t.length > 3 && !/report/i.test(t);
            });
            if (links.length > 0) {
                var title = links[0].textContent.trim();
                var key = text + '|' + title;
                if (!seen[key]) {
                    seen[key] = true;
                    items.push({ date: text, title: title });
                }
                break;
            }
        }
    }

    var hasShowMore = Array.from(
        document.querySelectorAll('button, a, [role="button"]')
    ).some(function(el) {
        return /show more/i.test(el.textContent.trim());
    });

    return JSON.stringify({ items: items, hasShowMore: hasShowMore });
})()
"""

_CLICK_SHOW_MORE_JS = r"""
(function() {
    var btn = Array.from(
        document.querySelectorAll('button, a, [role="button"]')
    ).find(function(el) {
        return /show more/i.test(el.textContent.trim());
    });
    if (btn) { btn.click(); return 'clicked'; }
    return 'not-found';
})()
"""


def scrape_viewing_activity() -> list[dict]:
    print("Scraping viewing activity from DOM (fallback)...", file=sys.stderr)
    fetched_at = datetime.now(tz=UTC).isoformat()
    prev_count = -1
    current_items: list[dict] = []

    for click_num in range(MAX_SHOW_MORE + 1):
        raw = run_js(_SCRAPE_JS, timeout=45)
        if not raw:
            print("  JS returned empty, waiting...", file=sys.stderr)
            time.sleep(3.0)
            continue
        result = json.loads(raw)
        current_items = result.get("items", [])

        if len(current_items) == prev_count:
            break
        prev_count = len(current_items)
        print(f"  {len(current_items)} items scraped...", file=sys.stderr)

        if not result.get("hasShowMore", False):
            break
        if click_num < MAX_SHOW_MORE:
            print("  Clicking Show More...", file=sys.stderr)
            run_js(_CLICK_SHOW_MORE_JS)
            time.sleep(3.0)

    return [_transform_dom(item, fetched_at) for item in current_items]


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def _parse_date(raw: str) -> str:
    for fmt in ("%m/%d/%y", "%m/%d/%Y", "%d/%m/%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(raw, fmt).strftime("%Y-%m-%d")
        except ValueError:
            pass
    return raw


def _parse_title(full_title: str) -> tuple[str, str]:
    """Extract (seriesTitle, episodeTitle) from Netflix title strings.

    DOM format:  'ShowName: ShowName: "Episode"'
    CSV format:  'ShowName: Episode Name'
    Film:        'Film Title'  (no colon, or subtitle after colon)
    """
    # DOM format -- episode in double quotes at end
    m = re.search(r'^(.*?):\s*"(.+)"$', full_title)
    if m:
        series = m.group(1).split(": ")[0].strip()
        return series, m.group(2)
    # CSV format -- simple colon separator; if ': ' present assume series/episode
    if ": " in full_title:
        parts = full_title.split(": ", 1)
        return parts[0].strip(), parts[1].strip()
    return "", ""


def _transform_dom(item: dict, fetched_at: str) -> dict:
    series_title, episode_title = _parse_title(item["title"])
    return {
        "videoId": None,
        "title": item["title"],
        "seriesTitle": series_title,
        "episodeTitle": episode_title,
        "date": _parse_date(item["date"]),
        "durationSecs": 0,
        "percentWatched": 0,
        "fetchedAt": fetched_at,
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    print("Navigating Safari to Netflix viewing activity...", file=sys.stderr)
    navigate_and_wait("https://www.netflix.com/browse", wait=3.0)
    navigate_and_wait("https://www.netflix.com/viewingactivity", wait=3.0)

    print("Waiting for viewingactivity page to load...", file=sys.stderr)
    loaded = wait_for_url("viewingactivity", max_wait=30.0)
    if not loaded:
        print("Warning: URL check timed out -- proceeding anyway.", file=sys.stderr)
    else:
        time.sleep(3.0)  # let React finish rendering

    # Strategy 1: Download All CSV
    items = try_download_all()

    # Strategy 2: DOM scraping
    if items is None:
        items = scrape_viewing_activity()

    if not items:
        print("Error: no viewing activity items retrieved.", file=sys.stderr)
        sys.exit(1)

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_PATH, "w") as f:
        for entry in items:
            f.write(json.dumps(entry) + "\n")

    print(json.dumps({
        "count": len(items),
        "outputPath": str(OUTPUT_PATH),
        "fetchedAt": datetime.now(tz=UTC).isoformat(),
    }))


if __name__ == "__main__":
    main()
