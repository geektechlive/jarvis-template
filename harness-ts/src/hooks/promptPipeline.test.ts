import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { IonSDK, IonContext } from 'ion-sdk'
import { sessionRecallCache } from './state'

const {
  mockBannedTokenEnforcement,
  mockLoadSoul,
  mockRecallMeta,
  mockLogMessage,
  mockPopPendingBrief,
  mockClarificationPop,
  mockDetectGapForMessage,
  mockDetectRoutingCorrection,
  mockRecentEvents,
  mockSessionLogMessage,
  mockGetRecentJournalContext,
  mockLoadRecallThreshold,
  mockLogEvent,
} = vi.hoisted(() => ({
  mockBannedTokenEnforcement: vi.fn().mockReturnValue('\n\nHard constraints: no em dash'),
  mockLoadSoul: vi.fn().mockReturnValue('You are Jarvis.'),
  mockRecallMeta: vi.fn().mockResolvedValue({ results: [], elapsed_ms: 0 }),
  mockLogMessage: vi.fn(),
  mockPopPendingBrief: vi.fn().mockReturnValue(null),
  mockClarificationPop: vi.fn().mockReturnValue(null),
  mockDetectGapForMessage: vi.fn().mockResolvedValue(undefined),
  mockDetectRoutingCorrection: vi.fn().mockResolvedValue(undefined),
  mockRecentEvents: vi.fn().mockReturnValue([]),
  mockSessionLogMessage: vi.fn(),
  mockGetRecentJournalContext: vi.fn().mockReturnValue(null),
  mockLoadRecallThreshold: vi.fn().mockReturnValue(0.7),
  mockLogEvent: vi.fn(),
}))

