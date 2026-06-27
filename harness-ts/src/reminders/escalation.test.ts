import { describe, it, expect } from 'vitest'
import {
  classifyUrgency,
  escalationIntervalMs,
  deferToActiveHours,
  nextEscalationAt,
} from './escalation'

const H = 3_600_000
const M = 60_000

function ctHour(d: Date): number {
  return parseInt(
    d.toLocaleString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hour12: false }),
    10,
  )
}

describe('classifyUrgency', () => {
  it('classifies by lead time', () => {
    expect(classifyUrgency(1 * H)).toBe('CRITICAL')
    expect(classifyUrgency(3.9 * H)).toBe('CRITICAL')
    expect(classifyUrgency(6 * H)).toBe('URGENT')
    expect(classifyUrgency(11.9 * H)).toBe('URGENT')
    expect(classifyUrgency(24 * H)).toBe('NORMAL')
    expect(classifyUrgency(47.9 * H)).toBe('NORMAL')
    expect(classifyUrgency(72 * H)).toBe('LOW')
  })

  it('treats non-positive lead as CRITICAL', () => {
    expect(classifyUrgency(0)).toBe('CRITICAL')
    expect(classifyUrgency(-5 * H)).toBe('CRITICAL')
  })
})

describe('escalationIntervalMs', () => {
  it('uses per-level columns and clamps level 3+', () => {
    expect(escalationIntervalMs('CRITICAL', 1)).toBe(15 * M)
    expect(escalationIntervalMs('CRITICAL', 2)).toBe(30 * M)
    expect(escalationIntervalMs('CRITICAL', 3)).toBe(15 * M)
    expect(escalationIntervalMs('CRITICAL', 9)).toBe(15 * M)
    expect(escalationIntervalMs('URGENT', 1)).toBe(60 * M)
    expect(escalationIntervalMs('NORMAL', 2)).toBe(120 * M)
    expect(escalationIntervalMs('LOW', 1)).toBe(1440 * M)
    expect(escalationIntervalMs('LOW', 3)).toBe(360 * M)
  })

  it('clamps level below 1 to level 1', () => {
    expect(escalationIntervalMs('URGENT', 0)).toBe(60 * M)
  })
})

describe('deferToActiveHours', () => {
  // June is CDT (UTC-5).
  it('leaves an active-window time unchanged', () => {
    const noonCT = new Date('2026-06-16T17:00:00.000Z') // 12:00 CT
    expect(ctHour(noonCT)).toBe(12)
    expect(deferToActiveHours(noonCT).getTime()).toBe(noonCT.getTime())
  })

  it('defers a late-night time to 07:00 CT', () => {
    const elevenPmCT = new Date('2026-06-17T04:00:00.000Z') // 23:00 CT on 6/16
    expect(ctHour(elevenPmCT)).toBe(23)
    const out = deferToActiveHours(elevenPmCT)
    expect(ctHour(out)).toBe(7)
    expect(out.getTime()).toBeGreaterThan(elevenPmCT.getTime())
  })

  it('defers an early-morning time to 07:00 CT', () => {
    const twoAmCT = new Date('2026-06-16T07:00:00.000Z') // 02:00 CT
    expect(ctHour(twoAmCT)).toBe(2)
    expect(ctHour(deferToActiveHours(twoAmCT))).toBe(7)
  })

  it('still lands inside the window on the autumn DST fall-back night', () => {
    // 2026-11-01 is the US fall-back date (a 25-hour CT day). Fixed-hour
    // arithmetic alone would land at 06:00 CT (one hour out of window); the
    // self-correcting loop must pull it back inside [7, 22).
    const quietFallBackNight = new Date('2026-11-01T08:30:00.000Z') // ~02:30 CST, quiet
    const h = ctHour(deferToActiveHours(quietFallBackNight))
    expect(h).toBeGreaterThanOrEqual(7)
    expect(h).toBeLessThan(22)
  })
})

describe('nextEscalationAt', () => {
  it('adds the level interval then keeps an in-window result', () => {
    const from = new Date('2026-06-16T17:00:00.000Z') // 12:00 CT
    expect(nextEscalationAt('CRITICAL', 1, from).getTime()).toBe(from.getTime() + 15 * M)
  })

  it('defers a re-fire that would land overnight', () => {
    const from = new Date('2026-06-17T03:30:00.000Z') // 22:30 CT on 6/16
    // NORMAL L1 = 4h -> 02:30 CT, inside quiet hours -> deferred to 07:00 CT.
    expect(ctHour(nextEscalationAt('NORMAL', 1, from))).toBe(7)
  })
})
