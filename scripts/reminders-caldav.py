#!/usr/bin/env python3
"""
reminders-caldav -- manage iCloud Reminders via CalDAV VTODO.

Credentials: macOS Keychain (com.example.jarvis / icloud_user + icloud_app_password).
Fallback: ~/.jarvis-mail-creds with ICLOUD_USER and ICLOUD_APP_PASSWORD keys.

Subcommands:
  list   [--list NAME] [--all]        -- list reminders (incomplete by default)
  create --title TEXT [--list NAME] [--due-date YYYY-MM-DD]
  complete --query TITLE_OR_UID [--list NAME]
"""

import argparse
import json
import re
import subprocess
import sys
import uuid
from datetime import datetime
from pathlib import Path

TIMEZONE = "America/Chicago"
BASE_URL = "https://caldav.icloud.com"


# ---------------------------------------------------------------------------
# Credential helpers
# ---------------------------------------------------------------------------

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

    sys.exit("reminders-caldav: iCloud credentials not found in Keychain or ~/.jarvis-mail-creds")


# ---------------------------------------------------------------------------
# HTTP helpers (curl-based, same pattern as calendar-check.py)
# ---------------------------------------------------------------------------

def curl_propfind(url: str, user: str, pw: str, body: str, depth: str = "0") -> str:
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
        sys.exit(f"reminders-caldav: curl error on PROPFIND {url}: {result.stderr.strip()}")
    return result.stdout


def curl_report(url: str, user: str, pw: str, body: str) -> str:
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
        sys.exit(f"reminders-caldav: curl error on REPORT {url}: {result.stderr.strip()}")
    return result.stdout


def curl_put(url: str, user: str, pw: str, body: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["curl", "-s", "-X", "PUT", url,
         "-u", f"{user}:{pw}",
         "-H", "Content-Type: text/calendar; charset=utf-8",
         "--data", body,
         "--max-time", "20",
         "-w", "%{http_code}",
         "-o", "/dev/null"],
        capture_output=True, text=True,
    )


# ---------------------------------------------------------------------------
# XML helpers
# ---------------------------------------------------------------------------

def xml_get(xml: str, tag: str) -> str:
    m = re.search(rf"<[\w\-]*:?{tag}(?:\s[^>]*)?>([^<]*)</[\w\-]*:?{tag}>", xml, re.IGNORECASE)
    return m.group(1).strip() if m else ""


def xml_get_inner(xml: str, outer_tag: str, inner_tag: str) -> str:
    m = re.search(
        rf"<[\w\-]*:?{outer_tag}(?:\s[^>]*)?>.*?<[\w\-]*:?{inner_tag}(?:\s[^>]*)?>([^<]*)</[\w\-]*:?{inner_tag}>",
        xml, re.DOTALL | re.IGNORECASE,
    )
    return m.group(1).strip() if m else ""


# ---------------------------------------------------------------------------
# CalDAV discovery
# ---------------------------------------------------------------------------

def discover_todo_collections(
    user: str, pw: str, list_filter: str | None = None
) -> list[tuple[str, str, str]]:
    """Return list of (url, display_name, home_base) for VTODO-capable collections."""
    # Step 1: principal
    xml = curl_propfind(BASE_URL, user, pw,
        '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop>'
        '<d:current-user-principal/></d:prop></d:propfind>')
    principal = xml_get_inner(xml, "current-user-principal", "href")
    if not principal:
        sys.exit("reminders-caldav: could not find current-user-principal")
    if not principal.startswith("http"):
        principal = BASE_URL + principal

    # Step 2: calendar home
    xml = curl_propfind(principal, user, pw,
        '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" '
        'xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop>'
        '<c:calendar-home-set/></d:prop></d:propfind>')
    home = xml_get_inner(xml, "calendar-home-set", "href")
    if not home:
        sys.exit("reminders-caldav: could not find calendar-home-set")
    if not home.startswith("http"):
        home = BASE_URL + home
    from urllib.parse import urlparse
    parsed = urlparse(home)
    home_base = f"{parsed.scheme}://{parsed.netloc}"

    # Step 3: enumerate collections
    xml = curl_propfind(home, user, pw,
        '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" '
        'xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop>'
        '<d:displayname/><d:resourcetype/>'
        '<c:supported-calendar-component-set/></d:prop></d:propfind>',
        depth="1")

    collections: list[tuple[str, str, str]] = []
    for chunk in re.split(r"<[dD]?:?response(?:\s[^>]*)?>", xml)[1:]:
        # Must have <calendar> in resourcetype
        rt_m = re.search(
            r"<resourcetype[^>]*>(.*?)</[^>]*resourcetype>", chunk, re.DOTALL | re.IGNORECASE
        )
        if not rt_m:
            continue
        if not re.search(r"<[\w\-]*:?calendar[\s/>]", rt_m.group(1), re.IGNORECASE):
            continue
        # Must support VTODO
        comp_m = re.search(
            r"<supported-calendar-component-set[^>]*>(.*?)</[^>]*supported-calendar-component-set>",
            chunk, re.DOTALL | re.IGNORECASE,
        )
        if not comp_m or "VTODO" not in comp_m.group(1).upper():
            continue
        href = xml_get(chunk, "href")
        name = xml_get(chunk, "displayname") or "Reminders"
        if not href:
            continue
        url = href if href.startswith("http") else home_base + href
        if list_filter and list_filter.lower() not in name.lower():
            continue
        collections.append((url, name, home_base))

    return collections


