// Pre-routine gap probe -- fires 10-20 minutes before a scheduled daily/weekly
// routine. Recalls memory for the routine's topic; if fewer than 2 facts are
// found, posts a Discord embed noting the knowledge gap.
//
// No LLM call, no subprocess. Fast heuristic only.
// Cooldown: one notification per routine per calendar day (inner per-routine
// cooldown keyed on routine ID + ISO date), separate from the outer proactive
// engine cooldown (which is set to 0 so the engine never skips the trigger).

import { log } from 'ion-sdk'
import { logEvent, recentEvents } from '../memory/episodic'
import { recall } from '../memory/recall'
import { loadRoutinesConfig, isEnabled, type RoutineConfig } from '../scheduler/helpers'
import { buildRichEmbed } from '../discord/format'
import { postProactive } from './notify'
import { ROUTINE_TOPICS } from '../scheduler/routineTopics'

// Lowercase weekday name -> JS Date.getDay() index (Sunday = 0)
const DAY_INDEX: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ChicagoTime {
  hour: number
  minute: number
  dayOfWeek: number   // 0=Sun, matches Date.getDay()
  todayStr: string    // YYYY-MM-DD in local time (used for cooldown keys)
}

function getChicagoTime(): ChicagoTime {
  const now = new Date()

  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'long',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour12: false,
  })

  const parts = fmt.formatToParts(now)
  const get = (type: string): string => parts.find(p => p.type === type)?.value ?? '0'

  const hour = parseInt(get('hour'), 10)
  const minute = parseInt(get('minute'), 10)
  const weekday = get('weekday').toLowerCase()  // e.g. "monday"
  const dayOfWeek = DAY_INDEX[weekday] ?? now.getDay()

  // Build todayStr from Chicago date parts (year/month/day in Chicago timezone)
  const year = get('year')
  const month = get('month')
  const day = get('day')
  const todayStr = `${year}-${month}-${day}`

  return { hour, minute, dayOfWeek, todayStr }
}

function formatRoutineId(id: string): string {
  return id
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

// ---------------------------------------------------------------------------
// findUpcomingRoutines
// ---------------------------------------------------------------------------

interface UpcomingRoutine {
  id: string
  minutesUntil: number
}

export function findUpcomingRoutines(
  cfg: Record<string, RoutineConfig>,
): UpcomingRoutine[] {
  const { hour, minute, dayOfWeek, todayStr: _todayStr } = getChicagoTime()
  const nowMinutes = hour * 60 + minute
  const result: UpcomingRoutine[] = []

  for (const [id, routine] of Object.entries(cfg)) {
    // Only daily/weekly routines have a time field
    if (!routine.time) continue
    if (!isEnabled(id)) continue

    const [rawHour, rawMin] = routine.time.split(':')
    const routineHour = parseInt(rawHour ?? '0', 10)
    const routineMinute = parseInt(rawMin ?? '0', 10)
    if (isNaN(routineHour) || isNaN(routineMinute)) continue

    const routineMinutes = routineHour * 60 + routineMinute
    const minutesUntil = routineMinutes - nowMinutes

    if (minutesUntil < 10 || minutesUntil > 20) continue

    // Weekly routines: check day matches today
    if (routine.day !== undefined) {
      const routineDayIndex = DAY_INDEX[routine.day.toLowerCase()]
      if (routineDayIndex === undefined || routineDayIndex !== dayOfWeek) continue
    }

    result.push({ id, minutesUntil })
  }

  return result
}

// ---------------------------------------------------------------------------
// preRoutineGapProbe
// ---------------------------------------------------------------------------

export async function preRoutineGapProbe(): Promise<boolean> {
  const cfg = loadRoutinesConfig()
  const upcoming = findUpcomingRoutines(cfg)
  if (upcoming.length === 0) return false

  const { todayStr } = getChicagoTime()
  let anyFired = false

  for (const { id: routineId, minutesUntil } of upcoming) {
    const topic = ROUTINE_TOPICS[routineId]
    if (!topic) {
      // System routine with no useful gap context -- skip
      log.debug('proactive: preRoutineGapProbe -- no topic for routine', { routineId })
      continue
    }

    const cooldownKey = `pre_routine_gap_probe:${routineId}:${todayStr}`

    // Per-routine daily cooldown: skip if already fired today
    const recent = recentEvents(cooldownKey, 'proactive_fired', 24)
    if (recent.length > 0) {
      log.debug('proactive: preRoutineGapProbe -- already fired today', { routineId })
      continue
    }

    let recallCount = 0
    try {
      const { results } = await recall(topic, 'knowledge', 5)
      recallCount = results.length

      if (recallCount >= 2) {
        log.debug('proactive: preRoutineGapProbe -- sufficient context', { routineId, recallCount })
        continue
      }
    } catch (err) {
      // vec-server down -- fail gracefully, do not fire
      log.warn('proactive: preRoutineGapProbe -- recall failed, skipping', {
        routineId,
        err: String(err),
      })
      continue
    }

    // Gap detected -- post Discord embed
    const routineName = formatRoutineId(routineId)

    const embed = buildRichEmbed({
      emoji: '🔍',
      title: `Low context: ${routineName}.`,
      subtitle: '',
      narrative: `Fewer than 2 recalled facts for the upcoming ${routineName}. You may wish to add context before it fires.`,
      color: 0xFEE75C,
    })

    try {
      await postProactive(null, { embed })
    } catch (err) {
      log.warn('proactive: preRoutineGapProbe -- postProactive failed', {
        routineId,
        err: String(err),
      })
      continue
    }

    logEvent(cooldownKey, 'proactive_fired', {
      trigger: 'pre_routine_gap_probe',
      routine: routineId,
      recall_count: recallCount,
    })

    log.info('proactive: preRoutineGapProbe fired', { routineId, minutesUntil, recallCount })
    anyFired = true
  }

  return anyFired
}
