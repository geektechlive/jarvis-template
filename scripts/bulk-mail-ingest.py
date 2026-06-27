#!/usr/bin/env python3
"""bulk-mail-ingest — one-shot ingest of an entire mail archive into Jarvis.

Iterates a date range month-by-month per (source, folder), triages each
message with an LLM, extracts durable facts, and writes them to the vec
server. Routes by message age:

  - <12 months old   → `knowledge` collection (default confidence ~0.5)
  - 12-24 months     → `knowledge` with lower starting confidence
  - 24+ months       → `archive` collection directly (no decay journey)

Idempotent: every (source, message_id) is recorded in `processed_mail` and
skipped on re-runs. Safe to interrupt and resume.

Usage:
  # Pilot, dry-run, Gmail INBOX, last 30 days, Ollama only:
  bulk-mail-ingest.py --source gmail --folders INBOX \\
      --since 2026-04-14 --before 2026-05-14 \\
      --provider ollama --dry-run-facts pilot-facts.jsonl

  # Full archive, all sources, all folders, write to memory:
  bulk-mail-ingest.py --source all --all-folders --provider ollama

Requires the vec server on http://127.0.0.1:9876.
"""
from __future__ import annotations

import argparse
import imaplib
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from email.message import Message
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "scripts"))

# Import IMAP helpers from mail-check via runpy-style import. The script name
# has a hyphen, so we load it through importlib.
import importlib.util as _ilu  # noqa: E402

_spec = _ilu.spec_from_file_location("_mailcheck", REPO_ROOT / "scripts" / "mail-check.py")
assert _spec and _spec.loader
_mailcheck = _ilu.module_from_spec(_spec)
_spec.loader.exec_module(_mailcheck)

from harness.memory import episodic  # noqa: E402

VEC_SERVER = os.environ.get("VEC_SERVER", "http://127.0.0.1:9876")

# Check once at startup — not per email — to avoid exhausting file descriptors.
_HAS_PDFTOTEXT: bool = (
    subprocess.run(["which", "pdftotext"], capture_output=True, text=True).returncode == 0
)

# Promotional / transactional senders and subject patterns to skip before
# spending LLM cycles. Conservative -- anything ambiguous goes to triage.
_SKIP_SENDER_RE = re.compile(
    r"(noreply|no-reply|donotreply|do-not-reply|notifications?@|alerts?@|"
    r"updates?@|news(letter)?@|marketing@|hello@|info@|automated@|"
    r"team@|support@|billing@|orders?@|receipts?@|cosplanreports?@)",
    re.IGNORECASE,
)
_SKIP_SUBJECT_RE = re.compile(
    r"(unsubscribe|view in browser|your receipt|order #|shipped|delivered|"
    r"verify your|password reset|verification code|2fa|two.factor|"
    r"weekly digest|daily digest)",
    re.IGNORECASE,
)

# Triage prompt -- mirrors harness-ts/src/triage/index.ts classifications.
_TRIAGE_SYSTEM = """You are a mail triage classifier for an executive's inbox.
Classify each email into exactly one decision:
  suppress  — promotional, transactional, automated, or trivially auto-generated. No future value.
  batch     — non-urgent but mildly informative; surface in a digest, not alone.
  notify    — material content but not urgent; user should see it soon.
  question  — sender is asking the user something requiring an answer.
  review    — needs the user's deliberate attention before acting.

Reply with ONLY the single word: suppress, batch, notify, question, or review.
No explanation."""

_EXTRACT_SYSTEM = """You extract durable facts from emails for a personal AI assistant.

Hard rule: ONLY extract facts that would be useful to recall in a future
conversation. SKIP promotional, transactional, or automated content even if
the email is otherwise non-trivial. A fact is durable if it involves:
  - a decision, commitment, or deadline
  - a person, organization, or relationship
  - an event, meeting, or scheduling change
  - a stated preference, opinion, or position

Return a JSON array of factual one-to-three-sentence extracts. Each extract
should be self-contained (who/what/when), under 1500 characters. If nothing
durable is present, return an empty array [].

Output ONLY the JSON array. No prose, no markdown fences."""


