#!/usr/bin/env python3
"""
calendar-update -- update an existing iCloud calendar event via CalDAV PUT.

Credentials: macOS Keychain (com.example.jarvis / icloud_user + icloud_app_password).
Fallback: ~/.jarvis-mail-creds with ICLOUD_USER and ICLOUD_APP_PASSWORD keys.

Usage:
  calendar-update --uid UUID [--title TEXT] [--date YYYY-MM-DD|today|tomorrow]
                  [--start HH:MM] [--end HH:MM] [--calendar NAME]

At least one of --title, --date, --start, or --end must be provided.
Times are 24-hour local (America/Chicago).
"""

import argparse
import os
import re
import subprocess
import sys
import tempfile
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from urllib.parse import urlparse

TIMEZONE = "America/Chicago"


def _keychain_get(account: str) -> str:
    result = subprocess.run(
        ["security", "find-generic-password", "-s", "com.example.jarvis", "-a", account, "-w"],
        capture_output=True, text=True,
    )
    return result.stdout.strip() if result.returncode == 0 else ""


def load_creds() -> tuple[str, str]:
    user = _keychain_get("icloud_user")
    pw = _keychain_get("icloud_app_password")
    if user and pw:
        return user, pw

    path = Path.home() / ".jarvis-mail-creds"
    if path.exists():
        kv: dict[str, str] = {}
        for line in path.read_text().splitlines():
            i = line.find("=")
            if i > 0:
                kv[line[:i].strip()] = line[i + 1:].strip()
        user = kv.get("ICLOUD_USER", "")
        pw = kv.get("ICLOUD_APP_PASSWORD", "")
        if user and pw:
            return user, pw

    sys.exit("calendar-update: no credentials found in Keychain or ~/.jarvis-mail-creds")