vi.mock('ion-sdk', () => ({
  log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

vi.mock('../config', () => ({
  OLLAMA_HOST: 'http://127.0.0.1:11434',
  HARNESS_DIR: '/tmp/test-harness',
  loadRecallThreshold: mockLoadRecallThreshold,
}))

vi.mock('../persona/audit', () => ({
  bannedTokenEnforcement: mockBannedTokenEnforcement,
  auditReply: vi.fn().mockReturnValue({ passed: true, violations: [] }),
}))

vi.mock('../persona/soul', () => ({
  loadSoul: mockLoadSoul,
}))

 
function mkItem(text: string, source = 'cli', ageDays: number | null = 1, archived = false): any {
  return { text, source, confidence: 0.95, age_days: ageDays, archived }
}

vi.mock('../memory/recall', async () => {
  const actual = await vi.importActual<typeof import('../memory/recall')>('../memory/recall')
  return {
    ...actual,
    recallMeta: mockRecallMeta,
  }
})

vi.mock('../memory/episodic', () => ({
  logMessage: mockLogMessage,
  logEvent: mockLogEvent,
  popPendingBrief: mockPopPendingBrief,
  popPendingReminder: vi.fn().mockReturnValue(null),
  recentEvents: mockRecentEvents,
  readWorkingMemory: vi.fn().mockReturnValue([]),
  getRecentUserTopics: vi.fn().mockReturnValue([]),
}))

vi.mock('../scheduler/helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../scheduler/helpers')>()
  return {
    ...actual,
    isWorkingMemoryEnabled: vi.fn().mockReturnValue(false),
  }
})

vi.mock('../clarify', () => ({
  clarificationManager: { pop: mockClarificationPop },
}))

vi.mock('../learning', () => ({
  detectGapForMessage: mockDetectGapForMessage,
  detectRoutingCorrection: mockDetectRoutingCorrection,
  extractAndStore: vi.fn().mockResolvedValue(undefined),
  extractFromMeetings: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../sessions', () => ({
  sessionLogMessage: mockSessionLogMessage,
  writeSessionJournal: vi.fn().mockResolvedValue(undefined),
  getRecentJournalContext: mockGetRecentJournalContext,
}))

vi.mock('../openThreads', () => ({
  loadOpenThreads: vi.fn().mockReturnValue([]),
  formatOpenThreadsBlock: vi.fn().mockReturnValue(''),
}))

import { wirePromptPipeline } from './promptPipeline'

// Clear the session recall cache before each test so caching logic from one
// test does not leak into subsequent tests that share the 'test-session' key.
beforeEach(() => {
  sessionRecallCache.clear()
})

function makeIon(): { ion: IonSDK; fire: (event: string, ctx: IonContext, info?: unknown) => Promise<unknown> } {
  const handlers = new Map<string, Function>()
  const ion = {
    on(event: string, handler: Function) {
      handlers.set(event, handler)
    },
  } as unknown as IonSDK
  return {
    ion,
    fire: async (event, ctx, info?) => handlers.get(event)?.(ctx, info),
  }
}

function makeCtx(sessionKey = 'test-session'): IonContext {
  return {
    sessionKey,
    emit: vi.fn(),
    sendMessage: vi.fn(),
    setSessionMemory: vi.fn().mockResolvedValue(undefined),
    cwd: '/test',
    model: null,
    config: {} as any,
  } as unknown as IonContext
}

describe('wirePromptPipeline: before_prompt return value', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockBannedTokenEnforcement.mockReturnValue('\n\nHard constraints: no em dash')
    mockLoadSoul.mockReturnValue('You are Jarvis.')
    mockRecallMeta.mockResolvedValue({ results: [], elapsed_ms: 0 })
    mockPopPendingBrief.mockReturnValue(null)
    mockClarificationPop.mockReturnValue(null)
    mockGetRecentJournalContext.mockReturnValue(null)
  })

  it('returns an object with a systemPrompt field', async () => {
    const { ion, fire } = makeIon()
    wirePromptPipeline(ion)
    const ctx = makeCtx()

    const result = await fire('before_prompt', ctx, 'Hello.')

    expect(result).toHaveProperty('systemPrompt')
  })

  it('includes soul content in systemPrompt', async () => {
    const { ion, fire } = makeIon()
    wirePromptPipeline(ion)
    const ctx = makeCtx()

    const result = (await fire('before_prompt', ctx, 'Hello.')) as { systemPrompt: string }

    expect(result.systemPrompt).toContain('You are Jarvis.')
  })

  it('includes bannedTokenEnforcement addendum in systemPrompt', async () => {
    const { ion, fire } = makeIon()
    wirePromptPipeline(ion)
    const ctx = makeCtx()

    const result = (await fire('before_prompt', ctx, 'Hello.')) as { systemPrompt: string }

    expect(result.systemPrompt).toContain('Hard constraints: no em dash')
  })
})

describe('wirePromptPipeline: payload coercion', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLoadSoul.mockReturnValue('')
    mockBannedTokenEnforcement.mockReturnValue('')
    mockRecallMeta.mockResolvedValue({ results: [], elapsed_ms: 0 })
    mockPopPendingBrief.mockReturnValue(null)
    mockClarificationPop.mockReturnValue(null)
    mockGetRecentJournalContext.mockReturnValue(null)
  })

  it('handles a plain string payload', async () => {
    const { ion, fire } = makeIon()
    wirePromptPipeline(ion)
    const ctx = makeCtx()

    await fire('before_prompt', ctx, 'What is the weather?')

    expect(mockLogMessage).toHaveBeenCalledWith(
      'test-session',
      'user',
      'What is the weather?',
      'test-session',
    )
  })

  it('handles a wrapped { _payload: "..." } object', async () => {
    const { ion, fire } = makeIon()
    wirePromptPipeline(ion)
    const ctx = makeCtx()

    await fire('before_prompt', ctx, { _payload: 'What time is it?' })

    expect(mockLogMessage).toHaveBeenCalledWith(
      'test-session',
      'user',
      'What time is it?',
      'test-session',
    )
  })

  it('does not call logMessage when payload is empty', async () => {
    const { ion, fire } = makeIon()
    wirePromptPipeline(ion)
    const ctx = makeCtx()

    await fire('before_prompt', ctx, undefined)

    expect(mockLogMessage).not.toHaveBeenCalled()
  })
})