@dataclass
class IngestStats:
    examined: int = 0
    skipped_pre_triage: int = 0
    skipped_already_processed: int = 0
    suppressed: int = 0
    extracted: int = 0
    facts_written: int = 0
    bodies_written: int = 0
    errors: int = 0


@dataclass
class EmailMeta:
    source: str
    folder: str
    uid: str
    message_id: str
    sender: str
    subject: str
    sent_at: datetime
    body: str
    attachments_text: str = ""


# ---------------------------------------------------------------------------
# IMAP fetch
# ---------------------------------------------------------------------------


def _imap_date(dt: datetime) -> str:
    """IMAP date format: 01-Jan-2025."""
    return dt.strftime("%d-%b-%Y")


def _select(conn: imaplib.IMAP4_SSL, folder: str, readonly: bool = True) -> bool:
    select_arg = f'"{folder}"' if " " in folder or "/" in folder else folder
    status, _ = conn.select(select_arg, readonly=readonly)
    return status == "OK"


def _list_folders(conn: imaplib.IMAP4_SSL) -> list[str]:
    """List all selectable folders on the server."""
    status, data = conn.list()
    if status != "OK" or not data:
        return []
    out: list[str] = []
    for raw in data:
        if not raw:
            continue
        line = raw.decode("utf-8", errors="replace") if isinstance(raw, bytes) else str(raw)
        # Format: (\HasNoChildren) "/" "INBOX/Receipts"
        m = re.match(r'\([^)]*\)\s+"[^"]*"\s+(.+)$', line)
        if not m:
            continue
        name = m.group(1).strip()
        if name.startswith('"') and name.endswith('"'):
            name = name[1:-1]
        # Skip non-selectable virtual folders
        if "\\Noselect" in line:
            continue
        out.append(name)
    return out


def _search_range(
    conn: imaplib.IMAP4_SSL, since: datetime, before: datetime,
) -> list[str]:
    """Return UIDs in [since, before) for the currently-selected folder."""
    crit = f'(SINCE "{_imap_date(since)}" BEFORE "{_imap_date(before)}")'
    status, data = conn.uid("SEARCH", None, crit)
    if status != "OK" or not data or not data[0]:
        return []
    raw = data[0]
    if isinstance(raw, bytes):
        return raw.decode().split()
    return [s.decode() if isinstance(s, bytes) else str(s) for s in raw.split()]


def _fetch_one(conn: imaplib.IMAP4_SSL, uid: str) -> Message | None:
    status, msg_data = conn.uid("FETCH", uid, "(BODY.PEEK[])")
    if status != "OK" or not msg_data or not isinstance(msg_data[0], tuple):
        return None
    raw = msg_data[0][1]
    if not isinstance(raw, bytes):
        return None
    import email as _email
    return _email.message_from_bytes(raw)


# ---------------------------------------------------------------------------
# Attachment text extraction (PDFs only, best-effort)
# ---------------------------------------------------------------------------


def _extract_attachments_text(msg: Message, max_chars: int = 4000) -> str:
    """Pull text out of PDF attachments using pdftotext. Skips silently if absent."""
    if not msg.is_multipart() or not _HAS_PDFTOTEXT:
        return ""
    pieces: list[str] = []
    for part in msg.walk():
        disp = str(part.get("Content-Disposition", "")).lower()
        if not disp.startswith("attachment"):
            continue
        ctype = (part.get_content_type() or "").lower()
        if ctype != "application/pdf":
            continue
        payload = part.get_payload(decode=True)
        if not isinstance(payload, bytes):
            continue
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
            f.write(payload)
            tmp_path = f.name
        try:
            proc = subprocess.run(
                ["pdftotext", "-layout", tmp_path, "-"],
                capture_output=True, text=True, timeout=30,
            )
            if proc.returncode == 0 and proc.stdout.strip():
                pieces.append(proc.stdout.strip())
        except Exception:
            pass
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
        if sum(len(p) for p in pieces) > max_chars:
            break
    combined = "\n\n".join(pieces)
    return combined[:max_chars]


