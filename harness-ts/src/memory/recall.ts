// Memory recall via the vector-store Python tool server (http://127.0.0.1:9876).
// Called from before_prompt to inject relevant memories into the system prompt.

import { log } from 'ion-sdk'
import { logEvent } from './episodic'
import { span } from '../util/span'

const VEC_SERVER = 'http://127.0.0.1:9876'
const RECALL_TIMEOUT_MS = Number(process.env.VEC_RECALL_TIMEOUT_MS ?? 10_000)
// Issue #613: raised from 15 000 ms to 30 000 ms.
// The vec-server /remember handler calls store().remember() → _find_near_duplicate()
// which triggers an Ollama embedding query (nomic-embed-text).  When Graphiti's
// background ingest thread is also calling Ollama for entity-extraction embeddings
// the embedding queue can block for 15-25 s -- well past the former 15 s limit.
// 30 s gives the embedding call enough headroom on a contested GPU without
// meaningfully extending a happy-path write (typical < 2 s when Ollama is idle).
const REMEMBER_TIMEOUT_MS = 30_000
// Issue #613: raised retry delay from 1 s to 3 s.
// A 1 s pause is not enough for Ollama to drain an embedding queue blocked by a
// concurrent Graphiti ingest.  3 s gives the embedder a real window to finish the
// in-flight request before we re-queue the next attempt.
const REMEMBER_RETRY_MAX = 2
const REMEMBER_RETRY_DELAY_MS = 3_000

// Issue #573: rate-limit memory_recall_failed events to at most once per 5 min
// per collection so a sustained vec server outage doesn't flood agent_events.
const RECALL_FAIL_RATE_LIMIT_MS = 5 * 60 * 1000
const _lastRecallFailTs = new Map<string, number>()

// Turn-scoped degradation signal. Set when recall runs degraded (fallback path)
// or fails entirely. Consumed and cleared at turn_end so the user sees a one-line
// note for that turn. Always cleared (not rate-limited) so every failed turn is loud.
let _recallDegradation: { reason: 'degraded' | 'failed'; at: number } | null = null

export function clearRecallDegradation(): void {
  _recallDegradation = null
}

// Returns the reason if the degradation signal is fresh (within maxAgeMs),
// then clears it. Always clears the signal regardless of age.
// Pass maxAgeMs = -1 to force the stale branch (useful in tests).
export function consumeRecallDegradation(maxAgeMs = 60_000): 'degraded' | 'failed' | null {
  const d = _recallDegradation
  _recallDegradation = null
  if (d === null) return null
  if (Date.now() - d.at <= maxAgeMs) return d.reason
  return null
}

export interface RecallResult {
  results: string[]
  elapsed_ms: number
}

export interface RecallItem {
  text: string
  source: string
  confidence: number
  age_days: number | null
  archived: boolean
}

export interface RecallMetaResult {
  results: RecallItem[]
  elapsed_ms: number
}

export type RememberResult =
  | { ok: true; id: string }
  | { ok: false; reason: 'network' | 'dedup' | 'disabled' | 'other'; detail?: string }

// Sources that represent user-stated facts (vs. agent-inferred / ingested).
// Mirrors the source-prefix → confidence mapping in harness/memory/store.py.
export const STATED_SOURCES = new Set(['cli', 'tui', 'agent', 'manual'])

// True when a recalled fact's source is a user-stated source. Case-insensitive
// prefix match, mirroring store.py's `source.startswith(prefix)` lookups, so a
// source like 'cli:some_command' still counts as stated. This is the single
// source of truth for the stated/inferred split -- formatRecalledMemory uses it
// too (#857), rather than an exact Set.has() that would misclassify a
// prefixed-but-stated source as inferred.
export function isStatedSource(source: string): boolean {
  const s = source.toLowerCase()
  for (const prefix of STATED_SOURCES) {
    if (s.startsWith(prefix)) return true
  }
  return false
}

export async function recallMeta(
  query: string,
  collection: 'user_profile' | 'knowledge' | 'agent_memories' | 'task_memory' | 'procedural' | 'episodic_journal' = 'user_profile',
  n = 5,
  goalIds?: string[],
): Promise<RecallMetaResult> {
  return span(`recall:${collection}`, () => _recallMetaImpl(query, collection, n, goalIds))
}

