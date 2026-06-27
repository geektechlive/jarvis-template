"""Tests for issue #76 (source_actor) and issue #79 (tag_match / keyword extraction)."""
from __future__ import annotations

import pytest

from harness.memory import episodic
from harness.memory.store import _extract_keywords, _keyword_tokens


@pytest.fixture(autouse=True)
def temp_db(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENT_DATA_DIR", str(tmp_path))
    episodic.init_db()


# ---------------------------------------------------------------------------
# _extract_keywords
# ---------------------------------------------------------------------------


def test_extract_keywords_strips_stopwords():
    result = _extract_keywords("Alex is using Python and TypeScript for development")
    tokens = result.split()
    assert "is" not in tokens
    assert "and" not in tokens
    assert "for" not in tokens
    assert "Alex" not in tokens  # 5 chars but lowercased to 'chris' -- passes length check
    assert "python" in tokens
    assert "typescript" in tokens
    assert "development" in tokens


def test_extract_keywords_deduplicates():
    result = _extract_keywords("Python Python Python development development")
    tokens = result.split()
    assert tokens.count("python") == 1
    assert tokens.count("development") == 1


def test_extract_keywords_respects_max():
    text = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima"
    result = _extract_keywords(text, max_keywords=3)
    assert len(result.split()) <= 3


def test_extract_keywords_empty_string():
    assert _extract_keywords("") == ""


def test_extract_keywords_only_stopwords():
    assert _extract_keywords("is the and or but in on at") == ""


def test_extract_keywords_keeps_version_numbers_and_hardware_ids():
    # #859: the prior str.isalpha() filter dropped any token containing a digit,
    # so version numbers and hardware ids never became tags. They must survive.
    result = _extract_keywords("Alex runs python3.11 on his m1pro laptop")
    tokens = result.split()
    assert "python311" in tokens  # 'python3.11' -> alphanumerics only
    assert "m1pro" in tokens
    assert "laptop" in tokens


def test_keyword_tokens_strips_surrounding_and_internal_punctuation():
    # Punctuation is stripped to alphanumerics; short tokens (<=3 after strip) drop.
    assert _keyword_tokens("tea, coffee. ios14! gpu-1") == ["coffee", "ios14", "gpu1"]


def test_keyword_tokens_matches_extract_keywords_tokenization():
    # The write-time tags and the query-time tokens must agree (#859): both go
    # through _keyword_tokens, so a query for 'python3.11' yields the same
    # 'python311' token that was stored as a tag.
    text = "Alex benchmarked python3.11 against node18"
    assert _keyword_tokens(text) == _extract_keywords(text).split()


def test_extract_keywords_excludes_short_tokens():
    # Tokens ≤3 chars should be excluded
    result = _extract_keywords("cat dog elephant")
    tokens = result.split()
    assert "cat" not in tokens
    assert "dog" not in tokens
    assert "elephant" in tokens


# ---------------------------------------------------------------------------
# upsert_memory_meta with source_actor and keywords
# ---------------------------------------------------------------------------


def test_upsert_stores_source_actor():
    episodic.upsert_memory_meta(
        "doc-actor-1",
        confidence=0.9,
        source="manual",
        collection="knowledge",
        source_actor="user",
    )
    meta = episodic.get_memory_meta("doc-actor-1")
    assert meta is not None
    assert meta["source_actor"] == "user"


def test_upsert_stores_keywords():
    episodic.upsert_memory_meta(
        "doc-kw-1",
        confidence=0.8,
        source="learning",
        collection="knowledge",
        keywords="python typescript development",
    )
    meta = episodic.get_memory_meta("doc-kw-1")
    assert meta is not None
    assert meta["keywords"] == "python typescript development"


def test_upsert_defaults_source_actor_to_jarvis_inference():
    episodic.upsert_memory_meta("doc-default-actor", source="cli", collection="knowledge")
    meta = episodic.get_memory_meta("doc-default-actor")
    assert meta is not None
    assert meta["source_actor"] == "jarvis_inference"


def test_upsert_defaults_keywords_to_empty():
    episodic.upsert_memory_meta("doc-default-kw", source="cli", collection="knowledge")
    meta = episodic.get_memory_meta("doc-default-kw")
    assert meta is not None
    assert meta["keywords"] == ""


def test_upsert_updates_source_actor_on_conflict():
    episodic.upsert_memory_meta(
        "doc-update", source="cli", collection="knowledge", source_actor="user"
    )
    episodic.upsert_memory_meta(
        "doc-update", source="cli", collection="knowledge", source_actor="reflection"
    )
    meta = episodic.get_memory_meta("doc-update")
    assert meta is not None
    assert meta["source_actor"] == "reflection"


# ---------------------------------------------------------------------------
# tag_match (Stage 1 pre-filter)
# ---------------------------------------------------------------------------


def test_tag_match_returns_ids_overlapping_keywords():
    episodic.upsert_memory_meta(
        "km-1",
        source="cli",
        collection="knowledge",
        keywords="python typescript editor",
    )
    episodic.upsert_memory_meta(
        "km-2",
        source="cli",
        collection="knowledge",
        keywords="python docker linux",
    )
    episodic.upsert_memory_meta(
        "km-3",
        source="cli",
        collection="knowledge",
        keywords="cooking recipes",
    )
    hits = episodic.tag_match(["python"], collection="knowledge")
    assert "km-1" in hits
    assert "km-2" in hits
    assert "km-3" not in hits


def test_tag_match_matches_tags_column():
    episodic.upsert_memory_meta(
        "tm-1",
        source="cli",
        collection="knowledge",
        tags=["python", "scripting"],
    )
    hits = episodic.tag_match(["python"], collection="knowledge")
    assert "tm-1" in hits


def test_tag_match_returns_empty_for_empty_tokens():
    episodic.upsert_memory_meta(
        "tm-empty",
        source="cli",
        collection="knowledge",
        keywords="python editor",
    )
    hits = episodic.tag_match([], collection="knowledge")
    assert hits == []


def test_tag_match_excludes_superseded():
    episodic.upsert_memory_meta(
        "superseded-1",
        source="cli",
        collection="knowledge",
        keywords="python editor",
    )
    episodic.set_superseded("superseded-1", superseded_by="decay")
    hits = episodic.tag_match(["python"], collection="knowledge")
    assert "superseded-1" not in hits


def test_tag_match_respects_collection():
    episodic.upsert_memory_meta(
        "col-k",
        source="cli",
        collection="knowledge",
        keywords="python editor",
    )
    episodic.upsert_memory_meta(
        "col-u",
        source="cli",
        collection="user_profile",
        keywords="python preferences",
    )
    hits = episodic.tag_match(["python"], collection="knowledge")
    assert "col-k" in hits
    assert "col-u" not in hits


def test_tag_match_respects_limit():
    for i in range(10):
        episodic.upsert_memory_meta(
            f"limit-{i}",
            source="cli",
            collection="knowledge",
            keywords="python editor development",
        )
    hits = episodic.tag_match(["python"], collection="knowledge", limit=3)
    assert len(hits) <= 3
