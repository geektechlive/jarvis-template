// Prospective gap probing — runs immediately before routine execution.
// Recalls context for the routine's topic; if insufficient facts found,
// returns a gap description string that can be injected into routine context.

import { log } from 'ion-sdk'
import { recall } from '../memory/recall'
import { logEvent, recentEvents } from '../memory/episodic'
import { ROUTINE_TOPICS } from './routineTopics'

// ---------------------------------------------------------------------------
// Per-routine cooldown for gap probe logging.
// Without this, a routine like meeting_prep (every 5 min) that consistently
// finds 0 recall results fires a gap_probe event (and log noise) on every
// single cycle. One gap_probe per routine per 6-hour window is sufficient.
// (#563)
// ---------------------------------------------------------------------------

const GAP_PROBE_COOLDOWN_HOURS = 6

/**
 * Probe for knowledge gaps before a routine fires.
 *
 * Takes a routine ID, recalls context for the routine's topic, and returns
 * a gap description if fewer than 2 results are found. Otherwise returns null.
 *
 * Failures are swallowed — vec-server down or recall error returns null gracefully.
 * The gap event is logged for audit; gap context injection is handled by the caller.
 */
export async function prospectiveGapProbe(routineId: string): Promise<string | null> {
  try {
    const topic = ROUTINE_TOPICS[routineId]
    if (!topic) {
      // System routine with no gap context defined
      log.debug('gapProbe: no topic mapping for routine', { routineId })
      return null
    }

    const { results } = await recall(topic, 'knowledge', 5)
    const resultCount = results.length

    // Gap threshold: fewer than 2 facts found
    if (resultCount >= 2) {
      log.debug('gapProbe: sufficient context', { routineId, resultCount })
      return null
    }

    // Gap detected — check per-routine cooldown before logging/returning.
    // Without this, a high-frequency routine (e.g. meeting_prep every 5 min)
    // that consistently returns 0 recall results fires a gap event on every
    // single cycle, producing spurious probe noise. (#563)
    try {
      const recent = recentEvents(routineId, 'gap_probe', GAP_PROBE_COOLDOWN_HOURS)
      if (recent.length > 0) {
        log.debug('gapProbe: gap already logged within cooldown window', { routineId, cooldownHours: GAP_PROBE_COOLDOWN_HOURS })
        return null
      }
    } catch (err) {
      log.warn('gapProbe: failed to check cooldown', { routineId, err: String(err) })
      // Fail-open: proceed with gap detection even if cooldown check fails
    }

    // Compose description
    const routineName = formatRoutineId(routineId)
    const gapDescription = `Low context for ${routineName}: only ${resultCount} fact${resultCount === 1 ? '' : 's'} found about "${topic}"`

    try {
      logEvent(routineId, 'gap_probe', {
        routine: routineId,
        topic,
        results_found: resultCount,
        gap: true,
      })
    } catch (err) {
      log.warn('gapProbe: failed to log gap_probe event', { routineId, err: String(err) })
    }

    log.info('gapProbe: gap detected', { routineId, resultCount })
    return gapDescription
  } catch (err) {
    // Fail silently — recall errors or network issues should not break routines
    log.warn('gapProbe: error during probe', { routineId, err: String(err) })
    return null
  }
}

function formatRoutineId(id: string): string {
  return id
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/**
 * Wrap a routine with prospective gap probing.
 * Probes for knowledge gaps before execution; the routine itself decides what to
 * do with the gap context (if accessed via lastEvent). Non-fatal on probe errors.
 */
export function wrapWithGapProbe(routineId: string, fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    try {
      const gapContext = await prospectiveGapProbe(routineId)
      if (gapContext) {
        log.info('scheduler: gap context available for routine', { routineId, gap: gapContext })
      }
    } catch (err) {
      log.warn('scheduler: gap probe error (proceeding anyway)', { routineId, err: String(err) })
    }
    return fn()
  }
}