def curl_propfind(url: str, user: str, pw: str, body: str, depth: str = "0") -> str:  # noqa: E501
    r = subprocess.run(
        ["curl", "-s", "-X", "PROPFIND", url,
         "-u", f"{user}:{pw}",
         "-H", "Content-Type: application/xml; charset=utf-8",
         "-H", f"Depth: {depth}",
         "--data", body,
         "--max-time", "20"],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        sys.exit(f"calendar-update: curl PROPFIND error: {r.stderr.strip()}")
    return r.stdout


def xml_get(xml: str, tag: str) -> str | None:
    m = re.search(rf"<[\w\-]*:?{tag}(?:\s[^>]*)?>([^<]*)</[\w\-]*:?{tag}>", xml, re.IGNORECASE)
    return m.group(1).strip() if m else None


def xml_get_inner(xml: str, outer: str, inner: str) -> str | None:
    m = re.search(
        rf"<[\w\-]*:?{outer}(?:\s[^>]*)?>.*?<[\w\-]*:?{inner}(?:\s[^>]*)?>([^<]*)</[\w\-]*:?{inner}>.*?</[\w\-]*:?{outer}>",
        xml, re.IGNORECASE | re.DOTALL)
    return m.group(1).strip() if m else None


SKIP_TAGS = ("notification", "schedule-inbox", "schedule-outbox")


def is_native_calendar(rt_text: str) -> bool:
    lower = rt_text.lower()
    if any(f"<{t}" in lower or f":{t}" in lower for t in SKIP_TAGS):
        return False
    if re.search(r"<[\w\-]*:?subscribed[\s/>]", rt_text, re.IGNORECASE):
        return False
    return bool(re.search(r"<[\w\-]*:?calendar[\s/>]", rt_text, re.IGNORECASE))


def discover_calendars(user: str, pw: str) -> list[tuple[str, str]]:
    """Return list of (url, displayName) for all writable calendars."""
    base = "https://caldav.icloud.com"

    xml = curl_propfind(base, user, pw,
        '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop>'
        '<d:current-user-principal/></d:prop></d:propfind>')
    principal = xml_get_inner(xml, "current-user-principal", "href")
    if not principal:
        sys.exit("calendar-update: could not find current-user-principal")
    if not principal.startswith("http"):
        principal = base + principal

    xml = curl_propfind(principal, user, pw,
        '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" '
        'xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop>'
        '<c:calendar-home-set/></d:prop></d:propfind>')
    home = xml_get_inner(xml, "calendar-home-set", "href")
    if not home:
        sys.exit("calendar-update: could not find calendar-home-set")
    if not home.startswith("http"):
        home = base + home

    parsed = urlparse(home)
    home_base = f"{parsed.scheme}://{parsed.netloc}"

    xml = curl_propfind(home, user, pw,
        '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" '
        'xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop>'
        '<d:displayname/><d:resourcetype/></d:prop></d:propfind>',
        depth="1")

    cals: list[tuple[str, str]] = []
    for chunk in re.split(r"<[dD]?:?response(?:\s[^>]*)?>", xml)[1:]:
        rt = re.search(
            r"<resourcetype[^>]*>(.*?)</[^>]*resourcetype>", chunk, re.DOTALL | re.IGNORECASE
        )
        if not rt or not is_native_calendar(rt.group(1)):
            continue
        href = xml_get(chunk, "href")
        name = xml_get(chunk, "displayname") or ""
        if href:
            url = href if href.startswith("http") else home_base + href
            cals.append((url, name))

    if not cals:
        sys.exit("calendar-update: no writable calendars found")
    return cals


def parse_date(s: str) -> date:
    today = date.today()
    if s.lower() == "today":
        return today
    if s.lower() == "tomorrow":
        return today + timedelta(days=1)
    try:
        return date.fromisoformat(s)
    except ValueError:
        sys.exit(f"calendar-update: invalid date '{s}' — use YYYY-MM-DD, today, or tomorrow")


def ical_dt(d: date, hhmm: str) -> str:
    h, m = hhmm.split(":")
    return f"{d.strftime('%Y%m%d')}T{int(h):02d}{int(m):02d}00"


def dtstamp_now() -> str:
    return datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")


def unfold(ical: str) -> str:
    """Unfold RFC 5545 line continuations."""
    return re.sub(r"\r?\n[ \t]", "", ical)


def mutate_line(vevent: str, prop: str, new_line: str) -> str:
    """Replace an existing property line or insert before END:VEVENT."""
    pattern = re.compile(rf"^{prop}(;[^:]*)?:.*$", re.MULTILINE)
    if pattern.search(vevent):
        return pattern.sub(new_line, vevent)
    end_match = re.search(r"END:VEVENT", vevent)
    if not end_match:
        return vevent
    return vevent[: end_match.start()] + new_line + "\r\n" + vevent[end_match.start():]


def bump_sequence(vevent: str) -> str:
    seq_match = re.search(r"^SEQUENCE:(\d+)$", vevent, re.MULTILINE)
    new_seq = str(int(seq_match.group(1)) + 1) if seq_match else "1"
    if seq_match:
        return re.sub(r"^SEQUENCE:\d+$", f"SEQUENCE:{new_seq}", vevent, flags=re.MULTILINE)
    return mutate_line(vevent, "SEQUENCE", f"SEQUENCE:{new_seq}")


def escape_ical(s: str) -> str:
    return s.replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n")


def fetch_event(event_url: str, user: str, pw: str) -> tuple[str | None, str | None]:
    """GET an .ics file; return (body, etag) or (None, None) if not found."""
    hdr_fd, hdr_path = tempfile.mkstemp(suffix=".hdrs")
    os.close(hdr_fd)
    try:
        r = subprocess.run(
            ["curl", "-s", "-D", hdr_path, "-w", "\n%{http_code}", "-X", "GET", event_url,
             "-u", f"{user}:{pw}",
             "--max-time", "20"],
            capture_output=True, text=True,
        )
        if r.returncode != 0:
            return None, None
        parts = r.stdout.rsplit("\n", 1)
        code = parts[-1].strip() if len(parts) > 1 else ""
        body = parts[0] if len(parts) > 1 else r.stdout
        if code != "200":
            return None, None
        etag: str | None = None
        try:
            hdrs = Path(hdr_path).read_text()
            m = re.search(r'^ETag:\s*"?([^"\r\n]+)"?', hdrs, re.IGNORECASE | re.MULTILINE)
            if m:
                etag = m.group(1).strip().strip('"')
        except Exception:
            pass
        return body, etag
    finally:
        try:
            os.unlink(hdr_path)
        except Exception:
            pass


def put_event(event_url: str, user: str, pw: str, ical: str, etag: str | None = None) -> str:
    """PUT an updated .ics; return the HTTP status code."""
    cmd = [
        "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
        "-X", "PUT", event_url,
        "-u", f"{user}:{pw}",
        "-H", "Content-Type: text/calendar; charset=utf-8",
    ]
    if etag:
        cmd.extend(["-H", f'If-Match: "{etag}"'])
    cmd.extend(["--data", ical, "--max-time", "20"])
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f"calendar-update: curl PUT error: {r.stderr.strip()}")
    return r.stdout.strip()


