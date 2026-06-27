"""Tests for the pure reply-detection logic in scripts/mail-check.py.

The IMAP plumbing (folder selection, SEARCH/FETCH) needs a live mailbox and is
verified manually on the Mini. What is pinned here is the part that decides
"replied vs not" -- the logic that previously did not exist at all and that
goal #1 depends on: subject normalization, age math, and the reply test
(threading headers first, same-subject-newer-than-inbound as fallback).
"""

import importlib.util
from datetime import UTC, datetime, timedelta
from pathlib import Path

_SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "mail-check.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("mail_check", _SCRIPT)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


mc = _load_module()
NOW = datetime(2026, 6, 17, 12, 0, tzinfo=UTC)


# --- normalize_subject ------------------------------------------------------

def test_normalize_strips_single_prefix():
    assert mc.normalize_subject("Re: COI for Meadowlands") == "coi for meadowlands"


def test_normalize_strips_stacked_prefixes():
    assert mc.normalize_subject("Re: Fwd: RE: Annual minutes") == "annual minutes"


def test_normalize_collapses_whitespace_and_case():
    assert mc.normalize_subject("  FWD:   Insurance   Renewal ") == "insurance renewal"


def test_normalize_handles_empty():
    assert mc.normalize_subject("") == ""


# --- extract_addresses (correspondent derivation) --------------------------

def test_extract_single_address_lowercased():
    assert mc.extract_addresses("Sam Example <contact@example.com>") == {"contact@example.com"}


def test_extract_multiple_recipients():
    got = mc.extract_addresses("A <a@x.com>, b@y.com, C <c@z.org>")
    assert got == {"a@x.com", "b@y.com", "c@z.org"}


def test_extract_empty_and_garbage():
    assert mc.extract_addresses("") == set()
    assert mc.extract_addresses("not an address") == set()


# --- is_calendar_invite -----------------------------------------------------

def test_invite_detected():
    assert mc.is_calendar_invite("Invitation: Play Games at Alex' @ Fri Jun 19") is True


def test_invite_variants_detected():
    assert mc.is_calendar_invite("Updated invitation: Coffee @ Sun") is True
    assert mc.is_calendar_invite("Accepted: Standup") is True
    assert mc.is_calendar_invite("Re: Invitation: Loca Latte") is True  # prefix stripped


def test_non_invite_not_flagged():
    assert mc.is_calendar_invite("Fwd: COI for Meadowlands") is False
    assert mc.is_calendar_invite("Good to reconnect") is False


# --- age_hours --------------------------------------------------------------

def test_age_hours_counts_from_now():
    two_days_ago = (NOW - timedelta(days=2)).strftime("%a, %d %b %Y %H:%M:%S +0000")
    assert mc.age_hours(two_days_ago, NOW) == 48.0


def test_age_hours_assumes_utc_when_no_tz():
    # No timezone in the header -> treated as UTC, not rejected.
    assert mc.age_hours("17 Jun 2026 06:00:00", NOW) == 6.0


def test_age_hours_returns_none_on_garbage():
    assert mc.age_hours("not a date", NOW) is None


# --- is_replied -------------------------------------------------------------

def _inbound(msgid="<abc@x>", subject_norm="coi for meadowlands", age_h=72):
    return {
        "message_id": msgid,
        "subject_norm": subject_norm,
        "dt": NOW - timedelta(hours=age_h),
    }


def test_replied_via_in_reply_to_header():
    inbound = _inbound()
    sent = [{"in_reply_to": "<abc@x>", "references": "", "subject_norm": "x", "dt": NOW}]
    assert mc.is_replied(inbound, sent) is True


def test_replied_via_references_header_case_insensitive():
    inbound = _inbound(msgid="<ABC@X>")
    sent = [{"in_reply_to": "", "references": "<other> <abc@x>", "subject_norm": "x", "dt": NOW}]
    assert mc.is_replied(inbound, sent) is True


def test_replied_via_subject_fallback_when_sent_newer():
    inbound = _inbound(msgid="")  # client dropped threading headers
    sent = [{
        "in_reply_to": "", "references": "",
        "subject_norm": "coi for meadowlands",
        "dt": NOW - timedelta(hours=1),  # newer than the 72h-old inbound
    }]
    assert mc.is_replied(inbound, sent) is True


def test_not_replied_when_sent_older_than_inbound():
    # A reply that predates the sender's latest message means the ball is back
    # in Alex's court -- still unreplied.
    inbound = _inbound(msgid="", age_h=24)
    sent = [{
        "in_reply_to": "", "references": "",
        "subject_norm": "coi for meadowlands",
        "dt": NOW - timedelta(hours=48),
    }]
    assert mc.is_replied(inbound, sent) is False


def test_not_replied_on_subject_mismatch():
    inbound = _inbound()
    sent = [{"in_reply_to": "", "references": "", "subject_norm": "unrelated", "dt": NOW}]
    assert mc.is_replied(inbound, sent) is False


def test_not_replied_with_empty_sent():
    assert mc.is_replied(_inbound(), []) is False
