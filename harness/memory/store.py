"""Vector memory store backed by ChromaDB with Ollama embeddings.

All embeddings are generated locally via Ollama (nomic-embed-text model).
No data leaves the machine.
"""
from __future__ import annotations

import ipaddress
import json
import os
import re
import threading
import time
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlparse

import chromadb
from chromadb.utils.embedding_functions import OllamaEmbeddingFunction


def _validate_ollama_host(host: str) -> None:
    """Reject public hostnames to prevent data exfiltration via tampered .env."""
    parsed = urlparse(host)
    hostname = parsed.hostname or ""
    if hostname in ("localhost",) or hostname.endswith(".local"):
        return
    try:
        addr = ipaddress.ip_address(hostname)
        if addr.is_loopback or addr.is_private:
            return
    except ValueError:
        pass
    raise ValueError(
        f"OLLAMA_HOST/OLLAMA_EMBED_HOST must resolve to loopback or RFC1918: {host!r}"
    )


def _resolve_embed_host() -> str:
    """Return the Ollama embed endpoint URL, validated to be loopback/RFC1918/.local."""
    host = os.environ.get("OLLAMA_EMBED_HOST") or os.environ.get(
        "OLLAMA_HOST", "http://127.0.0.1:11434"
    )
    _validate_ollama_host(host)
    return host


def _load_models_config() -> dict:
    """Load harness/config/models.yaml. Returns {} on any failure."""
    try:
        import yaml
        config_path = Path(__file__).parent.parent / "config" / "models.yaml"
        with open(config_path) as f:
            return yaml.safe_load(f) or {}
    except Exception:
        return {}


def _get_ollama_client(timeout: float | None = None):
    """Return an ollama.Client pointed at OLLAMA_HOST.

    `timeout` is forwarded to the underlying httpx client (the only kwarg the
    Ollama client passes through). None means no timeout — only acceptable for
    the embedding path that already has its own watchdog.
    """
    import ollama
    host = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434")
    if timeout is None:
        return ollama.Client(host=host)
    return ollama.Client(host=host, timeout=timeout)


def _openrouter_chat(model: str, prompt: str, timeout: float = 30) -> str:
    """Single-turn chat via OpenRouter REST API. Returns assistant content string.

    Raises ValueError when OPENROUTER_API_KEY is unset, or httpx.HTTPStatusError
    on a non-2xx response. Callers are responsible for try/except.
    """
    import httpx

    api_key = os.environ.get("OPENROUTER_API_KEY", "")
    if not api_key:
        raise ValueError("OPENROUTER_API_KEY not set")
    resp = httpx.post(
        "https://openrouter.ai/api/v1/chat/completions",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        json={
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
        },
        timeout=timeout,
    )
    resp.raise_for_status()
    data = resp.json()
    return (data["choices"][0]["message"]["content"] or "").strip()


_AFM_SERVER = os.environ.get("AFM_SERVER", "http://127.0.0.1:9878")


def _afm_chat(prompt: str, timeout: float = 30) -> str:
    """Single-turn generation via the on-device Apple Foundation Models service
    (tools-py/apple-foundation). Free + offline. Raises on unavailability or HTTP
    error so callers fall back to their configured backup backend.
    """
    import httpx

    resp = httpx.post(f"{_AFM_SERVER}/generate", json={"prompt": prompt}, timeout=timeout)
    resp.raise_for_status()
    data = resp.json()
    if not data.get("ok"):
        raise RuntimeError(f"afm unavailable: {data.get('error', 'unknown')}")
    return (data.get("content") or "").strip()


def _chat_by_backend(backend: str, model: str, prompt: str, timeout: float = 30) -> str:
    """Route a single-turn chat to the correct backend.

    Supported backends: ``"apple"`` (on-device Foundation Models), ``"openrouter"``
    (OpenRouter REST API), anything else falls back to Ollama. Raises on
    unrecoverable errors; callers handle silently.
    """
    if backend == "apple":
        return _afm_chat(prompt, timeout)
    if backend == "openrouter":
        return _openrouter_chat(model, prompt, timeout)
    client = _get_ollama_client(timeout=timeout)
    resp = client.chat(
        model=model,
        messages=[{"role": "user", "content": prompt}],
    )
    return (resp.message.content or "").strip()


def _chat_with_fallback(
    backend: str, model: str, prompt: str, timeout: float,
    fb_backend: str = "", fb_model: str = "",
) -> str:
    """Try the primary backend; on any failure, fall back to fb_backend if set.

    Used for roles migrated to the on-device ``apple`` backend so a model that is
    unavailable (Apple Intelligence off, service down) degrades to the prior cloud
    backend instead of losing the result. Re-raises if no fallback is configured.
    """
    try:
        return _chat_by_backend(backend, model, prompt, timeout)
    except Exception:
        if fb_backend:
            return _chat_by_backend(fb_backend, fb_model or model, prompt, timeout)
        raise


# ---------------------------------------------------------------------------
# Shared LLM circuit breaker
# ---------------------------------------------------------------------------
# All helper LLM calls in this process share one breaker: the write-path
# helpers here (tagging, importance, HyDE, query augmentation) and
# consolidation's _llm_call. They all hit the same chat backend, so its health
# is a single fact. When the backend is unhealthy, opening the breaker lets
# every caller skip its (often multi-second) timeout -- and any retry backoff --
# and degrade to its fail-safe default immediately, instead of each remember()
# serially paying the full timeout. Before this, only consolidation was
# protected; writes were not.

_LLM_CIRCUIT_THRESHOLD = 8        # consecutive failures before opening
_LLM_CIRCUIT_COOLDOWN_S = 1800.0  # 30 minutes; auto-closes after this


class _CircuitOpenError(Exception):
    """Raised by _chat_guarded when the shared LLM breaker is open. Callers
    already convert exceptions to fail-safe defaults, so this degrades the same
    way a backend error would -- but without the round-trip or the backoff."""


class _CircuitBreaker:
    """Thread-safe breaker. The vec-server is a ThreadingHTTPServer, so
    concurrent remember() calls touch this state from multiple threads."""

    def __init__(self, threshold: int, cooldown_s: float) -> None:
        self._threshold = threshold
        self._cooldown_s = cooldown_s
        self._consecutive = 0
        self._open_until = 0.0
        self._lock = threading.Lock()

    def is_open(self) -> bool:
        with self._lock:
            return bool(self._open_until and time.time() < self._open_until)

    def record_success(self) -> None:
        with self._lock:
            self._consecutive = 0
            self._open_until = 0.0

    def record_failure(self) -> None:
        with self._lock:
            self._consecutive += 1
            if self._consecutive >= self._threshold:
                self._open_until = time.time() + self._cooldown_s
                self._consecutive = 0


_llm_circuit = _CircuitBreaker(_LLM_CIRCUIT_THRESHOLD, _LLM_CIRCUIT_COOLDOWN_S)


def _chat_guarded(
    backend: str, model: str, prompt: str, timeout: float,
    fb_backend: str = "", fb_model: str = "",
) -> str:
    """_chat_with_fallback wrapped by the shared breaker. Raises
    _CircuitOpenError immediately when the breaker is open; otherwise records
    the call's success/failure to drive it. A fallback that succeeds counts as
    success -- the breaker tracks logical-call health, not per-backend."""
    if _llm_circuit.is_open():
        raise _CircuitOpenError
    try:
        result = _chat_with_fallback(backend, model, prompt, timeout, fb_backend, fb_model)
    except Exception:
        _llm_circuit.record_failure()
        raise
    _llm_circuit.record_success()
    return result