def main() -> None:
    p = argparse.ArgumentParser(
        description="Update an existing iCloud calendar event via CalDAV.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument(
        "--uid", required=True, help="UID of the event to update (from calendar-check output)"
    )
    p.add_argument("--title", help="New event title/summary")
    p.add_argument("--date", help="New date: YYYY-MM-DD, today, or tomorrow")
    p.add_argument("--start", help="New start time: HH:MM (24-hour, requires --date)")
    p.add_argument("--end", help="New end time: HH:MM (24-hour, requires --date)")
    p.add_argument("--calendar", default="My calendar",
                   help="Calendar name to search first (default: My calendar)")
    args = p.parse_args()

    if not any([args.title, args.date, args.start, args.end]):
        sys.exit("calendar-update: provide at least one of --title, --date, --start, --end")

    if (args.start or args.end) and not args.date:
        sys.exit("calendar-update: --start/--end require --date")

    for t in filter(None, [args.start, args.end]):
        if not re.match(r"^\d{1,2}:\d{2}$", t):
            sys.exit(f"calendar-update: invalid time '{t}' — use HH:MM 24-hour format")

    ev_date = parse_date(args.date) if args.date else None

    user, pw = load_creds()
    cals = discover_calendars(user, pw)

    # Search preferred calendar first, then others.
    preferred = [c for c in cals if c[1].lower() == args.calendar.lower()]
    others = [c for c in cals if c[1].lower() != args.calendar.lower()]
    search_order = preferred + others

    found_cal_name: str | None = None
    existing_ics: str | None = None
    event_url: str | None = None
    found_etag: str | None = None

    for cal_url, cal_name in search_order:
        url = f"{cal_url.rstrip('/')}/{args.uid}.ics"
        body, etag = fetch_event(url, user, pw)
        if body:
            found_cal_name = cal_name
            existing_ics = body
            event_url = url
            found_etag = etag
            break

    if not existing_ics or not event_url:
        sys.exit(f"calendar-update: event UID '{args.uid}' not found in any calendar")

    # Extract VEVENT block.
    unfolded = unfold(existing_ics)
    ve_match = re.search(r"BEGIN:VEVENT([\s\S]*?)END:VEVENT", unfolded, re.IGNORECASE)
    if not ve_match:
        sys.exit("calendar-update: could not parse VEVENT in existing event")
    vevent = "BEGIN:VEVENT" + ve_match.group(1) + "END:VEVENT"

    # Apply mutations for each provided field.
    vevent = mutate_line(vevent, "DTSTAMP", f"DTSTAMP:{dtstamp_now()}")

    if args.title:
        vevent = mutate_line(vevent, "SUMMARY", f"SUMMARY:{escape_ical(args.title)}")

    if ev_date and args.start:
        vevent = mutate_line(
            vevent, "DTSTART", f"DTSTART;TZID={TIMEZONE}:{ical_dt(ev_date, args.start)}"
        )

    if ev_date and args.end:
        vevent = mutate_line(vevent, "DTEND", f"DTEND;TZID={TIMEZONE}:{ical_dt(ev_date, args.end)}")

    vevent = bump_sequence(vevent)

    ical = (
        "BEGIN:VCALENDAR\r\nVERSION:2.0\r\n"
        "PRODID:-//Jarvis//calendar-update//EN\r\n"
        f"{vevent}\r\nEND:VCALENDAR\r\n"
    )

    code = put_event(event_url, user, pw, ical, etag=found_etag)
    if code not in ("200", "201", "204"):
        sys.exit(f"calendar-update: server returned HTTP {code}")

    # Build a human-readable summary of what changed.
    changes: list[str] = []
    if args.title:
        changes.append(f"title → \"{args.title}\"")
    if ev_date and args.start and args.end:
        day_label = ev_date.strftime("%A, %B %-d")
        changes.append(f"time → {day_label} {args.start}–{args.end} {TIMEZONE}")
    elif ev_date and args.start:
        changes.append(f"start → {ev_date} {args.start} {TIMEZONE}")
    elif ev_date and args.end:
        changes.append(f"end → {ev_date} {args.end} {TIMEZONE}")

    print(f"Updated in {found_cal_name}: {', '.join(changes)}")
    print(f"UID: {args.uid}")


if __name__ == "__main__":
    main()
