// Behavior 1: extractAndStore  -- post-turn LLM extraction of durable facts
// Behavior 8: extractConcreteValues -- detail-pass for concrete values (9+ messages)

import { log } from 'ion-sdk'
import { OLLAMA_HOST, isAllowedHost, loadMemoryTtlDays } from '../config'
import { db, getRecentMessages, logEvent } from '../memory/episodic'
import { remember } from '../memory/recall'
import { guardedRemember, PRONOUN_SUBJECT_RE } from '../memory/write'
import { isEphemeralMode } from '../memory/ephemeralMode'
import { looksLikeSecret, looksLikeAgentIdentityClaim } from '../memory/sanitize'
import { parseList } from '../util/parseList'
import {
  ollamaChat,
  normalizeFact,
  firstSentence,
  sleep,
} from './shared'

const _extractionInFlight = new Set<string>()
const _detailPassInFlight = new Set<string>()

// Issue #232: default TTL for detail-pass facts (ephemeral or knowledge collection).
// Configurable via integrations.yaml under memory.ttl_days.
// TTL cleanup is implemented in consolidation.py (decay_knowledge routine).
const DEFAULT_DETAIL_PASS_TTL_DAYS = 30

// Read memory.ttl_days through the shared config module (#820). No module-level
// cache: the detail pass runs at most once per 9+-message session, so a fresh
// read picks up config edits without a process restart. Warn (rather than
// silently default) when the value is missing or invalid so a misconfiguration
// is visible to the observability watcher.
function loadDetailPassTtlDays(): number {
  const ttl = loadMemoryTtlDays()
  if (ttl === null) {
    log.warn('learning: memory.ttl_days missing/invalid in integrations.yaml; using default', {
      default_days: DEFAULT_DETAIL_PASS_TTL_DAYS,
    })
    return DEFAULT_DETAIL_PASS_TTL_DAYS
  }
  return ttl
}

// ---------------------------------------------------------------------------
// Behavior 1: extractAndStore
// ---------------------------------------------------------------------------

const EXTRACT_SYSTEM = `You are extracting durable facts about Alex from a conversation.

Rules — each fact MUST follow all of these:
- One subject, one predicate, one object. No "and" joining two separate predicates.
- Subject must be "Alex" — never use pronouns (he, his, they, it).
- Self-contained: a stranger reading it cold knows exactly what it means.
- Durable: stable long-term preference, habit, or context — not a one-off.
- Skip questions Alex asked. Skip generic observations with no specific value.

NEVER extract (skip these entirely, they pollute or leak memory):
- Secrets/credentials: API keys, tokens, passwords, full card or account numbers.
- Transient one-offs: a date ("today is..."), a single trip's seat/flight/order/tracking number, a shipping choice, a one-time status/error, a current commit SHA, a version bump.
- Dev-machine/host setup: ssh commands, remote IPs, dev-laptop paths. The agent already runs locally; these mislead it.

Tag each fact with its type as the FIRST token on the line:
- [pref] for a personal preference, taste, habit, or working style (how Alex likes things).
- [fact] for an objective fact or context about Alex, his projects, tools, or world (what is true).

GOOD:  [pref] Alex uses uv for Python package management.
GOOD:  [pref] Alex prefers dark mode in all editors and apps.
GOOD:  [fact] Alex's primary machine is a Mac Mini M2.
GOOD:  [fact] Alex's Jarvis project runs on the ion runtime.
BAD:   Alex prefers dark mode and uses VS Code.       ← two predicates — split into two items
BAD:   [pref] He works on a Mac Mini.                  ← pronoun subject
BAD:   Alex mentioned something about Python.         ← too vague; also missing a type tag
BAD:   [fact] Alex's UniFi API key is ph1f6EPyOW...   ← credential — never store secrets
BAD:   [fact] Alex's outbound seat is 14B.            ← transient one-off — skip
BAD:   [fact] Today is Saturday, 6 June.               ← transient — skip
BAD:   [fact] Reach the Mini with ssh <username>@<mac-mini-ip>. ← dev/host setup — skip

Output: a numbered list, 3–12 items, one tagged atomic fact per line. Nothing else.`

