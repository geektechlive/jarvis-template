// Behavior 3: detectGapForMessage -- per-turn quick gap check, 7-day suppression

import { log } from 'ion-sdk'
import { OLLAMA_HOST, isAllowedHost } from '../config'
import { logEvent, recentEvents } from '../memory/episodic'
import { ollamaChatJson, buildRosterSummary } from './shared'

// Issue #229: per-session gate for detectGapForMessage.
// Issue #666: rate limit persisted to SQLite so it survives daemon restarts.
// Uses a 1-hour SQLite window (vs. 5-minute in-process original) -- the
// sub-hour granularity gap is acceptable because the 7-day proposal suppression
// is the primary dedup; this gate only prevents rapid-fire LLM calls.
const GAP_CHECK_WINDOW_HOURS = 1

// Issue #356: split analysis and proposal budgets so a slow analysis call
// cannot exhaust all budget before proposal generation runs.
// Shared 7-day suppression window used by both gap analysis and per-turn dedup.
export const SUPPRESSION_WINDOW_HOURS = 168
export const ANALYSIS_WINDOW_DAYS = SUPPRESSION_WINDOW_HOURS / 24

const QUICK_GAP_SYSTEM = `You are checking if a user message needs a specialist not in the current roster.
Answer "yes" only if the user is asking for substantive help in a domain that NO current staff member handles well.
Answer "no" for casual chat, greetings, meta-questions, or anything a current staff member can handle.
Respond with a JSON object: {"gap": true or false, "topic_cluster": "short label", "description": "one sentence"}
JSON only:`

export async function detectGapForMessage(message: string, session?: string): Promise<void> {
  if (!isAllowedHost(OLLAMA_HOST)) return

  // Issue #229 / #666: rate limit via SQLite so it survives daemon restarts.
  const bucketKey = session ?? '__global__'
  if (recentEvents(bucketKey, 'gap_check', GAP_CHECK_WINDOW_HOURS).length > 0) {
    log.debug('learning: detectGapForMessage skipped -- rate limit', { session: bucketKey })
    return
  }
  logEvent(bucketKey, 'gap_check', { source: 'per_turn' })

  // 7-day suppression check: skip if this topic was already proposed recently
  const recentProposals = recentEvents('', 'staff_gap_proposed', 168)
  if (recentProposals.length > 0) {
    const msgLower = message.toLowerCase()
    for (const evt of recentProposals) {
      const d = evt.detail as Record<string, unknown> | null
      const cluster = String(d?.['topic_cluster'] ?? '').toLowerCase()
      // Substring suppression (mirrors Python fallback logic; no embedding available)
      const clusterWords = cluster.split('_').filter((w) => w.length >= 4)
      const matchCount = clusterWords.filter((w) => msgLower.includes(w)).length
      if (cluster && (msgLower.includes(cluster) || (clusterWords.length > 0 && matchCount >= Math.min(2, clusterWords.length)))) {
        // emit observable event before returning
        logEvent(session ?? 'gap_detection', 'gap_detection_suppressed', { cluster, reason: 'word_split_match', snippet: message.slice(0, 100) })
        log.debug('learning: detectGapForMessage suppressed', { cluster })
        return
      }
    }
  }

  const rosterSummary = buildRosterSummary()
  const userPrompt = `A user asked: ${message.slice(0, 500)}\n\nCurrent staff roster covers these domains:\n${rosterSummary}`

  let data: unknown
  try {
    data = await ollamaChatJson(QUICK_GAP_SYSTEM, userPrompt, 0.1)
  } catch (err) {
    log.debug('learning: detectGapForMessage LLM failed', { err: String(err) })
    return
  }

  if (typeof data !== 'object' || !data) return
  const d = data as Record<string, unknown>
  if (!d['gap']) return

  const cluster = String(d['topic_cluster'] ?? '').trim()
  const description = String(d['description'] ?? '').trim()
  if (!cluster) return

  // Cross-session dedup: skip if this exact cluster was proposed or detected in the last 7 days.
  const clusterLower = cluster.toLowerCase()
  const proposedClusters = recentEvents('', 'staff_gap_proposed', SUPPRESSION_WINDOW_HOURS)
    .map((e) => String((e.detail as Record<string, unknown> | null)?.['topic_cluster'] ?? '').toLowerCase())
    .filter(Boolean)
  const detectedClusters = recentEvents('', 'per_turn_gap_detected', SUPPRESSION_WINDOW_HOURS)
    .map((e) => String((e.detail as Record<string, unknown> | null)?.['topic_cluster'] ?? '').toLowerCase())
    .filter(Boolean)
  if (proposedClusters.includes(clusterLower) || detectedClusters.includes(clusterLower)) {
    log.debug('learning: detectGapForMessage cross-session dedup suppressed', { cluster })
    return
  }

  logEvent('', 'per_turn_gap_detected', {
    topic_cluster: cluster,
    description,
    source: 'per_turn',
    message_snippet: message.slice(0, 200),
  })

  log.info('learning: per-turn gap detected', { cluster, description: description.slice(0, 80) })
}

/** No-op kept for API compatibility; SQLite-backed rate limit needs no cleanup. */
export function clearGapCheckSession(_session: string): void {}
