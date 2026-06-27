// Behavior 6: detectRoutingCorrection -- per-turn routing correction detection
//
// Detects when the user corrects a dispatch decision ("you should have called
// the CFO for that"). Stores the correction in both:
//   - agent_events as routing_correction (for always-on injection via recentEvents)
//   - knowledge collection (for semantic recall when similar situations arise)
//
// No LLM -- fast pattern match only. Duplicates are harmless; the dedup pass
// in consolidation.py keeps the knowledge collection clean.

import { log } from 'ion-sdk'
import { loadStaff } from '../config'
import { logEvent, recentEvents } from '../memory/episodic'
import { remember } from '../memory/recall'

const ROUTING_CORRECTION_PATTERNS: RegExp[] = [
  /should(?:\s+have|'ve)\s+(?:called|dispatched|used|asked|sent\s+to|routed\s+to)\s+/i,
  /next\s+time\s+(?:use|call|ask|dispatch|route\s+to|send\s+to)\s+/i,
  /that\s+should\s+(?:have\s+)?go(?:ne)?\s+to\s+/i,
  /that(?:'s|\s+is|\s+was)\s+(?:a\s+|an\s+)?(?:\w+\s+)?(?:task|question|job|request)\s+for\s+/i,
  /(?:route|dispatch|send)\s+(?:this|that|it|these)\s+to\s+/i,
  /wrong\s+(?:agent|staff|person)\s*[,.]?\s*(?:use|try|call)\s+/i,
  /actually[,.]?\s+(?:ask|call|use|check\s+with|bring\s+in)\s+/i,
  /(?:more\s+of|really\s+a|should\s+be\s+a)\s+\w[\w\s]{0,20}\s+(?:thing|domain|question|job)\b/i,
  /bring\s+in\s+(?:the\s+)?\w[\w\s]{0,20}\s+(?:on|for|to\s+handle)\b/i,
  /(?:that\s+)?(?:belongs?|goes?)\s+(?:with|to|under)\s+/i,
]

// Context guard: at least one staff-role keyword must appear in the message to
// distinguish genuine routing corrections from casual speech that matches
// the broad patterns above (e.g. "Actually, ask John" or "more of a Monday thing").
//
// Issue #231: when extractGapsAndPropose appends a new draft staff member, their
// title must be recognized for routing corrections to work. The regex is rebuilt
// from CORE_ROUTING_VOCAB + active staff titles on demand, cached for 60s.
// The core vocabulary is defined as an alternation for use in both the static
// fallback and the dynamically-rebuilt regex. Character class for apostrophe/curly
// written as a string so it remains valid across quote styles.
const _APOSTROPHE_CLASS = "['\\u2019]"
const CORE_ROUTING_VOCAB = [
  'researcher', 'analyst', 'writer', 'cfo', 'personal\\s+cfo',
  'portfolio(?:\\s+manager)?', 'admin(?:istrative)?',
  '(?:backend|frontend|infra)\\s*dev(?:eloper)?', 'engineer(?:ing)?',
  'security', 'wellness\\s+coach', 'tech(?:nology)?\\s*advisor',
  'knowledge\\s*curator', 'news\\s*desk',
  'chief\\s+of\\s+(?:strategy|communications?)',
  'comms?', 'strategy', 'doc\\s+steward', 'contacts?\\s+manager',
  'systems?\\s*engineer', 'repo\\s+steward', 'observability',
  'entertainment(?:\\s+advisor)?',
  `devil${_APOSTROPHE_CLASS}?s?\\s+advocate`,
  'legal(?:\\s+reviewer)?', '(?:home|property)(?:\\s+manager)?',
].join('|')

let _routingVocabRE: RegExp = new RegExp(`\\b(?:${CORE_ROUTING_VOCAB})\\b`, 'i')
let _routingVocabBuiltAt = 0
const ROUTING_VOCAB_CACHE_MS = 60_000

/** Build (or return cached) routing vocabulary regex, including dynamically-added staff. */
export function getRoutingVocabularyRE(): RegExp {
  const now = Date.now()
  if (now - _routingVocabBuiltAt < ROUTING_VOCAB_CACHE_MS) return _routingVocabRE
  try {
    const dynamicTerms = loadStaff()
      .filter((s) => s.status === 'active')
      .flatMap((s) => [s.id.replace(/_/g, '\\s+'), s.title.toLowerCase()])
      .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .filter((t) => t.length > 2)
    const allTerms = dynamicTerms.length
      ? `${CORE_ROUTING_VOCAB}|${dynamicTerms.join('|')}`
      : CORE_ROUTING_VOCAB
    _routingVocabRE = new RegExp(`\\b(?:${allTerms})\\b`, 'i')
  } catch {
    // Keep the previous regex on failure rather than crashing every turn
  }
  _routingVocabBuiltAt = now
  return _routingVocabRE
}

/** Force-rebuild the routing vocabulary regex (e.g. after new staff is appended). */
export function rebuildRoutingVocabulary(): void {
  _routingVocabBuiltAt = 0 // Invalidate cache -- next call to getRoutingVocabularyRE rebuilds
}

// Backwards-compatible alias. This is the static core-only regex -- it won't include
// dynamically-added staff. detectRoutingCorrection uses getRoutingVocabularyRE() instead.
// External test imports of ROUTING_VOCABULARY_RE still work as before.
export const ROUTING_VOCABULARY_RE: RegExp = new RegExp(`\\b(?:${CORE_ROUTING_VOCAB})\\b`, 'i')

export async function detectRoutingCorrection(message: string, session: string): Promise<void> {
  if (!ROUTING_CORRECTION_PATTERNS.some((p) => p.test(message))) return
  // Issue #231: use live vocabulary regex (includes dynamically-added staff titles)
  if (!getRoutingVocabularyRE().test(message)) return

  const snippet = message.slice(0, 400)

  // Correlate with the most recent dispatch in this session (within 2 hours) so the
  // stored memory names the staff member that was wrong, not just the user's correction text.
  const recentDispatches = recentEvents(session, 'agent_dispatch', 2)
  const lastDispatch = recentDispatches.at(-1)
  const correctedFrom = (lastDispatch?.detail as Record<string, unknown> | null)
    ?.subagentType as string | undefined

  const memoryText = correctedFrom
    ? `Routing rule: dispatched ${correctedFrom} but user corrected — ${snippet}`
    : `Routing rule: ${snippet}`

  logEvent('', 'routing_correction', { correction: snippet, corrected_from: correctedFrom ?? null })
  logEvent('', 'feedback_correction', { text: snippet, detector: 'regex', confidence: 0.5, ts: new Date().toISOString() })
  // Issue #393: check remember() return -- ok: false means the knowledge write
  // failed (vec server down, timeout). The SQLite event is written above regardless,
  // so routing corrections accumulate in episodic but won't inform semantic recall.
  const routingResult = await remember(memoryText, 'knowledge', 'routing_correction', 'jarvis_inference')
  if (!routingResult.ok) {
    log.warn('learning: detectRoutingCorrection -- routing correction not stored in knowledge', {
      snippet: snippet.slice(0, 80),
      reason: routingResult.reason,
    })
    logEvent('', 'routing_correction_dropped', { reason: routingResult.reason, snippet: snippet.slice(0, 200) })
  } else {
    log.info('learning: routing_correction stored', {
      snippet: snippet.slice(0, 80),
      correctedFrom: correctedFrom ?? 'unknown',
    })
  }
}
