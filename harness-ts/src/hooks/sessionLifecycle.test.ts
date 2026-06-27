import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import type { IonSDK, IonContext } from 'ion-sdk'
import { lastReply } from './state'
import { triggerMemoryConsolidation, __resetConsolidationState } from './sessionLifecycle'

const { mockLogEvent, mockExtractFromMeetings, mockWriteSessionJournal, mockRefreshRoster, mockRegisterRosterSpecs, mockInitializeControlRoom } =
  vi.hoisted(() => ({
    mockLogEvent: vi.fn(),
    mockExtractFromMeetings: vi.fn().mockResolvedValue(undefined),
    mockWriteSessionJournal: vi.fn().mockResolvedValue(undefined),
    mockRefreshRoster: vi.fn().mockResolvedValue(undefined),
    mockRegisterRosterSpecs: vi.fn().mockResolvedValue(undefined),
    mockInitializeControlRoom: vi.fn().mockResolvedValue(undefined),
  }))

vi.mock('ion-sdk', () => ({
  log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

vi.mock('../memory/episodic', () => ({
  logEvent: mockLogEvent,
  logMessage: vi.fn(),
  popPendingBrief: vi.fn().mockReturnValue(null),
  getRecentMessages: vi.fn().mockReturnValue([]),
  setPendingImprove: vi.fn(),
  recordError: vi.fn(),
}))

vi.mock('../learning', () => ({
  extractFromMeetings: mockExtractFromMeetings,
  extractAndStore: vi.fn().mockResolvedValue(undefined),
  detectGapForMessage: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../sessions', () => ({
  writeSessionJournal: mockWriteSessionJournal,
  sessionLogMessage: vi.fn(),
  getRecentJournalContext: vi.fn().mockReturnValue(null),
}))

vi.mock('../staff/roster', () => ({
  refreshRoster: mockRefreshRoster,
  registerRosterSpecs: mockRegisterRosterSpecs,
}))

vi.mock('../staff/init', () => ({
  initializeControlRoom: mockInitializeControlRoom,
}))

import { wireSessionLifecycle } from './sessionLifecycle'

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

function makeCtx(
  sessionKey = 'test-session',
  runOnceFn?: (id: string, opts: unknown, fn: () => Promise<unknown>) => Promise<unknown>,
): IonContext {
  // Default runOnce: execute the fn and return { executed: true }.
  const defaultRunOnce = async (_id: string, _opts: unknown, fn: () => Promise<unknown>) => {
    await fn()
    return { executed: true }
  }
  return {
    sessionKey,
    emit: vi.fn(),
    sendMessage: vi.fn(),
    cleanStaleProcesses: vi.fn().mockResolvedValue(undefined),
    suppressTool: vi.fn().mockResolvedValue(undefined),
    discoverAgents: vi.fn().mockResolvedValue(undefined),
    runOnce: runOnceFn ?? defaultRunOnce,
    cwd: '/test',
    model: null,
    config: {} as any,
  } as unknown as IonContext
}

describe('wireSessionLifecycle: session_start', () => {
  beforeEach(() => {
    lastReply.clear()
    vi.clearAllMocks()
  })

  it('logs a session_start event to episodic', () => {
    const { ion, fire } = makeIon()
    wireSessionLifecycle(ion)
    const ctx = makeCtx()
    fire('session_start', ctx)

    expect(mockLogEvent).toHaveBeenCalledWith(
      'test-session',
      'session_start',
      expect.objectContaining({ ion_session: 'test-session' }),
    )
  })
})

describe('wireSessionLifecycle: session_start roster runOnce dedup', () => {
  beforeEach(() => {
    lastReply.clear()
    vi.clearAllMocks()
  })

  it('calls refreshRoster and initializeControlRoom when runOnce executes', async () => {
    const { ion, fire } = makeIon()
    wireSessionLifecycle(ion)
    // Default ctx: runOnce runs fn → executed: true
    const ctx = makeCtx()

    await fire('session_start', ctx)

    expect(mockRefreshRoster).toHaveBeenCalledOnce()
    expect(mockInitializeControlRoom).toHaveBeenCalledOnce()
  })

  it('skips refreshRoster but still calls initializeControlRoom when runOnce returns debounced', async () => {
    const { ion, fire } = makeIon()
    wireSessionLifecycle(ion)
    // runOnce returns debounced — another instance already refreshed recently
    const ctx = makeCtx('test-session', async () => ({ executed: false, reason: 'debounced' as const }))

    await fire('session_start', ctx)

    expect(mockRefreshRoster).not.toHaveBeenCalled()
    expect(mockInitializeControlRoom).toHaveBeenCalledOnce()
  })

  it('falls back to direct refreshRoster when runOnce is unavailable (throws)', async () => {
    const { ion, fire } = makeIon()
    wireSessionLifecycle(ion)
    // runOnce throws (old engine build)
    const ctx = makeCtx('test-session', async () => {
      throw new Error('ext/run_once_check not found')
    })

    await fire('session_start', ctx)

    expect(mockRefreshRoster).toHaveBeenCalledOnce()
    expect(mockInitializeControlRoom).toHaveBeenCalledOnce()
  })

  it('calls refreshRoster directly when runOnce returns in_progress', async () => {
    const { ion, fire } = makeIon()
    wireSessionLifecycle(ion)
    // in_progress: another instance is mid-refresh; we do our own to avoid empty roster
    const ctx = makeCtx('test-session', async () => ({ executed: false, reason: 'in_progress' as const }))

    await fire('session_start', ctx)

    expect(mockRefreshRoster).toHaveBeenCalledOnce()
    expect(mockInitializeControlRoom).toHaveBeenCalledOnce()
  })

  it('always calls initializeControlRoom regardless of runOnce result (suppressTool is inside initializeControlRoom)', async () => {
    const { ion, fire } = makeIon()
    wireSessionLifecycle(ion)
    const ctx = makeCtx('test-session', async () => ({ executed: false, reason: 'debounced' as const }))

    await fire('session_start', ctx)

    // suppressTool is now called inside initializeControlRoom (which is mocked here).
    // Verify initializeControlRoom was invoked; live-Mini test verifies suppressTool fires.
    expect(mockInitializeControlRoom).toHaveBeenCalledWith(ctx)
  })
})

describe('wireSessionLifecycle: session_end', () => {
  beforeEach(() => {
    lastReply.clear()
    vi.clearAllMocks()
  })

  it('removes the session lastReply entry', async () => {
    const { ion, fire } = makeIon()
    wireSessionLifecycle(ion)
    const ctx = makeCtx()
    lastReply.set('test-session', 'goodbye')

    await fire('session_end', ctx)

    expect(lastReply.has('test-session')).toBe(false)
  })

  it('calls extractFromMeetings for the session', async () => {
    const { ion, fire } = makeIon()
    wireSessionLifecycle(ion)
    const ctx = makeCtx()

    await fire('session_end', ctx)

    expect(mockExtractFromMeetings).toHaveBeenCalledWith('test-session')
  })

  it('calls writeSessionJournal for the session', async () => {
    const { ion, fire } = makeIon()
    wireSessionLifecycle(ion)
    const ctx = makeCtx()

    await fire('session_end', ctx)

    expect(mockWriteSessionJournal).toHaveBeenCalledWith('test-session')
  })

  it('logs a session_end event to episodic', async () => {
    const { ion, fire } = makeIon()
    wireSessionLifecycle(ion)
    const ctx = makeCtx()

    await fire('session_end', ctx)

    expect(mockLogEvent).toHaveBeenCalledWith(
      'test-session',
      'session_end',
      expect.objectContaining({ ion_session: 'test-session' }),
    )
  })

  it('does not throw when extractFromMeetings rejects', async () => {
    mockExtractFromMeetings.mockRejectedValueOnce(new Error('vec down'))
    const { ion, fire } = makeIon()
    wireSessionLifecycle(ion)
    const ctx = makeCtx()

    await expect(fire('session_end', ctx)).resolves.not.toThrow()
  })
})

describe('wireSessionLifecycle: message_update', () => {
  beforeEach(() => {
    lastReply.clear()
    vi.clearAllMocks()
  })

  it('stores assistant reply in lastReply', () => {
    const { ion, fire } = makeIon()
    wireSessionLifecycle(ion)
    const ctx = makeCtx()

    fire('message_update', ctx, { role: 'assistant', content: 'Very good, sir.' })

    expect(lastReply.get('test-session')).toBe('Very good, sir.')
  })

  it('overwrites a prior reply with the latest content', () => {
    const { ion, fire } = makeIon()
    wireSessionLifecycle(ion)
    const ctx = makeCtx()

    fire('message_update', ctx, { role: 'assistant', content: 'First.' })
    fire('message_update', ctx, { role: 'assistant', content: 'Second.' })

    expect(lastReply.get('test-session')).toBe('Second.')
  })

  it('ignores non-assistant roles', () => {
    const { ion, fire } = makeIon()
    wireSessionLifecycle(ion)
    const ctx = makeCtx()

    fire('message_update', ctx, { role: 'user', content: 'Hello.' })

    expect(lastReply.has('test-session')).toBe(false)
  })

  it('stores replies independently per session', () => {
    const { ion, fire } = makeIon()
    wireSessionLifecycle(ion)
    const ctxA = makeCtx('sess-a')
    const ctxB = makeCtx('sess-b')

    fire('message_update', ctxA, { role: 'assistant', content: 'Reply A.' })
    fire('message_update', ctxB, { role: 'assistant', content: 'Reply B.' })

    expect(lastReply.get('sess-a')).toBe('Reply A.')
    expect(lastReply.get('sess-b')).toBe('Reply B.')
  })
})

describe('wireSessionLifecycle: task_created / task_completed', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('logs task_created to episodic', () => {
    const { ion, fire } = makeIon()
    wireSessionLifecycle(ion)
    const ctx = makeCtx()
    fire('task_created', ctx, { task_id: 'abc', name: 'Write tests' })
    expect(mockLogEvent).toHaveBeenCalledWith(
      'test-session',
      'task_created',
      expect.objectContaining({ task_id: 'abc', name: 'Write tests' }),
    )
  })

  it('logs task_completed with status to episodic', () => {
    const { ion, fire } = makeIon()
    wireSessionLifecycle(ion)
    const ctx = makeCtx()
    fire('task_completed', ctx, { task_id: 'abc', name: 'Write tests', status: 'done' })
    expect(mockLogEvent).toHaveBeenCalledWith(
      'test-session',
      'task_completed',
      expect.objectContaining({ task_id: 'abc', status: 'done' }),
    )
  })

  it('is a no-op for task_created when info is null', () => {
    const { ion, fire } = makeIon()
    wireSessionLifecycle(ion)
    const ctx = makeCtx()
    expect(() => fire('task_created', ctx, null)).not.toThrow()
    expect(mockLogEvent).not.toHaveBeenCalledWith(expect.anything(), 'task_created', expect.anything())
  })
})

describe('wireSessionLifecycle: on_error', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('logs every error to episodic', () => {
    const { ion, fire } = makeIon()
    wireSessionLifecycle(ion)
    const ctx = makeCtx()
    fire('on_error', ctx, {
      message: 'provider timeout',
      category: 'provider_error',
      retryable: true,
      httpStatus: 503,
    })
    expect(mockLogEvent).toHaveBeenCalledWith(
      'test-session',
      'on_error',
      expect.objectContaining({ message: 'provider timeout', category: 'provider_error', http_status: 503 }),
    )
  })

  it('does not sendMessage below threshold', () => {
    const { ion, fire } = makeIon()
    wireSessionLifecycle(ion)
    const ctx = makeCtx('err-session-1')
    const info = { message: 'fail', category: 'provider_error' as const }
    fire('on_error', ctx, info)
    fire('on_error', ctx, info)
    expect(ctx.sendMessage).not.toHaveBeenCalled()
  })

  it('sends a warning message after 3 consecutive provider_errors', () => {
    const { ion, fire } = makeIon()
    wireSessionLifecycle(ion)
    const ctx = makeCtx('err-session-2')
    const info = { message: 'fail', category: 'provider_error' as const }
    fire('on_error', ctx, info)
    fire('on_error', ctx, info)
    fire('on_error', ctx, info)
    expect(ctx.sendMessage).toHaveBeenCalledOnce()
    expect(ctx.sendMessage).toHaveBeenCalledWith(expect.stringContaining('provider errors'))
  })

  it('sends the warning only once even with more errors', () => {
    const { ion, fire } = makeIon()
    wireSessionLifecycle(ion)
    const ctx = makeCtx('err-session-3')
    const info = { message: 'fail', category: 'provider_error' as const }
    for (let i = 0; i < 5; i++) fire('on_error', ctx, info)
    expect(ctx.sendMessage).toHaveBeenCalledOnce()
  })

  it('does not send warning for non-provider_error categories', () => {
    const { ion, fire } = makeIon()
    wireSessionLifecycle(ion)
    const ctx = makeCtx('err-session-4')
    for (let i = 0; i < 5; i++) {
      fire('on_error', ctx, { message: 'tool fail', category: 'tool_error' as const })
    }
    expect(ctx.sendMessage).not.toHaveBeenCalled()
  })

  it('is a no-op when info is null', () => {
    const { ion, fire } = makeIon()
    wireSessionLifecycle(ion)
    const ctx = makeCtx()
    expect(() => fire('on_error', ctx, null)).not.toThrow()
    expect(mockLogEvent).not.toHaveBeenCalledWith(expect.anything(), 'on_error', expect.anything())
  })
})

describe('wireSessionLifecycle: session_before_compact', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('logs session_before_compact to episodic', () => {
    const { ion, fire } = makeIon()
    wireSessionLifecycle(ion)
    const ctx = makeCtx()
    fire('session_before_compact', ctx, { strategy: 'auto', messagesBefore: 42, messagesAfter: 0 })
    expect(mockLogEvent).toHaveBeenCalledWith(
      'test-session',
      'session_before_compact',
      expect.objectContaining({ strategy: 'auto', messages_before: 42 }),
    )
  })

  it('logs reactive strategy', () => {
    const { ion, fire } = makeIon()
    wireSessionLifecycle(ion)
    const ctx = makeCtx()
    fire('session_before_compact', ctx, { strategy: 'reactive', messagesBefore: 10, messagesAfter: 0 })
    expect(mockLogEvent).toHaveBeenCalledWith(
      'test-session',
      'session_before_compact',
      expect.objectContaining({ strategy: 'reactive', messages_before: 10 }),
    )
  })

  it('is a no-op when info is null', () => {
    const { ion, fire } = makeIon()
    wireSessionLifecycle(ion)
    const ctx = makeCtx()
    expect(() => fire('session_before_compact', ctx, null)).not.toThrow()
    expect(mockLogEvent).not.toHaveBeenCalledWith(expect.anything(), 'session_before_compact', expect.anything())
  })
})

