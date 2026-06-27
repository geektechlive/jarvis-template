import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { IonSDK, IonContext } from 'ion-sdk'
import { lastReply, sessionTurnNumber, sessionTurnCounts } from './state'

const ORIGINAL_FETCH = globalThis.fetch

const { mockAuditReply, mockLogEvent, mockLogMessage, mockSessionLogMessage, mockExtractAndStore, mockDetectMemoryCorrection } = vi.hoisted(
  () => ({
    mockAuditReply: vi.fn().mockReturnValue({ passed: true, violations: [] }),
    mockLogEvent: vi.fn(),
    mockLogMessage: vi.fn(),
    mockSessionLogMessage: vi.fn(),
    mockExtractAndStore: vi.fn().mockResolvedValue(undefined),
    mockDetectMemoryCorrection: vi.fn().mockResolvedValue(undefined),
  }),
)

vi.mock('ion-sdk', () => ({
  log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

vi.mock('../persona/audit', () => ({
  auditReply: mockAuditReply,
  bannedTokenEnforcement: vi.fn().mockReturnValue(''),
}))

vi.mock('../memory/episodic', () => ({
  logEvent: mockLogEvent,
  logMessage: mockLogMessage,
  popPendingBrief: vi.fn().mockReturnValue(null),
  recordError: vi.fn(),
  recordPerfMetric: vi.fn(),
}))

vi.mock('../sessions', () => ({
  sessionLogMessage: mockSessionLogMessage,
  writeSessionJournal: vi.fn().mockResolvedValue(undefined),
  getRecentJournalContext: vi.fn().mockReturnValue(null),
}))

vi.mock('../learning', () => ({
  extractAndStore: mockExtractAndStore,
  extractFromMeetings: vi.fn().mockResolvedValue(undefined),
  detectGapForMessage: vi.fn().mockResolvedValue(undefined),
  detectMemoryCorrection: mockDetectMemoryCorrection,
}))

import { wireTurnLifecycle } from './turnLifecycle'

function makeIon(): { ion: IonSDK; fire: (event: string, ctx: IonContext, info?: unknown) => unknown } {
  const handlers = new Map<string, Function>()
  const ion = {
    on(event: string, handler: Function) {
      handlers.set(event, handler)
    },
  } as unknown as IonSDK
  return {
    ion,
    fire: (event, ctx, info?) => handlers.get(event)?.(ctx, info),
  }
}

function makeCtx(sessionKey = 'test-session'): IonContext {
  return {
    sessionKey,
    emit: vi.fn(),
    sendMessage: vi.fn(),
    cwd: '/test',
    model: null,
    config: {} as any,
  } as unknown as IonContext
}

describe('wireTurnLifecycle: turn_end', () => {
  beforeEach(() => {
    lastReply.clear()
    sessionTurnCounts.clear()
    vi.clearAllMocks()
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 200 }))
  })

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH
  })

  it('logs the assistant reply to episodic when a reply is present', () => {
    const { ion, fire } = makeIon()
    wireTurnLifecycle(ion)
    const ctx = makeCtx()
    lastReply.set('test-session', 'Very good, sir.')

    fire('turn_end', ctx, { turnNumber: 1 })

    expect(mockLogMessage).toHaveBeenCalledWith(
      'test-session',
      'assistant',
      'Very good, sir.',
      'test-session',
    )
  })

  it('logs the assistant reply to the session journal buffer', () => {
    const { ion, fire } = makeIon()
    wireTurnLifecycle(ion)
    const ctx = makeCtx()
    lastReply.set('test-session', 'Indeed.')

    fire('turn_end', ctx, { turnNumber: 2 })

    expect(mockSessionLogMessage).toHaveBeenCalledWith('test-session', 'assistant', 'Indeed.')
  })

  it('calls auditReply with the assistant reply', () => {
    const { ion, fire } = makeIon()
    wireTurnLifecycle(ion)
    const ctx = makeCtx()
    lastReply.set('test-session', 'Certainly not.')

    fire('turn_end', ctx, { turnNumber: 3 })

    expect(mockAuditReply).toHaveBeenCalledWith('Certainly not.')
  })

  it('fires the voice fetch endpoint as fire-and-forget', () => {
    const { ion, fire } = makeIon()
    wireTurnLifecycle(ion)
    const ctx = makeCtx()
    lastReply.set('test-session', 'A fine observation.')

    fire('turn_end', ctx, { turnNumber: 4 })

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:9877/speak',
      expect.objectContaining({ method: 'POST' }),
    )
    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string) as { text: string }
    expect(body.text).toBe('A fine observation.')
  })

  it('fires extractAndStore fire-and-forget after the 4th turn (deferred cadence)', async () => {
    const { ion, fire } = makeIon()
    wireTurnLifecycle(ion)
    const ctx = makeCtx()
    lastReply.set('test-session', 'Right.')

    // Cadence: first extraction at turn count 4, then every 3 (4, 7, 10...).
    // Fire 4 turn_ends so sessionTurnCounts reaches the first threshold.
    fire('turn_end', ctx, { turnNumber: 1 })
    fire('turn_end', ctx, { turnNumber: 2 })
    fire('turn_end', ctx, { turnNumber: 3 })
    fire('turn_end', ctx, { turnNumber: 4 })

    // extractAndStore is chained after detectMemoryCorrection resolves -- flush microtasks
    await Promise.resolve()
    await Promise.resolve()

    expect(mockExtractAndStore).toHaveBeenCalledWith('test-session')
  })

  it('does not fire extractAndStore before the 4th turn', async () => {
    const { ion, fire } = makeIon()
    wireTurnLifecycle(ion)
    const ctx = makeCtx()
    lastReply.set('test-session', 'Right.')

    fire('turn_end', ctx, { turnNumber: 1 })
    fire('turn_end', ctx, { turnNumber: 2 })
    fire('turn_end', ctx, { turnNumber: 3 })

    await Promise.resolve()
    await Promise.resolve()

    expect(mockExtractAndStore).not.toHaveBeenCalled()
  })

  it('fires detectMemoryCorrection on every turn_end', () => {
    const { ion, fire } = makeIon()
    wireTurnLifecycle(ion)
    const ctx = makeCtx()
    lastReply.set('test-session', 'Right.')

    fire('turn_end', ctx, { turnNumber: 5 })

    expect(mockDetectMemoryCorrection).toHaveBeenCalledWith('test-session')
    expect(mockExtractAndStore).not.toHaveBeenCalled() // only at cadence turns (4, 7, 10...)
  })

  it('logs a turn_end event to episodic regardless of reply presence', () => {
    const { ion, fire } = makeIon()
    wireTurnLifecycle(ion)
    const ctx = makeCtx()

    fire('turn_end', ctx, { turnNumber: 6 })

    expect(mockLogEvent).toHaveBeenCalledWith(
      'test-session',
      'turn_end',
      expect.objectContaining({ turn: 6 }),
    )
  })

  it('skips logging and audit when no reply is in lastReply', () => {
    const { ion, fire } = makeIon()
    wireTurnLifecycle(ion)
    const ctx = makeCtx()

    fire('turn_end', ctx, { turnNumber: 7 })

    expect(mockLogMessage).not.toHaveBeenCalled()
    expect(mockAuditReply).not.toHaveBeenCalled()
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('does not throw when the voice server fetch rejects', () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    const { ion, fire } = makeIon()
    wireTurnLifecycle(ion)
    const ctx = makeCtx()
    lastReply.set('test-session', 'Hello.')

    expect(() => fire('turn_end', ctx, { turnNumber: 8 })).not.toThrow()
  })
})

// Agent-dispatch flipping is gone (the engine's built-in Agent tool owns
// engine_agent_state); turn_start now only records the turn number.
describe('wireTurnLifecycle: turn_start', () => {
  beforeEach(() => {
    lastReply.clear()
    sessionTurnNumber.clear()
    vi.clearAllMocks()
  })

  it('records the turn number for the session', () => {
    const { ion, fire } = makeIon()
    wireTurnLifecycle(ion)
    const ctx = makeCtx()

    fire('turn_start', ctx, { turnNumber: 4 })

    expect(sessionTurnNumber.get('test-session')).toBe(4)
  })

})