COLLECTIONS = (
    "user_profile", "knowledge", "news", "agent_memories",
    "episodic_journal", "archive", "task_memory", "procedural",
)
DEFAULT_DEDUP_THRESHOLD = 0.92
# Bumped from 0.85 to 0.95 (2026-05-02): the prior value was so aggressive
# that genuinely distinct facts about Alex's tech stack hit dedup against
# unrelated existing entries. Confirmed via diagnostic: posting "Alex uses
# fastify v5 ..." merged into an existing "Alex is developing intent.py /
# learning.py / agent.py" row. 0.95 keeps near-verbatim duplicates filtered
# while letting semantically-distinct novel facts through. Consolidation
# (DEFAULT_DEDUP_THRESHOLD=0.92) remains the second-pass safety net.
DEDUP_ON_WRITE_THRESHOLD = 0.95

# Confidence by source prefix: explicit user input=1.0, extracted=0.75, ingested=0.3-0.5
_SOURCE_CONFIDENCE: dict[str, float] = {
    "cli": 1.0,
    "tui": 1.0,
    "agent": 1.0,
    "manual": 1.0,
    # jarvis#818: a memory correction is user-driven (the principal said "no, actually..."),
    # so the replacement fact is authoritative -- not the 0.5 default it used to fall through to.
    "memory_correction": 1.0,
    "learning": 0.75,
    "reflection": 0.75,
    "triage_correction": 0.75,
    # jarvis#818: cascade facts re-encoded around a correction are LLM-inferred (like learning).
    "correction_deep_encode": 0.75,
    "consolidation": 0.75,
    "dedup_merge": 0.75,
    "mail": 0.5,
    "journal": 0.5,
    "claude-code": 0.5,
    "browser": 0.3,
    "ingest": 0.3,
    "archived": 0.3,
}

_QUOTED_RE = re.compile(r'"[^"]{3,}"')

# Module-level lazy cache for the cross-encoder model (avoids re-loading on every call)
_CROSS_ENCODER: object | None = None

_STOPWORDS = frozenset({
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
    "is", "are", "was", "were", "be", "been", "have", "has", "had", "do",
    "does", "did", "will", "would", "could", "should", "may", "might",
    "can", "it", "this", "that", "with", "from", "by", "of", "about",
    "its", "their", "not", "as", "if", "when", "than", "then", "so",
})

# One-time logging flag for tag generation failures (per process)
_TAG_GEN_FAIL_LOGGED = False

# One-time logging flag for HyDE failures (per process). HyDE is fail-silent by
# design and is NEVER disabled by a failure -- _hyde_query retries on every recall
# and the shared circuit breaker backs off only after repeated failures, then
# auto-recovers. This flag gates the warn() to once per process so a persistent
# cause (e.g. missing OPENROUTER_API_KEY) is visible without per-recall spam.
_HYDE_FAIL_LOGGED = False


def _keyword_tokens(text: str) -> list[str]:
    """Tokenize text into keyword tags for the tag-match fast path.

    Lowercase, strip each token down to its alphanumeric characters, and keep
    tokens longer than 3 chars that are not stopwords. Used by BOTH write-time
    tag extraction (_extract_keywords) and the query-time tag_match path so a
    version number or hardware id ('python3.11' -> 'python311', 'm1pro') is
    tagged and matched consistently, instead of being silently dropped by an
    all-alpha (str.isalpha) filter on one side but kept on the other (#859).
    """
    out: list[str] = []
    for raw in text.lower().split():
        w = "".join(ch for ch in raw if ch.isalnum())
        if len(w) > 3 and w not in _STOPWORDS:
            out.append(w)
    return out


def _extract_keywords(text: str, max_keywords: int = 10) -> str:
    """Extract meaningful keywords from text by stripping stopwords and short tokens.

    Returns a space-separated string of up to max_keywords unique lowercase tokens.
    No LLM call -- pure string processing for low-latency write-time use.
    """
    seen: set[str] = set()
    unique = [w for w in _keyword_tokens(text) if not (w in seen or seen.add(w))]  # type: ignore[func-returns-value]
    return " ".join(unique[:max_keywords])


def _fts_or_query(query: str, max_terms: int = 8) -> str:
    """Build an FTS5 OR-query from a natural-language query's significant terms.

    Strips quotes, stopwords, and 1-char tokens, then OR-joins the survivors as
    quoted FTS5 phrases. This is what lets an unquoted entity/name query like
    "who is Brandon my manager" become `"Brandon" OR "manager"` and match via bm25
    ranking. 2-char tokens are kept (jarvis#808) so short names/initials like
    "Jo", "Bo", "AJ" survive -- non-name 2-char noise is handled by the stopword
    set. Returns '' when no significant term survives, so the caller can skip FTS.
    """
    cleaned = query.replace('"', " ")
    terms: list[str] = []
    seen: set[str] = set()
    for raw in cleaned.split():
        w = "".join(ch for ch in raw if ch.isalnum())
        if len(w) < 2:
            continue
        lw = w.lower()
        if lw in _STOPWORDS or lw in seen:
            continue
        seen.add(lw)
        terms.append(f'"{w}"')
        if len(terms) >= max_terms:
            break
    return " OR ".join(terms)


def _content_token_set(text: str) -> set[str]:
    """Lowercased content-word token set for lexical-duplicate comparison.

    Drops stopwords, short tokens, and non-alphabetic fragments (timestamps,
    phone numbers, punctuation) so two phrasings of the same fact compare cleanly
    via Jaccard overlap. Used only by lexical-duplicate detection, never recall.
    """
    return {
        w
        for w in ("".join(ch for ch in raw if ch.isalpha()).lower() for raw in text.split())
        if len(w) > 3 and w not in _STOPWORDS
    }


def _confidence_for_source(source: str) -> float:
    """Map a source string to its initial confidence score."""
    for prefix, confidence in _SOURCE_CONFIDENCE.items():
        if source.startswith(prefix):
            return confidence
    return 0.5


# Source reliability (jarvis#806). Distinct from confidence: confidence decays with
# age (a freshness signal); trust is static source reliability. Was dead -- 1.0 on
# every row. Now derived from source so user-stated facts outrank inferred/ingested
# ones in recall, and the column carries a real signal.
_SOURCE_TRUST: dict[str, float] = {
    "cli": 1.0, "tui": 1.0, "agent": 1.0, "manual": 1.0, "explicit": 1.0,
    # jarvis#818: a user correction is authoritative; its cascade is inferred (like learning).
    "memory_correction": 1.0,
    "learning": 0.7, "reflection": 0.7, "triage_correction": 0.7,
    "correction_deep_encode": 0.7,
    "consolidation": 0.7, "dedup_merge": 0.7,
    "mail": 0.6, "journal": 0.6, "claude-code": 0.6,
    "browser": 0.4, "ingest": 0.4, "archived": 0.4, "feed": 0.4,
}


def _trust_for_source(source: str) -> float:
    """Map a source string to its static trust (source reliability) score."""
    for prefix, trust in _SOURCE_TRUST.items():
        if source.startswith(prefix):
            return trust
    return 0.6


def _should_use_fts(query: str) -> bool:
    """Return True if the query contains quoted strings, suggesting exact/factual recall."""
    return bool(_QUOTED_RE.search(query))


def _rerank_enabled() -> bool:
    """Check whether cross-encoder reranking is enabled in models.yaml."""
    try:
        return bool(_load_models_config().get("rerank_enabled", False))
    except Exception:
        return False


def _recency_boost_enabled() -> bool:
    """Check whether recency boost is enabled by default in models.yaml."""
    try:
        return bool(_load_models_config().get("recency_boost_enabled", False))
    except Exception:
        return False