# ---------------------------------------------------------------------------
# LLM providers
# ---------------------------------------------------------------------------


class LLM:
    """Tiny provider wrapper. Picks Ollama or Anthropic based on --provider."""

    def __init__(self, provider: str, triage_model: str, extract_model: str):
        self.provider = provider
        self.triage_model = triage_model
        self.extract_model = extract_model

    def triage(self, email_text: str) -> str:
        prompt = f"{_TRIAGE_SYSTEM}\n\n---\nEMAIL:\n{email_text[:4000]}"
        raw = self._call(self.triage_model, prompt).strip().lower()
        for word in ("suppress", "batch", "notify", "question", "review"):
            if word in raw:
                return word
        return "batch"

    def extract(self, email_text: str) -> list[str]:
        prompt = f"{_EXTRACT_SYSTEM}\n\n---\nEMAIL:\n{email_text[:8000]}"
        raw = self._call(self.extract_model, prompt).strip()
        # Tolerate fences if the model adds them
        raw = re.sub(r"^```(?:json)?", "", raw).strip()
        raw = re.sub(r"```$", "", raw).strip()
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            # Best-effort: scrape array
            m = re.search(r"\[.*\]", raw, re.DOTALL)
            if not m:
                return []
            try:
                parsed = json.loads(m.group(0))
            except json.JSONDecodeError:
                return []
        if not isinstance(parsed, list):
            return []
        # Normalize: some models return [{"text": "..."}, ...] instead of ["...", ...]
        def _coerce(x: Any) -> str:
            if isinstance(x, dict):
                return (x.get("text") or x.get("content") or x.get("fact") or "").strip()
            return str(x).strip()
        return [s for s in (_coerce(x) for x in parsed) if 20 <= len(s) <= 1500]

    def _call(self, model: str, prompt: str) -> str:
        if self.provider == "ollama":
            return self._ollama(model, prompt)
        if self.provider == "anthropic":
            return self._anthropic(model, prompt)
        if self.provider == "claude":
            return self._claude_cli(model, prompt)
        raise ValueError(f"unknown provider {self.provider!r}")

    @staticmethod
    def _ollama(model: str, prompt: str) -> str:
        import ollama
        host = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434")
        client = ollama.Client(host=host, timeout=120)
        resp = client.chat(
            model=model,
            messages=[{"role": "user", "content": prompt}],
            options={"temperature": 0.0},
        )
        return resp.message.content or ""

    @staticmethod
    def _anthropic(model: str, prompt: str) -> str:
        import anthropic
        client = anthropic.Anthropic()
        msg = client.messages.create(
            model=model,
            max_tokens=2048,
            messages=[{"role": "user", "content": prompt}],
        )
        for block in msg.content:
            if getattr(block, "type", None) == "text":
                return block.text
        return ""

    @staticmethod
    def _claude_cli(model: str, prompt: str) -> str:
        # Use the Claude Code CLI binary (~/.local/bin/claude on Mini).
        # Inherits stored auth — no API key env var required.
        binary = (
            subprocess.run(["which", "claude"], capture_output=True, text=True).stdout.strip()
            or os.path.expanduser("~/.local/bin/claude")
        )
        result = subprocess.run(
            [binary, "-p", prompt, "--model", model],
            capture_output=True, text=True, timeout=120,
        )
        if result.returncode != 0:
            raise RuntimeError(f"claude CLI ({binary}): {result.stderr.strip()}")
        return result.stdout.strip()


# ---------------------------------------------------------------------------
# Vec server writes
# ---------------------------------------------------------------------------


