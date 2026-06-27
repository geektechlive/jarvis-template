// Escalating reminders (#542): urgency-tiered follow-up intervals.
//
// A reminder's urgency tier is fixed by its LEAD TIME (fire_at - created_at):
// a short-fuse reminder nags frequently, a long-lead one nags slowly. Each tier
// has a per-level interval schedule (level 1, 2, 3+); the schedule is set per the
// spec table and is not necessarily monotonic. Escalation stops when the user
// dismisses/cancels, the cap is reached, or the reminder is otherwise resolved.

export type UrgencyTier = 'CRITICAL' | 'URGENT' | 'NORMAL' | 'LOW'

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000

/**
 * Classify a reminder by lead time (ms between creation and the initial fire).
 *   < 4h CRITICAL | 4–12h URGENT | 12–48h NORMAL | > 48h LOW
 * Negative/zero lead (created at or after fire_at) is treated as CRITICAL.
 */
export function classifyUrgency(leadMs: number): UrgencyTier {
  const hours = leadMs / HOUR_MS
  if (hours < 4) return 'CRITICAL'
  if (hours < 12) return 'URGENT'
  if (hours < 48) return 'NORMAL'
  return 'LOW'
}

// Per-tier re-fire intervals in minutes, indexed by escalation level (1, 2, 3+).
const TIER_INTERVALS_MIN: Record<UrgencyTier, readonly [number, number, number]> = {
  CRITICAL: [15, 30, 15],
  URGENT: [60, 45, 30],
  NORMAL: [240, 120, 60],
  LOW: [1440, 720, 360],
}

/**
 * Interval (ms) to wait before the re-fire at the given 1-indexed escalation
 * level. Levels >= 3 use the third column; levels < 1 are clamped to 1.
 */
export function escalationIntervalMs(tier: UrgencyTier, level: number): number {
  const [l1, l2, l3] = TIER_INTERVALS_MIN[tier]
  const minutes = level <= 1 ? l1 : level === 2 ? l2 : l3
  return minutes * MINUTE_MS
}

// Active-hours window for escalation re-fires (CT). A re-fire that would land
// outside [START, END) is deferred to the next START:00 CT so the user is not
// nagged overnight. The user's explicit initial fire_at is NOT gated -- only the
// escalation follow-ups are.
export const ACTIVE_START_HOUR = 7
export const ACTIVE_END_HOUR = 22

function ctHour(d: Date): number {
  return parseInt(
    d.toLocaleString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hour12: false }),
    10,
  )
}

function ctMinute(d: Date): number {
  return parseInt(d.toLocaleString('en-US', { timeZone: 'America/Chicago', minute: 'numeric' }), 10)
}

/**
 * If `d` falls inside the active window, return it unchanged. Otherwise defer to
 * the top of the next ACTIVE_START_HOUR:00 CT.
 *
 * Uses fixed-hour arithmetic, which is off by an hour across a DST transition (a
 * 23- or 25-hour day), so it re-checks the result and corrects until it lands
 * inside the window -- without this, the autumn fall-back night lands at 06:00 CT,
 * one hour outside the window. Bounded loop; always returns an in-window time.
 */
export function deferToActiveHours(d: Date): Date {
  let result = d
  for (let i = 0; i < 4; i++) {
    const h = ctHour(result)
    if (h >= ACTIVE_START_HOUR && h < ACTIVE_END_HOUR) return result
    const hoursToAdd = h < ACTIVE_START_HOUR ? ACTIVE_START_HOUR - h : 24 - h + ACTIVE_START_HOUR
    const bumped = new Date(result.getTime() + hoursToAdd * HOUR_MS)
    // Land on the top of the active-start hour for tidiness.
    result = new Date(bumped.getTime() - ctMinute(bumped) * MINUTE_MS)
  }
  return result
}

/**
 * Compute the next re-fire timestamp for a reminder escalating to `nextLevel`,
 * measured from `from`, then deferred out of quiet hours.
 */
export function nextEscalationAt(tier: UrgencyTier, nextLevel: number, from: Date): Date {
  const target = new Date(from.getTime() + escalationIntervalMs(tier, nextLevel))
  return deferToActiveHours(target)
}
