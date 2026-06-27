#!/usr/bin/env python3
"""
calendar-delete -- delete an iCloud calendar event via CalDAV DELETE.

Credentials: ~/.jarvis-mail-creds
  ICLOUD_USER=you@icloud.com
  ICLOUD_APP_PASSWORD=xxxx

Usage:
  calendar-delete --uid UUID [--calendar NAME]
  calendar-delete --title TEXT --date YYYY-MM-DD [--calendar NAME]

Default calendar: My calendar.
"""

import argparse
import re
import subprocess
import sys
from datetime import date, timedelta
from pathlib import Path
from urllib.parse import urlparse

TIMEZONE = "America/Chicago"


def _keychain_get(account):
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

    sys.exit("calendar-delete: no credentials found in Keychain or ~/.jarvis-mail-creds")


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
        sys.exit(f"calendar-delete: curl PROPFIND error: {r.stderr.strip()}")
    return r.stdout


def curl_report(url, user, pw, body):
    r = subprocess.run(
        ["curl", "-s", "-X", "REPORT", url,
         "-u", f"{user}:{pw}",
         "-H", "Content-Type: application/xml; charset=utf-8",
         "-H", "Depth: 1",
         "--data", body,
         "--max-time", "20"],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        sys.exit(f"calendar-delete: curl REPORT error: {r.stderr.strip()}")
    return r.stdout


def xml_get(xml, tag):
    m = re.search(rf"<[\w\-]*:?{tag}(?:\s[^>]*)?>([^<]*)</[\w\-]*:?{tag}>", xml, re.IGNORECASE)
    return m.group(1).strip() if m else None


def xml_get_inner(xml, outer, inner):
    m = re.search(
        rf"<[\w\-]*:?{outer}(?:\s[^>]*)?>.*?<[\w\-]*:?{inner}(?:\s[^>]*)?>([^<]*)</[\w\-]*:?{inner}>.*?</[\w\-]*:?{outer}>",
        xml, re.IGNORECASE | re.DOTALL)
    return m.group(1).strip() if m else None


SKIP_TAGS = ("notification", "schedule-inbox", "schedule-outbox")


def is_native_calendar(rt_text):
    lower = rt_text.lower()
    if any(f"<{t}" in lower or f":{t}" in lower for t in SKIP_TAGS):
        return False
    if re.search(r"<[\w\-]*:?subscribed[\s/>]", rt_text, re.IGNORECASE):
        return False
    return bool(re.search(r"<[\w\-]*:?calendar[\s/>]", rt_text, re.IGNORECASE))


def discover_writable(user, pw, preferred_name="My calendar"):
    base = "https://caldav.icloud.com"

    xml = curl_propfind(base, user, pw,
        '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop>'
        '<d:current-user-principal/></d:prop></d:propfind>')
    principal = xml_get_inner(xml, "current-user-principal", "href")
    if not principal:
        sys.exit("calendar-delete: could not find current-user-principal")
    if not principal.startswith("http"):
        principal = base + principal

    xml = curl_propfind(principal, user, pw,
        '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" '
        'xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop>'
        '<c:calendar-home-set/></d:prop></d:propfind>')
    home = xml_get_inner(xml, "calendar-home-set", "href")
    if not home:
        sys.exit("calendar-delete: could not find calendar-home-set")
    if not home.startswith("http"):
        home = base + home

    parsed = urlparse(home)
    home_base = f"{parsed.scheme}://{parsed.netloc}"

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
        sys.exit("calendar-delete: no writable calendars found")

    preferred = next((c for c in cals if c[1].lower() == preferred_name.lower()), None)
    return preferred[0] if preferred else cals[0][0]


def delete_by_href(href, user, pw):
    r = subprocess.run(
        ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
         "-X", "DELETE", href,
         "-u", f"{user}:{pw}",
         "--max-time", "20"],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        sys.exit(f"calendar-delete: curl DELETE error: {r.stderr.strip()}")
    code = r.stdout.strip()
    if code not in ("200", "204"):
        sys.exit(f"calendar-delete: server returned HTTP {code}")


def find_events_by_title(cal_url, user, pw, title, ev_date):
    s = ev_date.strftime("%Y%m%dT000000Z")
    e = ev_date.strftime("%Y%m%dT235959Z")
    body = f"""<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/><d:href/><c:calendar-data/></d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="{s}" end="{e}"/>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>"""
    xml = curl_report(cal_url, user, pw, body)

    matches = []
    for chunk in re.split(r"<[dD]?:?response(?:\s[^>]*)?>", xml)[1:]:
        href = xml_get(chunk, "href")
        summary_m = re.search(r"\nSUMMARY:([^\r\n]+)", chunk)
        if not href or not summary_m:
            continue
        if title.lower() in summary_m.group(1).strip().lower():
            matches.append((href, summary_m.group(1).strip()))
    return matches


def parse_date(s: str) -> date:
    today = date.today()
    if s.lower() == "today":
        return today
    if s.lower() == "tomorrow":
        return today + timedelta(days=1)
    try:
        return date.fromisoformat(s)
    except ValueError:
        sys.exit(f"calendar-delete: invalid date '{s}' — use YYYY-MM-DD, today, or tomorrow")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--uid", help="UID of event to delete")
    p.add_argument("--title", help="Title substring to search for (requires --date)")
    p.add_argument("--date", help="YYYY-MM-DD, today, or tomorrow (used with --title)")
    p.add_argument("--calendar", default="My calendar")
    args = p.parse_args()

    if not args.uid and not (args.title and args.date):
        sys.exit("calendar-delete: provide --uid UUID or --title TEXT --date DATE")

    user, pw = load_creds()
    cal_url = discover_writable(user, pw, preferred_name=args.calendar)

    parsed = urlparse(cal_url)
    server_base = f"{parsed.scheme}://{parsed.netloc}"

    if args.uid:
        event_url = f"{cal_url.rstrip('/')}/{args.uid}.ics"
        delete_by_href(event_url, user, pw)
        print(f"Deleted UID: {args.uid}")
    else:
        ev_date = parse_date(args.date)
        matches = find_events_by_title(cal_url, user, pw, args.title, ev_date)
        if not matches:
            sys.exit(f"calendar-delete: no events matching '{args.title}' on {ev_date}")
        if len(matches) > 1:
            print(f"Found {len(matches)} matching events:")
            for href, title in matches:
                print(f"  {title} — {href}")
            sys.exit("calendar-delete: multiple matches — use --uid to be specific")
        href, title = matches[0]
        full_href = href if href.startswith("http") else server_base + href
        delete_by_href(full_href, user, pw)
        print(f"Deleted: \"{title}\" on {ev_date}")


if __name__ == "__main__":
    main()