def _importance_boost_factor() -> float:
    """Multiplicative importance-boost factor from models.yaml (default 0.3).

    An entry with importance 10 gets score * (1 + factor); importance 0 gets
    score * 1.0. Kept configurable for tuning recall ranking without a code
    change. Falls back to 0.3 on any error or missing key.
    """
    try:
        return float(_load_models_config().get("importance_boost_factor", 0.3))
    except Exception:
        return 0.3


def _hyde_enabled() -> bool:
    """Check whether HyDE retrieval is enabled in models.yaml."""
    try:
        return bool(_load_models_config().get("hyde_enabled", False))
    except Exception:
        return False


def _query_augmentation_enabled() -> bool:
    """Check whether write-time query augmentation is enabled in models.yaml."""
    try:
        return bool(_load_models_config().get("query_augmentation_enabled", False))
    except Exception:
        return False


def _rerank_results(
    query: str, candidates: list[tuple[str, str]], threshold: float = 0.5
) -> list[tuple[str, str]]:
    """Cross-encoder rerank. Falls back to original order if sentence-transformers unavailable."""
    global _CROSS_ENCODER
    try:
        if _CROSS_ENCODER is None:
            from sentence_transformers import CrossEncoder  # type: ignore[import-not-found]
            _CROSS_ENCODER = CrossEncoder("cross-encoder/ms-marco-MiniLM-L6-v2")
        pairs = [[query, text] for _, text in candidates]
        scores = _CROSS_ENCODER.predict(pairs)  # type: ignore[union-attr]
        scored = sorted(zip(candidates, scores), key=lambda x: float(x[1]), reverse=True)
        return [pair for pair, score in scored if float(score) >= threshold]
    except Exception:
        return candidates


@dataclass
class MemoryEntry:
    """A single stored memory with the metadata needed for audit/purge."""

    id: str
    text: str
    source: str
    stored_at: str
    metadata: dict

# Recalled memories are injected verbatim into every system prompt. Cap the
# size of any single entry so a /remember can't paste a multi-page adversarial
# instruction block that then permanently contaminates future prompts.
MAX_MEMORY_CHARS = 1500

# Self-identity statements about the agent ("you are a Claude Code session", "you
# are the Mini", "you are an ion engine session", ...). These are usually the
# principal correcting Jarvis mid-conversation. Storing one is a feedback loop:
# it is recalled and re-injected into Jarvis's own prompt every turn, re-priming
# the exact identity break it was meant to fix. This is the universal write
# chokepoint -- every path crosses it (learning extractor, Reflection Analyst
# curl, /learn, journal ingestion) -- so the guard lives here, not only in the TS
# learning layer. Mirrors looksLikeAgentIdentityClaim() in
# harness-ts/src/memory/sanitize.ts. Match NARROWLY on agent-identity framing,
# NOT every "Claude Code" mention -- episodic_journal legitimately records dev
# work where "Claude Code" is a real subject ("fixed the Claude Code bug").
_AGENT_IDENTITY_PATTERNS = [
    re.compile(
        r"\b(?:you|i|jarvis)\s*(?:'?re|'?m|\s+am|\s+are|\s+is)?\s+"
        r"(?:not\s+)?(?:a |an |the )?(?:claude|clause)\s*code\b",
        re.I,
    ),
    re.compile(r"\b(?:claude|clause)\s*code\s+(?:cli\s+)?session\b", re.I),
    re.compile(r"\byou'?(?:re|\s+are)\s+(?:the\s+|a\s+)?(?:mac\s+)?mini\b", re.I),
    re.compile(
        r"\byou\s+are\s+(?:running|operating)\s+(?:on|as)\s+"
        r"(?:a |an |the )?(?:mac\s+mini|ion|claude)\b",
        re.I,
    ),
    re.compile(r"\byou\s+are\s+(?:a |an |the )?ion\b", re.I),
    re.compile(
        r"\byou\s+are\s+(?:a |an |the )?[\w\s]*session\s+on\s+the\s+"
        r"(?:mac\s+mini|mini)\b",
        re.I,
    ),
]


def _looks_like_agent_identity_claim(text: str) -> bool:
    """True when ``text`` is a self-identity statement about the agent (see above).

    Such "facts" are never legitimate to persist; the write path refuses them.
    """
    return any(p.search(text) for p in _AGENT_IDENTITY_PATTERNS)

# Cap recall query length before embedding (jarvis#805). nomic-embed-text's context
# is ~2048 tokens; an over-long query (e.g. a pasted document used verbatim as the
# before_prompt recall query) makes Ollama return 400 "input length exceeds the
# context length", which surfaced as instant vec-server 500s on every-turn
# user_profile recall. 4000 chars (~1000-1300 tokens) keeps the query's leading
# intent while staying well under the embedder's limit.
MAX_QUERY_CHARS = 4000

# Ephemeral ingestion sources get an explicit TTL so they expire (jarvis#809).
# After jarvis#822 untagged entries are durable, so high-volume read-rarely sources
# (browser history, news feeds) would otherwise accumulate forever -- safari was
# 716 entries at 9% recall. Tagging them with a TTL routes them through the
# consolidation TTL prune. Durable sources (learning, manual, user_profile) stay
# untagged and permanent.
EPHEMERAL_SOURCE_PREFIXES = ("browser", "feed")
EPHEMERAL_TTL_DAYS = 30


def _data_dir() -> Path:
    raw = os.environ.get("AGENT_DATA_DIR", "~/.jarvis")
    return Path(raw).expanduser()


