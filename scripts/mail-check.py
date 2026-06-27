#!/usr/bin/env python3
"""
mail-check -- fetch mail from Gmail and/or iCloud via IMAP.

Credentials: ~/.jarvis-mail-creds (chmod 600)
  GMAIL_USER=you@gmail.com
  GMAIL_APP_PASSWORD=xxxx  (spaces OK -- stripped automatically)
  ICLOUD_USER=you@icloud.com
  ICLOUD_APP_PASSWORD=xxxx

Usage:
  mail-check                                  # 15 most recent unread, both sources
  mail-check --source gmail --recent 30
  mail-check --search "MoMA Design store"     # search subject/body across all mail
  mail-check --source gmail --uid 12345 --body
  mail-check --search "order" --json
  mail-check --source gmail --mark-read 12345 12346
  mail-check --source icloud --mark-read 1742
  mail-check --unreplied --hours 48 --json          # auto-watches everyone you email
  mail-check --unreplied --senders "vip@x.com" --no-derive --json  # explicit list only
"""
from __future__ import annotations

import argparse
import email
import email.header
import email.message
import email.utils
import html
import imaplib
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

UTC = timezone.utc  # noqa: UP017 -- Mini runs Python 3.9; datetime.UTC requires 3.11

CREDS_FILE = Path.home() / ".jarvis-mail-creds"
_KEYCHAIN_SVC = "com.example.jarvis"


def _keychain_get(account: str) -> str:
    import subprocess
    result = subprocess.run(
        ["security", "find-generic-password", "-s", _KEYCHAIN_SVC, "-a", account, "-w"],
        capture_output=True, text=True,
    )
    return result.stdout.strip() if result.returncode == 0 else ""

IMAP_HOSTS = {
    "gmail": ("imap.gmail.com", 993),
    "icloud": ("imap.mail.me.com", 993),
}

# Folder defaults. Gmail archives live in [Gmail]/All Mail; INBOX-only search
# misses anything Alex already filed away. iCloud has no unified All Mail
# folder, so INBOX stays the default; pass --folder to target Archive etc.
SEARCH_FOLDER_DEFAULTS = {
    "gmail": "[Gmail]/All Mail",
    "icloud": "INBOX",
}


def load_creds() -> dict[str, str]:
    # Try Keychain first.
    creds: dict[str, str] = {}
    for key, env in (
        ("icloud_user", "ICLOUD_USER"),
        ("icloud_app_password", "ICLOUD_APP_PASSWORD"),
        ("gmail_user", "GMAIL_USER"),
        ("gmail_app_password", "GMAIL_APP_PASSWORD"),
    ):
        val = _keychain_get(key)
        if val:
            creds[env] = val

    # Legacy fallback for any keys not in Keychain.
    if CREDS_FILE.exists():
        for line in CREDS_FILE.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" in line:
                key, _, value = line.partition("=")
                k = key.strip()
                if k not in creds:
                    creds[k] = value.strip()

    return creds


def decode_header_value(value: str) -> str:
    parts = email.header.decode_header(value)
    decoded = []
    for part, charset in parts:
        if isinstance(part, bytes):
            decoded.append(part.decode(charset or "utf-8", errors="replace"))
        else:
            decoded.append(str(part))
    return "".join(decoded)


def _format_date(date_str: str) -> str:
    try:
        return email.utils.parsedate_to_datetime(date_str).strftime("%Y-%m-%d %H:%M")
    except Exception:
        return date_str


def _decode_part(part: email.message.Message) -> str:
    payload = part.get_payload(decode=True)
    if not isinstance(payload, bytes):
        return ""
    charset = part.get_content_charset() or "utf-8"
    try:
        return payload.decode(charset, errors="replace")
    except (LookupError, UnicodeDecodeError):
        return payload.decode("utf-8", errors="replace")


