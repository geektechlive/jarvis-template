#!/usr/bin/env python3
"""
calendar-check -- fetch iCloud calendar events via CalDAV.

Credentials: macOS Keychain (com.example.jarvis / icloud_user + icloud_app_password).
Fallback: ~/.jarvis-mail-creds with ICLOUD_USER and ICLOUD_APP_PASSWORD keys.

Usage:
  calendar-check [--days N] [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--json]

Default: today's events. --days 7 gives the full week.
"""

import argparse
import json
import re
import subprocess
import sys
from datetime import date, datetime, timedelta
from pathlib import Path


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

    sys.exit("calendar-check: iCloud credentials not found in Keychain or ~/.jarvis-mail-creds")


def curl_propfind(url, user, pw, body, depth="0"):
    result = subprocess.run(
        ["curl", "-s", "-X", "PROPFIND", url,
         "-u", f"{user}:{pw}",
         "-H", "Content-Type: application/xml; charset=utf-8",
         "-H", f"Depth: {depth}",
         "--data", body,
         "--max-time", "20"],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        sys.exit(f"calendar-check: curl error on PROPFIND {url}: {result.stderr.strip()}")
    return result.stdout


def curl_report(url, user, pw, body):
    result = subprocess.run(
        ["curl", "-s", "-X", "REPORT", url,
         "-u", f"{user}:{pw}",
         "-H", "Content-Type: application/xml; charset=utf-8",
         "-H", "Depth: 1",
         "--data", body,
         "--max-time", "20"],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        sys.exit(f"calendar-check: curl error on REPORT {url}: {result.stderr.strip()}")
    return result.stdout


def curl_get(url):
    result = subprocess.run(
        ["curl", "-s", "-L", url, "--max-time", "15"],
        capture_output=True, text=True,
    )
    return result.stdout if result.returncode == 0 else ""


def fetch_ics_events(ics_url, cal_name, start_dt, end_dt):
    """Fetch a public ICS feed and return events in [start_dt, end_dt]."""
    ics = curl_get(ics_url)
    if not ics:
        return []
    events = []
    for vevent in re.findall(r"BEGIN:VEVENT(.*?)END:VEVENT", ics, re.DOTALL):
        vevent = re.sub(r"\r?\n[ \t]", "", vevent)  # unfold
        summary = re.search(r"\nSUMMARY:([^\r\n]+)", vevent)
        dtstart = re.search(r"\nDTSTART[^:]*:([^\r\n]+)", vevent)
        uid = re.search(r"\nUID:([^\r\n]+)", vevent)
        is_recurring = bool(re.search(r"\nRRULE:", vevent))
        if not summary or not dtstart:
            continue
        s = dtstart.group(1).strip()
        dt = parse_dt(s)
        if dt is None:
            continue
        import time as _time
        _raw = _time.altzone if (_time.daylight and _time.localtime().tm_isdst) else _time.timezone
        ev_date = (dt + timedelta(seconds=-_raw)).date() if s.endswith("Z") else dt.date()
        if start_dt <= ev_date <= end_dt:
            events.append({"title": summary.group(1).strip(), "dtstart": s,
                           "recurring": is_recurring, "calendar": cal_name,
                           "uid": uid.group(1).strip() if uid else ""})
    return events


def xml_get(xml, tag):
    m = re.search(rf"<[\w\-]*:?{tag}(?:\s[^>]*)?>([^<]*)</[\w\-]*:?{tag}>", xml, re.IGNORECASE)
    return m.group(1).strip() if m else None


def xml_get_inner(xml, outer, inner):
    """Extract inner_tag href from within outer_tag block."""
    m = re.search(
        rf"<[\w\-]*:?{outer}(?:\s[^>]*)?>.*?<[\w\-]*:?{inner}(?:\s[^>]*)?>([^<]*)</[\w\-]*:?{inner}>.*?</[\w\-]*:?{outer}>",
        xml, re.IGNORECASE | re.DOTALL)
    return m.group(1).strip() if m else None


def xml_get_all(xml, tag):
    return [m.group(1).strip() for m in re.finditer(
        rf"<[\w\-]*:?{tag}(?:\s[^>]*)?>([^<]*)</[\w\-]*:?{tag}>", xml, re.IGNORECASE)]


def discover(user, pw):
    base = "https://caldav.icloud.com"
    # Step 1: principal
    xml = curl_propfind(base, user, pw,
        '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop>'
        '<d:current-user-principal/></d:prop></d:propfind>')
    principal = xml_get_inner(xml, "current-user-principal", "href")
    if not principal:
        sys.exit("calendar-check: could not find current-user-principal")
    if not principal.startswith("http"):
        principal = base + principal

    # Step 2: calendar home
    xml = curl_propfind(principal, user, pw,
        '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" '
        'xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop>'
        '<c:calendar-home-set/></d:prop></d:propfind>')
    home = xml_get_inner(xml, "calendar-home-set", "href")
    if not home:
        sys.exit("calendar-check: could not find calendar-home-set")
    if not home.startswith("http"):
        home = base + home
    # derive server base from home URL (may be p##-caldav.icloud.com)
    from urllib.parse import urlparse
    parsed = urlparse(home)
    home_base = f"{parsed.scheme}://{parsed.netloc}"

    # Step 3: list calendars (Depth:1 enumerates children)
    xml = curl_propfind(home, user, pw,
        '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" '
        'xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop>'
        '<d:displayname/><d:resourcetype/></d:prop></d:propfind>',
        depth="1")
    # iCloud returns <response xmlns="DAV:"> (no namespace prefix)
    # Include: <calendar> (native caldav) and <subscribed> (external feed like Formula 1).
    # Skip: notification, inbox, outbox, bare collection (the home collection itself).
    # "calendar" substring check hits "calendarserver.org" URIs — use tag-name anchoring.
    SKIP_TAGS = ("notification", "schedule-inbox", "schedule-outbox")

    def is_queryable(rt_text):
        lower = rt_text.lower()
        if any(f"<{t}" in lower or f":{t}" in lower for t in SKIP_TAGS):
            return False
        return bool(re.search(r"<[\w\-]*:?calendar[\s/>]", rt_text, re.IGNORECASE)
                    or re.search(r"<[\w\-]*:?subscribed[\s/>]", rt_text, re.IGNORECASE))

    cals = []
    for chunk in re.split(r"<[dD]?:?response(?:\s[^>]*)?>", xml)[1:]:
        rt = re.search(
            r"<resourcetype[^>]*>(.*?)</[^>]*resourcetype>", chunk, re.DOTALL | re.IGNORECASE
        )
        if not rt or not is_queryable(rt.group(1)):
            continue
        href = xml_get(chunk, "href")
        name = xml_get(chunk, "displayname") or ""
        is_sub = bool(re.search(r"<[\w\-]*:?subscribed[\s/>]", rt.group(1), re.IGNORECASE))
        if href:
            url = href if href.startswith("http") else home_base + href
            source_url = None
            if is_sub:
                # Fetch the subscription source URL so we can read events directly
                sp = curl_propfind(url, user, pw,
                    '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" '
                    'xmlns:cs="http://calendarserver.org/ns/"><d:prop>'
                    '<cs:source/></d:prop></d:propfind>')
                source_url = xml_get_inner(sp, "source", "href")
            cals.append((url, name, is_sub, source_url))
    # Sort: "My calendar" first, then alphabetical
    cals.sort(key=lambda c: (0 if "my calendar" in c[1].lower() else 1, c[1].lower()))
    return cals  # list of (cal_url, name, is_sub, source_url)


def fetch_events(cal_url, user, pw, start_dt, end_dt):
    s = start_dt.strftime("%Y%m%dT000000Z")
    e = end_dt.strftime("%Y%m%dT235959Z")
    body = f"""<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="{s}" end="{e}"/>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>"""
    xml = curl_report(cal_url, user, pw, body)
    events = []
    for vevent in re.findall(r"BEGIN:VEVENT(.*?)END:VEVENT", xml, re.DOTALL):
        vevent = re.sub(r"\r?\n[ \t]", "", vevent)  # unfold
        summary = re.search(r"\nSUMMARY:([^\r\n]+)", vevent)
        dtstart = re.search(r"\nDTSTART[^:]*:([^\r\n]+)", vevent)
        uid = re.search(r"\nUID:([^\r\n]+)", vevent)
        is_recurring = bool(re.search(r"\nRRULE:", vevent))
        if summary and dtstart:
            events.append({"title": summary.group(1).strip(),
                           "dtstart": dtstart.group(1).strip(),
                           "recurring": is_recurring,
                           "calendar": "",
                           "uid": uid.group(1).strip() if uid else ""})
    return events


def parse_dt(s):
    s = s.strip()
    for fmt in ("%Y%m%dT%H%M%SZ", "%Y%m%dT%H%M%S", "%Y%m%d"):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--days", type=int, default=1)
    p.add_argument("--start", help="YYYY-MM-DD")
    p.add_argument("--end", help="YYYY-MM-DD")
    p.add_argument("--json", action="store_true")
    p.add_argument("--calendars", action="store_true", help="List calendar names and exit")
    args = p.parse_args()

    user, pw = load_creds()
    today = date.today()

    if args.calendars:
        cals = discover(user, pw)
        for url, name, is_sub, source_url in cals:
            tag = " (read-only subscription)" if is_sub else ""
            print(f"{name or url}{tag}")
        return

    start = date.fromisoformat(args.start) if args.start else today
    end = date.fromisoformat(args.end) if args.end else start + timedelta(days=args.days - 1)

    cals = discover(user, pw)
    if not cals:
        print("No calendars found.")
        return

    all_events = []
    for cal_url, cal_name, is_sub, source_url in cals:
        try:
            if is_sub and source_url:
                evs = fetch_ics_events(source_url, cal_name, start, end)
            else:
                evs = fetch_events(cal_url, user, pw, start, end)
                for ev in evs:
                    ev["calendar"] = cal_name
            all_events.extend(evs)
        except SystemExit:
            pass

    # Client-side date filter: some calendars (Reminders) ignore server time-range.
    # iCloud expands recurring events server-side, returning one VEVENT per occurrence with
    # the correct occurrence DTSTART -- so we filter all events the same way.
    import time as _time
    # Use current offset including DST (altzone when DST is active, timezone otherwise)
    _raw_offset = (
        _time.altzone if (_time.daylight and _time.localtime().tm_isdst) else _time.timezone
    )
    utc_offset = timedelta(seconds=-_raw_offset)

    def event_date(ev):
        try:
            s = ev["dtstart"]
            dt = parse_dt(s)
            if dt is None:
                return None
            if s.endswith("Z"):
                dt = dt + utc_offset
            return dt.date()
        except Exception:
            return None

    filtered = []
    for ev in all_events:
        d = event_date(ev)
        if d and start <= d <= end:
            filtered.append(ev)
    all_events = filtered
    all_events.sort(key=lambda e: e["dtstart"])

    if not all_events:
        label = "today" if start == end == today else f"{start} to {end}"
        print(f"No events {label}.")
        return

    if args.json:
        print(json.dumps(all_events, indent=2))
        return

    for ev in all_events:
        s = ev["dtstart"]
        dt = parse_dt(s)
        if dt:
            # UTC timestamps (ending in Z) must be converted to local time before display.
            if s.endswith("Z"):
                dt = dt + utc_offset
            time_str = dt.strftime("%-I:%M %p") if (dt.hour or dt.minute) else "All day"
            display_date = dt.date()
        else:
            time_str = s
            try:
                display_date = date(int(s[:4]), int(s[4:6]), int(s[6:8]))
            except Exception:
                display_date = today
        date_label = ""
        if display_date != today:
            date_label = display_date.strftime("%a %b %-d — ")
        cal_tag = f" [{ev['calendar']}]" if ev.get("calendar") else ""
        uid_tag = f" [uid:{ev['uid']}]" if ev.get("uid") else ""
        print(f"{date_label}{time_str}: {ev['title']}{cal_tag}{uid_tag}")


if __name__ == "__main__":
    main()