class VectorStore:
    """Thin wrapper around ChromaDB for semantic memory storage and retrieval."""

    def __init__(self) -> None:
        chroma_dir = _data_dir() / "chroma"
        chroma_dir.mkdir(parents=True, exist_ok=True)

        # W6: point at the dedicated embed instance when OLLAMA_EMBED_HOST is set.
        # Timeout is 300s as a belt-and-suspenders fallback; with process isolation
        # the embed model is always resident and this should never trigger.
        self._ef = OllamaEmbeddingFunction(
            model_name="nomic-embed-text",
            url=_resolve_embed_host(),
            timeout=300,
        )

        self._client = chromadb.PersistentClient(path=str(chroma_dir))
        # Per-collection write lock: prevents two concurrent remember() calls
        # from both passing _find_near_duplicate before either write lands in
        # ChromaDB, which would produce duplicate entries.
        self._write_locks: dict[str, threading.Lock] = {}
        self._write_locks_lock = threading.Lock()
        self._cols: dict[str, chromadb.Collection] = {}
        for name in COLLECTIONS:
            col = self._client.get_or_create_collection(
                name,
                embedding_function=self._ef,  # type: ignore[arg-type]
            )
            # ChromaDB warns and sets the EF to None when it can't reconstruct
            # the stored config on restart (e.g. [Errno 24] Too many open files,
            # or Ollama not yet running). Re-inject so query_texts always works.
            if not getattr(col, "_embedding_function", None):
                col._embedding_function = self._ef  # type: ignore[attr-defined]
            self._cols[name] = col

    def remember(
        self,
        text: str,
        collection: str = "knowledge",
        metadata: dict | None = None,
        source: str = "manual",
        defer_tags: bool = False,
        source_actor: str = "jarvis_inference",
        ttl_days: int | None = None,
        goal_id: str | None = None,
    ) -> str:
        """Store a piece of text and return its ID.

        Length is capped (see MAX_MEMORY_CHARS) and every entry is tagged with
        a source and timestamp so entries can be audited or purged later.

        Dedup-on-write: if a near-duplicate (cosine >= DEDUP_ON_WRITE_THRESHOLD,
        currently 0.95) already exists, bumps its access count and returns the
        existing ID without inserting.

        When ``defer_tags=True``, tag generation via the LLM tagger is skipped.
        The entry is written without tags so the caller can respond immediately
        and schedule a background backfill. This avoids blocking the HTTP
        response on a potentially slow Ollama model swap.

        ``source_actor`` records which pipeline stage produced this memory:
        ``'user'`` for explicit /learn commands, ``'jarvis_inference'`` for LLM-extracted
        facts, ``'reflection'`` for reflection-panel facts, etc.

        ``ttl_days`` (optional): when set, this entry will expire and be pruned after
        ttl_days have elapsed since stored_at. Used for ephemeral sources like RSS feeds.
        """
        text = text.strip()
        if not text:
            raise ValueError("Cannot remember empty text.")
        if len(text) > MAX_MEMORY_CHARS:
            raise ValueError(
                f"Memory entry too long ({len(text)} chars; max {MAX_MEMORY_CHARS}). "
                "Memories are injected into every future system prompt -- keep them tight."
            )
        if _looks_like_agent_identity_claim(text):
            raise ValueError(
                "Refused: self-identity claim about the agent (e.g. 'you are a "
                "Claude Code session', 'you are the Mini'). Storing it would re-inject "
                "that framing into every future prompt. This is not a fact about the principal."
            )

        # Serialize writes per collection so concurrent remember() calls don't
        # both pass _find_near_duplicate before either write is queryable.
        with self._write_locks_lock:
            if collection not in self._write_locks:
                self._write_locks[collection] = threading.Lock()
        with self._write_locks[collection]:
            return self._remember_locked(
                text, collection, metadata, source, defer_tags, source_actor, ttl_days,
                goal_id=goal_id,
            )

    def _remember_locked(
        self,
        text: str,
        collection: str,
        metadata: dict | None,
        source: str,
        defer_tags: bool,
        source_actor: str = "jarvis_inference",
        ttl_days: int | None = None,
        goal_id: str | None = None,
    ) -> str:
        # Dedup-on-write: return existing ID if near-duplicate found
        existing_id = self._find_near_duplicate(text, collection)
        if existing_id:
            try:
                from harness.memory import episodic
                episodic.bump_access(existing_id)
            except Exception:
                pass
            return existing_id

        tags: list[str] = [] if defer_tags else self._generate_tags(text)
        # Importance scoring: skipped during bulk ingestion (defer_tags=True) to avoid
        # rate-limiting Ollama. Neutral default (5) is used on failure or when skipped.
        importance: int = 5 if defer_tags else self._rate_importance(text)
        trust = _trust_for_source(source)
        # jarvis#809: auto-tag ephemeral sources with a TTL so they expire. Durable
        # sources (learning/manual/...) keep ttl_days=None and persist (jarvis#822).
        if ttl_days is None and source.startswith(EPHEMERAL_SOURCE_PREFIXES):
            ttl_days = EPHEMERAL_TTL_DAYS
        # Prefer caller-provided stored_at (preserves original extraction timestamp);
        # generate a server-side value only when the caller omits it.
        caller_stored_at = metadata.get("stored_at") if metadata else None
        meta: dict = {
            "source": source,
            "stored_at": caller_stored_at if caller_stored_at else datetime.now(UTC).isoformat(),
            "importance": importance,
            "trust": trust,  # jarvis#806: in chroma meta so recall ranking can use it
        }
        if tags:
            meta["tags"] = json.dumps(tags)
        if goal_id is not None:
            meta["goal_id"] = goal_id
        if metadata:
            meta.update({k: v for k, v in metadata.items() if k != "stored_at"})

        doc_id = str(uuid.uuid4())
        if _query_augmentation_enabled():
            augmented = self._augment_with_queries(text)
            aug_vec = self._ef([augmented])[0]
            self._cols[collection].add(
                documents=[text],
                embeddings=[aug_vec],
                metadatas=[meta],
                ids=[doc_id],
            )
        else:
            self._cols[collection].add(
                documents=[text],
                metadatas=[meta],
                ids=[doc_id],
            )

        # Write provenance + FTS (fail-silent so ChromaDB write always wins)
        try:
            from harness.memory import episodic
            episodic.init_db()
            keywords = _extract_keywords(text)
            episodic.upsert_memory_meta(
                doc_id,
                confidence=_confidence_for_source(source),
                trust_score=trust,
                source=source,
                collection=collection,
                tags=tags,
                source_actor=source_actor,
                keywords=keywords,
                created_at=meta.get("received_at"),
                ttl_days=ttl_days,
            )
            episodic.index_memory(doc_id, collection, text)
        except Exception as _e:
            import logging as _log
            # jarvis#811c: this was logged at debug -- the silence is why the FTS
            # index drifted to ~50% coverage unnoticed. Warn + emit a counter so
            # the recall/FTS write path is observable.
            _log.getLogger(__name__).warning(
                "Failed to write provenance/FTS for %s in %s: %s", doc_id, collection, _e
            )
            try:
                episodic.log_event(
                    "embed_write_failure",
                    {"doc_id": doc_id, "collection": collection, "error": str(_e)},
                    session="vec-server",
                )
            except Exception:
                pass

        return doc_id

    def _find_near_duplicate(self, text: str, collection: str) -> str | None:
        """Return ID of nearest entry with cosine >= DEDUP_ON_WRITE_THRESHOLD, else None.

        Checks top-3 neighbors (vs find_similar's top-1) to catch cases where the
        closest match is slightly below threshold but the second match is above it.
        """
        col = self._cols[collection]
        if col.count() == 0:
            return None
        results = col.query(query_texts=[text], n_results=min(3, col.count()))
        ids = results.get("ids") or [[]]
        distances = results.get("distances") or [[]]
        if not ids[0]:
            return None
        for doc_id, d in zip(ids[0], distances[0]):
            cosine_sim = 1 - (d * d) / 2
            if cosine_sim >= DEDUP_ON_WRITE_THRESHOLD:
                return doc_id
        # Lexical complement: an identically-worded fact the embedder happens to
        # rank below threshold must still not enter as a fresh duplicate. FTS
        # surfaces candidates; a strict token-overlap gate confirms before we
        # treat one as a dup (never on FTS keyword match alone).
        lex_dups = self.find_lexical_duplicates(text, collection)
        if lex_dups:
            return lex_dups[0][0]
        return None

    def find_lexical_duplicates(
        self,
        text: str,
        collection: str,
        min_overlap: float = 0.85,
        exclude_id: str | None = None,
        limit: int = 5,
    ) -> list[tuple[str, str]]:
        """Surface near-exact LEXICAL duplicates of ``text`` via FTS, each confirmed
        by a strict Jaccard token-overlap test (>= min_overlap).

        Complements vector dedup, which can rank identically-worded facts far apart.
        The Jaccard gate is what makes this safe: a match is never returned on FTS
        keyword overlap alone, so two distinct facts that merely share keywords are
        not treated as duplicates. Superseded entries are excluded. Returns
        (chroma_id, text) pairs, best-effort (``[]`` on any failure).
        """
        try:
            from harness.memory import episodic
            fts_query = _fts_or_query(text)
            target = _content_token_set(text)
            if not fts_query or not target:
                return []
            hits = episodic.fts_search(fts_query, collection=collection, limit=limit + 1)
            superseded = episodic.superseded_ids(collection=collection)
            out: list[tuple[str, str]] = []
            for h in hits:
                cid = h["chroma_id"]
                if cid == exclude_id or cid in superseded:
                    continue
                cand = _content_token_set(h["content"])
                if not cand:
                    continue
                jaccard = len(target & cand) / len(target | cand)
                if jaccard >= min_overlap:
                    out.append((cid, h["content"]))
            return out
        except Exception:
            return []

    def _generate_tags(self, text: str, max_attempts: int = 4) -> list[str]:
        """Generate 3-5 keyword tags via the tagger model. Returns [] on any failure.

        Timeout is read from models.yaml tagger.timeout (default 30s). The
        previous hardcoded 5s caused 100% timeouts when gemma3:27b monopolized
        the GPU. Tags are optional enrichment; degrading to no tags is the right
        policy when Ollama is contended, but the timeout should accommodate model
        swap latency on a shared GPU.

        ``max_attempts`` controls the total number of tries (first attempt plus
        retries). Callers running in a background backfill thread should pass
        ``max_attempts=1`` to skip retries entirely -- tagging is best-effort and
        holding a semaphore slot through exponential backoff under load starves
        other queued backfills.

        On timeout or other transient failures, retries (when max_attempts > 1)
        with exponential backoff (2s, 4s, 8s). Logs all failures to agent_events
        for observability.
        """
        import logging as _log
        import time as _time

        logger = _log.getLogger(__name__)

        tagger_cfg = _load_models_config().get("tagger", {})
        model = tagger_cfg.get("model", "llama3.1:8b")
        backend = tagger_cfg.get("backend", "ollama")
        timeout = int(tagger_cfg.get("timeout", 30))
        fb_backend = tagger_cfg.get("fallback_backend", "")
        fb_model = tagger_cfg.get("fallback_model", "")

        last_exc: Exception | None = None
        for attempt in range(max(1, max_attempts)):
            try:
                prompt = (
                    "List 3-5 keyword tags for this text. "
                    "Reply with comma-separated words only, no explanation:\n\n"
                    + text[:500]
                )
                raw = _chat_guarded(backend, model, prompt, timeout, fb_backend, fb_model)
                return [t.strip().lower() for t in raw.split(",") if t.strip()][:5]
            except _CircuitOpenError as exc:
                # Backend is known-unhealthy: don't sleep/retry, degrade to [] now.
                last_exc = exc
                break
            except Exception as exc:
                last_exc = exc
                if attempt < max_attempts - 1:
                    _time.sleep(min(2 ** (attempt + 1), 8))
                    continue

        # Log once per process to avoid spam in logs
        global _TAG_GEN_FAIL_LOGGED
        if not _TAG_GEN_FAIL_LOGGED:
            logger.warning("tag generation failed: %s", last_exc)
            _TAG_GEN_FAIL_LOGGED = True

        # Record event for observability (fail-silent)
        try:
            from harness.memory import episodic

            event_detail = {
                "text_prefix": text[:80],
                "backend": backend,
                "model": model,
                "timeout_s": timeout,
                "error": str(last_exc),
            }
            episodic.log_event(
                "tag_generation_timeout",
                event_detail,
                session="vec-server",
            )
        except Exception:
            pass
        return []

    def _rate_importance(self, text: str) -> int:
        """Rate the importance of a fact on a 1-10 scale.

        Returns the parsed integer. On any error (model unavailable, timeout,
        parse failure) returns 5 as a neutral default so writes always succeed.
        Backend is read from models.yaml importance.backend (default: ollama).
        """
        importance_cfg = _load_models_config().get("importance", {})
        model = importance_cfg.get("model", "qwen2.5:14b")
        backend = importance_cfg.get("backend", "ollama")
        timeout = int(importance_cfg.get("timeout", 15))
        try:
            prompt = (
                "Rate the importance of this fact to the person's life "
                "on a scale of 1-10. Only return the integer. "
                f"Fact: {text[:500]}"
            )
            raw = _chat_guarded(backend, model, prompt, timeout)
            # Extract the first integer from the response (handles "7." or "7\n" etc.)
            match = re.search(r"\b([1-9]|10)\b", raw)
            if match:
                return int(match.group(1))
            return 5
        except Exception:
            return 5

    def _hyde_query(self, query: str) -> str:
        """Generate a hypothetical memory entry phrased like a stored fact.

        Returns empty string on any failure so callers skip HyDE gracefully.
        15s timeout mirrors _generate_tags() -- fast model, fail-silent.
        """
        hyde_cfg = _load_models_config().get("hyde", {})
        model = hyde_cfg.get("model", "llama3.1:8b")
        backend = hyde_cfg.get("backend", "ollama")
        fb_backend = hyde_cfg.get("fallback_backend", "")
        fb_model = hyde_cfg.get("fallback_model", "")
        try:
            prompt = (
                "Write one concise memory entry (single sentence, third-person fact) "
                "that would answer this question. No preamble:\n\n" + query
            )
            return _chat_guarded(backend, model, prompt, 15, fb_backend, fb_model)
        except _CircuitOpenError:
            # Breaker is open after repeated upstream failures; it auto-recovers
            # after the cooldown, so HyDE is only skipped for this turn. Debug-level
            # so a degraded window is traceable without per-recall warn spam.
            import logging as _log
            _log.getLogger(__name__).debug(
                "HyDE skipped this turn: LLM circuit open (auto-retries after cooldown)"
            )
            return ""
        except Exception as exc:
            # Fail-silent for the caller. This failure does NOT disable HyDE:
            # _hyde_query runs again on the next recall, and the shared circuit
            # breaker only backs off after repeated failures (then auto-recovers).
            # Warn once per process to surface a persistent cause (missing key, bad
            # model/backend) without per-recall spam -- the flag gates logging only.
            global _HYDE_FAIL_LOGGED
            if not _HYDE_FAIL_LOGGED:
                import logging as _log
                _log.getLogger(__name__).warning(
                    "HyDE query generation failing (hyde_enabled=true; backend=%s "
                    "model=%s); retried each recall, breaker backs off on repeats: %s",
                    backend, model, exc,
                )
                _HYDE_FAIL_LOGGED = True
            return ""

    def _augment_with_queries(self, text: str) -> str:
        """Prepend anticipated search queries to text for a richer write-time embedding.

        The stored document remains the original text; only the embedding vector
        is computed from the augmented form. Returns original text on any failure.
        10s timeout mirrors _generate_tags() -- fast model, fail-silent.
        """
        tagger_cfg = _load_models_config().get("tagger", {})
        model = tagger_cfg.get("model", "llama3.1:8b")
        backend = tagger_cfg.get("backend", "ollama")
        try:
            prompt = (
                "List 4 short questions someone might ask to retrieve this memory. "
                "One per line, no numbering, no preamble:\n\n" + text[:500]
            )
            queries = _chat_guarded(backend, model, prompt, 10)
            return queries + "\n\n" + text if queries else text
        except Exception:
            return text

    def recall(
        self,
        query: str,
        collection: str = "knowledge",
        n: int = 5,
        min_relevance: float = 0.3,
        where: dict | None = None,
        recency_boost: bool | None = None,
        recency_decay_factor: float = 0.3,
        include_archive: bool = True,
        goal_ids: list[str] | None = None,
    ) -> list[str]:
        """Return semantically similar stored texts for a query.

        Filters out hits with cosine similarity below min_relevance so that
        unrelated memories don't bleed into the results when memory is sparse.
        Pass `where` to restrict results to entries matching a metadata filter
        (e.g. ``{"type": {"$eq": "meeting"}}`` for meeting-only recall).

        recency_boost re-ranks only the VECTOR results by a blend of similarity
        and recency: score = cosine * (1 + recency_decay_factor/sqrt(age_days+1)).
        It does not touch the lexical stages -- the tag_match pre-filter and the
        FTS exact-match first-pass run regardless of recency_boost (recency is a
        vector concern, not a reason to suppress exact matches).

        Hybrid routing: an FTS5 first-pass runs on every query's significant terms
        (see _fts_or_query). A quoted query returns its FTS hits exclusively; an
        unquoted one merges FTS hits ahead of the vector results. Vector search is
        always run as the semantic layer.

        When recency_boost is None (the default), the value is read from
        recency_boost_enabled in models.yaml.

        When goal_ids is provided, results are filtered to entries tagged with
        one of those goal IDs. The tag_match and FTS fast paths are bypassed
        because they cannot apply goal_id filtering.
        Note: legacy entries without a goal_id field are excluded from
        goal-filtered queries (ChromaDB has no $exists filter).
        """
        if len(query) > MAX_QUERY_CHARS:
            query = query[:MAX_QUERY_CHARS]
        if recency_boost is None:
            recency_boost = _recency_boost_enabled()
        # Translate goal_ids into a ChromaDB where filter and merge with any
        # existing where clause.
        effective_where = where
        if goal_ids:
            goal_filter: dict = {"goal_id": {"$in": goal_ids}}
            if where:
                effective_where = {"$and": [where, goal_filter]}
            else:
                effective_where = goal_filter
        # Stage 1: fast metadata pre-filter (SQL only, no embeddings or FTS).
        # Tokenise the query and check if any non-trivial token overlaps with
        # stored tags or keywords. If ≥2 hits come back, skip FTS5/vector entirely
        # and return immediately -- much cheaper for common keyword-overlap queries.
        # Runs regardless of recency_boost: like FTS below, this is a lexical
        # pre-filter, and recency is only a vector re-rank -- it must not suppress
        # exact/keyword matches (the same gate-off bug that once hid FTS under
        # recency_boost=True). Bypassed when a metadata/goal filter is set
        # (tag_match cannot apply those).
        if not effective_where and not goal_ids:
            from harness.memory import episodic as _episodic
            # #859: tokenize the query exactly as write-time tags were produced
            # (_keyword_tokens), so a version/hardware token like 'python3.11'
            # matches the stored 'python311' tag instead of missing it.
            query_tokens = _keyword_tokens(query)
            if query_tokens:
                try:
                    fast_ids = _episodic.tag_match(query_tokens, collection=collection, limit=n)
                    if len(fast_ids) >= 2:
                        result = self._cols[collection].get(ids=fast_ids, include=["documents"])
                        docs: list[str] = result.get("documents") or []
                        if docs:
                            return docs[:n]
                except Exception:
                    pass  # fail-silent; fall through to FTS5/vector
        # FTS exact/lexical first-pass. Runs regardless of recency_boost --
        # recency is a vector re-rank, not a reason to suppress exact matches.
        # Previously this whole block was gated on `not recency_boost`, so with
        # recency_boost_enabled=True (the live default) FTS never ran and every
        # query fell to vector-only -- which returns near-random results for
        # short entity/name queries (e.g. "Brandon" -> "NVDA reports Tuesday").
        # Bypassed only when metadata/goal filters are set (FTS can't apply them).
        fts_hits: list[str] = []
        if not effective_where and not goal_ids:
            fts_hits = self._fts_recall(
                query, collection=collection, n=n, include_archive=include_archive,
            )
            # A quoted query signals exact-match intent: return FTS hits alone.
            if fts_hits and _should_use_fts(query):
                return fts_hits[:n]
        pairs = self.recall_with_ids(
            query, collection=collection, n=n, min_relevance=min_relevance,
            where=effective_where,
            recency_boost=recency_boost, recency_decay_factor=recency_decay_factor,
            include_archive=include_archive,
            goal_ids=goal_ids,
        )
        if _hyde_enabled():
            hypo = self._hyde_query(query)
            if hypo:
                hypo_pairs = self.recall_with_ids(
                    hypo, collection=collection, n=n, min_relevance=min_relevance,
                    where=effective_where, recency_boost=recency_boost,
                    recency_decay_factor=recency_decay_factor,
                    include_archive=include_archive,
                    goal_ids=goal_ids,
                )
                seen = {eid for eid, _ in pairs}
                extras = [(eid, text) for eid, text in hypo_pairs if eid not in seen]
                pairs = (pairs + extras)[:n]
        vec_docs = [text for _, text in pairs]
        # Merge exact FTS hits ahead of semantic vector hits (dedup, cap n) so
        # lexical matches surface for unquoted natural-language queries without
        # losing semantic recall. FTS-empty queries return pure vector results.
        if fts_hits:
            merged: list[str] = []
            seen_docs: set[str] = set()
            for doc in fts_hits + vec_docs:
                if doc not in seen_docs:
                    seen_docs.add(doc)
                    merged.append(doc)
            return merged[:n]
        return vec_docs

    def _fts_recall(
        self,
        query: str,
        collection: str,
        n: int,
        include_archive: bool = True,
    ) -> list[str]:
        """Run FTS5 search. Returns [] on any failure (graceful degradation).

        When include_archive is True and the primary collection returns fewer
        than n hits, top up from the archive collection with results prefixed
        by ``[archive] `` so downstream callers can label long-term hits.
        """
        try:
            from harness.memory import episodic
            # OR-join significant terms (drops stopwords/short tokens) so
            # natural-language entity queries match. Implicit-AND of every token
            # -- the old behavior -- meant "who is Brandon my manager" required a
            # doc containing all five words and silently returned nothing.
            fts_query = _fts_or_query(query)
            if not fts_query:
                return []
            hits = episodic.fts_search(fts_query, collection=collection, limit=n)
            superseded = episodic.superseded_ids(collection=collection)
            results = [h["content"] for h in hits if h["chroma_id"] not in superseded]
            if include_archive and collection != "archive" and len(results) < n:
                remaining = n - len(results)
                archive_hits = episodic.fts_search(
                    fts_query, collection="archive", limit=remaining,
                )
                results.extend(f"[archive] {h['content']}" for h in archive_hits[:remaining])
            return results
        except Exception:
            return []

    def recall_with_ids(
        self,
        query: str,
        collection: str = "knowledge",
        n: int = 5,
        min_relevance: float = 0.3,
        where: dict | None = None,
        recency_boost: bool | None = None,
        recency_decay_factor: float = 0.3,
        include_archive: bool = True,
        goal_ids: list[str] | None = None,
    ) -> list[tuple[str, str]]:
        """Like recall() but returns (doc_id, text) pairs.

        Superseded entries (confidence-decayed) are excluded. Hits bump
        access_count in memories_meta. Optional cross-encoder rerank applies
        when rerank_enabled=true in models.yaml.

        When recency_boost=True, final_score = cosine * (1 + decay_factor/sqrt(age+1))
        where decay_factor defaults to 0.3 (pass via recency_decay_factor). Entries with
        missing stored_at metadata get a neutral multiplier of 1.0.

        Importance scoring is always applied: entries with a higher stored
        importance value (1-10) receive a multiplicative boost of up to 1.3x.
        Formula: score = cosine * (1 + factor * importance / 10) * recency_multiplier,
        where factor is importance_boost_factor in models.yaml (default 0.3).

        Used by consolidation to track which entries were recalled and build
        deduplication clusters.

        When recency_boost is None (the default), the value is read from
        recency_boost_enabled in models.yaml.

        When goal_ids is provided, results are filtered to entries tagged with
        one of those goal IDs. Legacy entries without goal_id are excluded.
        """
        if len(query) > MAX_QUERY_CHARS:
            query = query[:MAX_QUERY_CHARS]
        if recency_boost is None:
            recency_boost = _recency_boost_enabled()
        # Translate goal_ids into a where filter if not already resolved by caller.
        effective_where = where
        if goal_ids:
            goal_filter: dict = {"goal_id": {"$in": goal_ids}}
            if where:
                effective_where = {"$and": [where, goal_filter]}
            else:
                effective_where = goal_filter
        count = self._cols[collection].count()
        # When the primary collection is empty we still want to fall through to
        # the archive fallback below so long-term memory remains reachable.
        pairs: list[tuple[str, str]] = []
        result_ids: list[str] = []
        distances: list[float] = []
        # Chroma returns list[Metadata] (TypedDict); keep this loose to absorb that.
        metadatas: list = []
        if count > 0:
            # Fetch extra candidates so rerank has a pool to work from
            fetch_n = min(n * 4 if _rerank_enabled() else n, count)
            # Always include metadatas: needed for importance scoring (always-on)
            # and recency boost. Cost is negligible vs embedding query.
            includes = ["documents", "distances", "metadatas"]
            query_kwargs: dict = {
                "query_texts": [query],
                "n_results": fetch_n,
                "include": includes,
            }
            if effective_where:
                query_kwargs["where"] = effective_where
            _recall_start = time.monotonic()
            try:
                results = self._cols[collection].query(**query_kwargs)
            except Exception as exc:
                import logging
                logging.getLogger(__name__).warning(
                    "recall failed for collection=%s: %s; falling back to archive.",
                    collection,
                    exc,
                    exc_info=True,
                )
                results = None
            finally:
                try:
                    from harness.memory import episodic as _ep
                    _ep.record_perf(
                        "recall",
                        (time.monotonic() - _recall_start) * 1000,
                        metadata={"collection": collection},
                    )
                except Exception:
                    pass
            if results is not None:
                docs = results["documents"][0] if results["documents"] else []
                raw_distances = results.get("distances") or [[]]
                distances = raw_distances[0]
                raw_ids = results.get("ids") or [[]]
                result_ids = raw_ids[0] if raw_ids else []
                raw_metas = results.get("metadatas") or [[]]
                metadatas = raw_metas[0] if raw_metas else []
                if not distances:
                    pairs = [(eid, doc) for eid, doc in zip(result_ids, docs)]
                else:
                    pairs = [
                        (eid, doc)
                        for eid, doc, d in zip(result_ids, docs, distances)
                        if (1 - (d ** 2) / 2) >= min_relevance
                    ]
        # Filter entries superseded by confidence decay
        try:
            from harness.memory import episodic as _ep
            _superseded = _ep.superseded_ids(collection=collection)
            pairs = [(eid, doc) for eid, doc in pairs if eid not in _superseded]
        except Exception:
            pass
        # Combined scoring: importance boost (always-on) + optional recency boost.
        # importance_boost = 1 + 0.3 * importance / 10  (1.0 at importance=0, 1.3 at importance=10)
        # recency_multiplier = 1.0 + decay_factor / sqrt(age_days + 1)  when recency_boost=True
        # final_score = cosine * importance_boost * recency_multiplier
        if pairs:
            from datetime import UTC
            from datetime import datetime as _dt

            decay_factor = recency_decay_factor

            def _recency_multiplier(stored_at: str | None) -> float:
                if not stored_at:
                    return 1.0
                try:
                    age = (_dt.now(UTC) - _dt.fromisoformat(stored_at)).total_seconds() / 86400.0
                    return 1.0 + decay_factor * (age + 1) ** -0.5
                except Exception:
                    return 1.0

            meta_by_id = {
                eid: (meta or {})
                for eid, meta in zip(result_ids, metadatas)
            }
            dist_by_id = {
                eid: d
                for eid, d in zip(result_ids, distances)
            }
            scored: list[tuple[float, str, str]] = []
            importance_factor = _importance_boost_factor()
            for eid, doc in pairs:
                d = dist_by_id.get(eid, 1.0)
                cosine = max(0.0, 1 - (d ** 2) / 2)
                meta = meta_by_id.get(eid, {})
                raw_importance = meta.get("importance", 5)
                importance = int(raw_importance) if raw_importance is not None else 5
                importance_boost = 1.0 + importance_factor * importance / 10.0
                # jarvis#806: gentle trust weight so user-stated facts (trust 1.0)
                # outrank inferred/ingested ones (0.4-0.7). Bounded ~0.94-1.15 so it
                # nudges ranking without overriding semantic similarity. Defaults to
                # 1.0 (neutral) for entries written before trust was stored.
                raw_trust = meta.get("trust", 1.0)
                trust = float(raw_trust) if raw_trust is not None else 1.0
                trust_boost = 0.85 + 0.3 * trust
                if recency_boost:
                    raw_stored_at = meta.get("stored_at")
                    stored_at_str = str(raw_stored_at) if raw_stored_at is not None else None
                    recency_mult = _recency_multiplier(stored_at_str)
                else:
                    recency_mult = 1.0
                scored.append((cosine * importance_boost * trust_boost * recency_mult, eid, doc))
            scored.sort(key=lambda x: x[0], reverse=True)
            pairs = [(eid, doc) for _, eid, doc in scored]
        # Optional cross-encoder rerank, then trim to requested n.
        # Not gated on recency_boost: rerank runs after recency scoring and, when
        # enabled, wins (it is the more precise relevance signal). The previous
        # `and not recency_boost` clause silently disabled rerank whenever recency
        # was on -- the same gate-off-another-stage bug as FTS/tag_match. rerank
        # stays off by default via rerank_enabled; this only removes the hidden trap.
        if pairs and _rerank_enabled():
            pairs = _rerank_results(query, pairs)
        pairs = pairs[:n]
        # Archive fallback: when the primary collection has fewer than n hits,
        # top up from long-term memory. Archive entries are prefixed with
        # ``[archive] `` so the prompt pipeline can label them in Jarvis's voice
        # ("If memory serves, sir, ..."). The archive collection holds entries
        # that were decay-archived from knowledge; their memories_meta rows
        # remain with superseded_by='decay', so the superseded filter above
        # does NOT apply here -- the whole point of archive is to surface those.
        if include_archive and collection != "archive" and len(pairs) < n:
            remaining = n - len(pairs)
            archive_hits = self._query_archive(query, n=remaining, min_relevance=min_relevance)
            if archive_hits:
                pairs.extend(
                    (eid, f"[archive] {doc}") for eid, doc in archive_hits[:remaining]
                )
        if pairs:
            try:
                from harness.memory import episodic
                for eid, _ in pairs:
                    episodic.bump_access(eid)
                episodic.log_event(
                    "recall_hit",
                    {
                        "collection": collection,
                        "ids": [eid for eid, _ in pairs],
                        "query": query[:100],
                    },
                    session="recall",
                )
            except Exception:
                pass
        return pairs

    def _query_archive(
        self,
        query: str,
        n: int,
        min_relevance: float,
    ) -> list[tuple[str, str]]:
        """Query the archive collection. Returns (id, text) pairs above min_relevance.

        Does NOT apply the superseded filter -- archived entries are
        deliberately marked superseded by decay; surfacing them here is the
        whole point of long-term recall.
        """
        archive = self._cols["archive"]
        if archive.count() == 0:
            return []
        try:
            results = archive.query(
                query_texts=[query],
                n_results=min(n, archive.count()),
            )
        except Exception as exc:
            import logging
            logging.getLogger(__name__).warning(
                "archive recall failed: %s; returning empty.", exc, exc_info=True,
            )
            return []
        raw_ids = results.get("ids") or [[]]
        raw_docs = results.get("documents") or [[]]
        raw_distances = results.get("distances") or [[]]
        ids = raw_ids[0] if raw_ids else []
        docs = raw_docs[0] if raw_docs else []
        distances = raw_distances[0] if raw_distances else []
        if not distances:
            return [(eid, doc) for eid, doc in zip(ids, docs)]
        return [
            (eid, doc)
            for eid, doc, d in zip(ids, docs, distances)
            if (1 - (d ** 2) / 2) >= min_relevance
        ]

    def forget(self, doc_id: str, collection: str = "knowledge", reason: str = "forgotten") -> None:
        """Delete a stored memory by ID. Also removes from FTS index and marks the
        memories_meta row superseded (jarvis#803) so it can't dangle as 'active' with
        no vector. ``reason`` is recorded unless the row is already superseded."""
        self._cols[collection].delete(ids=[doc_id])
        try:
            from harness.memory import episodic
            episodic.delete_fts_memory(doc_id)
            episodic.mark_superseded_if_unset([doc_id], superseded_by=reason)
        except Exception:
            pass

    def forget_by_ids(
        self, ids: list[str], collection: str = "knowledge", reason: str = "forgotten"
    ) -> int:
        """Delete multiple memories by ID. Returns count deleted (0 if list empty).

        Also removes them from the FTS index and marks their memories_meta rows
        superseded (jarvis#803) so deleting a vector never leaves a dangling 'active'
        row. ``reason`` is recorded unless a row is already superseded."""
        if not ids:
            return 0
        self._cols[collection].delete(ids=ids)
        try:
            from harness.memory import episodic
            for doc_id in ids:
                episodic.delete_fts_memory(doc_id)
            episodic.mark_superseded_if_unset(ids, superseded_by=reason)
        except Exception:
            pass
        return len(ids)

    def forget_by_filter(
        self, collection: str, where: dict, reason: str = "forgotten"
    ) -> int:
        """Delete all entries matching a metadata filter. Returns count deleted.

        Delegates to forget_by_ids so the FTS index is cleaned and memories_meta
        rows are marked superseded (jarvis#803/#839) -- a metadata-filter delete
        must not leave dangling 'active' rows or orphaned FTS entries.
        """
        col = self._cols[collection]
        result = col.get(where=where, include=[])  # type: ignore[list-item]
        ids = result.get("ids") or []
        if not ids:
            return 0
        return self.forget_by_ids(ids, collection, reason)

    def backfill_fts(self, collection: str = "knowledge", limit: int = 500) -> dict[str, int]:
        """Re-index facts that are active in memories_meta but missing from FTS.

        jarvis#836: remember()'s FTS write is fail-silent, so a transient failure
        (SQLite lock, init race) orphans a fact from FTS recall permanently with no
        recovery. This self-heals by pulling each orphaned id's document from
        ChromaDB and re-indexing it -- the work-list is reconstructed from existing
        tables, so no separate retry queue is needed. Returns counts.
        """
        from harness.memory import episodic

        missing = episodic.fts_missing_ids(collection, limit)
        if not missing:
            return {"checked": 0, "reindexed": 0, "failed": 0}
        col = self._cols[collection]
        got = col.get(ids=missing, include=["documents"])  # type: ignore[list-item]
        reindexed = failed = 0
        for cid, doc in zip(got.get("ids") or [], got.get("documents") or []):
            if not doc:
                continue
            try:
                episodic.index_memory(cid, collection, doc)
                reindexed += 1
            except Exception as e:
                failed += 1
                import logging as _log
                _log.getLogger(__name__).warning(
                    "backfill_fts: re-index failed for %s in %s: %s", cid, collection, e
                )
        return {"checked": len(missing), "reindexed": reindexed, "failed": failed}

    def get_embeddings_by_ids(
        self, ids: list[str], collection: str = "knowledge"
    ) -> dict[str, list[float]]:
        """Return embedding vectors keyed by chroma_id for the given IDs.

        Used by archive_to_cold() to persist vectors in Parquet so cold
        recall can use cosine similarity instead of substring matching.
        Missing or None embeddings are silently dropped from the result.
        """
        if not ids:
            return {}
        col = self._cols[collection]
        result = col.get(ids=ids, include=["embeddings"])  # type: ignore[list-item]
        out: dict[str, list[float]] = {}
        for doc_id, emb in zip(result.get("ids") or [], result.get("embeddings") or []):
            if emb is not None:
                out[doc_id] = list(emb)
        return out

    def find_similar(
        self,
        text: str,
        collection: str = "knowledge",
        threshold: float = DEFAULT_DEDUP_THRESHOLD,
    ) -> str | None:
        """Return the ID of an existing entry with cosine similarity >= threshold, else None.

        Used by the learning loop to dedup before inserting an extracted fact.
        ChromaDB returns L2 distances by default; we compute approximate cosine
        from the distance using the relation cosine_sim = 1 - (distance^2 / 2)
        for normalized vectors. nomic-embed-text outputs are normalized.
        """
        col = self._cols[collection]
        if col.count() == 0:
            return None
        results = col.query(query_texts=[text], n_results=1)
        ids = results.get("ids") or [[]]
        distances = results.get("distances") or [[]]
        if not ids[0] or not distances[0]:
            return None
        d = distances[0][0]
        cosine_sim = 1 - (d * d) / 2
        return ids[0][0] if cosine_sim >= threshold else None

    @staticmethod
    def _rows_to_entries(ids, documents, metadatas) -> list[MemoryEntry]:
        """Build MemoryEntry objects from Chroma get() result columns (no sorting)."""
        entries: list[MemoryEntry] = []
        for doc_id, text, meta in zip(ids, documents, metadatas, strict=False):
            meta = meta or {}
            entries.append(
                MemoryEntry(
                    id=doc_id,
                    text=text or "",
                    source=str(meta.get("source", "unknown")),
                    stored_at=str(meta.get("stored_at", "")),
                    metadata=dict(meta),
                )
            )
        return entries

    def list_entries(
        self,
        collection: str = "knowledge",
        limit: int = 20,
        where: dict | None = None,
    ) -> list[MemoryEntry]:
        """List entries, newest first, with optional where filter."""
        col = self._cols[collection]
        # Fetch a larger batch so we can sort by stored_at and return the top N.
        fetch_limit = max(limit * 5, 200)
        result = (
            col.get(limit=fetch_limit, where=where)
            if where
            else col.get(limit=fetch_limit)
        )
        entries = self._rows_to_entries(
            result.get("ids") or [],
            result.get("documents") or [],
            result.get("metadatas") or [],
        )
        entries.sort(key=lambda e: e.stored_at, reverse=True)
        return entries[:limit]

    def list_entries_page(
        self,
        collection: str = "knowledge",
        limit: int = 500,
        offset: int = 0,
        where: dict | None = None,
    ) -> list[MemoryEntry]:
        """Return one raw page of entries for a FULL scan of a collection.

        Unlike list_entries -- which over-fetches, re-sorts newest-first, and
        returns only the newest `limit` -- this pages straight through the whole
        collection via offset (insertion order from the backing store), so a
        caller can process EVERY entry without the newest-N cap. Returns an empty
        list past the end. Used by decay_knowledge so the oldest entries (the
        ones most likely to be stale) are no longer skipped (#858).
        """
        col = self._cols[collection]
        result = (
            col.get(limit=limit, offset=offset, where=where)
            if where
            else col.get(limit=limit, offset=offset)
        )
        return self._rows_to_entries(
            result.get("ids") or [],
            result.get("documents") or [],
            result.get("metadatas") or [],
        )