describe('wirePromptPipeline: memory recall', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLoadSoul.mockReturnValue('')
    mockBannedTokenEnforcement.mockReturnValue('')
    mockPopPendingBrief.mockReturnValue(null)
    mockClarificationPop.mockReturnValue(null)
    mockGetRecentJournalContext.mockReturnValue(null)
  })

  it('includes recalled memories in systemPrompt when results are returned', async () => {
    mockRecallMeta.mockResolvedValueOnce({ results: [mkItem('Prefers brief summaries.')], elapsed_ms: 5 })
    mockRecallMeta.mockResolvedValueOnce({ results: [], elapsed_ms: 0 })

    const { ion, fire } = makeIon()
    wirePromptPipeline(ion)
    const ctx = makeCtx()

    const result = (await fire('before_prompt', ctx, 'Summarise the week.')) as { systemPrompt: string }

    expect(result.systemPrompt).toContain('Recalled memories (grouped by provenance):')
    expect(result.systemPrompt).toContain('Prefers brief summaries.')
  })

  it('omits the memory block when recall returns nothing', async () => {
    mockRecallMeta.mockResolvedValue({ results: [], elapsed_ms: 0 })

    const { ion, fire } = makeIon()
    wirePromptPipeline(ion)
    const ctx = makeCtx()

    const result = (await fire('before_prompt', ctx, 'Hello.')) as { systemPrompt: string }

    expect(result.systemPrompt).not.toContain('Recalled memories')
  })

  it('calls recall for both user_profile and knowledge collections', async () => {
    mockRecallMeta.mockResolvedValue({ results: [], elapsed_ms: 0 })

    const { ion, fire } = makeIon()
    wirePromptPipeline(ion)
    const ctx = makeCtx()

    await fire('before_prompt', ctx, 'Any news?')

    const calls = mockRecallMeta.mock.calls as [string, string, number][]
    const collections = calls.map(([, collection]) => collection)
    expect(collections).toContain('user_profile')
    expect(collections).toContain('knowledge')
  })

  it('groups inferred / ingested items under their own section', async () => {
    mockRecallMeta.mockResolvedValueOnce({
      results: [mkItem('Prefers brief summaries.', 'cli', 2)],
      elapsed_ms: 5,
    })
    mockRecallMeta.mockResolvedValueOnce({
      results: [mkItem('Alex seems to like espresso.', 'learning', 14)],
      elapsed_ms: 5,
    })

    const { ion, fire } = makeIon()
    wirePromptPipeline(ion)
    const ctx = makeCtx()

    const result = (await fire('before_prompt', ctx, 'What do I drink?')) as { systemPrompt: string }

    expect(result.systemPrompt).toContain('Recent stated facts:')
    expect(result.systemPrompt).toContain('Inferred / ingested:')
    expect(result.systemPrompt).toContain('Alex seems to like espresso.')
  })

  it('appends archive-tier instruction when a recalled item is from long-term memory', async () => {
    mockRecallMeta.mockResolvedValueOnce({ results: [mkItem('Fresh fact.', 'cli', 1)], elapsed_ms: 5 })
    mockRecallMeta.mockResolvedValueOnce({
      results: [mkItem('Old fact from 2024.', 'manual', 400, true)],
      elapsed_ms: 8,
    })

    const { ion, fire } = makeIon()
    wirePromptPipeline(ion)
    const ctx = makeCtx()

    const result = (await fire('before_prompt', ctx, 'Tell me about that.')) as {
      systemPrompt: string
    }

    expect(result.systemPrompt).toContain('[archive] Old fact from 2024.')
    expect(result.systemPrompt).toContain('If memory serves, sir,')
  })

  it('omits archive instruction when no recalled item carries the [archive] prefix', async () => {
    mockRecallMeta.mockResolvedValueOnce({ results: [mkItem('Fresh fact.', 'cli', 1)], elapsed_ms: 5 })
    mockRecallMeta.mockResolvedValueOnce({ results: [], elapsed_ms: 0 })

    const { ion, fire } = makeIon()
    wirePromptPipeline(ion)
    const ctx = makeCtx()

    const result = (await fire('before_prompt', ctx, 'Tell me about that.')) as {
      systemPrompt: string
    }

    expect(result.systemPrompt).toContain('Recalled memories (grouped by provenance):')
    expect(result.systemPrompt).not.toContain('If memory serves')
  })
})