# ---------------------------------------------------------------------------
# VTODO parsing
# ---------------------------------------------------------------------------

def parse_vtodo(ics_text: str, collection_name: str) -> dict | None:  # type: ignore[type-arg]
    """Parse a VTODO block into a dict. Returns None if no VTODO found."""
    m = re.search(r"BEGIN:VTODO(.*?)END:VTODO", ics_text, re.DOTALL)
    if not m:
        return None
    block = m.group(1)

    def prop(name: str) -> str:
        pm = re.search(rf"^{name}[;:][^\r\n]*", block, re.MULTILINE)
        if not pm:
            return ""
        line = pm.group(0)
        colon = line.find(":")
        return line[colon + 1:].strip() if colon >= 0 else ""

    uid = prop("UID")
    summary = prop("SUMMARY")
    status = prop("STATUS").upper()
    completed = status in ("COMPLETED",)
    priority_raw = prop("PRIORITY")
    priority = int(priority_raw) if priority_raw.isdigit() else 0

    due_raw = prop("DUE")
    due_date: str | None = None
    if due_raw:
        # Formats: 20260615 or 20260615T180000Z or 20260615T180000
        dm = re.match(r"(\d{4})(\d{2})(\d{2})", due_raw)
        if dm:
            due_date = f"{dm.group(1)}-{dm.group(2)}-{dm.group(3)}"

    return {
        "uid": uid,
        "title": summary,
        "dueDate": due_date,
        "completed": completed,
        "list": collection_name,
        "priority": priority,
    }


def fetch_todos(  # type: ignore[type-arg]
    url: str, user: str, pw: str, collection_name: str, include_completed: bool = False
) -> list[dict]:
    """Fetch all VTODOs from a collection URL."""
    body = """<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VTODO"/>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>"""

    xml = curl_report(url, user, pw, body)
    results: list[dict] = []  # type: ignore[type-arg]

    for chunk in re.split(r"<[dD]?:?response(?:\s[^>]*)?>", xml)[1:]:
        cd_m = re.search(
            r"<calendar-data[^>]*>(.*?)</[^>]*calendar-data>", chunk, re.DOTALL | re.IGNORECASE
        )
        if not cd_m:
            continue
        ics = cd_m.group(1).strip()
        todo = parse_vtodo(ics, collection_name)
        if todo is None:
            continue
        if not include_completed and todo["completed"]:
            continue
        results.append(todo)

    return results


def fetch_todo_by_uid(  # type: ignore[type-arg]
    url: str, user: str, pw: str, collection_name: str, uid: str
) -> tuple[str, dict, str] | None:
    """Return (resource_url, todo_dict, raw_ics) for a specific UID, or None."""
    body = f"""<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/><d:href/><c:calendar-data/></d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VTODO">
        <c:prop-filter name="UID">
          <c:text-match>{uid}</c:text-match>
        </c:prop-filter>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>"""

    xml = curl_report(url, user, pw, body)
    from urllib.parse import urlparse
    parsed = urlparse(url)
    base = f"{parsed.scheme}://{parsed.netloc}"

    for chunk in re.split(r"<[dD]?:?response(?:\s[^>]*)?>", xml)[1:]:
        href = xml_get(chunk, "href")
        cd_m = re.search(
            r"<calendar-data[^>]*>(.*?)</[^>]*calendar-data>", chunk, re.DOTALL | re.IGNORECASE
        )
        if not cd_m or not href:
            continue
        ics = cd_m.group(1).strip()
        todo = parse_vtodo(ics, collection_name)
        if todo is None:
            continue
        resource_url = href if href.startswith("http") else base + href
        return resource_url, todo, ics

    return None


# ---------------------------------------------------------------------------
# Subcommands
# ---------------------------------------------------------------------------

def cmd_list(args: argparse.Namespace) -> None:
    user, pw = load_creds()
    list_filter: str | None = args.list or None
    include_completed: bool = args.all

    collections = discover_todo_collections(user, pw, list_filter)
    if not collections:
        if list_filter:
            print(json.dumps({"error": f"No Reminders list matching '{list_filter}' found"}))
        else:
            print("[]")
        return

    all_todos: list[dict] = []  # type: ignore[type-arg]
    for (col_url, col_name, _) in collections:
        todos = fetch_todos(col_url, user, pw, col_name, include_completed)
        all_todos.extend(todos)

    print(json.dumps(all_todos, ensure_ascii=False))