def _post_remember(text: str, collection: str, metadata: dict[str, Any]) -> bool:
    import urllib.request
    payload = json.dumps({
        "text": text[:1500],
        "collection": collection,
        "source": metadata.get("source", "mail"),
        "metadata": metadata,
    }).encode()
    req = urllib.request.Request(
        f"{VEC_SERVER}/remember",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status == 200
    except Exception as exc:
        print(f"  remember failed: {exc}", file=sys.stderr)
        return False


# ---------------------------------------------------------------------------
# Routing
# ---------------------------------------------------------------------------


def _route(sent_at: datetime, now: datetime) -> tuple[str, str]:
    """Return (collection, source_label) by age. source_label drives initial confidence."""
    age = now - sent_at
    if age < timedelta(days=365):
        return "knowledge", "mail"          # confidence 0.5
    if age < timedelta(days=730):
        return "knowledge", "mail-aging"    # treated as 'mail' prefix → 0.5
    return "archive", "mail-archive"        # archive bypass


def _months_between(since: datetime, before: datetime) -> list[tuple[datetime, datetime]]:
    """Inclusive month-by-month chunks of [since, before). Oldest first."""
    chunks: list[tuple[datetime, datetime]] = []
    cur = datetime(since.year, since.month, 1, tzinfo=since.tzinfo)
    while cur < before:
        if cur.month == 12:
            nxt = datetime(cur.year + 1, 1, 1, tzinfo=cur.tzinfo)
        else:
            nxt = datetime(cur.year, cur.month + 1, 1, tzinfo=cur.tzinfo)
        chunks.append((max(cur, since), min(nxt, before)))
        cur = nxt
    return chunks


# ---------------------------------------------------------------------------
# Pre-filter
# ---------------------------------------------------------------------------


def _should_skip_pre_triage(sender: str, subject: str) -> bool:
    if _SKIP_SENDER_RE.search(sender or ""):
        return True
    if _SKIP_SUBJECT_RE.search(subject or ""):
        return True
    return False


# ---------------------------------------------------------------------------
# Main per-message handler
# ---------------------------------------------------------------------------


def _process_message(
    em: EmailMeta,
    llm: LLM,
    now: datetime,
    dry_run_writer: Any | None,
    stats: IngestStats,
) -> None:
    if episodic.is_mail_processed(em.source, em.message_id):
        stats.skipped_already_processed += 1
        return

    stats.examined += 1
    collection, source_label = _route(em.sent_at, now)
    sender_domain = em.sender.split("@")[-1].rstrip(">").strip() if "@" in em.sender else "unknown"

    if _should_skip_pre_triage(em.sender, em.subject):
        stats.skipped_pre_triage += 1
        episodic.mark_mail_processed(
            em.source, em.message_id,
            uid=em.uid, folder=em.folder,
            triage_decision="suppress_pre",
            fact_count=0, tier=collection,
            message_date=em.sent_at.isoformat(),
        )
        return

    body_for_llm = (
        f"From: {em.sender}\nSubject: {em.subject}\n"
        f"Date: {em.sent_at.isoformat()}\n\n{em.body}"
    )
    if em.attachments_text:
        body_for_llm += f"\n\n--- ATTACHMENTS ---\n{em.attachments_text}"

    try:
        decision = llm.triage(body_for_llm)
    except Exception as exc:
        stats.errors += 1
        print(f"  triage failed for {em.uid}: {exc}", file=sys.stderr)
        return

    if decision == "suppress":
        stats.suppressed += 1
        episodic.mark_mail_processed(
            em.source, em.message_id,
            uid=em.uid, folder=em.folder,
            triage_decision="suppress",
            fact_count=0, tier=collection,
            message_date=em.sent_at.isoformat(),
        )
        return

    try:
        facts = llm.extract(body_for_llm)
    except Exception as exc:
        stats.errors += 1
        print(f"  extract failed for {em.uid}: {exc}", file=sys.stderr)
        return

    if not facts:
        episodic.mark_mail_processed(
            em.source, em.message_id,
            uid=em.uid, folder=em.folder,
            triage_decision=decision,
            fact_count=0, tier=collection,
            message_date=em.sent_at.isoformat(),
        )
        return

    stats.extracted += 1
    base_meta = {
        "source": f"mail:{sender_domain}",
        "sender": em.sender,
        "sender_domain": sender_domain,
        "subject": em.subject,
        "received_at": em.sent_at.isoformat(),
        "triage": decision,
        "tier": collection,
        "message_id": em.message_id,
    }

    if dry_run_writer is not None:
        for fact in facts:
            dry_run_writer.write(json.dumps({
                **base_meta, "fact": fact, "collection": collection,
            }) + "\n")
        episodic.mark_mail_processed(
            em.source, em.message_id,
            uid=em.uid, folder=em.folder,
            triage_decision=decision,
            fact_count=len(facts), tier=collection,
            message_date=em.sent_at.isoformat(),
        )
        stats.facts_written += len(facts)
        return

    written = 0
    for fact in facts:
        if _post_remember(
            fact, collection,
            {**base_meta, "source": source_label, "kind": "fact"},
        ):
            written += 1
    stats.facts_written += written

    # Store the email body as a linked entry so semantic recall on a fact can
    # pull the surrounding context. Capped to MAX_MEMORY_CHARS by the vec server.
    body_summary = body_for_llm[:1400]
    if _post_remember(
        body_summary, collection,
        {**base_meta, "source": source_label, "kind": "email_body",
         "linked_message_id": em.message_id, "type": "email_body"},
    ):
        stats.bodies_written += 1

    episodic.mark_mail_processed(
        em.source, em.message_id,
        uid=em.uid, folder=em.folder,
        triage_decision=decision,
        fact_count=written, tier=collection,
        message_date=em.sent_at.isoformat(),
    )


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------


def _resolve_message_id(msg: Message, fallback_uid: str, source: str) -> str:
    raw_id = msg.get("Message-ID") or msg.get("Message-Id") or ""
    cleaned = raw_id.strip().strip("<>")
    return cleaned or f"{source}-uid-{fallback_uid}"


def _parse_sent_at(msg: Message) -> datetime:
    date_hdr = msg.get("Date") or ""
    try:
        dt = parsedate_to_datetime(date_hdr)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=UTC)
        return dt
    except Exception:
        return datetime.now(UTC)


