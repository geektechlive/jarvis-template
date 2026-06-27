import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { lastReply, sessionTurnNumber, touchSession, evictStale, clearSessionState } from './state'

const SIX_HOURS = 6 * 60 * 60 * 1000
const SEVEN_HOURS = 7 * 60 * 60 * 1000

// sessionTouched is private (not exported). Evicting with a maximally negative
// maxAgeMs sets cutoff = Date.now() + MAX_SAFE_INTEGER, which is larger than any
// real or fake-time timestamp, so every entry is swept regardless of when it was
// touched. This is the only way to clear sessionTouched between tests.
function flushAllState() {
  evictStale(Number.MIN_SAFE_INTEGER)
  lastReply.clear()
  sessionTurnNumber.clear()
}

describe('state: evictStale', () => {
  beforeEach(() => {
    flushAllState()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('evicts a session touched before the cutoff', () => {
    vi.useFakeTimers()
    touchSession('sess-a')
    lastReply.set('sess-a', 'hello')

    vi.advanceTimersByTime(SEVEN_HOURS)

    const { evicted, remaining } = evictStale(SIX_HOURS)
    expect(evicted).toBe(1)
    expect(remaining).toBe(0)
    expect(lastReply.has('sess-a')).toBe(false)
  })

  it('keeps a session touched after the cutoff', () => {
    vi.useFakeTimers()
    vi.advanceTimersByTime(SEVEN_HOURS)
    touchSession('sess-fresh')

    const { evicted, remaining } = evictStale(SIX_HOURS)
    expect(evicted).toBe(0)
    expect(remaining).toBe(1)
  })

  it('evicts stale and keeps fresh in a mixed set', () => {
    vi.useFakeTimers()
    touchSession('sess-stale')

    vi.advanceTimersByTime(SEVEN_HOURS)
    touchSession('sess-fresh')

    const { evicted, remaining } = evictStale(SIX_HOURS)
    expect(evicted).toBe(1)
    expect(remaining).toBe(1)
  })

  it('returns zero evicted and zero remaining when nothing was touched', () => {
    const { evicted, remaining } = evictStale(SIX_HOURS)
    expect(evicted).toBe(0)
    expect(remaining).toBe(0)
  })

  it('evicts multiple stale sessions in one pass', () => {
    vi.useFakeTimers()
    touchSession('a')
    touchSession('b')
    touchSession('c')
    vi.advanceTimersByTime(SEVEN_HOURS)

    const { evicted, remaining } = evictStale(SIX_HOURS)
    expect(evicted).toBe(3)
    expect(remaining).toBe(0)
  })
})

describe('state: clearSessionState', () => {
  beforeEach(() => {
    flushAllState()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('removes a session from the touched map so it is not later evicted', () => {
    vi.useFakeTimers()
    touchSession('sess-clear')
    clearSessionState('sess-clear')
    vi.advanceTimersByTime(SEVEN_HOURS)

    const { evicted } = evictStale(SIX_HOURS)
    expect(evicted).toBe(0)
  })

  it('does not throw for sessions that were never touched', () => {
    expect(() => clearSessionState('unknown-session')).not.toThrow()
  })

  it('only removes the named session, leaving others intact', () => {
    vi.useFakeTimers()
    touchSession('keep')
    touchSession('remove')
    clearSessionState('remove')
    vi.advanceTimersByTime(SEVEN_HOURS)

    const { evicted, remaining } = evictStale(SIX_HOURS)
    // 'keep' is stale, 'remove' was cleared so evict only sees 'keep'
    expect(evicted).toBe(1)
    expect(remaining).toBe(0)
  })

  it('resets sessionTurnNumber to zero for the cleared session', () => {
    sessionTurnNumber.set('sess-turn', 7)
    clearSessionState('sess-turn')
    expect(sessionTurnNumber.has('sess-turn')).toBe(false)
  })

  it('does not affect sessionTurnNumber for other sessions when clearing one', () => {
    sessionTurnNumber.set('sess-keep', 3)
    sessionTurnNumber.set('sess-gone', 5)
    clearSessionState('sess-gone')
    expect(sessionTurnNumber.has('sess-gone')).toBe(false)
    expect(sessionTurnNumber.get('sess-keep')).toBe(3)
  })
})

describe('state: exported maps are shared references', () => {
  beforeEach(() => {
    flushAllState()
  })

  it('lastReply mutations are visible from the same import', () => {
    lastReply.set('s', 'reply-text')
    expect(lastReply.get('s')).toBe('reply-text')
  })

})