def _strip_html(raw: str) -> str:
    """Best-effort HTML → text. Sufficient for receipt/order parsing, not perfect."""
    raw = re.sub(r"<(script|style)\b[^>]*>.*?</\1>", "", raw, flags=re.DOTALL | re.IGNORECASE)
    raw = re.sub(r"<br\s*/?>", "\n", raw, flags=re.IGNORECASE)
    raw = re.sub(r"</(p|div|tr|li|h[1-6])\s*>", "\n", raw, flags=re.IGNORECASE)
    raw = re.sub(r"<[^>]+>", "", raw)
    raw = html.unescape(raw)
    lines = [re.sub(r"[ \t]+", " ", line).strip() for line in raw.splitlines()]
    out: list[str] = []
    blank = False
    for line in lines:
        if line:
            out.append(line)
            blank = False
        elif not blank:
            out.append("")
            blank = True
    return "\n".join(out).strip()


def extract_body(msg: email.message.Message) -> str:
    """Return best-effort plain text. Prefers text/plain; falls back to stripped text/html."""
    text_plain: str | None = None
    text_html: str | None = None
    if msg.is_multipart():
        for part in msg.walk():
            disposition = str(part.get("Content-Disposition", ""))
            if disposition.lower().startswith("attachment"):
                continue
            ctype = part.get_content_type()
            if ctype == "text/plain" and text_plain is None:
                text_plain = _decode_part(part)
            elif ctype == "text/html" and text_html is None:
                text_html = _decode_part(part)
    else:
        ctype = msg.get_content_type()
        if ctype == "text/plain":
            text_plain = _decode_part(msg)
        elif ctype == "text/html":
            text_html = _decode_part(msg)
    if text_plain and text_plain.strip():
        return text_plain.strip()
    if text_html:
        stripped = _strip_html(text_html)
        if stripped:
            return stripped
    return "(no readable body)"


def _connect(source: str, user: str, password: str) -> imaplib.IMAP4_SSL:
    host, port = IMAP_HOSTS[source]
    conn = imaplib.IMAP4_SSL(host, port, timeout=30)
    conn.login(user, password)
    return conn


def fetch_recent(source: str, user: str, password: str, n: int) -> list[dict]:
    try:
        conn = _connect(source, user, password)
        conn.select("INBOX")

        status, data = conn.search(None, "UNSEEN")
        if status != "OK" or not data[0]:
            conn.logout()
            return []

        uids = data[0].split()
        recent = list(reversed(uids[-n:] if len(uids) > n else uids))

        messages = []
        for uid in recent:
            status, msg_data = conn.fetch(
                uid, "(BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])"
            )
            if status != "OK" or not msg_data or not isinstance(msg_data[0], tuple):
                continue
            raw = msg_data[0][1]
            if not isinstance(raw, bytes):
                continue
            msg = email.message_from_bytes(raw)

            messages.append(
                {
                    "source": source,
                    "from": decode_header_value(msg.get("From", "")),
                    "subject": decode_header_value(msg.get("Subject", "(no subject)")),
                    "date": _format_date(msg.get("Date", "")),
                }
            )

        conn.logout()
        return messages
    except imaplib.IMAP4.error as e:
        return [{"source": source, "error": str(e)}]
    except Exception as e:
        return [{"source": source, "error": str(e)}]


def search_source(
    source: str, user: str, password: str, query: str, folder: str | None, limit: int
) -> list[dict]:
    """Search a source for messages matching `query` (TEXT search: subject + body + headers)."""
    target = folder or SEARCH_FOLDER_DEFAULTS.get(source, "INBOX")
    try:
        conn = _connect(source, user, password)
        # Some folder names have spaces ([Gmail]/All Mail). imaplib needs the
        # folder name quoted for SELECT.
        select_arg = f'"{target}"' if " " in target or "/" in target else target
        status, _ = conn.select(select_arg, readonly=True)
        if status != "OK":
            conn.logout()
            return [{"source": source, "error": f"could not select folder {target}"}]

        # IMAP SEARCH with charset UTF-8. TEXT searches headers + body.
        status, data = conn.uid("SEARCH", "CHARSET", "UTF-8", "TEXT", f'"{query}"')
        if status != "OK" or not data or not data[0]:
            # Retry without explicit charset for servers that reject it
            status, data = conn.uid("SEARCH", None, "TEXT", f'"{query}"')
        if status != "OK" or not data or not data[0]:
            conn.logout()
            return []

        uids = data[0].split()
        recent = list(reversed(uids[-limit:] if len(uids) > limit else uids))

        results: list[dict] = []
        for uid in recent:
            status, msg_data = conn.uid(
                "FETCH", uid, "(BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])"
            )
            if status != "OK" or not msg_data or not isinstance(msg_data[0], tuple):
                continue
            raw = msg_data[0][1]
            if not isinstance(raw, bytes):
                continue
            msg = email.message_from_bytes(raw)
            results.append(
                {
                    "source": source,
                    "uid": uid.decode() if isinstance(uid, bytes) else str(uid),
                    "folder": target,
                    "from": decode_header_value(msg.get("From", "")),
                    "subject": decode_header_value(msg.get("Subject", "(no subject)")),
                    "date": _format_date(msg.get("Date", "")),
                }
            )
        conn.logout()
        return results
    except imaplib.IMAP4.error as e:
        return [{"source": source, "error": str(e)}]
    except Exception as e:
        return [{"source": source, "error": str(e)}]


