// Shared helpers used across multiple learning sub-modules.
// Nothing in this file imports from other learning/ sub-modules.

import { log } from 'ion-sdk'
import { OLLAMA_HOST, loadModelForRole, loadBackendForRole, loadStaff } from '../config'
import { runClaudeAgent } from '../util/claudeAgent'

// Extraction and normalize roles now default to cli/Haiku so they survive when
// Ollama is running embeddings-only (qwen2.5:14b not resident). Roles are
// still configurable in models.yaml — setting backend: ollama reverts to local.
export const EXTRACTION_MODEL = loadModelForRole('extraction', 'qwen2.5:14b')
export const EXTRACTION_BACKEND = loadBackendForRole('extraction', 'ollama')
export const NORMALIZE_MODEL = loadModelForRole('normalize', 'qwen2.5:14b')
export const NORMALIZE_BACKEND = loadBackendForRole('normalize', 'ollama')
// Per-call timeout for all extraction calls — Ollama, CLI, and OpenRouter paths.
// For CLI calls, TIMEOUT_MS is explicitly forwarded as timeoutMs to runClaudeAgent;
// the function default (120 s) is NOT used. See issue #627.
// Lowered from 90_000: Ollama calls either succeed in a few seconds or hang
// indefinitely. 90s burned the 180s aggregate budget when two calls hung,
// silently dropping remaining facts. 20s gives enough headroom for success
// while fast-failing a stuck call. See issue #P3-D.
export const TIMEOUT_MS = 20_000

// Combine the per-call timeout with an optional outer signal so a caller can
// enforce an aggregate budget across a loop of LLM calls. AbortSignal.any
// triggers when whichever child signal aborts first.
export function combinedSignal(outer?: AbortSignal): AbortSignal {
  const inner = AbortSignal.timeout(TIMEOUT_MS)
  return outer ? AbortSignal.any([inner, outer]) : inner
}

// Safely pull `message.content` out of an Ollama /api/chat response. Guards
// res.json() -- a truncated or empty body throws -- and tolerates an
// unexpected envelope shape, returning '' rather than letting either escape as
// an unhandled rejection. Callers decide what '' means (fall back to the raw
// fact, or surface a typed JSON error after a failed parse).
export async function extractOllamaContent(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { message?: { content?: string } }
    return (data?.message?.content ?? '').trim()
  } catch {
    return ''
  }
}

// The CLI backend has no `format: "json"` enforcement, so a model occasionally
// prefixes the JSON block with a sentence of prose ("Here is the result: {...}").
// Strip to the outermost JSON object/array before parsing so one stray sentence
// doesn't break JSON.parse and silently drop the caller's result (#785).
//
// Bracket-agnostic: callers expect either `{...}` (gapDetection, proposal) or a
// top-level `[...]` array (gap analysis in gapProposal.ts). The earlier version
// picked whichever bracket appeared FIRST, so a prose `[...]` annotation before
// the real object (e.g. "the [extracted] facts: {...}") returned the wrong slice
// and JSON.parse threw, silently dropping the turn's result (#831). Instead, try
// both spans and return whichever actually parses; when both parse (an object
// whose value contains an array), the earlier opening bracket wins.
export function extractJsonBlock(raw: string): string {
  const candidates: { start: number; text: string }[] = []
  const objStart = raw.indexOf('{')
  if (objStart >= 0) {
    const end = raw.lastIndexOf('}')
    if (end > objStart) candidates.push({ start: objStart, text: raw.slice(objStart, end + 1) })
  }
  const arrStart = raw.indexOf('[')
  if (arrStart >= 0) {
    const end = raw.lastIndexOf(']')
    if (end > arrStart) candidates.push({ start: arrStart, text: raw.slice(arrStart, end + 1) })
  }
  if (candidates.length === 0) return raw

  const parses = (text: string): boolean => {
    try {
      JSON.parse(text)
      return true
    } catch {
      return false
    }
  }
  // Prefer a span that actually parses; if none does, fall back to the earliest
  // bracket span (prior behavior) so the caller's own JSON.parse reports the
  // malformation. Either way pick the earliest opening bracket among the pool.
  const valid = candidates.filter(c => parses(c.text))
  const pool = valid.length > 0 ? valid : candidates
  pool.sort((a, b) => a.start - b.start)
  const best = pool[0]
  return best ? best.text : raw
}

/**
 * Keep only the first sentence, enforcing the one-atomic-sentence contract (#784).
 * A multi-sentence fact blends topics in its embedding and can hide a dangling
 * pronoun in a later sentence that the sentence-initial pronoun guard won't catch.
 */
export function firstSentence(s: string): string {
  return s.split(/(?<=[.!?])\s+/)[0]?.trim() || s
}

export interface Normalized {
  text: string
  fallback: boolean
}