// Issue #774: facts are tagged [pref]/[fact] by the extraction model and routed
// to different collections. Untagged facts default to 'preference' -- that
// preserves the prior behavior (everything landed in user_profile).
type FactType = 'preference' | 'factual'

function classifyFactTag(raw: string): { type: FactType; text: string } {
  // Tolerate near-miss tags ([preference], [factual], [prefs], ...) so a model
  // deviation from the exact [pref]/[fact] tokens doesn't leave the literal tag
  // embedded in the stored fact text.
  const m = /^\[(pref\w*|fact\w*)\]\s*/i.exec(raw)
  if (m) {
    const tag = (m[1] ?? '').toLowerCase()
    const type: FactType = tag.startsWith('pref') ? 'preference' : 'factual'
    return { type, text: raw.slice(m[0].length) }
  }
  return { type: 'preference', text: raw }
}

// Resolve the destination collection for an extracted fact.
// Issue #773: ephemeral mode is the OUTER gate -- facts learned in an ephemeral
// session must not pollute durable memory, so they go to task_memory regardless
// of type (mirrors extractConcreteValues' isEphemeralMode() routing).
// Issue #774: otherwise route by type -- preferences to user_profile, objective
// facts to knowledge.
function resolveFactCollection(type: FactType): 'user_profile' | 'knowledge' | 'task_memory' {
  if (isEphemeralMode()) return 'task_memory'
  return type === 'preference' ? 'user_profile' : 'knowledge'
}

// Aggregate budget across all LLM calls in extractAndStore. One initial
// extraction + up to 5 per-fact normalizations at 60s each could otherwise
// reach 360s and starve concurrent Ollama traffic.
const EXTRACT_AND_STORE_BUDGET_MS = 180_000
// Delay between primary extraction retries (Issue #180)
const EXTRACTION_RETRY_DELAY_MS = 5_000
const EXTRACTION_MAX_ATTEMPTS = 3

// Budget for draining pending_memory events left over from prior budget exhaustions.
// Intentionally smaller than EXTRACT_AND_STORE_BUDGET_MS to leave headroom for the
// new extraction pass that follows in the same turn_end hook.
const DRAIN_BUDGET_MS = 30_000

// Warn when the durability buffer grows beyond this threshold. At normal cadence
// a single drain pass clears the session's backlog; a rising count means the
// vec-server is consistently failing to accept writes and warrants investigation.
const PENDING_MEMORY_WARN_THRESHOLD = 200

// ---------------------------------------------------------------------------
// pending_memory drain — stores facts queued from prior budget-exhausted runs
// ---------------------------------------------------------------------------

interface PendingMemoryDetail {
  text: string
  collection: 'user_profile' | 'knowledge' | 'agent_memories' | 'task_memory' | 'procedural'
  session: string
  ttl_days?: number
}

/**
 * Drain any pending_memory events logged during previous budget-exhausted
 * extractAndStore runs. Called at the top of extractAndStore so stale queued
 * facts get a write opportunity before the new batch starts.
 *
 * Issue #570: drains current session's overflow first (session-scoped query)
 * so each session's 30s drain budget is spent on its own backlog before
 * consuming rows queued by other sessions.
 *
 * Non-blocking: stops mid-loop when the drain budget is hit; remaining rows
 * stay queued for the next turn.
 */