def mark_read(
    source: str,
    user: str,
    password: str,
    uids: list[str],
    folder: str | None,
) -> list[dict]:
    """Mark one or more messages as read by setting the \\Seen flag."""
    target = folder or ("INBOX" if source == "icloud" else "INBOX")
    results: list[dict] = []
    try:
        conn = _connect(source, user, password)
        select_arg = f'"{target}"' if " " in target or "/" in target else target
        status, _ = conn.select(select_arg)
        if status != "OK":
            conn.logout()
            return [
                {"source": source, "uid": uid, "error": f"could not select folder {target}"}
                for uid in uids
            ]
        for uid in uids:
            uid_bytes = uid.encode() if isinstance(uid, str) else uid
            status, data = conn.store(uid_bytes, "+FLAGS", "\\Seen")
            if status == "OK":
                results.append({"source": source, "uid": uid, "marked_read": True})
            else:
                results.append({"source": source, "uid": uid, "error": f"STORE failed: {data}"})
        conn.logout()
    except imaplib.IMAP4.error as e:
        results.append({"source": source, "error": str(e)})
    except Exception as e:
        results.append({"source": source, "error": str(e)})
    return results


def fetch_uid(
    source: str,
    user: str,
    password: str,
    uid: str,
    folder: str | None,
    include_body: bool,
) -> dict:
    """Fetch one message by UID. Tries the requested folder, then falls back to INBOX."""
    target = folder or SEARCH_FOLDER_DEFAULTS.get(source, "INBOX")
    try:
        conn = _connect(source, user, password)
        select_arg = f'"{target}"' if " " in target or "/" in target else target
        status, _ = conn.select(select_arg, readonly=True)
        if status != "OK":
            conn.logout()
            return {"source": source, "error": f"could not select folder {target}"}

        spec = "(BODY.PEEK[])" if include_body else "(BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])"
        status, msg_data = conn.uid("FETCH", uid, spec)
        if status != "OK" or not msg_data or not isinstance(msg_data[0], tuple):
            conn.logout()
            return {"source": source, "error": f"UID {uid} not found in {target}"}
        raw = msg_data[0][1]
        if not isinstance(raw, bytes):
            conn.logout()
            return {"source": source, "error": f"UID {uid} returned non-bytes payload"}
        msg = email.message_from_bytes(raw)

        out = {
            "source": source,
            "uid": uid,
            "folder": target,
            "from": decode_header_value(msg.get("From", "")),
            "subject": decode_header_value(msg.get("Subject", "(no subject)")),
            "date": _format_date(msg.get("Date", "")),
        }
        if include_body:
            out["body"] = extract_body(msg)
        conn.logout()
        return out
    except imaplib.IMAP4.error as e:
        return {"source": source, "error": str(e)}
    except Exception as e:
        return {"source": source, "error": str(e)}


# --- Unreplied-thread detection ---------------------------------------------
# A thread from a tracked sender counts as "unreplied" when its most recent
# inbound message is older than the cutoff AND no message in the user's Sent
# folder belongs to that thread and is newer than that inbound message. This
# replaces the old UNSEEN-flag heuristic, which conflated "unread" with
# "unreplied" in both directions (missed read-but-unreplied mail; flagged
# unread-but-ignored mail).