describe('wireSessionLifecycle: session_compact', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    __resetConsolidationState()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    __resetConsolidationState()
  })

  it('logs session_compact with before and after counts to episodic', async () => {
    const { ion, fire } = makeIon()
    wireSessionLifecycle(ion)
    const ctx = makeCtx()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }))
    fire('session_compact', ctx, { strategy: 'auto', messagesBefore: 80, messagesAfter: 12 })
    await vi.waitFor(() => {
      expect(mockLogEvent).toHaveBeenCalledWith(
        'test-session',
        'session_compact',
        expect.objectContaining({ strategy: 'auto', messages_before: 80, messages_after: 12 }),
      )
    })
  })

  it('is a no-op when info is null', async () => {
    const { ion, fire } = makeIon()
    wireSessionLifecycle(ion)
    const ctx = makeCtx()
    expect(() => fire('session_compact', ctx, null)).not.toThrow()
    expect(mockLogEvent).not.toHaveBeenCalledWith(expect.anything(), 'session_compact', expect.anything())
  })

  it('triggers memory consolidation on first session_compact', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    vi.stubGlobal('fetch', mockFetch)
    const { ion, fire } = makeIon()
    wireSessionLifecycle(ion)
    const ctx = makeCtx()
    fire('session_compact', ctx, { strategy: 'auto', messagesBefore: 80, messagesAfter: 12 })
    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        'http://127.0.0.1:9876/consolidate',
        expect.objectContaining({ method: 'POST' }),
      )
    })
  })

  it('logs memory_consolidation_started event on fire', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    vi.stubGlobal('fetch', mockFetch)
    const { ion, fire } = makeIon()
    wireSessionLifecycle(ion)
    const ctx = makeCtx()
    fire('session_compact', ctx, { strategy: 'auto', messagesBefore: 80, messagesAfter: 12 })
    await vi.waitFor(() => {
      expect(mockLogEvent).toHaveBeenCalledWith(
        'memory_consolidation',
        'memory_consolidation_started',
        expect.objectContaining({ source: 'session_compact' }),
      )
    })
  })

  it('logs memory_consolidation_complete event on success with duration', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    vi.stubGlobal('fetch', mockFetch)
    const { ion, fire } = makeIon()
    wireSessionLifecycle(ion)
    const ctx = makeCtx()
    fire('session_compact', ctx, { strategy: 'auto', messagesBefore: 80, messagesAfter: 12 })
    await vi.waitFor(() => {
      expect(mockLogEvent).toHaveBeenCalledWith(
        'memory_consolidation',
        'memory_consolidation_complete',
        expect.objectContaining({ source: 'session_compact', duration_ms: expect.any(Number) }),
      )
    })
  })

  it('respects 5-minute cooldown on second fire', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    vi.stubGlobal('fetch', mockFetch)
    vi.useFakeTimers()
    try {
      const { ion, fire } = makeIon()
      wireSessionLifecycle(ion)
      const ctx = makeCtx()

      // First fire should trigger fetch
      fire('session_compact', ctx, { strategy: 'auto', messagesBefore: 80, messagesAfter: 12 })
      await vi.runAllTimersAsync()
      expect(mockFetch).toHaveBeenCalledTimes(1)

      // Reset mock and advance time by 2 minutes (still in cooldown)
      mockFetch.mockClear()
      vi.advanceTimersByTime(2 * 60 * 1000)

      // Second fire should NOT trigger fetch
      fire('session_compact', ctx, { strategy: 'auto', messagesBefore: 80, messagesAfter: 12 })
      await vi.runAllTimersAsync()
      expect(mockFetch).not.toHaveBeenCalled()

      // Advance time by 4 more minutes (total 6 > 5, cooldown should be clear)
      mockFetch.mockClear()
      vi.advanceTimersByTime(4 * 60 * 1000)

      // Third fire should trigger fetch again
      fire('session_compact', ctx, { strategy: 'auto', messagesBefore: 80, messagesAfter: 12 })
      await vi.runAllTimersAsync()
      expect(mockFetch).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('logs failed consolidation on fetch error', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('network unavailable'))
    vi.stubGlobal('fetch', mockFetch)
    const { ion, fire } = makeIon()
    wireSessionLifecycle(ion)
    const ctx = makeCtx()
    fire('session_compact', ctx, { strategy: 'auto', messagesBefore: 80, messagesAfter: 12 })
    await vi.waitFor(() => {
      expect(mockLogEvent).toHaveBeenCalledWith(
        'memory_consolidation',
        'memory_consolidation_failed',
        expect.objectContaining({ source: 'session_compact', err: expect.stringContaining('network unavailable') }),
      )
    })
  })

  it('logs failed consolidation on non-200 http status', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: 'Internal Server Error' })
    vi.stubGlobal('fetch', mockFetch)
    const { ion, fire } = makeIon()
    wireSessionLifecycle(ion)
    const ctx = makeCtx()
    fire('session_compact', ctx, { strategy: 'auto', messagesBefore: 80, messagesAfter: 12 })
    await vi.waitFor(() => {
      expect(mockLogEvent).toHaveBeenCalledWith(
        'memory_consolidation',
        'memory_consolidation_failed',
        expect.objectContaining({ source: 'session_compact', http_status: 500 }),
      )
    })
  })

  it('does not rethrow consolidation errors', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('catastrophic'))
    vi.stubGlobal('fetch', mockFetch)
    const { ion, fire } = makeIon()
    wireSessionLifecycle(ion)
    const ctx = makeCtx()
    expect(() => fire('session_compact', ctx, { strategy: 'auto', messagesBefore: 80, messagesAfter: 12 })).not.toThrow()
  })

  it('uses VEC_SERVER env var when set', async () => {
    const originalVecServer = process.env['VEC_SERVER']
    process.env['VEC_SERVER'] = 'http://custom-vec:9876'
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    vi.stubGlobal('fetch', mockFetch)
    try {
      const { ion, fire } = makeIon()
      wireSessionLifecycle(ion)
      const ctx = makeCtx()
      fire('session_compact', ctx, { strategy: 'auto', messagesBefore: 80, messagesAfter: 12 })
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(mockFetch).toHaveBeenCalledWith(
        'http://custom-vec:9876/consolidate',
        expect.objectContaining({ method: 'POST' }),
      )
    } finally {
      if (originalVecServer !== undefined) {
        process.env['VEC_SERVER'] = originalVecServer
      } else {
        delete process.env['VEC_SERVER']
      }
    }
  })
})