export async function normalizeFact(fact: string, signal?: AbortSignal): Promise<Normalized> {
  const prompt =
    'Rewrite the following fact as one atomic sentence about Alex. ' +
    "Rules: (1) One subject, one predicate — no 'and' joining two predicates. " +
    '(2) Replace every pronoun (he, his, they, it) with "Alex". ' +
    '(3) Self-contained — no dangling references. ' +
    'If the fact has two predicates, keep only the first. ' +
    'One sentence only, no commentary.\n\n' +
    `Fact: ${fact}\n\nRewritten:`
  try {
    let result: string
    if (NORMALIZE_BACKEND === 'cli') {
      // Route through Claude CLI subprocess when backend is cli (avoids Ollama
      // when qwen2.5:14b is not resident -- issue #613).
      result = (await runClaudeAgent('normalizeFact', prompt, { model: NORMALIZE_MODEL, ...(signal !== undefined ? { signal } : {}), timeoutMs: TIMEOUT_MS })).trim()
    } else {
      const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: NORMALIZE_MODEL,
          messages: [{ role: 'user', content: prompt }],
          stream: false,
          options: { temperature: 0 },
        }),
        signal: combinedSignal(signal),
      })
      if (!res.ok) {
        log.warn('learning: normalizeFact HTTP error, falling back to raw fact', { status: res.status, fact: fact.slice(0, 80) })
        return { text: fact, fallback: true }
      }
      result = await extractOllamaContent(res)
    }
    if (!result) {
      log.warn('learning: normalizeFact returned empty, falling back to raw fact', { fact: fact.slice(0, 80) })
      return { text: fact, fallback: true }
    }
    // Enforce the one-sentence contract: a model that returns multiple sentences
    // is exceeding it, so keep only the first (#784).
    return { text: firstSentence(result), fallback: false }
  } catch (err) {
    log.warn('learning: normalizeFact failed, falling back to raw fact', { err: String(err), fact: fact.slice(0, 80) })
    return { text: fact, fallback: true }
  }
}

// Issue #613: added CLI branch so extraction survives when Ollama is
// embeddings-only (qwen2.5:14b not resident).  When EXTRACTION_BACKEND is
// 'cli', route through the Claude CLI subprocess instead of Ollama.
export async function ollamaChat(system: string, userContent: string, temperature = 0.2, signal?: AbortSignal): Promise<string> {
  if (EXTRACTION_BACKEND === 'cli') {
    // Combine system + user into a single prompt for the CLI path.
    const prompt = `${system}\n\n${userContent}`
    return (await runClaudeAgent('ollamaChat', prompt, { model: EXTRACTION_MODEL, ...(signal !== undefined ? { signal } : {}), timeoutMs: TIMEOUT_MS })).trim()
  }
  const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: EXTRACTION_MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userContent },
      ],
      stream: false,
      options: { temperature },
    }),
    signal: combinedSignal(signal),
  })
  if (!res.ok) throw new Error(`ollama ${res.status}`)
  return extractOllamaContent(res)
}

// Backend-aware JSON chat. Routes through the Claude CLI subprocess when the
// given backend is 'cli' (survives Ollama running embeddings-only), otherwise
// hits Ollama /api/chat with format:json. Shared by ollamaChatJson (extraction
// role) and normalizeChatJson (normalize role) so every JSON classifier honors
// its configured backend instead of hard-coding a direct Ollama fetch (#855).
async function chatJson(
  label: string,
  backend: string,
  model: string,
  system: string,
  userContent: string,
  temperature: number,
  signal?: AbortSignal,
): Promise<unknown> {
  if (backend === 'cli') {
    const prompt = `${system}\n\n${userContent}`
    const raw = (await runClaudeAgent(label, prompt, { model, ...(signal !== undefined ? { signal } : {}), timeoutMs: TIMEOUT_MS })).trim()
    try {
      return JSON.parse(extractJsonBlock(raw))
    } catch (e) {
      throw new Error(`cli: invalid JSON response: ${(e as Error).message}`)
    }
  }
  const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userContent },
      ],
      stream: false,
      format: 'json',
      options: { temperature },
    }),
    signal: combinedSignal(signal),
  })
  if (!res.ok) throw new Error(`ollama ${res.status}`)
  const raw = await extractOllamaContent(res)
  try {
    return JSON.parse(raw)
  } catch (e) {
    // Truncated JSON (timeout abort mid-stream) or an unparseable envelope both
    // land here as '' -> JSON.parse failure, surfaced as a typed error instead
    // of an unhandled rejection.
    throw new Error(`ollama: invalid JSON response: ${(e as Error).message}`)
  }
}

export async function ollamaChatJson(system: string, userContent: string, temperature = 0.1, signal?: AbortSignal): Promise<unknown> {
  return chatJson('ollamaChatJson', EXTRACTION_BACKEND, EXTRACTION_MODEL, system, userContent, temperature, signal)
}

// Normalize-role analog of ollamaChatJson. The memory-correction classifier is a
// normalize-role task (NORMALIZE_MODEL), so routing it here makes it honor
// NORMALIZE_BACKEND=cli instead of always hitting Ollama -- which fails silently
// in production where Ollama runs embeddings-only and the chat model is not
// resident (#855).
export async function normalizeChatJson(system: string, userContent: string, temperature = 0, signal?: AbortSignal): Promise<unknown> {
  return chatJson('normalizeChatJson', NORMALIZE_BACKEND, NORMALIZE_MODEL, system, userContent, temperature, signal)
}

/** Brief non-blocking pause used between retries. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// maxChars caps the summary length: the active roster grows linearly as staff
// are added (~70 chars/entry) and an uncapped summary crowds the user message
// and system prompt out of a small model's context window (#819). Default 2000
// chars (~30 entries) leaves headroom on a 4096-token Ollama context.
export function buildRosterSummary(maxChars = 2000): string {
  const staff = loadStaff()
  if (!staff.length) return '(no staff registered)'
  const full = staff
    .filter((s) => s.status === 'active')
    .map((s) => `- ${s.id} (${s.title}): ${s.specialties.join(', ')}`)
    .join('\n')
  return full.length > maxChars ? full.slice(0, maxChars) + '\n...(roster truncated)' : full
}