_RE_PREFIX = re.compile(r"^\s*(?:re|fw|fwd)\s*:\s*", re.IGNORECASE)
# Known Sent-folder names by server, tried when LIST exposes no \Sent flag.
_SENT_FALLBACKS = ["Sent Messages", "[Gmail]/Sent Mail", "Sent", "Sent Items"]


def normalize_subject(subject: str) -> str:
    """Strip any run of Re:/Fwd: prefixes and collapse whitespace, lowercased."""
    prev = None
    cur = subject or ""
    while cur != prev:
        prev = cur
        cur = _RE_PREFIX.sub("", cur)
    return re.sub(r"\s+", " ", cur).strip().lower()


def _parse_dt(date_str: str) -> datetime | None:
    """Parse an RFC-2822 Date header to a timezone-aware UTC datetime."""
    try:
        dt = email.utils.parsedate_to_datetime(date_str)
    except (TypeError, ValueError):
        return None
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC)


def age_hours(date_str: str, now: datetime) -> float | None:
    dt = _parse_dt(date_str)
    if dt is None:
        return None
    return (now - dt).total_seconds() / 3600.0


def is_replied(inbound: dict, sent: list[dict]) -> bool:
    """Pure reply test. inbound carries message_id, subject_norm, dt; each sent
    entry carries in_reply_to, references, subject_norm, dt (all pre-parsed)."""
    msgid = (inbound.get("message_id") or "").strip().lower()
    inbound_dt = inbound.get("dt")
    inbound_subj = inbound.get("subject_norm") or ""
    for s in sent:
        # Threading headers are the authoritative signal.
        if msgid:
            refs = f"{s.get('in_reply_to', '')} {s.get('references', '')}".lower()
            if msgid in refs:
                return True
        # Fallback for clients that drop In-Reply-To/References: a sent message
        # with the same normalized subject, sent no earlier than the inbound.
        sent_dt = s.get("dt")
        if (
            inbound_subj
            and s.get("subject_norm") == inbound_subj
            and inbound_dt is not None
            and sent_dt is not None
            and sent_dt >= inbound_dt
        ):
            return True
    return False


_INVITE_PREFIX = re.compile(
    r"^(?:invitation|updated invitation|accepted|declined|tentative|"
    r"canceled|cancelled|new event):",
    re.IGNORECASE,
)


def is_calendar_invite(subject: str) -> bool:
    """True for Google/iCal invite mails (RSVP'd in the calendar, not replied).
    Checks the subject with any Re:/Fwd: prefix stripped."""
    return bool(_INVITE_PREFIX.match(normalize_subject(subject)))


def extract_addresses(header_value: str) -> set[str]:
    """Lowercased bare email addresses from a To/Cc/From header value."""
    out: set[str] = set()
    for _name, addr in email.utils.getaddresses([header_value or ""]):
        a = addr.strip().lower()
        if "@" in a:
            out.add(a)
    return out


def _detect_sent_folder(conn: imaplib.IMAP4_SSL) -> str | None:
    """Find the Sent folder via the \\Sent special-use flag (RFC 6154), then
    fall back to common names by attempting a read-only SELECT."""
    try:
        status, boxes = conn.list()
        if status == "OK" and boxes:
            for raw in boxes:
                if not isinstance(raw, bytes):
                    continue
                line = raw.decode(errors="replace")
                if "\\Sent" in line:
                    # Folder name is the quoted tail of the LIST response.
                    m = re.search(r'"([^"]+)"\s*$', line) or re.search(r"([^ ]+)\s*$", line)
                    if m:
                        return m.group(1)
    except imaplib.IMAP4.error:
        pass
    for name in _SENT_FALLBACKS:
        select_arg = f'"{name}"' if " " in name or "/" in name else name
        try:
            status, _ = conn.select(select_arg, readonly=True)
            if status == "OK":
                return name
        except imaplib.IMAP4.error:
            continue
    return None


