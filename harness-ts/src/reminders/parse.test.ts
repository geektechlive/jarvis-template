import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { parseReminderInput, formatReminderConfirmation } from './parse'

// Pin clock to 2026-05-11T14:00:00.000Z (Monday, 9am CT)
const FIXED_NOW = new Date('2026-05-11T14:00:00.000Z')

describe('parseReminderInput', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(FIXED_NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('parses "remind me in 2 hours to call the dentist"', () => {
    const result = parseReminderInput('remind me in 2 hours to call the dentist')
    expect(result).not.toBeNull()
    const fire_at = result!.fire_at
    // fire_at should be ~2 hours from FIXED_NOW
    const diffMs = fire_at.getTime() - FIXED_NOW.getTime()
    expect(diffMs).toBeGreaterThanOrEqual(90 * 60 * 1000)   // at least 90 min
    expect(diffMs).toBeLessThanOrEqual(150 * 60 * 1000)      // at most 150 min
    expect(result!.message.toLowerCase()).toContain('call the dentist')
  })

  it('parses "in 30 minutes check email"', () => {
    const result = parseReminderInput('in 30 minutes check email')
    expect(result).not.toBeNull()
    const diffMs = result!.fire_at.getTime() - FIXED_NOW.getTime()
    expect(diffMs).toBeGreaterThanOrEqual(20 * 60 * 1000)   // at least 20 min
    expect(diffMs).toBeLessThanOrEqual(40 * 60 * 1000)      // at most 40 min
  })

  it('returns null for empty string', () => {
    expect(parseReminderInput('')).toBeNull()
  })

  it('returns null for text with no time expression', () => {
    expect(parseReminderInput('some text with no time expression')).toBeNull()
  })

  it('returns null for a past date', () => {
    // Clock is pinned to 2026-05-11T14:00:00Z (9am CT)
    // Explicit past year bypasses forwardDate resolution
    const result = parseReminderInput('remind me on May 1 2025 at 3pm to do something')
    expect(result).toBeNull()
  })

  it('resolves "at 3pm" to next day when current time is past 3pm CT', () => {
    // Override clock to 2026-05-11T21:00:00Z (4pm CT — past 3pm)
    vi.setSystemTime(new Date('2026-05-11T21:00:00Z'))
    const result = parseReminderInput('remind me at 3pm to check in')
    expect(result).not.toBeNull()
    // Should fire on 2026-05-12 (tomorrow) at 3pm CT = 20:00 UTC
    expect(result!.fire_at.getUTCDate()).toBe(12)
    // Restore clock for subsequent tests
    vi.setSystemTime(new Date('2026-05-11T14:00:00Z'))
  })
})

describe('formatReminderConfirmation', () => {
  it('returns string containing id, message, and CT timezone label', () => {
    const fireAt = new Date('2026-05-11T18:00:00Z')  // 1pm CT
    const result = formatReminderConfirmation(1, fireAt, 'Call dentist')
    expect(result).toContain('#1')
    expect(result).toContain('Call dentist')
    expect(result).toContain('CT')
  })

  it('includes the reminder id when id is greater than 1', () => {
    const fireAt = new Date('2026-05-11T20:00:00Z')
    const result = formatReminderConfirmation(42, fireAt, 'Team standup')
    expect(result).toContain('#42')
    expect(result).toContain('Team standup')
  })
})