export async function drainPendingMemory(session: string, outerSignal?: AbortSignal): Promise<void> {
  // Check total queue depth before draining. A high count means facts are
  // accumulating faster than they're being written -- the vec-server may be
  // persistently failing and needs attention. Does not affect drain behavior;
  // purely observability.
  try {
    const depthRow = db()
      .prepare(`SELECT count(*) as n FROM agent_events WHERE event = 'pending_memory'`)
      .get() as { n: number } | undefined
    const depth = depthRow?.n ?? 0
    if (depth > PENDING_MEMORY_WARN_THRESHOLD) {
      log.warn('learning: pending_memory queue depth is high -- vec-server may need attention', {
        depth,
        threshold: PENDING_MEMORY_WARN_THRESHOLD,
      })
      // Also emit to agent_events so the observability-watcher (which queries
      // agent_events, not the engine log) can detect a sustained backlog (#783).
      logEvent(session, 'pending_memory_queue_high', { depth, threshold: PENDING_MEMORY_WARN_THRESHOLD })
    }
  } catch { /* non-fatal -- never block a drain on a count query */ }

  let rows: Array<{ id: number; detail: string | null }>
  try {
    // Issue #570: prioritise rows whose stored session matches the current
    // session. UNION ALL appends other-session rows so they drain on remaining
    // budget rather than consuming it before this session's facts.
    rows = db()
      .prepare(
        `SELECT id, detail FROM (
           SELECT id, detail FROM agent_events
           WHERE event = 'pending_memory'
             AND json_extract(detail, '$.session') = ?
           ORDER BY id ASC LIMIT 50
         )
         UNION ALL
         SELECT id, detail FROM (
           SELECT id, detail FROM agent_events
           WHERE event = 'pending_memory'
             AND (json_extract(detail, '$.session') IS NULL
                  OR json_extract(detail, '$.session') != ?)
           ORDER BY id ASC LIMIT 50
         )`,
      )
      .all(session, session) as Array<{ id: number; detail: string | null }>
  } catch (err) {
    log.warn('learning: drainPendingMemory query failed', { session, err: String(err) })
    return
  }
  if (rows.length === 0) return

  const drainBudget = outerSignal
    ? AbortSignal.any([outerSignal, AbortSignal.timeout(DRAIN_BUDGET_MS)])
    : AbortSignal.timeout(DRAIN_BUDGET_MS)
  let drained = 0
  for (const row of rows) {
    if (drainBudget.aborted) break
    if (!row.detail) {
      // Malformed row — delete it so it doesn't block the queue indefinitely.
      try { db().prepare('DELETE FROM agent_events WHERE id = ?').run(row.id) } catch { /* ignore */ }
      continue
    }
    let detail: PendingMemoryDetail
    try {
      detail = JSON.parse(row.detail) as PendingMemoryDetail
    } catch {
      try { db().prepare('DELETE FROM agent_events WHERE id = ?').run(row.id) } catch { /* ignore */ }
      continue
    }
    if (!detail.text || !detail.collection) {
      try { db().prepare('DELETE FROM agent_events WHERE id = ?').run(row.id) } catch { /* ignore */ }
      continue
    }
    try {
      // #863: pending_memory rows are queued by queueRemaining() as RAW typed
      // facts, BEFORE normalization, so a drain must normalize them to match the
      // quality of facts stored on the main extraction path. normalizeFact falls
      // back to the raw text on failure, so no fact is dropped for lack of an LLM.
      const normalized = await normalizeFact(detail.text, drainBudget)
      if (drainBudget.aborted) break
      // Route through the guarded chokepoint: it applies the secret, identity,
      // and pronoun guards (replacing the legacy inline secret/identity re-check)
      // and emits memory_dedup_rejected so the drain dedup rate is observable
      // (#864). Guards default ON -- a fact queued before the guards existed can
      // never reach durable memory via the drain path.
      const result = await guardedRemember(
        normalized.text,
        detail.collection,
        'learning',
        detail.ttl_days !== undefined ? 'detail_pass' : 'jarvis_inference',
        {
          session,
          signal: drainBudget,
          ...(detail.ttl_days !== undefined ? { metadata: { ttl_days: detail.ttl_days } } : {}),
        },
      )
      // Delete the row on any TERMINAL outcome: stored, dedup (already stored), a
      // guard drop (secret/identity/pronoun -- unstorable), or a terminal
      // vec-server rejection ('other' = 4xx / unrecoverable, which will never
      // succeed and would otherwise poison the queue head forever, burning a
      // normalize call every cycle). Leave the row queued only on a genuinely
      // transient failure: 'network' (retry-exhausted), 'disabled', or an 'other'
      // that is actually a budget cancellation (drainBudget aborted mid-write) --
      // those must survive to the next turn rather than being dropped.
      const terminal =
        result.ok ||
        result.reason === 'dedup' ||
        result.reason === 'secret' ||
        result.reason === 'identity' ||
        result.reason === 'pronoun' ||
        (result.reason === 'other' && !drainBudget.aborted)
      if (terminal) {
        db().prepare('DELETE FROM agent_events WHERE id = ?').run(row.id)
        if (result.ok || result.reason === 'dedup') {
          drained++
          log.info('learning: drained pending_memory', { session, preview: detail.text.slice(0, 80) })
        } else {
          // Guard drop (secret/identity/pronoun) or a terminal vec-server
          // rejection -- either way the row is unstorable and is removed.
          log.warn('learning: dropping unstorable pending_memory row (not stored)', { session, reason: result.reason, preview: detail.text.slice(0, 40) })
        }
      }
    } catch {
      // Unexpected error — leave the row.
    }
  }
  if (drained > 0) {
    log.info('learning: drain complete', { session, drained })
  }
}