def _batch_fetch(
    conn: imaplib.IMAP4_SSL, uids: list[bytes], fields: str, chunk: int = 300
) -> list[email.message.Message]:
    """Fetch the given header fields for many UIDs in chunked batches. One IMAP
    round-trip per chunk keeps a full-inbox scan from being O(messages) calls."""
    out: list[email.message.Message] = []
    spec = f"(BODY.PEEK[HEADER.FIELDS ({fields})])"
    for i in range(0, len(uids), chunk):
        part = b",".join(uids[i : i + chunk])
        status, data = conn.uid("FETCH", part, spec)
        if status != "OK" or not data:
            continue
        for item in data:
            if isinstance(item, tuple) and len(item) > 1 and isinstance(item[1], bytes):
                out.append(email.message_from_bytes(item[1]))
    return out


def _read_sent(
    conn: imaplib.IMAP4_SSL, since: str
) -> tuple[list[dict], set[str]] | None:
    """Select the Sent folder and return (reply-detection rows, correspondent
    addresses). Returns None if the Sent folder cannot be located."""
    sent_folder = _detect_sent_folder(conn)
    if sent_folder is None:
        return None
    select_arg = f'"{sent_folder}"' if " " in sent_folder or "/" in sent_folder else sent_folder
    conn.select(select_arg, readonly=True)
    status, sdata = conn.uid("SEARCH", None, "SINCE", since)
    sent: list[dict] = []
    correspondents: set[str] = set()
    if status == "OK" and sdata and sdata[0]:
        for msg in _batch_fetch(
            conn, sdata[0].split(), "TO CC SUBJECT DATE IN-REPLY-TO REFERENCES"
        ):
            sent.append(
                {
                    "subject_norm": normalize_subject(decode_header_value(msg.get("Subject", ""))),
                    "dt": _parse_dt(msg.get("Date", "")),
                    "in_reply_to": (msg.get("In-Reply-To", "") or "").strip(),
                    "references": (msg.get("References", "") or "").strip(),
                }
            )
            correspondents |= extract_addresses(msg.get("To", ""))
            correspondents |= extract_addresses(msg.get("Cc", ""))
    return sent, correspondents


def find_unreplied(
    source: str,
    user: str,
    password: str,
    seed_senders: list[str],
    hours: float,
    lookback_days: int,
    now: datetime,
    derive: bool = True,
    correspondent_days: int = 180,
) -> list[dict]:
    """Return inbound threads whose latest message is older than `hours` with no
    newer reply in Sent. The watched set is the union of `seed_senders` and (when
    `derive`) everyone Alex has emailed (To/Cc) within `correspondent_days` --
    so junk from never-emailed senders is ignored without a maintained list.
    INBOX only; archived mail is treated as handled."""
    try:
        conn = _connect(source, user, password)
        inbound_since = (now - timedelta(days=lookback_days)).strftime("%d-%b-%Y")
        corr_since = (now - timedelta(days=max(lookback_days, correspondent_days))).strftime(
            "%d-%b-%Y"
        )

        # 1. Read Sent once: reply-detection rows + derived correspondent set.
        read = _read_sent(conn, corr_since)
        if read is None:
            conn.logout()
            return [{"source": source, "error": "could not locate Sent folder"}]
        sent, correspondents = read

        watch = {s.strip().lower() for s in seed_senders if s.strip()}
        if derive:
            watch |= correspondents
        if not watch:
            conn.logout()
            return []

        # 2. Scan INBOX, keep only mail from watched correspondents.
        conn.select("INBOX", readonly=True)
        status, idata = conn.uid("SEARCH", None, "SINCE", inbound_since)
        latest: dict[tuple[str, str], dict] = {}
        if status == "OK" and idata and idata[0]:
            for msg in _batch_fetch(conn, idata[0].split(), "FROM SUBJECT DATE MESSAGE-ID"):
                from_raw = decode_header_value(msg.get("From", ""))
                addrs = extract_addresses(from_raw)
                hit = addrs & watch
                if not hit:
                    continue
                subject = decode_header_value(msg.get("Subject", "(no subject)"))
                if is_calendar_invite(subject):
                    continue  # calendar invites are RSVP'd, not email-replied
                date_raw = msg.get("Date", "")
                dt = _parse_dt(date_raw)
                key = (sorted(hit)[0], normalize_subject(subject))
                cand = {
                    "source": source,
                    "from": from_raw,
                    "subject": subject,
                    "subject_norm": normalize_subject(subject),
                    "date": _format_date(date_raw),
                    "dt": dt,
                    "message_id": (msg.get("Message-ID", "") or "").strip(),
                }
                prev = latest.get(key)
                if prev is None or (dt is not None and (prev["dt"] is None or dt > prev["dt"])):
                    latest[key] = cand

        conn.logout()

        # 3. Keep stale threads with no newer reply in Sent.
        results: list[dict] = []
        for c in latest.values():
            if c["dt"] is None or (now - c["dt"]).total_seconds() / 3600.0 <= hours:
                continue
            if is_replied(c, sent):
                continue
            age = (now - c["dt"]).total_seconds() / 3600.0
            results.append(
                {
                    "source": source,
                    "from": c["from"],
                    "subject": c["subject"],
                    "date": c["date"],
                    "age_hours": round(age, 1),
                    "message_id": c["message_id"],
                    "replied": False,
                }
            )
        results.sort(key=lambda r: r["age_hours"], reverse=True)
        return results
    except imaplib.IMAP4.error as e:
        return [{"source": source, "error": str(e)}]
    except Exception as e:
        return [{"source": source, "error": str(e)}]