def cmd_create(args: argparse.Namespace) -> None:
    user, pw = load_creds()
    list_filter: str | None = args.list or None

    collections = discover_todo_collections(user, pw, list_filter)
    if not collections:
        # Fall back: try default "Reminders" collection
        collections = discover_todo_collections(user, pw, None)
    if not collections:
        print(json.dumps({"error": "No Reminders collections found in iCloud"}))
        sys.exit(1)

    col_url, col_name, home_base = collections[0]

    new_uid = str(uuid.uuid4()).upper()
    now_str = datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")

    due_line = ""
    due_display: str | None = None
    if args.due_date:
        # Parse YYYY-MM-DD or YYYY-MM-DD HH:MM
        raw = args.due_date.strip()
        dm = re.match(r"(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2}):(\d{2}))?", raw)
        if dm:
            if dm.group(4):
                due_line = (
                    f"DUE;TZID={TIMEZONE}:"
                    f"{dm.group(1)}{dm.group(2)}{dm.group(3)}"
                    f"T{dm.group(4)}{dm.group(5)}00"
                )
            else:
                due_line = f"DUE;VALUE=DATE:{dm.group(1)}{dm.group(2)}{dm.group(3)}"
            due_display = raw
        else:
            print(json.dumps({"error": f"Invalid due-date format: {args.due_date}"}))
            sys.exit(1)

    ics_lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Jarvis//reminders-caldav//EN",
        "BEGIN:VTODO",
        f"UID:{new_uid}",
        f"DTSTAMP:{now_str}",
        f"CREATED:{now_str}",
        f"LAST-MODIFIED:{now_str}",
        f"SUMMARY:{args.title}",
        "STATUS:NEEDS-ACTION",
    ]
    if due_line:
        ics_lines.append(due_line)
    ics_lines += ["END:VTODO", "END:VCALENDAR"]
    ics_body = "\r\n".join(ics_lines) + "\r\n"

    resource_url = f"{col_url.rstrip('/')}/{new_uid}.ics"
    result = curl_put(resource_url, user, pw, ics_body)

    status_code = result.stdout.strip()
    if result.returncode != 0 or status_code not in ("201", "204", "200", ""):
        print(json.dumps({"error": f"CalDAV PUT failed (HTTP {status_code})"}))
        sys.exit(1)

    print(json.dumps({
        "uid": new_uid,
        "title": args.title,
        "list": col_name,
        "dueDate": due_display,
    }, ensure_ascii=False))


def cmd_complete(args: argparse.Namespace) -> None:
    user, pw = load_creds()
    list_filter: str | None = args.list or None
    query: str = args.query

    collections = discover_todo_collections(user, pw, list_filter)
    if not collections:
        print(json.dumps({"error": "No Reminders collections found in iCloud"}))
        sys.exit(1)

    # Search by UID first, then by title substring
    for (col_url, col_name, home_base) in collections:
        # Try exact UID match
        hit = fetch_todo_by_uid(col_url, user, pw, col_name, query)
        if hit is None:
            # Fall back: fetch all and match by title
            todos_raw = fetch_todos(col_url, user, pw, col_name, include_completed=False)
            for todo in todos_raw:
                if query.lower() in todo["title"].lower():
                    uid = todo["uid"]
                    hit = fetch_todo_by_uid(col_url, user, pw, col_name, uid)
                    break

        if hit is None:
            continue

        resource_url, todo, raw_ics = hit
        if todo["completed"]:
            print(json.dumps({"success": True, "title": todo["title"], "uid": todo["uid"],
                              "list": col_name, "note": "already completed"}))
            return

        # Mark complete: update STATUS and add COMPLETED timestamp
        now_str = datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
        updated_ics = re.sub(r"STATUS:[^\r\n]+", "STATUS:COMPLETED", raw_ics)
        if "COMPLETED:" not in updated_ics:
            updated_ics = updated_ics.replace("END:VTODO", f"COMPLETED:{now_str}\r\nEND:VTODO")
        updated_ics = re.sub(r"LAST-MODIFIED:[^\r\n]+", f"LAST-MODIFIED:{now_str}", updated_ics)

        result = curl_put(resource_url, user, pw, updated_ics)
        status_code = result.stdout.strip()
        if result.returncode != 0 or status_code not in ("200", "201", "204", ""):
            print(json.dumps({"error": f"CalDAV PUT failed (HTTP {status_code})"}))
            sys.exit(1)

        print(json.dumps({
            "success": True, "title": todo["title"], "uid": todo["uid"], "list": col_name
        }))
        return

    print(json.dumps({"error": f"Reminder not found matching '{query}'"}))
    sys.exit(1)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Manage iCloud Reminders via CalDAV")
    sub = parser.add_subparsers(dest="cmd")

    p_list = sub.add_parser("list")
    p_list.add_argument("--list", default="", help="Filter by list name (substring match)")
    p_list.add_argument("--all", action="store_true", help="Include completed reminders")

    p_create = sub.add_parser("create")
    p_create.add_argument("--title", required=True)
    p_create.add_argument("--list", default="")
    p_create.add_argument("--due-date", default="")

    p_complete = sub.add_parser("complete")
    p_complete.add_argument("--query", required=True, help="Title substring or exact UID to match")
    p_complete.add_argument("--list", default="")

    args = parser.parse_args()
    if args.cmd == "list":
        cmd_list(args)
    elif args.cmd == "create":
        cmd_create(args)
    elif args.cmd == "complete":
        cmd_complete(args)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