def _ingest_folder(
    source: str,
    user: str,
    password: str,
    folder: str,
    since: datetime,
    before: datetime,
    limit_per_month: int,
    llm: LLM,
    now: datetime,
    dry_run_writer: Any | None,
    stats: IngestStats,
    verbose: bool,
) -> None:
    try:
        conn = _mailcheck._connect(source, user, password)
    except Exception as exc:
        print(f"[{source}] connect failed: {exc}", file=sys.stderr)
        stats.errors += 1
        return

    if not _select(conn, folder, readonly=True):
        print(f"[{source}] could not select folder {folder}; skipping", file=sys.stderr)
        try:
            conn.logout()
        except Exception:
            pass
        return

    for (m_since, m_before) in _months_between(since, before):
        uids = _search_range(conn, m_since, m_before)
        if not uids:
            continue
        if len(uids) > limit_per_month:
            uids = uids[-limit_per_month:]
        if verbose:
            print(
                f"[{source}:{folder}] {m_since.strftime('%Y-%m')} → {len(uids)} messages",
                flush=True,
            )
        for i, uid in enumerate(uids, 1):
            msg = _fetch_one(conn, uid)
            if msg is None:
                continue
            sender = _mailcheck.decode_header_value(msg.get("From", ""))
            subject = _mailcheck.decode_header_value(msg.get("Subject", "(no subject)"))
            body = _mailcheck.extract_body(msg)
            atts = _extract_attachments_text(msg)
            em = EmailMeta(
                source=source,
                folder=folder,
                uid=uid,
                message_id=_resolve_message_id(msg, uid, source),
                sender=sender,
                subject=subject,
                sent_at=_parse_sent_at(msg),
                body=body,
                attachments_text=atts,
            )
            if verbose:
                print(f"  [{i}/{len(uids)}] {em.subject[:60]}", flush=True)
            _process_message(em, llm, now, dry_run_writer, stats)

    try:
        conn.logout()
    except Exception:
        pass


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Bulk-ingest mail into Jarvis memory.",
    )
    parser.add_argument("--source", choices=["gmail", "icloud", "all"], default="all")
    parser.add_argument(
        "--folders",
        help="Comma-separated folder list (e.g. 'INBOX,[Gmail]/Sent Mail')",
    )
    parser.add_argument(
        "--all-folders", action="store_true",
        help="Enumerate all selectable folders on the server",
    )
    parser.add_argument("--since", required=True, help="YYYY-MM-DD")
    parser.add_argument("--before", required=True, help="YYYY-MM-DD (exclusive)")
    parser.add_argument("--limit-per-month", type=int, default=5000)
    parser.add_argument(
        "--provider", choices=["ollama", "anthropic", "claude"], default="ollama",
    )
    parser.add_argument("--triage-model", default="qwen2.5:14b")
    parser.add_argument("--extract-model", default="gemma3:27b")
    parser.add_argument(
        "--dry-run-facts",
        help="Write extracted facts to JSONL; do not call /remember",
    )
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    if args.provider in ("anthropic", "claude"):
        # Use Claude models; swap Ollama defaults if not explicitly overridden.
        if args.triage_model == "qwen2.5:14b":
            args.triage_model = "claude-haiku-4-5-20251001"
        if args.extract_model == "gemma3:27b":
            args.extract_model = "claude-sonnet-4-6"

    since = datetime.strptime(args.since, "%Y-%m-%d").replace(tzinfo=UTC)
    before = datetime.strptime(args.before, "%Y-%m-%d").replace(tzinfo=UTC)
    if before <= since:
        parser.error("--before must be after --since")

    sources = ["gmail", "icloud"] if args.source == "all" else [args.source]
    explicit_folders = [f.strip() for f in args.folders.split(",")] if args.folders else None

    episodic.init_db()
    creds = _mailcheck.load_creds()
    llm = LLM(args.provider, args.triage_model, args.extract_model)
    stats = IngestStats()
    now = datetime.now(UTC)

    dry_run_writer = None
    if args.dry_run_facts:
        dry_run_writer = open(args.dry_run_facts, "w", encoding="utf-8")

    print(
        f"bulk-mail-ingest: {since.date()} → {before.date()} | "
        f"sources={sources} | provider={args.provider}"
    )
    if args.dry_run_facts:
        print(
            f"  dry-run: facts → {args.dry_run_facts} (NOT written to vec server)"
        )

    try:
        for src in sources:
            resolved = _mailcheck._resolve_creds(creds, src)
            if isinstance(resolved, dict):
                print(f"[{src}] {resolved.get('error', 'creds missing')}", file=sys.stderr)
                continue
            user, password = resolved

            # Resolve folder list per source.
            if args.all_folders:
                try:
                    conn = _mailcheck._connect(src, user, password)
                    folder_list = _list_folders(conn)
                    conn.logout()
                except Exception as exc:
                    print(f"[{src}] folder enumeration failed: {exc}", file=sys.stderr)
                    folder_list = ["INBOX"]
            elif explicit_folders:
                folder_list = explicit_folders
            else:
                # Sensible defaults per source: Gmail's All Mail covers archive
                # and Sent simultaneously; iCloud needs them named separately.
                folder_list = (
                    ["[Gmail]/All Mail"] if src == "gmail"
                    else ["INBOX", "Sent Messages", "Archive"]
                )

            for folder in folder_list:
                t0 = time.monotonic()
                _ingest_folder(
                    src, user, password, folder,
                    since, before, args.limit_per_month,
                    llm, now, dry_run_writer, stats, args.verbose,
                )
                dt = time.monotonic() - t0
                if args.verbose:
                    print(f"[{src}:{folder}] done in {dt:.1f}s")
    finally:
        if dry_run_writer is not None:
            dry_run_writer.close()

    print(
        f"\nDone: examined={stats.examined} suppressed={stats.suppressed} "
        f"extracted={stats.extracted} facts={stats.facts_written} "
        f"bodies={stats.bodies_written} skipped_pre={stats.skipped_pre_triage} "
        f"skipped_dup={stats.skipped_already_processed} errors={stats.errors}"
    )
    overall = episodic.processed_mail_stats()
    print(f"processed_mail totals: {overall}")


if __name__ == "__main__":
    main()
