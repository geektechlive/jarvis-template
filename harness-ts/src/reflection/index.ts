// Reflection panel -- three-agent deliberation over conversation history.
// Mirrors harness/reflection.py::run_reflection().
//
// Three sequential passes:
//   1. PatternFinder -- identifies durable user preferences and behaviors
//   2. GapFinder     -- identifies what the agent should know but doesn't
//   3. Synthesizer   -- distills both analyses into storable facts
//
// Output: 3-5 facts normalized to third person, deduplicated via write-time
// dedup (DEDUP_ON_WRITE_THRESHOLD=0.95 in the vec server, store.py), then stored in
// user_profile. Emits reflection_complete event.
//
// Transport: ctx.dispatchAgent() -- runs in a Go goroutine with no timeout ceiling.
// Background promise callers (overnight_reflection, /reflect command) remain
// responsible for not blocking Ion's hook budget.

import type { IonContext } from 'ion-sdk'
import { log } from 'ion-sdk'
import { loadModelForRole } from '../config'
import { getRecentMessages, recentEvents } from '../memory/episodic'
import { logEvent } from '../memory/episodic'
import { remember } from '../memory/recall'
import { sanitizeRecalled } from '../memory/sanitize'
import { parseList } from '../util/parseList'

const REFLECTION_MODEL = loadModelForRole('reflection', 'claude-haiku-4-5-20251001')

const PATTERN_FINDER_SYSTEM = `You are reviewing recent conversations with a personal AI assistant.
Your job: identify 3-5 durable patterns about the user's preferences, habits, and work style.

Rules:
- Stable, long-term traits only -- not one-off events or passing comments
- Be specific: "prefers concise code reviews" not "likes things short"
- Third person: "Alex prefers..." not "the user..." or "I..."
- Numbered list only -- no headers, no preamble, no extra commentary`

const GAP_FINDER_SYSTEM = `You are reviewing recent conversations with a personal AI assistant.
Your job: identify 3-5 things the assistant clearly doesn't know but should --
missing context, assumptions that seem wrong, or topics the user cares about
that aren't yet reflected in the assistant's behavior.

Rules:
- Frame as facts to store, not questions: "Alex lives in Houston" not "we don't know the city"
- Actionable only -- things that would concretely improve future responses if known
- Third person: "Alex..." not "the user..."
- Numbered list only -- no headers, no preamble, no extra commentary
- NEVER infer residency from weather or location searches -- only record stated facts
- NEVER infer demographics or ownership from one-off queries -- stated facts only`

const SYNTHESIZER_SYSTEM = `You are synthesizing findings from two analysts who reviewed recent AI assistant conversations.
Your job: produce the 3-5 most valuable, durable facts worth adding to long-term memory.

Rules:
- Durable means: true across sessions, not tied to a single event
- Prefer specificity: "Alex uses uv for Python dependency management" beats "Alex uses Python"
- Third person throughout: "Alex...", "Alex's..."
- Numbered list only -- no headers, no preamble, no commentary, no explanation`

const NORMALIZE_SYSTEM = `Rewrite the user's fact in third person, referring to the user as 'Alex'. One sentence only, no extra commentary.`

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface PanelUsage {
  inputTokens: number
  outputTokens: number
  costUsd: number
  durationMs: number
  // ion SDK does not expose cache token counts on dispatchAgent results (upstream: dsswift/ion#146).
}

function logUsage(session: string, agent: string, usage: PanelUsage): void {
  logEvent(session, 'reflection_token_usage', {
    agent,
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cost_usd: usage.costUsd,
    duration_ms: usage.durationMs,
  })
}

async function panelChat(
  ctx: IonContext,
  session: string,
  agent: string,
  system: string,
  user: string,
): Promise<string> {
  if (!user?.trim()) {
    log.warn('reflection: panelChat skipped — empty user prompt', { session, agent })
    return ''
  }
  const r = await ctx.dispatchAgent({
    name: `reflection_${agent}`,
    task: user,
    systemPrompt: system,
    model: REFLECTION_MODEL,
    maxTurns: 1,
  })
  logUsage(session, agent, {
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    costUsd: r.cost,
    durationMs: r.elapsed,
  })
  return r.output.trim()
}

