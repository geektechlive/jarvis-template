#!/usr/bin/env python3
"""
calendar-write -- create an iCloud calendar event via CalDAV PUT.

Credentials: macOS Keychain (com.example.jarvis / icloud_user + icloud_app_password).
Fallback: ~/.jarvis-mail-creds with ICLOUD_USER and ICLOUD_APP_PASSWORD keys.

Usage:
  calendar-write --title TEXT --date YYYY-MM-DD|today|tomorrow
                 --start HH:MM --end HH:MM [--calendar NAME]

Times are 24-hour local (America/Chicago). Default calendar: My calendar.
"""

import argparse
import re
import subprocess
import sys
import uuid
from datetime import date, timedelta
from pathlib import Path

TIMEZONE = "America/Chicago"


def _keychain_get(account: str) -> str:
    result = subprocess.run(
        ["security", "find-generic-password", "-s", "com.example.jarvis", "-a", account, "-w"],
        capture_output=True, text=True,
    )
    return result.stdout.strip() if result.returncode == 0 else ""


def load_creds():
    user = _keychain_get("icloud_user")
    pw = _keychain_get("icloud_app_password")
    if user and pw:
        return user, pw

    # Legacy fallback.
    path = Path.home() / ".jarvis-mail-creds"
    if path.exists():
        kv = {}
        for line in path.read_text().splitlines():
            i = line.find("=")
            if i > 0:
                kv[line[:i].strip()] = line[i + 1:].strip()
        user = kv.get("ICLOUD_USER", "")
        pw = kv.get("ICLOUD_APP_PASSWORD", "")
        if user and pw:
            return user, pw

    sys.exit("calendar-write: no credentials found in Keychain or ~/.jarvis-mail-creds")


def curl_propfind(url, user, pw, body, depth="0"):
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
        sys.exit(f"calendar-write: curl PROPFIND error: {r.stderr.strip()}")
    return r.stdout


def xml_get_inner(xml, outer, inner):
    m = re.search(
        rf"<[\w\-]*:?{outer}(?:\s[^>]*)?>.*?<[\w\-]*:?{inner}(?:\s[^>]*)?>([^<]*)</[\w\-]*:?{inner}>.*?</[\w\-]*:?{outer}>",
        xml, re.IGNORECASE | re.DOTALL)
    return m.group(1).strip() if m else None


def xml_get(xml, tag):
    m = re.search(rf"<[\w\-]*:?{tag}(?:\s[^>]*)?>([^<]*)</[\w\-]*:?{tag}>", xml, re.IGNORECASE)
    return m.group(1).strip() if m else None


SKIP_TAGS = ("notification", "schedule-inbox", "schedule-outbox")

def is_native_calendar(rt_text):
    lower = rt_text.lower()
    if any(f"<{t}" in lower or f":{t}" in lower for t in SKIP_TAGS):
        return False
    if re.search(r"<[\w\-]*:?subscribed[\s/>]", rt_text, re.IGNORECASE):
        return False  # subscription calendars are read-only
    return bool(re.search(r"<[\w\-]*:?calendar[\s/>]", rt_text, re.IGNORECASE))


def discover_writable(user, pw, preferred_name="My calendar"):
    """Return the CalDAV URL for the preferred writable calendar."""
    base = "https://caldav.icloud.com"

    xml = curl_propfind(base, user, pw,
        '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop>'
        '<d:current-user-principal/></d:prop></d:propfind>')
    principal = xml_get_inner(xml, "current-user-principal", "href")
    if not principal:
        sys.exit("calendar-write: could not find current-user-principal")
    if not principal.startswith("http"):
        principal = base + principal

    xml = curl_propfind(principal, user, pw,
        '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" '
        'xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop>'
        '<c:calendar-home-set/></d:prop></d:propfind>')
    home = xml_get_inner(xml, "calendar-home-set", "href")
    if not home:
        sys.exit("calendar-write: could not find calendar-home-set")
    if not home.startswith("http"):
        home = base + home

    from urllib.parse import urlparse
    home_base = "{0.scheme}://{0.netloc}".format(urlparse(home))

    xml = curl_propfind(home, user, pw,
        '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" '
        'xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop>'
        '<d:displayname/><d:resourcetype/></d:prop></d:propfind>',
        depth="1")

    cals = []
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
        sys.exit("calendar-write: no writable calendars found")

    # Prefer the requested calendar name, fall back to first
    preferred = next((c for c in cals if c[1].lower() == preferred_name.lower()), None)
    return preferred[0] if preferred else cals[0][0]


def ical_dt(d: date, hhmm: str) -> str:
    """Return iCal local datetime string with TZID parameter."""
    h, m = hhmm.split(":")
    return f"{d.strftime('%Y%m%d')}T{int(h):02d}{int(m):02d}00"


def parse_date(s: str) -> date:
    today = date.today()
    if s.lower() == "today":
        return today
    if s.lower() == "tomorrow":
        return today + timedelta(days=1)
    try:
        return date.fromisoformat(s)
    except ValueError:
        sys.exit(f"calendar-write: invalid date '{s}' — use YYYY-MM-DD, today, or tomorrow")


def create_event(cal_url: str, user: str, pw: str,
                 title: str, ev_date: date, start_hhmm: str, end_hhmm: str):
    uid = str(uuid.uuid5(uuid.NAMESPACE_URL, f"{title}|{ev_date}|{start_hhmm}|{end_hhmm}"))
    dtstart = ical_dt(ev_date, start_hhmm)
    dtend = ical_dt(ev_date, end_hhmm)
    ics = (
        "BEGIN:VCALENDAR\r\n"
        "VERSION:2.0\r\n"
        "PRODID:-//Jarvis//calendar-write//EN\r\n"
        "BEGIN:VEVENT\r\n"
        f"UID:{uid}\r\n"
        f"DTSTART;TZID={TIMEZONE}:{dtstart}\r\n"
        f"DTEND;TZID={TIMEZONE}:{dtend}\r\n"
        f"SUMMARY:{title}\r\n"
        "END:VEVENT\r\n"
        "END:VCALENDAR\r\n"
    )
    event_url = f"{cal_url.rstrip('/')}/{uid}.ics"
    r = subprocess.run(
        ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
         "-X", "PUT", event_url,
         "-u", f"{user}:{pw}",
         "-H", "Content-Type: text/calendar; charset=utf-8",
         "--data", ics,
         "--max-time", "20"],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        sys.exit(f"calendar-write: curl PUT error: {r.stderr.strip()}")
    code = r.stdout.strip()
    if code not in ("201", "204"):
        sys.exit(f"calendar-write: server returned HTTP {code}")
    return uid


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--title", required=True)
    p.add_argument("--date", required=True, help="YYYY-MM-DD, today, or tomorrow")
    p.add_argument("--start", required=True, help="HH:MM (24-hour)")
    p.add_argument("--end", required=True, help="HH:MM (24-hour)")
    p.add_argument("--calendar", default="My calendar")
    args = p.parse_args()

    user, pw = load_creds()
    ev_date = parse_date(args.date)

    for t in (args.start, args.end):
        if not re.match(r"^\d{1,2}:\d{2}$", t):
            sys.exit(f"calendar-write: invalid time '{t}' — use HH:MM 24-hour format")

    cal_url = discover_writable(user, pw, preferred_name=args.calendar)
    uid = create_event(cal_url, user, pw, args.title, ev_date, args.start, args.end)

    day_label = ev_date.strftime("%A, %B %-d")
    print(f"Created: \"{args.title}\" — {day_label} {args.start}–{args.end} {TIMEZONE}")
    print(f"UID: {uid}")


if __name__ == "__main__":
    main()