async function _recallMetaImpl(
  query: string,
  collection: 'user_profile' | 'knowledge' | 'agent_memories' | 'task_memory' | 'procedural' | 'episodic_journal',
  n: number,
  goalIds?: string[],
): Promise<RecallMetaResult> {
  const t0 = Date.now()
  try {
    const body: Record<string, unknown> = { query, collection, n }
    if (goalIds?.length) {
      body.goal_ids = goalIds
    }
    const res = await fetch(`${VEC_SERVER}/recall_meta`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(RECALL_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`vec server ${res.status}`)
    const data = (await res.json()) as RecallMetaResult
    log.debug('jarvis: recallMeta', { collection, n: data.results.length, ms: Date.now() - t0 })
    return data
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === 'TimeoutError'
    const tag = isTimeout ? 'jarvis: recallMeta timed out' : 'jarvis: recallMeta failed'
    log.warn(tag, { err: String(err) })
    // Issue #572: emit a degraded event so the turn is auditable. The /recall
    // fallback returns plain strings with no source metadata, so provenance is
    // unavailable. Mark source as 'fallback' (not in STATED_SOURCES) rather
    // than 'unknown' so it's distinguishable in agent_events queries.
    _recallDegradation = { reason: 'degraded', at: Date.now() }
    logEvent('system', 'memory_recall_degraded', {
      collection,
      reason: isTimeout ? 'timeout' : 'error',
      err: String(err),
      elapsed_ms: Date.now() - t0,
    })
    const legacy = await recall(query, collection, n, goalIds)
    const results: RecallItem[] = legacy.results.map((text) => {
      const archived = text.startsWith('[archive] ')
      return {
        text: archived ? text.slice('[archive] '.length) : text,
        source: 'fallback',
        confidence: 0.5,
        age_days: null,
        archived,
      }
    })
    return { results, elapsed_ms: Date.now() - t0 }
  }
}

function formatItem(item: RecallItem): string {
  const age = item.age_days == null ? '' : `, ${item.age_days}d`
  const src = item.source || 'unknown'
  return `- ${item.text} [${src}${age}]`
}

// Group recalled items by provenance so the LLM can see at a glance which
// facts came directly from Alex vs. which were inferred or ingested.
// Returns the formatted block (no leading divider) or '' when items is empty.
export function formatRecalledMemory(items: RecallItem[]): string {
  if (!items.length) return ''
  const recentStated: RecallItem[] = []
  const olderStated: RecallItem[] = []
  const inferred: RecallItem[] = []
  const archivedItems: RecallItem[] = []
  for (const item of items) {
    if (item.archived) {
      archivedItems.push(item)
      continue
    }
    const isStated = isStatedSource(item.source)
    const ageDays = item.age_days ?? 0
    if (isStated && ageDays < 30) recentStated.push(item)
    else if (isStated) olderStated.push(item)
    else inferred.push(item)
  }
  const parts: string[] = []
  if (recentStated.length) {
    parts.push('Recent stated facts:\n' + recentStated.map(formatItem).join('\n'))
  }
  if (olderStated.length) {
    parts.push('Older facts:\n' + olderStated.map(formatItem).join('\n'))
  }
  if (inferred.length) {
    parts.push('Inferred / ingested:\n' + inferred.map(formatItem).join('\n'))
  }
  if (archivedItems.length) {
    const lines = archivedItems
      .map((i) => {
        const age = i.age_days == null ? '' : `, ${i.age_days}d`
        return `- [archive] ${i.text} [${i.source || 'unknown'}${age}]`
      })
      .join('\n')
    parts.push('From long-term archive:\n' + lines)
  }
  return parts.join('\n\n')
}

export async function recall(
  query: string,
  collection: 'user_profile' | 'knowledge' | 'agent_memories' | 'task_memory' | 'procedural' | 'episodic_journal' = 'user_profile',
  n = 5,
  goalIds?: string[],
): Promise<RecallResult> {
  const t0 = Date.now()
  try {
    const body: Record<string, unknown> = { query, collection, n }
    if (goalIds?.length) {
      body.goal_ids = goalIds
    }
    const res = await fetch(`${VEC_SERVER}/recall`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(RECALL_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`vec server ${res.status}`)
    const data = (await res.json()) as { results: string[]; elapsed_ms: number }
    log.debug('jarvis: recall', { collection, n: data.results.length, ms: Date.now() - t0 })
    return data
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === 'TimeoutError'
    const tag = isTimeout ? 'jarvis: recall timed out' : 'jarvis: recall failed'
    log.warn(tag, { err: String(err) })
    // Per-turn signal: always set (not rate-limited) so every failed turn surfaces
    // a user-visible note. The logEvent below is rate-limited separately.
    _recallDegradation = { reason: 'failed', at: Date.now() }
    // Issue #573: write an agent_events row so memory unavailability is
    // queryable and detectable by observability-watcher. Rate-limited to
    // once per 5 min per collection to avoid flooding during sustained outages.
    const rateKey = collection
    const lastTs = _lastRecallFailTs.get(rateKey) ?? 0
    if (Date.now() - lastTs >= RECALL_FAIL_RATE_LIMIT_MS) {
      _lastRecallFailTs.set(rateKey, Date.now())
      logEvent('system', 'memory_recall_failed', {
        collection,
        reason: isTimeout ? 'timeout' : 'error',
        err: String(err),
        elapsed_ms: Date.now() - t0,
      })
    }
    return { results: [], elapsed_ms: Date.now() - t0 }
  }
}

function isTransientError(error: unknown): boolean {
  if (error instanceof Error && error.name === 'TimeoutError') {
    return true
  }
  if (error instanceof TypeError) {
    const msg = error.message.toLowerCase()
    return msg.includes('failed to fetch') || msg.includes('econnrefused') || msg.includes('timeout')
  }
  if (error instanceof Error) {
    const msg = error.message.toLowerCase()
    return msg.includes('timeout') || msg.includes('econnrefused') || msg.includes('5xx') || msg.includes('503') || msg.includes('502')
  }
  return false
}

export async function remember(
  text: string,
  collection: 'user_profile' | 'knowledge' | 'agent_memories' | 'task_memory' | 'procedural' | 'news' = 'knowledge',
  source = 'jarvis-ts',
  sourceActor = 'jarvis_inference',
  metadata?: Record<string, unknown>,
  goalId?: string,
  signal?: AbortSignal,
): Promise<RememberResult> {
  let lastErr: unknown

  for (let attempt = 0; attempt <= REMEMBER_RETRY_MAX; attempt++) {
    // Bail immediately if the caller's budget has been cancelled.
    if (signal?.aborted) {
      return { ok: false, reason: 'other', detail: 'cancelled by caller' }
    }
    try {
      // #840: do NOT set stored_at here. Sending a human-readable stamp broke
      // store.py's ISO recency parser; store.py stamps a clean UTC ISO when absent,
      // and a caller-provided metadata.stored_at (ISO) now passes through.
      const body: Record<string, unknown> = { text, collection, source, source_actor: sourceActor, metadata: { ...(metadata ?? {}) } }
      // #850: lift an explicit ttl_days from metadata to a top-level body field so
      // the vec-server applies a TTL (e.g. ephemeral RSS/news items).
      if (typeof metadata?.ttl_days === 'number') {
        body.ttl_days = metadata.ttl_days
      }
      if (goalId) {
        body.goal_id = goalId
      }
      // Combine caller's signal with the per-call timeout so whichever fires
      // first (budget exhausted or this specific call timing out) aborts the fetch.
      const fetchSignal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(REMEMBER_TIMEOUT_MS)])
        : AbortSignal.timeout(REMEMBER_TIMEOUT_MS)
      const res = await fetch(`${VEC_SERVER}/remember`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: fetchSignal,
      })

      if (!res.ok) {
        const status = res.status
        // Don't retry 4xx errors (terminal failures)
        if (status >= 400 && status < 500) {
          const detail = `HTTP ${status}`
          log.warn('jarvis: remember failed (terminal)', { status, detail })
          return { ok: false, reason: 'other', detail }
        }
        // Retry 5xx (transient)
        throw new Error(`vec server ${status}`)
      }

      const data = (await res.json()) as { id?: string }
      if (!data.id) {
        log.debug('jarvis: remember dedup rejected')
        return { ok: false, reason: 'dedup' }
      }

      log.debug('jarvis: remember success', { id: data.id, attempt })
      return { ok: true, id: data.id }
    } catch (err) {
      lastErr = err

      if (!isTransientError(err)) {
        const detail = String(err)
        log.warn('jarvis: remember failed (terminal)', { err: detail })
        return { ok: false, reason: 'other', detail }
      }

      if (attempt < REMEMBER_RETRY_MAX && !signal?.aborted) {
        log.debug('jarvis: remember transient error, retrying', { attempt, err: String(err) })
        await new Promise((resolve) => setTimeout(resolve, REMEMBER_RETRY_DELAY_MS))
      }
    }
  }

  const detail = String(lastErr)
  log.warn('jarvis: remember failed after retries', { err: detail })
  return { ok: false, reason: 'network', detail }
}

