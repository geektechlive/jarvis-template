import { describe, it, expect } from 'vitest'

import { parseStampedStoredAtMs } from './watch'

// jarvis#850: the daily_newsdesk 24h freshness window depends on correctly
// parsing the caller-stamped `stored_at` field. A naive `new Date(stored_at)`
// returns NaN (the field is "[YYYY-MM-DD HH:MM TZ] <text>", not ISO), which
// would silently disable the cutoff and re-post 14-day-TTL items daily.
describe('parseStampedStoredAtMs', () => {
  it('parses a caller-stamped stored_at prefix to epoch ms', () => {
    const ms = parseStampedStoredAtMs('[2026-06-21 08:30 CDT] [AI] Some headline: desc')
    expect(ms).not.toBeNull()
    expect(new Date(ms as number).getFullYear()).toBe(2026)
  })

  it('parses a bare ISO stored_at (Python-written rows)', () => {
    expect(parseStampedStoredAtMs('2026-06-21T08:30:00+00:00')).not.toBeNull()
  })

  it('returns null for an unparseable stamp so callers can fail open', () => {
    expect(parseStampedStoredAtMs('not a date at all')).toBeNull()
    expect(parseStampedStoredAtMs('')).toBeNull()
  })

  it('drives a 24h freshness cutoff correctly (TZ-agnostic relative compare)', () => {
    // Use local-time parsing on both sides so the assertion holds in any runner TZ.
    const now = Date.parse('2026-06-21T12:00:00')
    const cutoff = now - 24 * 60 * 60 * 1000
    const fresh = parseStampedStoredAtMs('[2026-06-21 06:00 CDT] fresh item')
    const stale = parseStampedStoredAtMs('[2026-06-19 06:00 CDT] stale item')
    expect(fresh).not.toBeNull()
    expect(stale).not.toBeNull()
    expect((fresh as number) >= cutoff).toBe(true)
    expect((stale as number) >= cutoff).toBe(false)
  })
})
