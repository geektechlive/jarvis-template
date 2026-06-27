import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const ORIGINAL_FETCH = globalThis.fetch

const {
  mockLogEvent,
  mockRemember,
  mockForget,
  mockRecallMeta,
  mockGetRecentMessages,
} = vi.hoisted(() => ({
  mockLogEvent: vi.fn(),
  mockRemember: vi.fn().mockResolvedValue({ ok: true, id: 'new-doc-id' }),
  mockForget: vi.fn().mockResolvedValue({ deleted: true, id: 'old-doc-id' }),
  mockRecallMeta: vi.fn().mockResolvedValue({ results: [], elapsed_ms: 0 }),
  mockGetRecentMessages: vi.fn().mockReturnValue([]),
}))

// Build a RecallItem. Default source 'learning' (inferred, NOT user-stated) so the
// provenance gate does not engage unless a test sets a stated source explicitly.
function item(text: string, source = 'learning', confidence = 0.75) {
  return { text, source, confidence, age_days: null, archived: false }
}

vi.mock('ion-sdk', () => ({
  log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

vi.mock('../config', () => ({
  OLLAMA_HOST: 'http://127.0.0.1:11434',
  HARNESS_DIR: '/tmp',
  isAllowedHost: vi.fn().mockReturnValue(true),
  loadModelForRole: vi.fn().mockReturnValue('qwen2.5:14b'),
  loadBackendForRole: vi.fn().mockReturnValue('ollama'),
  loadStaff: vi.fn().mockReturnValue([]),
}))

vi.mock('../memory/episodic', () => ({
  logEvent: mockLogEvent,
  getRecentMessages: mockGetRecentMessages,
  recentEvents: vi.fn().mockReturnValue([]),
  recentAgentEvents: vi.fn().mockReturnValue([]),
}))

vi.mock('../memory/recall', () => ({
  remember: mockRemember,
  recallMeta: mockRecallMeta,
  forget: mockForget,
  // Faithful prefix-match copy of the real helper (recall.ts) so the provenance gate
  // behaves correctly without pulling the real module's dependency graph.
  isStatedSource: (source: string) =>
    ['cli', 'tui', 'agent', 'manual'].some((p) => source.startsWith(p)),
}))

const { mockIsEphemeralMode } = vi.hoisted(() => ({
  mockIsEphemeralMode: vi.fn().mockReturnValue(false),
}))

vi.mock('../memory/ephemeralMode', () => ({
  isEphemeralMode: mockIsEphemeralMode,
}))

import { detectMemoryCorrection } from './index'

const SESSION = 'test-session'

function makeOllamaResponse(content: string): Response {
  return new Response(
    JSON.stringify({ message: { content } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

describe('detectMemoryCorrection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockForget.mockResolvedValue({ deleted: true, id: 'old-doc-id' })
    mockRemember.mockResolvedValue({ ok: true, id: 'new-doc-id' })
    mockRecallMeta.mockResolvedValue({ results: [], elapsed_ms: 0 })
    mockGetRecentMessages.mockReturnValue([])
    mockIsEphemeralMode.mockReturnValue(false)
    globalThis.fetch = vi.fn()
  })

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH
  })

  it('regex gate rejects non-corrections: recall not called', async () => {
    mockGetRecentMessages.mockReturnValue([
      { role: 'user', content: 'I like coffee' },
    ])

    await detectMemoryCorrection(SESSION)

    expect(mockRecallMeta).not.toHaveBeenCalled()
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('no stored facts exits before Ollama fetch', async () => {
    mockGetRecentMessages.mockReturnValue([
      { role: 'user', content: 'no, actually I prefer espresso now' },
    ])
    mockRecallMeta.mockResolvedValue({ results: [], elapsed_ms: 0 })

    await detectMemoryCorrection(SESSION)

    expect(globalThis.fetch).not.toHaveBeenCalled()
    expect(mockForget).not.toHaveBeenCalled()
  })

  it('LLM returns is_correction false -- no action taken', async () => {
    mockGetRecentMessages.mockReturnValue([
      { role: 'user', content: 'no, actually I prefer espresso now' },
    ])
    mockRecallMeta.mockResolvedValue({ results: [item('Alex prefers tea')], elapsed_ms: 0 })
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeOllamaResponse(
        JSON.stringify({ is_correction: false, contradicted: null, corrected: null }),
      ),
    )

    await detectMemoryCorrection(SESSION)

    expect(mockForget).not.toHaveBeenCalled()
    expect(mockRemember).not.toHaveBeenCalled()
    expect(mockLogEvent).not.toHaveBeenCalled()
  })

  it('#855: classifier failure emits memory_correction_classify_failed, not a silent drop', async () => {
    mockGetRecentMessages.mockReturnValue([
      { role: 'user', content: 'no, actually I prefer espresso now' },
    ])
    mockRecallMeta.mockResolvedValue({ results: [item('Alex prefers tea')], elapsed_ms: 0 })
    // The classifier backend call fails. In production this was the direct Ollama
    // fetch hitting an embeddings-only daemon; the old code returned via a silent
    // log.debug, so every correction vanished without a trace. The fix routes the
    // call through the backend-aware helper AND emits an observable event on failure.
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('ollama unreachable'))

    await detectMemoryCorrection(SESSION)

    expect(mockForget).not.toHaveBeenCalled()
    expect(mockRemember).not.toHaveBeenCalled()
    expect(mockLogEvent).toHaveBeenCalledWith(
      SESSION,
      'memory_correction_classify_failed',
      expect.objectContaining({ err: expect.stringContaining('ollama unreachable') }),
    )
  })

  it('hallucinated contradicted fact not in recall -- skipped with memory_correction_skipped event', async () => {
    mockGetRecentMessages.mockReturnValue([
      { role: 'user', content: 'no, actually I prefer espresso now' },
    ])
    mockRecallMeta.mockResolvedValue({
      results: [item('Alex prefers tea'), item('Alex drinks water daily')],
      elapsed_ms: 0,
    })
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeOllamaResponse(
        JSON.stringify({
          is_correction: true,
          // 'coffee beans' overlaps 'prefers tea' only at the shared 'chris/prefers'
          // prefix (tokenOverlap 0.5, below the 0.55 gate) -- a genuine hallucination.
          contradicted: 'Alex prefers coffee beans',
          corrected: 'Alex prefers espresso',
        }),
      ),
    )

    await detectMemoryCorrection(SESSION)

    expect(mockForget).not.toHaveBeenCalled()
    expect(mockLogEvent).toHaveBeenCalledWith(
      SESSION,
      'memory_correction_skipped',
      expect.objectContaining({ reason: 'hallucinated' }),
    )
  })

  it('happy path: deletes old fact and stores corrected version', async () => {
    mockGetRecentMessages.mockReturnValue([
      { role: 'user', content: 'no, actually I prefer espresso now' },
    ])
    mockRecallMeta.mockResolvedValue({ results: [item('Alex prefers tea')], elapsed_ms: 0 })
    ;(globalThis.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(
        makeOllamaResponse(
          JSON.stringify({
            is_correction: true,
            contradicted: 'Alex prefers tea',
            corrected: 'Alex prefers espresso',
          }),
        ),
      )
      .mockResolvedValueOnce(
        makeOllamaResponse('Alex prefers espresso.'),
      )

    await detectMemoryCorrection(SESSION)

    expect(mockForget).toHaveBeenCalledWith('Alex prefers tea', 'user_profile')
    expect(mockRemember).toHaveBeenCalledWith(
      'Alex prefers espresso.',
      'user_profile',
      'memory_correction',
      'jarvis_inference',
      // guardedRemember forwards metadata/goalId/signal positionally (#862).
      undefined,
      undefined,
      undefined,
    )
    expect(mockLogEvent).toHaveBeenCalledWith(
      SESSION,
      'memory_correction',
      expect.objectContaining({ old_fact: expect.stringContaining('tea') }),
    )
  })

  it('#826: accepts a PARAPHRASED contradicted fact the substring guard would drop', async () => {
    // Stored fact has a word ("the") the classifier drops when copying it back. Substring
    // match fails both ways, but tokenOverlap ("vim editor" 0.8) clears 0.55 -> applied.
    mockGetRecentMessages.mockReturnValue([
      { role: 'user', content: 'no, actually I use emacs now' },
    ])
    mockRecallMeta.mockResolvedValue({ results: [item('Alex uses the vim editor')], elapsed_ms: 0 })
    ;(globalThis.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(
        makeOllamaResponse(
          JSON.stringify({
            is_correction: true,
            contradicted: 'Alex uses vim editor',
            corrected: 'Alex uses emacs',
          }),
        ),
      )
      .mockResolvedValueOnce(makeOllamaResponse('Alex uses emacs.'))

    await detectMemoryCorrection(SESSION)

    // The original (paraphrased) stored fact is the one forgotten.
    expect(mockForget).toHaveBeenCalledWith('Alex uses the vim editor', 'user_profile')
    expect(mockRemember).toHaveBeenCalledWith(
      'Alex uses emacs.',
      'user_profile',
      'memory_correction',
      'jarvis_inference',
      // guardedRemember forwards metadata/goalId/signal positionally (#862).
      undefined,
      undefined,
      undefined,
    )
  })

  it('#835: a high-confidence user-stated fact is NOT deleted on an overlap-only (non-substring) match', async () => {
    // Same paraphrase as above, but the stored fact is user-stated (cli, conf 1.0). The
    // provenance gate requires a STRICT substring match for stated facts, so the fuzzy
    // overlap is rejected -- the typed-in fact is protected.
    mockGetRecentMessages.mockReturnValue([
      { role: 'user', content: 'no, actually I use emacs now' },
    ])
    mockRecallMeta.mockResolvedValue({
      results: [item('Alex uses the vim editor', 'cli', 1.0)],
      elapsed_ms: 0,
    })
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeOllamaResponse(
        JSON.stringify({
          is_correction: true,
          contradicted: 'Alex uses vim editor',
          corrected: 'Alex uses emacs',
        }),
      ),
    )

    await detectMemoryCorrection(SESSION)

    expect(mockForget).not.toHaveBeenCalled()
    // Distinct reason: this was a deliberate protection, NOT a hallucination.
    expect(mockLogEvent).toHaveBeenCalledWith(
      SESSION,
      'memory_correction_skipped',
      expect.objectContaining({ reason: 'stated_fact_protected' }),
    )
  })

  it('#835: the classifier prompt annotates each fact with its source and confidence', async () => {
    mockGetRecentMessages.mockReturnValue([
      { role: 'user', content: 'no, actually I prefer espresso now' },
    ])
    mockRecallMeta.mockResolvedValue({
      results: [item('Alex prefers tea', 'cli', 1.0)],
      elapsed_ms: 0,
    })
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeOllamaResponse(
        JSON.stringify({ is_correction: false, contradicted: null, corrected: null }),
      ),
    )

    await detectMemoryCorrection(SESSION)

    const body = JSON.parse(
      (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body as string,
    )
    const userContent = body.messages.find((m: { role: string }) => m.role === 'user').content
    expect(userContent).toContain('[source: cli, confidence: 1.00]')
  })

  it('#797: recalls from BOTH user_profile and knowledge', async () => {
    mockGetRecentMessages.mockReturnValue([
      { role: 'user', content: 'no, actually I prefer espresso now' },
    ])
    mockRecallMeta.mockResolvedValue({ results: [], elapsed_ms: 0 })

    await detectMemoryCorrection(SESSION)

    const collectionsQueried = mockRecallMeta.mock.calls.map((c) => c[1])
    expect(collectionsQueried).toContain('user_profile')
    expect(collectionsQueried).toContain('knowledge')
  })

  it('#797: a correction to a [fact] in the knowledge collection routes forget/remember to knowledge', async () => {
    mockGetRecentMessages.mockReturnValue([
      { role: 'user', content: 'no, actually Alex uses SQLite now' },
    ])
    // The contradicted fact lives ONLY in knowledge (a [fact]); user_profile is empty.
    mockRecallMeta.mockImplementation((_q: string, collection: string) =>
      Promise.resolve({
        results: collection === 'knowledge' ? [item('Alex uses PostgreSQL')] : [],
        elapsed_ms: 0,
      }),
    )
    ;(globalThis.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(
        makeOllamaResponse(
          JSON.stringify({
            is_correction: true,
            contradicted: 'Alex uses PostgreSQL',
            corrected: 'Alex uses SQLite',
          }),
        ),
      )
      .mockResolvedValueOnce(makeOllamaResponse('Alex uses SQLite.'))

    await detectMemoryCorrection(SESSION)

    expect(mockForget).toHaveBeenCalledWith('Alex uses PostgreSQL', 'knowledge')
    expect(mockRemember).toHaveBeenCalledWith(
      'Alex uses SQLite.',
      'knowledge',
      'memory_correction',
      'jarvis_inference',
      // guardedRemember forwards metadata/goalId/signal positionally (#862).
      undefined,
      undefined,
      undefined,
    )
    expect(mockLogEvent).toHaveBeenCalledWith(
      SESSION,
      'memory_correction',
      expect.objectContaining({ collection: 'knowledge' }),
    )
  })

  it('#797: a fact present in both collections is deduped and corrected once', async () => {
    mockGetRecentMessages.mockReturnValue([
      { role: 'user', content: 'no, actually I prefer espresso now' },
    ])
    // Same fact text returned by both collections (e.g. archive top-up coincidence).
    mockRecallMeta.mockResolvedValue({ results: [item('Alex prefers tea')], elapsed_ms: 0 })
    ;(globalThis.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(
        makeOllamaResponse(
          JSON.stringify({
            is_correction: true,
            contradicted: 'Alex prefers tea',
            corrected: 'Alex prefers espresso',
          }),
        ),
      )
      .mockResolvedValueOnce(makeOllamaResponse('Alex prefers espresso.'))

    await detectMemoryCorrection(SESSION)

    // Deduped: exactly one forget, targeting user_profile (queried first, first-wins).
    expect(mockForget).toHaveBeenCalledTimes(1)
    expect(mockForget).toHaveBeenCalledWith('Alex prefers tea', 'user_profile')
  })

  it('#772: strips [archive] prefix so forget targets the raw stored text', async () => {
    mockGetRecentMessages.mockReturnValue([
      { role: 'user', content: 'no, actually I prefer espresso now' },
    ])
    // store.py prepends "[archive] " to archive-collection recall hits.
    mockRecallMeta.mockResolvedValue({ results: [item('[archive] Alex prefers tea')], elapsed_ms: 0 })
    ;(globalThis.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(
        makeOllamaResponse(
          JSON.stringify({
            is_correction: true,
            contradicted: 'Alex prefers tea',
            corrected: 'Alex prefers espresso',
          }),
        ),
      )
      .mockResolvedValueOnce(makeOllamaResponse('Alex prefers espresso.'))

    await detectMemoryCorrection(SESSION)

    // Must forget the UNPREFIXED text -- the prefix is not in ChromaDB, so passing
    // "[archive] Alex prefers tea" would return deleted:false and leave the stale fact.
    expect(mockForget).toHaveBeenCalledWith('Alex prefers tea', 'user_profile')
  })

  it('forget returns deleted=false but remember is still called', async () => {
    mockGetRecentMessages.mockReturnValue([
      { role: 'user', content: 'no, actually I prefer espresso now' },
    ])
    mockRecallMeta.mockResolvedValue({ results: [item('Alex prefers tea')], elapsed_ms: 0 })
    mockForget.mockResolvedValue({ deleted: false, id: '' })
    ;(globalThis.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(
        makeOllamaResponse(
          JSON.stringify({
            is_correction: true,
            contradicted: 'Alex prefers tea',
            corrected: 'Alex prefers espresso',
          }),
        ),
      )
      .mockResolvedValueOnce(
        makeOllamaResponse('Alex prefers espresso.'),
      )

    await detectMemoryCorrection(SESSION)

    expect(mockRemember).toHaveBeenCalledWith(
      'Alex prefers espresso.',
      'user_profile',
      'memory_correction',
      'jarvis_inference',
      // guardedRemember forwards metadata/goalId/signal positionally (#862).
      undefined,
      undefined,
      undefined,
    )
  })

  it('Ollama fetch throws -- resolves without throwing', async () => {
    mockGetRecentMessages.mockReturnValue([
      { role: 'user', content: 'no, actually I prefer espresso now' },
    ])
    mockRecallMeta.mockResolvedValue({ results: [item('Alex prefers tea')], elapsed_ms: 0 })
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('ECONNREFUSED'),
    )

    await expect(detectMemoryCorrection(SESSION)).resolves.toBeUndefined()
    expect(mockForget).not.toHaveBeenCalled()
  })

  it('no user messages in session -- returns early', async () => {
    mockGetRecentMessages.mockReturnValue([])

    await detectMemoryCorrection(SESSION)

    expect(mockRecallMeta).not.toHaveBeenCalled()
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('pronoun-subject corrected fact: neither forget nor remember called (old fact preserved)', async () => {
    // Issue #227: remember must be attempted before forget. When normalizeFact returns a
    // pronoun-subject result, we abort before touching either store -- old fact is preserved.
    mockGetRecentMessages.mockReturnValue([
      { role: 'user', content: 'no, actually I prefer espresso now' },
    ])
    mockRecallMeta.mockResolvedValue({ results: [item('Alex prefers tea')], elapsed_ms: 0 })
    ;(globalThis.fetch as ReturnType<typeof vi.fn>)
      // Classifier
      .mockResolvedValueOnce(
        makeOllamaResponse(
          JSON.stringify({
            is_correction: true,
            contradicted: 'Alex prefers tea',
            corrected: 'He now prefers espresso',
          }),
        ),
      )
      // normalizeFact returns pronoun-subject result (plain text)
      .mockResolvedValueOnce(
        makeOllamaResponse('He now prefers espresso.'),
      )

    await detectMemoryCorrection(SESSION)

    expect(mockForget).not.toHaveBeenCalled()
    expect(mockRemember).not.toHaveBeenCalled()
    expect(mockLogEvent).not.toHaveBeenCalledWith(
      expect.anything(),
      'memory_correction',
      expect.anything(),
    )
  })

  it('routing-style correction not matched: recall not called', async () => {
    mockGetRecentMessages.mockReturnValue([
      { role: 'user', content: 'you should have asked the CFO' },
    ])

    await detectMemoryCorrection(SESSION)

    expect(mockRecallMeta).not.toHaveBeenCalled()
  })

  // Issue #274: recall error emits observable warn + logEvent
  it('#274 recall throws -- emits memory_correction_failed event with recall_error reason', async () => {
    mockGetRecentMessages.mockReturnValue([
      { role: 'user', content: 'no, actually I prefer espresso now' },
    ])
    mockRecallMeta.mockRejectedValue(new Error('ECONNREFUSED'))

    await detectMemoryCorrection(SESSION)

    expect(mockForget).not.toHaveBeenCalled()
    expect(mockRemember).not.toHaveBeenCalled()
    const failedEvents = mockLogEvent.mock.calls.filter(
      (call) => call[1] === 'memory_correction_failed',
    )
    expect(failedEvents.length).toBeGreaterThan(0)
    expect(failedEvents[0]?.[2]).toMatchObject({ reason: 'recall_error' })
  })

  it('#274 empty recall results after correction pattern -- emits memory_correction_failed with no_recalled_facts', async () => {
    mockGetRecentMessages.mockReturnValue([
      { role: 'user', content: 'no, actually I prefer espresso now' },
    ])
    // recall returns successfully but empty -- this is the normal path but
    // post-regex-gate we need an observable event to detect dropped corrections
    mockRecallMeta.mockResolvedValue({ results: [], elapsed_ms: 5 })

    await detectMemoryCorrection(SESSION)

    expect(mockForget).not.toHaveBeenCalled()
    const failedEvents = mockLogEvent.mock.calls.filter(
      (call) => call[1] === 'memory_correction_failed',
    )
    expect(failedEvents.length).toBeGreaterThan(0)
    expect(failedEvents[0]?.[2]).toMatchObject({ reason: 'no_recalled_facts' })
  })

  // Issue #393: remember() returns ok:false -- aborting + logEvent
  it('#393 remember returns ok:false -- correction aborted', async () => {
    mockGetRecentMessages.mockReturnValue([
      { role: 'user', content: 'no, actually I prefer espresso now' },
    ])
    mockRecallMeta.mockResolvedValue({ results: [item('Alex prefers tea')], elapsed_ms: 0 })
    mockRemember.mockResolvedValue({ ok: false, reason: 'network' })
    ;(globalThis.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(
        makeOllamaResponse(
          JSON.stringify({
            is_correction: true,
            contradicted: 'Alex prefers tea',
            corrected: 'Alex prefers espresso',
          }),
        ),
      )
      .mockResolvedValueOnce(
        makeOllamaResponse('Alex prefers espresso.'),
      )

    await detectMemoryCorrection(SESSION)

    // Old fact must NOT be deleted when remember fails
    expect(mockForget).not.toHaveBeenCalled()
    // No memory_correction event -- correction aborted
    const correctionEvents = mockLogEvent.mock.calls.filter(
      (call) => call[1] === 'memory_correction',
    )
    expect(correctionEvents.length).toBe(0)
  })

  // Bug #760: recall limit must be 15, not 8
  it('#760 recall uses limit=15 so deep-ranked contradicted facts are not silently dropped', async () => {
    mockGetRecentMessages.mockReturnValue([
      { role: 'user', content: 'no, actually I prefer espresso now' },
    ])
    mockRecallMeta.mockResolvedValue({
      results: Array.from({ length: 15 }, (_, i) => item(`Alex fact ${i}`)),
      elapsed_ms: 0,
    })
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeOllamaResponse(
        JSON.stringify({ is_correction: false, contradicted: null, corrected: null }),
      ),
    )

    await detectMemoryCorrection(SESSION)

    // recallMeta must have been called with limit 15
    expect(mockRecallMeta).toHaveBeenCalledWith(
      expect.any(String),
      'user_profile',
      15,
    )
  })

  // Issue #394: ephemeral mode -- returns early without touching user_profile
  it('#394 ephemeral mode active -- detectMemoryCorrection returns early without recall or remember', async () => {
    mockIsEphemeralMode.mockReturnValue(true)
    mockGetRecentMessages.mockReturnValue([
      { role: 'user', content: 'no, actually I prefer espresso now' },
    ])

    await detectMemoryCorrection(SESSION)

    expect(mockRecallMeta).not.toHaveBeenCalled()
    expect(mockRemember).not.toHaveBeenCalled()
    expect(mockForget).not.toHaveBeenCalled()
  })
})