// ---------------------------------------------------------------------------
// Graphiti knowledge graph ingest
// ---------------------------------------------------------------------------

const GRAPH_INGEST_TIMEOUT_MS = 5000
const GRAPH_EPISODE_MAX_CHARS = 1500
const GRAPH_RECALL_TIMEOUT_MS = Number(process.env.GRAPH_RECALL_TIMEOUT_MS ?? '4000')

export async function graphIngest(
  userMsg: string,
  assistantReply: string,
  episodeName: string,
  referenceTime?: string,
): Promise<void> {
  const body = [
    userMsg ? `Alex Example: ${userMsg}` : '',
    assistantReply ? `Jarvis: ${assistantReply}` : '',
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, GRAPH_EPISODE_MAX_CHARS)

  if (body.length < 20) return

  // #767: pass the originating turn time so graphiti dates extracted facts'
  // valid_at to when they were said, not when ingest fired.
  const payload: Record<string, string> = { text: body, name: episodeName }
  if (referenceTime) payload['reference_time'] = referenceTime

  try {
    const res = await fetch(`${VEC_SERVER}/graph/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(GRAPH_INGEST_TIMEOUT_MS),
    })
    // #856: the prior code never checked res.ok, so a 5xx from the graph endpoint
    // was a silent data-loss -- the turn never landed in the knowledge graph and
    // nothing recorded the gap. Surface non-2xx the same way as a thrown error.
    if (!res.ok) {
      log.warn('jarvis: graphIngest non-ok', { status: res.status })
      logEvent('system', 'graph_ingest_failed', { reason: 'http', status: res.status, episode: episodeName })
    }
  } catch (err) {
    // #856: emit an agent_event (not just an engine-log warn) so graph write
    // failures are visible to the observability watcher, which queries
    // agent_events rather than the engine log.
    const isTimeout = err instanceof Error && err.name === 'TimeoutError'
    log.warn('jarvis: graphIngest failed', { err: String(err) })
    logEvent('system', 'graph_ingest_failed', { reason: isTimeout ? 'timeout' : 'error', err: String(err), episode: episodeName })
  }
}

export interface GraphEdge {
  fact: string
  source_node: string | null
  target_node: string | null
  sourceName: string | null
  targetName: string | null
  valid_at: string | null
}

export async function graphRecall(query: string, n = 5, asOf?: string): Promise<GraphEdge[]> {
  const t0 = Date.now()
  try {
    const body: Record<string, unknown> = { query, n }
    if (asOf !== undefined) body['as_of'] = asOf
    const res = await fetch(`${VEC_SERVER}/graph/recall`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(GRAPH_RECALL_TIMEOUT_MS),
    })
    if (!res.ok) return []
    const data = (await res.json()) as { results: unknown[] }
    const edges = (data.results ?? []).map((e) => {
      const edge = e as Record<string, unknown>
      return {
        fact: edge['fact'] as string,
        source_node: (edge['source_node'] as string | null) ?? null,
        target_node: (edge['target_node'] as string | null) ?? null,
        sourceName: (edge['source_name'] as string | null) ?? null,
        targetName: (edge['target_name'] as string | null) ?? null,
        valid_at: (edge['valid_at'] as string | null) ?? null,
      }
    })
    // jarvis#811b/d: emit a success counterpart so memory_graph_recall_failed has
    // a denominator -- without it the graph-recall failure RATE is unknowable
    // (this is what made the audit's first-pass "Graphiti is dead" read wrong).
    logEvent('system', 'memory_graph_recall_success', {
      results: edges.length,
      elapsed_ms: Date.now() - t0,
    })
    return edges
  } catch (err) {
    const elapsed_ms = Date.now() - t0
    log.warn('jarvis: graphRecall failed', { err: String(err) })
    const rateKey = 'graph_recall'
    const lastTs = _lastRecallFailTs.get(rateKey) ?? 0
    if (Date.now() - lastTs >= RECALL_FAIL_RATE_LIMIT_MS) {
      _lastRecallFailTs.set(rateKey, Date.now())
      logEvent('system', 'memory_graph_recall_failed', { reason: String(err), elapsed_ms })
    }
    return []
  }
}

export interface ForgetResult {
  deleted: boolean
  id: string
}

export async function forget(
  text: string,
  collection: 'user_profile' | 'knowledge' | 'agent_memories' | 'task_memory' | 'procedural' = 'user_profile',
): Promise<ForgetResult> {
  try {
    const res = await fetch(`${VEC_SERVER}/forget`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, collection }),
      signal: AbortSignal.timeout(REMEMBER_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`vec server ${res.status}`)
    return (await res.json()) as ForgetResult
  } catch (err) {
    log.warn('jarvis: forget failed', { err: String(err) })
    return { deleted: false, id: '' }
  }
}