describe('triggerMemoryConsolidation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    __resetConsolidationState()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    __resetConsolidationState()
  })

  it('calls consolidate endpoint on the VEC_SERVER', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    vi.stubGlobal('fetch', mockFetch)
    await triggerMemoryConsolidation()
    expect(mockFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:9876/consolidate',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('uses AbortSignal.timeout in the request', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    vi.stubGlobal('fetch', mockFetch)
    await triggerMemoryConsolidation()
    const call = mockFetch.mock.calls.at(0)
    expect(call).toBeDefined()
    expect(call?.[1]).toHaveProperty('signal')
  })

  it('logs events on success', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    vi.stubGlobal('fetch', mockFetch)
    await triggerMemoryConsolidation()
    expect(mockLogEvent).toHaveBeenCalledWith(
      'memory_consolidation',
      'memory_consolidation_started',
      expect.objectContaining({ source: 'session_compact' }),
    )
    expect(mockLogEvent).toHaveBeenCalledWith(
      'memory_consolidation',
      'memory_consolidation_complete',
      expect.objectContaining({ source: 'session_compact', duration_ms: expect.any(Number) }),
    )
  })

  it('logs events on fetch error', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('net error'))
    vi.stubGlobal('fetch', mockFetch)
    await triggerMemoryConsolidation()
    expect(mockLogEvent).toHaveBeenCalledWith(
      'memory_consolidation',
      'memory_consolidation_failed',
      expect.objectContaining({ source: 'session_compact', err: expect.stringContaining('net error') }),
    )
  })
})