const DETAIL_PASS_THRESHOLD = 9
// Issue #247: budget must exceed one per-call timeout so a single-attempt timeout
// does not consume the entire budget before the retry fires. Two attempts at
// TIMEOUT_MS (90s) each plus one EXTRACTION_RETRY_DELAY_MS (5s) gap = 185s.
const DETAIL_PASS_BUDGET_MS = 200_000

const DETAIL_EXTRACT_SYSTEM = `Extract only DURABLE concrete values about Alex worth remembering long-term:
- Names of people, companies, and products, and stable relationships
- Recurring prices or financial figures that stay relevant
- Stable identifiers Alex reuses (a home address, a regular account name)

Each value must be one self-contained sentence about Alex.

NEVER extract these (skip entirely):
- Secrets or credentials: API keys, tokens, passwords, full card or account numbers. Never store credential material.
- Transient one-offs: a specific date ("today is..."), a single trip's seat/flight/order/tracking number, a shipping choice, a one-time status or error ("returned 401", "build failing"), a current commit SHA, a version bump.
- Dev-machine / host setup: ssh commands, remote IPs, dev-laptop paths or actions. Jarvis runs ON the Mini; these mislead it.

Skip anything vague, inferential, or that goes stale within days.
Output: a numbered list, one durable value per line. If none, output nothing. No more than 10 items.`

export interface ExtractAndStoreOptions {
  // Pass 'double' to use 2× EXTRACT_AND_STORE_BUDGET_MS (Issue #419: deep re-encode path).
  budgetMs?: 'double' | number
  // Issue #771: the in-flight de-dup key. Defaults to `session`. Long-running passes
  // (e.g. the budgetMs:'double' deep re-encode) pass a distinct lockKey so they don't
  // block a concurrent turn_end extraction on the SAME session. Message retrieval still
  // uses the real `session`, so the distinct key must not be threaded into data lookups.
  lockKey?: string
}