def format_markdown(messages: list[dict]) -> str:
    if not messages:
        return "No mail."
    lines = []
    for msg in messages:
        if "error" in msg:
            lines.append(f"- [{msg['source'].upper()} ERROR] {msg['error']}")
            continue
        uid_part = f"UID {msg['uid']} | " if msg.get("uid") else ""
        lines.append(
            f"- [{msg['source'].upper()}] {uid_part}{msg.get('date', '')} | "
            f"{msg.get('from', '')} | {msg.get('subject', '')}"
        )
    return "\n".join(lines)


def format_unreplied(results: list[dict], hours: float) -> str:
    real = [r for r in results if "error" not in r]
    errs = [r for r in results if "error" in r]
    lines: list[str] = []
    if not real:
        lines.append(f"No unreplied threads older than {hours:.0f}h from tracked senders.")
    else:
        for r in real:
            days = r["age_hours"] / 24.0
            age = f"{days:.0f}d" if days >= 1 else f"{r['age_hours']:.0f}h"
            lines.append(
                f"- [{r['source'].upper()}] {age} | {r.get('from', '')} | {r.get('subject', '')}"
            )
    for e in errs:
        lines.append(f"- [{e['source'].upper()} ERROR] {e['error']}")
    return "\n".join(lines)


def format_message_full(msg: dict) -> str:
    if "error" in msg:
        return f"[{msg['source'].upper()} ERROR] {msg['error']}"
    parts = [
        f"From:    {msg.get('from', '')}",
        f"Subject: {msg.get('subject', '')}",
        f"Date:    {msg.get('date', '')}",
        f"Source:  {msg['source']} ({msg.get('folder', '')}) UID {msg.get('uid', '')}",
    ]
    if "body" in msg:
        parts.append("")
        parts.append(msg["body"])
    return "\n".join(parts)


def _resolve_creds(creds: dict[str, str], source: str) -> tuple[str, str] | dict:
    user = creds.get(f"{source.upper()}_USER")
    password = creds.get(f"{source.upper()}_APP_PASSWORD")
    if not user or not password:
        return {
            "source": source,
            "error": (
                f"missing {source.upper()}_USER or "
                f"{source.upper()}_APP_PASSWORD in {CREDS_FILE}"
            ),
        }
    return user, password.replace(" ", "")