describe('wirePromptPipeline: recall cache instrumentation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sessionRecallCache.clear()
    mockLoadSoul.mockReturnValue('')
    mockBannedTokenEnforcement.mockReturnValue('')
    mockPopPendingBrief.mockReturnValue(null)
    mockGetRecentJournalContext.mockReturnValue(null)
  })

  it('emits recall_cache hit:false on the first turn (cache miss)', async () => {
    mockRecallMeta.mockResolvedValue({ results: [], elapsed_ms: 0 })
    const { ion, fire } = makeIon()
    wirePromptPipeline(ion)

    await fire('before_prompt', makeCtx('sess-miss'), 'Hello.')

    expect(mockLogEvent).toHaveBeenCalledWith('perf', 'recall_cache', { hit: false })
  })

  it('emits recall_cache hit:true on the second turn once the cache is populated', async () => {
    // Non-empty recall so turn 1 populates sessionRecallCache (the OR guard).
    mockRecallMeta.mockResolvedValue({ results: [mkItem('Alex prefers terse replies')], elapsed_ms: 5 })
    const { ion, fire } = makeIon()
    wirePromptPipeline(ion)
    const ctx = makeCtx('sess-hit')

    await fire('before_prompt', ctx, 'First message.')
    await fire('before_prompt', ctx, 'Second message.')

    const calls = mockLogEvent.mock.calls.filter((c) => c[1] === 'recall_cache')
    expect(calls[0]).toEqual(['perf', 'recall_cache', { hit: false }])
    expect(calls[1]).toEqual(['perf', 'recall_cache', { hit: true }])
  })

  it('emits prompt_size with the measured system-prompt length', async () => {
    mockRecallMeta.mockResolvedValue({ results: [], elapsed_ms: 0 })
    mockLoadSoul.mockReturnValue('You are Jarvis. '.repeat(20))
    const { ion, fire } = makeIon()
    wirePromptPipeline(ion)

    const result = (await fire('before_prompt', makeCtx('sess-size'), 'Hello.')) as {
      systemPrompt: string
    }

    const call = mockLogEvent.mock.calls.find((c) => c[1] === 'prompt_size')
    expect(call).toBeDefined()
    const detail = call![2] as { systemPromptChars: number; approxTokens: number; soulChars: number }
    // The recorded size matches what was actually returned to the engine.
    expect(detail.systemPromptChars).toBe(result.systemPrompt.length)
    expect(detail.approxTokens).toBe(Math.ceil(result.systemPrompt.length / 4))
    expect(detail.soulChars).toBeGreaterThan(0)
  })
})