export async function extractAndStore(session: string, opts?: ExtractAndStoreOptions): Promise<string[]> {
  if (!isAllowedHost(OLLAMA_HOST)) {
    log.warn('learning: OLLAMA_HOST rejected', { host: OLLAMA_HOST })
    return []
  }
  const lockKey = opts?.lockKey ?? session
  if (_extractionInFlight.has(lockKey)) {
    log.debug('learning: extractAndStore skipped -- already in flight', { session, lockKey })
    return []
  }

  // Issue #419: callers can request a larger budget (e.g. deepReencodeOnCorrection
  // passes budgetMs: 'double' to use 2× the normal extraction budget).
  // Declared before the try block so it can be threaded into drainPendingMemory.
  const effectiveBudgetMs = opts?.budgetMs === 'double'
    ? EXTRACT_AND_STORE_BUDGET_MS * 2
    : typeof opts?.budgetMs === 'number' && opts.budgetMs > 0
      ? opts.budgetMs
      : EXTRACT_AND_STORE_BUDGET_MS
  const budget = AbortSignal.timeout(effectiveBudgetMs)

  // Acquire the in-flight lock immediately before the guarded region so the
  // finally always releases it and no pre-try throw can pin the key.
  _extractionInFlight.add(lockKey)
  try {

  // Drain any facts queued from prior budget-exhausted runs before starting
  // the new extraction pass (non-blocking: stops at DRAIN_BUDGET_MS or outer budget,
  // whichever fires first).
  await drainPendingMemory(session, budget)

  const rows = getRecentMessages(session, 20)
  // Gate: skip very short exchanges to avoid extraction noise on thin context
  if (rows.length < 4) return []

  // Issue #314: cap per-message content so a single large paste doesn't overflow
  // the extraction model's context (~32K tokens for qwen2.5:14b). ~2000 chars ≈ 500 tokens.
  const MAX_MSG_CHARS = 2000
  const conversation = rows
    .map((m) => {
      const body = m.content.length > MAX_MSG_CHARS
        ? m.content.slice(0, MAX_MSG_CHARS) + ' [truncated]'
        : m.content
      return `${m.role.toUpperCase()}: ${body}`
    })
    .join('\n')

  // Issue #180: retry the primary extraction call with backoff so transient
  // Ollama saturation doesn't silently drop all facts from a turn.
  let raw: string | null = null
  for (let attempt = 1; attempt <= EXTRACTION_MAX_ATTEMPTS; attempt++) {
    if (budget.aborted) break
    try {
      raw = await ollamaChat(EXTRACT_SYSTEM, `Conversation:\n\n${conversation}\n\nExtracted preferences/facts:`, 0, budget)
      break
    } catch (err) {
      const isLastAttempt = attempt === EXTRACTION_MAX_ATTEMPTS
      log.warn('learning: extractAndStore LLM failed', { session, attempt, err: String(err) })
      if (isLastAttempt || budget.aborted) break
      // Wait before retrying, but bail early if the budget expires during the delay
      await Promise.race([sleep(EXTRACTION_RETRY_DELAY_MS), new Promise<void>((resolve) => {
        budget.addEventListener('abort', () => resolve(), { once: true })
      })])
    }
  }

  if (raw === null) {
    // #843: a zero-learning session from total extraction failure looks identical
    // to one with nothing to learn unless we emit a typed counter. Distinguish a
    // budget timeout from genuine LLM failure for the watcher.
    logEvent(session, 'learning_failed', {
      session,
      reason: budget.aborted ? 'budget_exhausted' : 'extraction_failed',
      attempts: EXTRACTION_MAX_ATTEMPTS,
    })
    log.warn('learning: extractAndStore produced no extraction output', { session })
    return []
  }

  // Issue #774: split each line into its [pref]/[fact] type and clean text.
  // Drop any fact carrying credential/secret material BEFORE the store loop and
  // the budget-skip queue, so a key can never reach durable memory or pending_memory
  // (write-path safety net behind the extraction prompt's no-secrets rule).
  const typedFacts = parseList(raw)
    .map(classifyFactTag)
    .filter((tf) => {
      if (looksLikeSecret(tf.text)) {
        log.warn('learning: dropping secret-like fact (not stored)', { session, preview: tf.text.slice(0, 40) })
        return false
      }
      if (looksLikeAgentIdentityClaim(tf.text)) {
        log.warn('learning: dropping Jarvis-identity claim (not stored)', { session, preview: tf.text.slice(0, 40) })
        return false
      }
      return true
    })
  const storedIds: string[] = []
  let skippedDueToBudget = 0
  const startedAt = Date.now()

  // Queue budget-skipped facts to pending_memory. The destination collection is
  // resolved NOW (issues #773/#774) so a later drain honors the ephemeral/type
  // routing decided at extraction time, not whatever mode is active at drain time.
  const queueRemaining = (items: ReadonlyArray<{ type: FactType; text: string }>): void => {
    const remaining = items.filter((f) => f.text.trim() && f.text.trim().length <= 1500)
    skippedDueToBudget = remaining.length
    for (const pf of remaining) {
      logEvent(session, 'pending_memory', {
        text: pf.text.trim(),
        collection: resolveFactCollection(pf.type),
        session,
      })
    }
  }

  for (const [i, tf] of typedFacts.entries()) {
    if (budget.aborted) {
      // Queue remaining facts so they survive to the next turn (issue #478).
      queueRemaining(typedFacts.slice(i))
      break
    }
    const rawFact = tf.text.trim()
    if (!rawFact || rawFact.length > 1500) continue
    const normalized = await normalizeFact(rawFact, budget)
    // Issue #132: if the budget was drained by this normalizeFact call (e.g. a
    // 60s timeout fired), break immediately rather than charging the remaining
    // facts against an already-exhausted budget that will produce nothing.
    if (budget.aborted) {
      // Queue remaining facts (excluding the current one that just finished normalization)
      // so they survive to the next turn (issue #478).
      queueRemaining(typedFacts.slice(i + 1))
      break
    }
    // #843: surface a systematic normalization failure (model down / empty /
    // HTTP error all collapse to the raw-fact fallback) that is otherwise only a
    // log.warn inside normalizeFact.
    if (normalized.fallback) {
      logEvent(session, 'normalize_fallback', { session, preview: rawFact.slice(0, 80) })
    }
    const fact = normalized.text
    if (fact.length > 1500) continue
    // Guard: sentence-initial pronoun means normalization failed to substitute.
    // Known limit: does not catch mid-sentence dangling pronouns (acceptable --
    // those are rare after the strengthened normalization prompt).
    // Issue #228: on the fallback path the raw fact was not normalized, so a
    // pronoun subject is expected -- log a warning and skip rather than silently dropping.
    if (PRONOUN_SUBJECT_RE.test(fact)) {
      if (normalized.fallback) {
        log.warn('learning: dropping un-normalized fact with pronoun subject', { fact: fact.slice(0, 80) })
      } else {
        log.debug('learning: skipping pronoun-subject fact', { fact: fact.slice(0, 80) })
      }
      continue
    }
    try {
      // Issues #773/#774: ephemeral -> task_memory; else [pref] -> user_profile,
      // [fact] -> knowledge. Write-time dedup handled by vec server at
      // DEDUP_ON_WRITE_THRESHOLD = 0.95 (store.py); see #866.
      const collection = resolveFactCollection(tf.type)
      const result = await remember(fact, collection, 'learning', 'jarvis_inference', undefined, undefined, budget)
      if (result.ok) {
        storedIds.push(result.id)
        log.info('learning: stored fact', { session, collection, preview: fact.slice(0, 80) })
      } else if (result.reason === 'dedup') {
        // #843: write-path dedup rejections are invisible without a typed event;
        // a rising rate signals the extraction model re-deriving known facts.
        logEvent(session, 'memory_dedup_rejected', { session, collection, preview: fact.slice(0, 80) })
      }
    } catch (err) {
      log.debug('learning: skipping fact', { err: String(err), fact: fact.slice(0, 60) })
    }
  }

  if (skippedDueToBudget > 0) {
    log.warn('learning: extractAndStore aggregate budget exceeded', {
      session,
      stored: storedIds.length,
      skipped: skippedDueToBudget,
      budget_ms: effectiveBudgetMs,
    })
    logEvent(session, 'extract_budget_exhausted', {
      session,
      budget_ms: effectiveBudgetMs,
      stored: storedIds.length,
      skipped: skippedDueToBudget,
      elapsed_ms: Date.now() - startedAt,
    })
  }

  logEvent(session, 'learning_complete', { facts_stored: storedIds.length, session })
  log.info('learning: extractAndStore complete', { session, stored: storedIds.length })
  return storedIds
  } finally {
    _extractionInFlight.delete(lockKey)
  }
}