def main() -> None:
    parser = argparse.ArgumentParser(description="Fetch mail via IMAP")
    parser.add_argument("--source", choices=["gmail", "icloud", "all"], default="all")
    parser.add_argument(
        "--recent", type=int, default=15, help="N most recent unread (default mode)"
    )
    parser.add_argument("--search", help="Search subject + body for the given text")
    parser.add_argument("--uid", help="Fetch one message by UID (requires --source)")
    parser.add_argument("--body", action="store_true", help="Include decoded body (with --uid)")
    parser.add_argument(
        "--folder",
        help="IMAP folder (default: INBOX; '[Gmail]/All Mail' for Gmail with --search/--uid)",
    )
    parser.add_argument("--limit", type=int, default=20, help="Max results for --search")
    parser.add_argument(
        "--mark-read", nargs="+", metavar="UID",
        help="Mark one or more messages as read by UID (requires --source gmail|icloud)",
    )
    parser.add_argument("--json", dest="as_json", action="store_true")
    parser.add_argument(
        "--unreplied", action="store_true",
        help="List threads from --senders with no reply newer than the latest inbound",
    )
    parser.add_argument(
        "--hours", type=float, default=48.0,
        help="Unreplied cutoff in hours (default 48; used with --unreplied)",
    )
    parser.add_argument(
        "--senders",
        help="Optional comma-separated seed addresses to always watch (with --unreplied)",
    )
    parser.add_argument(
        "--no-derive", dest="derive", action="store_false",
        help="Do not auto-watch everyone you've emailed; use --senders only",
    )
    parser.add_argument(
        "--correspondent-days", type=int, default=180,
        help="How far back in Sent to derive watched correspondents (default 180)",
    )
    parser.add_argument(
        "--lookback-days", type=int, default=30,
        help="How far back to scan inbox + sent (default 30; used with --unreplied)",
    )
    args = parser.parse_args()

    creds = load_creds()

    # Mode: unreplied-thread detection (verified against the Sent folder)
    if args.unreplied:
        senders = [s.strip() for s in (args.senders or "").split(",") if s.strip()]
        if not senders and not args.derive:
            parser.error("--unreplied needs --senders when --no-derive is set")
        now = datetime.now(UTC)
        sources = ["gmail", "icloud"] if args.source == "all" else [args.source]
        results: list[dict] = []
        for src in sources:
            resolved = _resolve_creds(creds, src)
            if isinstance(resolved, dict):
                results.append(resolved)
                continue
            user, password = resolved
            results.extend(
                find_unreplied(
                    src, user, password, senders, args.hours, args.lookback_days, now,
                    derive=args.derive, correspondent_days=args.correspondent_days,
                )
            )
        if args.as_json:
            print(json.dumps(results, indent=2))
        else:
            print(format_unreplied(results, args.hours))
        return

    # Mode: mark messages as read
    if args.mark_read:
        if args.source == "all":
            parser.error("--mark-read requires --source gmail|icloud")
        resolved = _resolve_creds(creds, args.source)
        if isinstance(resolved, dict):
            results = [resolved]
        else:
            user, password = resolved
            results = mark_read(args.source, user, password, args.mark_read, args.folder)
        if args.as_json:
            print(json.dumps(results, indent=2))
        else:
            for r in results:
                if "error" in r:
                    print(f"[{r['source'].upper()} ERROR] UID {r.get('uid', '?')}: {r['error']}")
                else:
                    print(f"[{r['source'].upper()}] UID {r['uid']} marked as read.")
        return

    # Mode: fetch one message by UID
    if args.uid:
        if args.source == "all":
            parser.error("--uid requires --source gmail|icloud")
        resolved = _resolve_creds(creds, args.source)
        if isinstance(resolved, dict):
            result = resolved
        else:
            user, password = resolved
            result = fetch_uid(args.source, user, password, args.uid, args.folder, args.body)
        if args.as_json:
            print(json.dumps(result, indent=2))
        else:
            print(format_message_full(result))
        return

    # Mode: search
    if args.search:
        sources = ["gmail", "icloud"] if args.source == "all" else [args.source]
        all_results: list[dict] = []
        for src in sources:
            resolved = _resolve_creds(creds, src)
            if isinstance(resolved, dict):
                all_results.append(resolved)
                continue
            user, password = resolved
            all_results.extend(
                search_source(src, user, password, args.search, args.folder, args.limit)
            )
        if args.as_json:
            print(json.dumps(all_results, indent=2))
        else:
            print(format_markdown(all_results))
        return

    # Default mode: most recent unread (existing behavior)
    sources = ["gmail", "icloud"] if args.source == "all" else [args.source]
    all_messages: list[dict] = []
    for src in sources:
        resolved = _resolve_creds(creds, src)
        if isinstance(resolved, dict):
            all_messages.append(resolved)
            continue
        user, password = resolved
        all_messages.extend(fetch_recent(src, user, password, args.recent))

    if args.as_json:
        print(json.dumps(all_messages, indent=2))
    else:
        print(format_markdown(all_messages))


if __name__ == "__main__":
    main()
