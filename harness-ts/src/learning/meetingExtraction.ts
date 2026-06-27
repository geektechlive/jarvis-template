// Behavior 5: extractFromMeetings -- meeting synthesis extraction into knowledge
//
// Aggregate budget caps the wall-clock time across N meetings so session_end
// never blocks the engine for more than this duration. Each meeting still has
// its own per-call timeout (TIMEOUT_MS = 90s) inside ollamaChat. With a 200s
// budget, up to two meetings can complete per session_end (2 × 90s + 5s retry
// gap = 185s). Realistic load is one meeting per session_end -- meetings are
// rare events.
//
// NOTE: In practice, `meeting_prepped` events only carry {title, start_time, prepped_at}
// and have no synthesis field. This means most calls will be no-ops. The Python source
// reads `meeting_recorded` events (from the minutes module) which DO carry a synthesis.
// The TS harness does not have a minutes module yet, so we read `meeting_prepped` events
// as specified and skip gracefully when no synthesis is present. This will become useful
// once the minutes/recording pipeline is ported to TS.

import { log } from 'ion-sdk'
import { OLLAMA_HOST, isAllowedHost } from '../config'
import { logEvent, recentEvents } from '../memory/episodic'
import { remember } from '../memory/recall'
import { PRONOUN_SUBJECT_RE } from '../memory/write'
import { parseList } from '../util/parseList'
import { ollamaChat, normalizeFact } from './shared'

const _meetingsExtractionInFlight = new Set<string>()

const MEETINGS_EXTRACT_SYSTEM = `A panel of AI staff members deliberated on a topic. Extract 1-3 durable conclusions or decisions from this synthesis that are worth remembering long-term.
Focus on stable facts or decisions ("Alex decided X", "The team concluded Y"). Skip procedural observations.
Format: a numbered list, one item per line. If nothing durable was concluded, return an empty response.`

// Issue #234: outer budget must be at least one per-call timeout (TIMEOUT_MS = 90s)
// plus buffer so a single slow meeting call is not silently aborted by the budget
// before it can complete. Original 20s was smaller than a single LLM call.
// Realistic load is 1 meeting per session_end; 2-meeting worst case = 195s.
const EXTRACT_FROM_MEETINGS_BUDGET_MS = 200_000

export async function extractFromMeetings(session: string): Promise<string[]> {
  if (!isAllowedHost(OLLAMA_HOST)) return []
  if (_meetingsExtractionInFlight.has(session)) {
    log.debug('learning: extractFromMeetings skipped -- already in flight', { session })
    return []
  }
  _meetingsExtractionInFlight.add(session)
  try {
  // Issue #275: only process meeting_recorded events -- they carry actual synthesis.
  // meeting_prepped events are prep artifacts ({title, start_time, prepped_at}) with
  // no synthesis field; including them produces permanent no-op rows in agent_events.
  // When the minutes/recording pipeline is added, it should emit meeting_recorded with
  // a stable calendar-event-id or title+date hash as the meeting identifier.
  const meetingEvents = recentEvents('meeting_prep', 'meeting_recorded', 24 * 30)
  if (!meetingEvents.length) return []

  // Skip meetings already processed
  const alreadyProcessed = new Set(
    recentEvents(session, 'meeting_learning_complete', 24 * 90)
      .map((e) => {
        const d = e.detail as Record<string, unknown> | null
        return String(d?.['meeting_id'] ?? '')
      })
      .filter(Boolean),
  )

  const unprocessed = meetingEvents.filter((e) => {
    const d = e.detail as Record<string, unknown> | null
    const id = String(d?.['meeting_id'] ?? d?.['calendar_id'] ?? e.id)
    return !alreadyProcessed.has(id)
  })
  if (!unprocessed.length) return []

  const budget = AbortSignal.timeout(EXTRACT_FROM_MEETINGS_BUDGET_MS)
  const storedIds: string[] = []
  let skippedDueToBudget = 0

  for (const [i, evt] of unprocessed.entries()) {
    if (budget.aborted) {
      skippedDueToBudget = unprocessed.length - i
      break
    }
    const detail = evt.detail as Record<string, unknown> | null
    const meetingId = String(detail?.['meeting_id'] ?? detail?.['calendar_id'] ?? evt.id)
    const topic = String(detail?.['topic'] ?? detail?.['title'] ?? '')
    const synthesis = String(detail?.['synthesis'] ?? '').trim()

    if (!synthesis) {
      // Issue #275: do NOT log meeting_learning_complete for no-synthesis events --
      // it would permanently pollute the alreadyProcessed set with no-op rows.
      // meeting_recorded events without synthesis are rare; just skip silently.
      log.debug('learning: extractFromMeetings skipped -- no synthesis', { meetingId })
      continue
    }

    let raw: string
    try {
      const userPrompt = `Topic: ${topic}\nSynthesis: ${synthesis.slice(0, 1000)}\n\nDurable conclusions:`
      raw = await ollamaChat(MEETINGS_EXTRACT_SYSTEM, userPrompt, 0, budget)
    } catch (err) {
      log.warn('learning: extractFromMeetings LLM failed', { meetingId, err: String(err) })
      continue
    }

    const facts = parseList(raw)
    const meetingStored: string[] = []

    for (const rawFact of facts) {
      const trimmed = rawFact.trim()
      if (!trimmed || trimmed.length > 1500) continue
      const normalized = await normalizeFact(trimmed, budget)
      const fact = normalized.text
      if (!fact || fact.length > 1500) continue
      // Pronoun guard: sentence-initial pronoun means normalization failed.
      if (PRONOUN_SUBJECT_RE.test(fact)) {
        if (normalized.fallback) {
          log.warn('learning: dropping un-normalized meeting fact with pronoun subject', { fact: fact.slice(0, 80) })
        } else {
          log.debug('learning: skipping pronoun-subject meeting fact', { fact: fact.slice(0, 80) })
        }
        continue
      }
      try {
        const result = await remember(fact, 'knowledge', `meeting_learning:${meetingId}`, 'reflection')
        if (result.ok) {
          meetingStored.push(result.id)
          storedIds.push(result.id)
          log.info('learning: stored meeting conclusion', { meetingId, preview: fact.slice(0, 80) })
        }
      } catch (err) {
        log.debug('learning: skipping meeting fact', { err: String(err) })
      }
    }

    logEvent(session, 'meeting_learning_complete', {
      meeting_id: meetingId,
      facts_stored: meetingStored.length,
    })
  }

  if (skippedDueToBudget > 0) {
    log.warn('learning: extractFromMeetings aggregate budget exceeded', {
      session,
      stored: storedIds.length,
      skipped: skippedDueToBudget,
      budget_ms: EXTRACT_FROM_MEETINGS_BUDGET_MS,
    })
  }

  log.info('learning: extractFromMeetings complete', { session, stored: storedIds.length })
  return storedIds
  } finally {
    _meetingsExtractionInFlight.delete(session)
  }
}