describe('wirePromptPipeline: clarification resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLoadSoul.mockReturnValue('')
    mockBannedTokenEnforcement.mockReturnValue('')
    mockRecallMeta.mockResolvedValue({ results: [], elapsed_ms: 0 })
    mockPopPendingBrief.mockReturnValue(null)
    mockGetRecentJournalContext.mockReturnValue(null)
  })

  it('includes a clarification block when a pending clarification is resolved', async () => {
    mockClarificationPop.mockReturnValueOnce({
      session: 'test-session',
      originalMessage: 'Book a flight',
      question: 'What departure date?',
      intentAction: 'calendar_create_event',
      intentArgs: {},
      missingArgs: ['date'],
      askedAt: Date.now(),
    })

    const { ion, fire } = makeIon()
    wirePromptPipeline(ion)
    const ctx = makeCtx()

    const result = (await fire('before_prompt', ctx, 'Next Friday.')) as { systemPrompt: string }

    expect(result.systemPrompt).toContain('Clarification resolved:')
    expect(result.systemPrompt).toContain('Book a flight')
    expect(result.systemPrompt).toContain('What departure date?')
    expect(result.systemPrompt).toContain('Next Friday.')
  })

  it('omits the clarification block when no pending clarification exists', async () => {
    mockClarificationPop.mockReturnValueOnce(null)

    const { ion, fire } = makeIon()
    wirePromptPipeline(ion)
    const ctx = makeCtx()

    const result = (await fire('before_prompt', ctx, 'Hello.')) as { systemPrompt: string }

    expect(result.systemPrompt).not.toContain('Clarification resolved:')
  })
})

describe('wirePromptPipeline: pending brief', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLoadSoul.mockReturnValue('')
    mockBannedTokenEnforcement.mockReturnValue('')
    mockRecallMeta.mockResolvedValue({ results: [], elapsed_ms: 0 })
    mockClarificationPop.mockReturnValue(null)
    mockGetRecentJournalContext.mockReturnValue(null)
  })

  it('includes the morning brief when a pending brief exists', async () => {
    mockPopPendingBrief.mockReturnValueOnce('Today: three meetings, low email volume.')

    const { ion, fire } = makeIon()
    wirePromptPipeline(ion)
    const ctx = makeCtx()

    const result = (await fire('before_prompt', ctx, 'Good morning.')) as { systemPrompt: string }

    expect(result.systemPrompt).toContain('Morning brief')
    expect(result.systemPrompt).toContain('Today: three meetings, low email volume.')
  })

  it('omits the brief block when no brief is pending', async () => {
    mockPopPendingBrief.mockReturnValueOnce(null)

    const { ion, fire } = makeIon()
    wirePromptPipeline(ion)
    const ctx = makeCtx()

    const result = (await fire('before_prompt', ctx, 'Hello.')) as { systemPrompt: string }

    expect(result.systemPrompt).not.toContain('Morning brief')
  })
})

describe('wirePromptPipeline: gap detection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLoadSoul.mockReturnValue('')
    mockBannedTokenEnforcement.mockReturnValue('')
    mockRecallMeta.mockResolvedValue({ results: [], elapsed_ms: 0 })
    mockPopPendingBrief.mockReturnValue(null)
    mockClarificationPop.mockReturnValue(null)
    mockGetRecentJournalContext.mockReturnValue(null)
  })

  it('fires detectGapForMessage as fire-and-forget when prompt is present', async () => {
    const { ion, fire } = makeIon()
    wirePromptPipeline(ion)
    const ctx = makeCtx()

    await fire('before_prompt', ctx, 'What is the schedule?')

    expect(mockDetectGapForMessage).toHaveBeenCalledWith('What is the schedule?', 'test-session')
  })

  it('skips detectGapForMessage when prompt is empty', async () => {
    const { ion, fire } = makeIon()
    wirePromptPipeline(ion)
    const ctx = makeCtx()

    await fire('before_prompt', ctx, undefined)

    expect(mockDetectGapForMessage).not.toHaveBeenCalled()
  })
})