async function normalizeFact(ctx: IonContext, session: string, fact: string): Promise<string> {
  try {
    return (
      (await panelChat(ctx, session, 'normalize', NORMALIZE_SYSTEM, `Fact: ${fact}\n\nRewritten:`)) || fact
    )
  } catch (err) {
    log.debug('reflection: normalize failed, using original', { err: String(err) })
    return fact
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function runReflection(
  ctx: IonContext,
  session: string,
  messagesOverride?: Array<{ role: string; content: string }>,
): Promise<string[]> {
  const rows = messagesOverride ?? getRecentMessages(session, 20)
  if (!rows.length) {
    log.info('reflection: no messages for session, skipping', { session })
    return []
  }

  const conversation = rows
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join('\n')

  // Feedback signals from the last 7 days, sorted oldest-first
  const feedbackEvents = [
    ...recentEvents('', 'feedback_rating', 24 * 7),
    ...recentEvents('', 'feedback_correction', 24 * 7),
    ...recentEvents('', 'feedback_preference', 24 * 7),
    ...recentEvents('', 'feedback_endorsement', 24 * 7),
    ...recentEvents('', 'feedback_escalation', 24 * 7),
  ].sort((a, b) => (a.ts < b.ts ? -1 : 1))

  const feedbackSummary = feedbackEvents.length > 0
    ? '\n\nFeedback signals (last 7 days):\n' + feedbackEvents.map((e) => {
        const d = e.detail as Record<string, unknown> | null
        const text = e.event === 'feedback_rating'
          ? `Rating ${String(d?.['rating'])}/5${d?.['note'] ? ': ' + String(d['note']) : ''}`
          : String(d?.['text'] ?? d?.['reason'] ?? d?.['target'] ?? e.event)
        return `- [${e.event}] ${sanitizeRecalled(text).slice(0, 150)}`
      }).join('\n')
    : ''

  const prompt = `Recent conversations:\n\n${conversation}${feedbackSummary}`

  let patterns = ''
  let patternsOk = false
  try {
    patterns = await panelChat(ctx, session, 'PatternFinder', PATTERN_FINDER_SYSTEM, prompt)
    patternsOk = true
    log.debug('reflection: PatternFinder complete', { session, len: patterns.length })
  } catch (err) {
    log.warn('reflection: PatternFinder failed', { session, err: String(err) })
    logEvent(session, 'reflection_failed', { agent: 'PatternFinder', error: String(err) })
  }

  let gaps = ''
  let gapsOk = false
  try {
    gaps = await panelChat(ctx, session, 'GapFinder', GAP_FINDER_SYSTEM, prompt)
    gapsOk = true
    log.debug('reflection: GapFinder complete', { session, len: gaps.length })
  } catch (err) {
    log.warn('reflection: GapFinder failed', { session, err: String(err) })
    logEvent(session, 'reflection_failed', { agent: 'GapFinder', error: String(err) })
  }

  if (!patternsOk && !gapsOk) {
    log.warn('reflection: both PatternFinder and GapFinder failed, aborting', { session })
    return []
  }

  const combined = `Pattern Analysis:\n${patterns}\n\nGap Analysis:\n${gaps}${feedbackSummary}`
  let synthesis: string
  try {
    synthesis = await panelChat(ctx, session, 'Synthesizer', SYNTHESIZER_SYSTEM, combined)
    log.debug('reflection: Synthesizer complete', { session, len: synthesis.length })
  } catch (err) {
    log.warn('reflection: Synthesizer failed, falling back to upstream results', { session, err: String(err) })
    logEvent(session, 'reflection_failed', { agent: 'Synthesizer', error: String(err) })
    synthesis = (patternsOk ? patterns : '') + '\n' + (gapsOk ? gaps : '')
  }

  const facts = parseList(synthesis)
  const storedIds: string[] = []

  for (let fact of facts) {
    fact = fact.trim()
    if (!fact || fact.length > 1500) continue
    try {
      fact = await normalizeFact(ctx, session, fact)
    } catch (err) {
      log.debug('reflection: normalizeFact error, using original', { err: String(err) })
    }
    if (fact.length > 1500) continue
    try {
      const result = await remember(fact, 'user_profile', 'reflection', 'reflection')
      if (result.ok) {
        storedIds.push(result.id)
        log.info('reflection: stored fact', { session, preview: fact.slice(0, 80) })
      } else {
        log.debug('reflection: remember failed', { reason: result.reason, detail: result.detail, fact: fact.slice(0, 60) })
      }
    } catch (err) {
      log.debug('reflection: skipping fact', { err: String(err), fact: fact.slice(0, 60) })
    }
  }

  logEvent(session, 'reflection_complete', {
    facts_stored: storedIds.length,
    session,
    patterns_length: patterns.length,
    gaps_length: gaps.length,
    // Carry truncated qualitative findings so the weekly gap analysis can use what
    // the reflection panel actually concluded, not just counts (#647).
    patterns_excerpt: patterns.slice(0, 400),
    gaps_excerpt: gaps.slice(0, 400),
  })

  log.info('reflection: complete', { session, stored: storedIds.length })
  return storedIds
}