// ---------------------------------------------------------------------------
// Behavior 8: extractConcreteValues
// ---------------------------------------------------------------------------

export async function extractConcreteValues(session: string): Promise<string[]> {
  if (!isAllowedHost(OLLAMA_HOST)) return []
  if (_detailPassInFlight.has(session)) {
    log.debug('learning: extractConcreteValues skipped -- already in flight', { session })
    return []
  }
  _detailPassInFlight.add(session)
  try {

  const rows = getRecentMessages(session, 12)
  if (rows.length < DETAIL_PASS_THRESHOLD) return []

  // Issue #314: same per-message content cap as extractAndStore -- prevents
  // large pastes from overflowing qwen2.5:14b's context window silently.
  const MAX_MSG_CHARS = 2000
  const conversation = rows
    .map((m) => {
      const body = m.content.length > MAX_MSG_CHARS
        ? m.content.slice(0, MAX_MSG_CHARS) + ' [truncated]'
        : m.content
      return `${m.role.toUpperCase()}: ${body}`
    })
    .join('\n')

  const budget = AbortSignal.timeout(DETAIL_PASS_BUDGET_MS)

  // Issue #187: retry the detail-pass extraction call with backoff so transient
  // Ollama saturation doesn't silently drop all concrete values from a turn.
  let raw: string | null = null
  for (let attempt = 1; attempt <= EXTRACTION_MAX_ATTEMPTS; attempt++) {
    if (budget.aborted) break
    try {
      raw = await ollamaChat(DETAIL_EXTRACT_SYSTEM, `Conversation:\n\n${conversation}\n\nConcrete values:`, 0, budget)
      break
    } catch (err) {
      const isLastAttempt = attempt === EXTRACTION_MAX_ATTEMPTS
      log.warn('learning: detail-pass LLM failed', { session, attempt, err: String(err) })
      if (isLastAttempt || budget.aborted) break
      await Promise.race([sleep(EXTRACTION_RETRY_DELAY_MS), new Promise<void>((resolve) => {
        budget.addEventListener('abort', () => resolve(), { once: true })
      })])
    }
  }

  if (raw === null) return []

  // Drop credential/secret-bearing values before storing or queueing. The detail
  // pass is the highest-risk path (it captures "concrete values" -- keys, account
  // ids, card numbers), so the write-path secret guard matters most here.
  const facts = parseList(raw).filter((f) => {
    if (looksLikeSecret(f)) {
      log.warn('learning: dropping secret-like concrete value (not stored)', { session, preview: f.slice(0, 40) })
      return false
    }
    if (looksLikeAgentIdentityClaim(f)) {
      log.warn('learning: dropping Jarvis-identity claim (not stored)', { session, preview: f.slice(0, 40) })
      return false
    }
    return true
  })
  const storedIds: string[] = []
  // Issue #232: route to task_memory in ephemeral mode; otherwise knowledge.
  // All detail-pass writes include a TTL so they decay faster than durable knowledge.
  const targetCollection = isEphemeralMode() ? 'task_memory' : 'knowledge'
  const ttlDays = loadDetailPassTtlDays()
  let skippedDueToBudget = 0

  for (const [i, fact] of facts.entries()) {
    if (budget.aborted) {
      // Queue remaining facts so they survive to the next turn (issue #602).
      const remaining = facts.slice(i).filter((f) => f.trim() && f.trim().length <= 1500)
      skippedDueToBudget = remaining.length
      for (const remainingFact of remaining) {
        logEvent(session, 'pending_memory', {
          text: remainingFact.trim(),
          collection: targetCollection,
          session,
          ttl_days: ttlDays,
        })
      }
      break
    }
    let trimmed = fact.trim()
    if (!trimmed || trimmed.length > 1500) continue
    // Regex pre-pass: normalize sentence-initial subject aliases to "Alex".
    // Reduces pronoun/alias variance that degrades embedding recall, and also
    // ensures the fallback value (used when normalizeFact fails) is already
    // pronoun-clean so it can survive the pronoun guard below.
    trimmed = trimmed
      .replace(/^(The user|The principal|He|She|They)\b/i, 'Alex')
      .replace(/((?:^|[.!?]\s+))(the user|the principal|he|she|they)\b/gi, (_, punct, pronoun) => {
        void pronoun
        return `${punct}Alex`
      })
    // Keep only the first sentence so the fallback value (used when normalizeFact
    // fails) is atomic and can't carry a 2nd-sentence dangling pronoun past the
    // sentence-initial guard below (#784).
    trimmed = firstSentence(trimmed)
    // Issue #665: apply LLM normalization (same path as extractAndStore) so
    // detail-pass facts have consistent quality. normalizeFact falls back to
    // the regex-cleaned trimmed value on failure -- no facts are dropped.
    const normalized = await normalizeFact(trimmed, budget)
    // Issue #132 pattern: if the budget drained during normalizeFact, queue
    // remaining facts as pending_memory and break rather than continuing the
    // loop against an already-exhausted budget.
    if (budget.aborted) {
      const remaining = facts.slice(i + 1).filter((f) => f.trim() && f.trim().length <= 1500)
      skippedDueToBudget += remaining.length
      for (const remainingFact of remaining) {
        logEvent(session, 'pending_memory', {
          text: remainingFact.trim(),
          collection: targetCollection,
          session,
          ttl_days: ttlDays,
        })
      }
      break
    }
    const normalizedText = normalized.text
    if (normalizedText.length > 1500) continue
    if (PRONOUN_SUBJECT_RE.test(normalizedText)) {
      if (normalized.fallback) {
        log.warn('learning: detail-pass dropping un-normalized fact with pronoun subject', { fact: normalizedText.slice(0, 80) })
      } else {
        log.debug('learning: detail-pass dropping pronoun-subject fact', { fact: normalizedText.slice(0, 80) })
      }
      continue
    }
    try {
      // Pass ttl_days in metadata so the vec server can apply TTL-based decay.
      // remember() already accepts metadata (5th param added by Worker B).
      const result = await remember(normalizedText, targetCollection, 'learning', 'detail_pass', { ttl_days: ttlDays }, undefined, budget)
      if (result.ok) {
        storedIds.push(result.id)
        log.info('learning: detail-pass stored', { session, preview: normalizedText.slice(0, 80), ttl_days: ttlDays })
      } else if (result.reason === 'dedup') {
        // #843: detail-pass dedup rejections are invisible without a typed event.
        logEvent(session, 'memory_dedup_rejected', { session, collection: targetCollection, preview: normalizedText.slice(0, 80) })
      }
    } catch (err) {
      log.debug('learning: detail-pass skipping', { err: String(err), fact: normalizedText.slice(0, 60) })
    }
  }

  if (skippedDueToBudget > 0) {
    log.warn('learning: detail-pass budget exceeded', {
      session,
      stored: storedIds.length,
      skipped: skippedDueToBudget,
    })
    logEvent(session, 'extract_budget_exhausted', {
      session,
      stored: storedIds.length,
      skipped: skippedDueToBudget,
    })
  }

  // #843: the detail pass was visible only via log.info, so a completed run was
  // invisible to the agent_events-based watcher. Emit a typed completion counter.
  logEvent(session, 'detail_pass_complete', {
    session,
    stored: storedIds.length,
    skipped: skippedDueToBudget,
  })
  log.info('learning: detail-pass complete', { session, stored: storedIds.length })
  return storedIds
  } finally {
    _detailPassInFlight.delete(session)
  }
}