describe('wirePromptPipeline: tiered context injection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLoadSoul.mockReturnValue('')
    mockBannedTokenEnforcement.mockReturnValue('')
    mockPopPendingBrief.mockReturnValue(null)
    mockClarificationPop.mockReturnValue(null)
    mockGetRecentJournalContext.mockReturnValue(null)
    mockLoadRecallThreshold.mockReturnValue(0.7)
  })

   
  function mkKnowledge(text: string, confidence: number): any {
    return { text, source: 'learning', confidence, age_days: 1, archived: false }
  }

  it('loadRecallThreshold returns 0.7 by default from the mock', () => {
    expect(mockLoadRecallThreshold()).toBe(0.7)
  })

  it('always includes high-confidence knowledge items (confidence >= 0.7)', async () => {
    mockRecallMeta.mockResolvedValueOnce({ results: [], elapsed_ms: 0 })
    mockRecallMeta.mockResolvedValueOnce({
      results: [mkKnowledge('Alex prefers dark roast coffee.', 0.9)],
      elapsed_ms: 5,
    })

    const { ion, fire } = makeIon()
    wirePromptPipeline(ion)
    const ctx = makeCtx()

    const result = (await fire('before_prompt', ctx, 'What coffee do I like?')) as { systemPrompt: string }

    expect(result.systemPrompt).toContain('Alex prefers dark roast coffee.')
  })

  it('includes low-confidence items when core context is under 800 tokens', async () => {
    // Empty profile keeps core context small (well under budget).
    mockRecallMeta.mockResolvedValueOnce({ results: [], elapsed_ms: 0 })
    mockRecallMeta.mockResolvedValueOnce({
      results: [mkKnowledge('Alex might enjoy jazz.', 0.5)],
      elapsed_ms: 5,
    })

    const { ion, fire } = makeIon()
    wirePromptPipeline(ion)
    const ctx = makeCtx()

    const result = (await fire('before_prompt', ctx, 'What music do I like?')) as { systemPrompt: string }

    expect(result.systemPrompt).toContain('Alex might enjoy jazz.')
  })

  it('excludes low-confidence items when core context already exceeds 800 tokens', async () => {
    // Fill profile with enough text to exceed the 800-token rough budget.
    // roughTokens = ceil(length / 4), so we need > 3200 characters in formatted output.
    const bulkyItems = Array.from({ length: 10 }, (_, i) =>
      mkItem('x'.repeat(350) + ` item-${i}`, 'cli', 1),
    )
    mockRecallMeta.mockResolvedValueOnce({ results: bulkyItems, elapsed_ms: 0 })
    mockRecallMeta.mockResolvedValueOnce({
      results: [mkKnowledge('Low-confidence guess about hobbies.', 0.4)],
      elapsed_ms: 5,
    })

    const { ion, fire } = makeIon()
    wirePromptPipeline(ion)
    const ctx = makeCtx()

    const result = (await fire('before_prompt', ctx, 'Tell me about my hobbies.')) as { systemPrompt: string }

    expect(result.systemPrompt).not.toContain('Low-confidence guess about hobbies.')
  })
})

describe('wirePromptPipeline: journal context', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLoadSoul.mockReturnValue('')
    mockBannedTokenEnforcement.mockReturnValue('')
    mockRecallMeta.mockResolvedValue({ results: [], elapsed_ms: 0 })
    mockPopPendingBrief.mockReturnValue(null)
    mockClarificationPop.mockReturnValue(null)
  })

  it('includes journal context in context_inject when available', async () => {
    mockGetRecentJournalContext.mockReturnValueOnce('Yesterday: reviewed quarterly goals.')

    const { ion, fire } = makeIon()
    wirePromptPipeline(ion)
    const ctx = makeCtx()

    const result = (await fire('context_inject', ctx)) as { label: string; content: string }

    expect(result.content).toContain("Jarvis's recent session journal")
    expect(result.content).toContain('Yesterday: reviewed quarterly goals.')
  })

  it('omits the journal block when context is null', async () => {
    mockGetRecentJournalContext.mockReturnValueOnce(null)

    const { ion, fire } = makeIon()
    wirePromptPipeline(ion)
    const ctx = makeCtx()

    const result = (await fire('context_inject', ctx)) as { label: string; content: string }

    expect(result.content).not.toContain("Jarvis's recent session journal")
  })
})
