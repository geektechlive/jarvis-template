import { describe, it, expect, vi, beforeEach } from 'vitest'

// Regression coverage for Issue #771: the deepReencodeOnCorrection deep re-encode
// pass holds the extraction in-flight lock for up to ~360s (budgetMs:'double').
// Before the fix it keyed that lock on `session`, so a concurrent turn_end
// extractAndStore on the SAME session was skipped and silently dropped its facts.
// The fix decouples the lock key (opts.lockKey) from the message-lookup session.

const {
  mockOllamaChat,
  mockNormalizeFact,
  mockGetRecentMessages,
  mockLogEvent,
  mockRemember,
  mockDb,
  mockIsEphemeralMode,
} = vi.hoisted(() => ({
  mockOllamaChat: vi.fn(),
  mockNormalizeFact: vi.fn().mockResolvedValue({ text: 'Alex likes tea', fallback: false }),
  mockGetRecentMessages: vi.fn(),
  mockLogEvent: vi.fn(),
  mockRemember: vi.fn().mockResolvedValue({ ok: true, id: 'doc-1' }),
  mockDb: vi.fn(),
  mockIsEphemeralMode: vi.fn(() => false),
}))

vi.mock('ion-sdk', () => ({
  log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

vi.mock('../config', () => ({
  HARNESS_DIR: '/tmp',
  OLLAMA_HOST: 'http://127.0.0.1:11434',
  isAllowedHost: () => true,
}))

vi.mock('../memory/episodic', () => ({
  db: mockDb,
  getRecentMessages: mockGetRecentMessages,
  logEvent: mockLogEvent,
}))

vi.mock('../memory/recall', () => ({
  remember: mockRemember,
}))

vi.mock('../memory/ephemeralMode', () => ({
  isEphemeralMode: mockIsEphemeralMode,
}))

vi.mock('./shared', () => ({
  ollamaChat: mockOllamaChat,
  normalizeFact: mockNormalizeFact,
  sleep: vi.fn().mockResolvedValue(undefined),
}))

import { extractAndStore, drainPendingMemory } from './factExtraction'

// Four messages clears the `rows.length < 4` short-exchange gate.
const FOUR_ROWS = [
  { role: 'user', content: 'one' },
  { role: 'assistant', content: 'two' },
  { role: 'user', content: 'three' },
  { role: 'assistant', content: 'four' },
]

// An empty-DB stub so drainPendingMemory finds no queued rows and returns fast.
const EMPTY_STMT = { get: () => ({ n: 0 }), all: () => [], run: () => undefined }

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

describe('extractAndStore in-flight lock key (#771)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDb.mockReturnValue({ prepare: () => EMPTY_STMT })
    mockGetRecentMessages.mockReturnValue(FOUR_ROWS)
  })

  it('a distinct lockKey does not block a concurrent same-session extraction', async () => {
    const gate = deferred<string>()
    mockOllamaChat.mockReturnValue(gate.promise)

    // Simulate the deep re-encode pass: same session, distinct lockKey. It reaches
    // ollamaChat and hangs there, holding the lock for `${session}::reencode`.
    const reencode = extractAndStore('sessA', { lockKey: 'sessA::reencode', budgetMs: 'double' })
    await vi.waitFor(() => expect(mockGetRecentMessages).toHaveBeenCalledTimes(1))

    // A normal turn_end extraction on the SAME session (default lockKey = session)
    // must proceed past the in-flight gate rather than skip.
    const normal = extractAndStore('sessA')
    await vi.waitFor(() => expect(mockGetRecentMessages).toHaveBeenCalledTimes(2))

    gate.resolve('') // unblock both passes so the locks release
    await Promise.all([reencode, normal])
  })

  it('the same lockKey still blocks a concurrent extraction (guard intact)', async () => {
    const gate = deferred<string>()
    mockOllamaChat.mockReturnValue(gate.promise)

    const first = extractAndStore('sessB') // holds lock 'sessB', hangs at ollamaChat
    await vi.waitFor(() => expect(mockGetRecentMessages).toHaveBeenCalledTimes(1))

    // Same default lockKey -> skipped immediately, returns [] without re-reading messages.
    const second = await extractAndStore('sessB')
    expect(second).toEqual([])
    expect(mockGetRecentMessages).toHaveBeenCalledTimes(1)

    gate.resolve('')
    await first
  })
})

describe('extractAndStore collection routing (#773/#774)', () => {
  const REMEMBER_TAIL = ['learning', 'jarvis_inference', undefined, undefined, expect.anything()]

  beforeEach(() => {
    vi.clearAllMocks()
    mockDb.mockReturnValue({ prepare: () => EMPTY_STMT })
    mockGetRecentMessages.mockReturnValue(FOUR_ROWS)
    // Passthrough normalization so assertions see the extracted text verbatim.
    mockNormalizeFact.mockImplementation((t: string) => Promise.resolve({ text: t, fallback: false }))
    mockRemember.mockResolvedValue({ ok: true, id: 'doc' })
    mockIsEphemeralMode.mockReturnValue(false)
  })

  it('routes [pref] to user_profile and [fact] to knowledge (#774)', async () => {
    mockOllamaChat.mockResolvedValue('1. [pref] Alex likes tea\n2. [fact] Alex runs a Mac Mini')

    await extractAndStore('sessC')

    expect(mockRemember).toHaveBeenCalledWith('Alex likes tea', 'user_profile', ...REMEMBER_TAIL)
    expect(mockRemember).toHaveBeenCalledWith('Alex runs a Mac Mini', 'knowledge', ...REMEMBER_TAIL)
  })

  it('routes all facts to task_memory in ephemeral mode regardless of type (#773)', async () => {
    mockIsEphemeralMode.mockReturnValue(true)
    mockOllamaChat.mockResolvedValue('1. [pref] Alex likes tea\n2. [fact] Alex runs a Mac Mini')

    await extractAndStore('sessD')

    expect(mockRemember).toHaveBeenCalledWith('Alex likes tea', 'task_memory', ...REMEMBER_TAIL)
    expect(mockRemember).toHaveBeenCalledWith('Alex runs a Mac Mini', 'task_memory', ...REMEMBER_TAIL)
  })

  it('defaults an untagged fact to user_profile (#774 backward-compat)', async () => {
    mockOllamaChat.mockResolvedValue('1. Alex likes tea')

    await extractAndStore('sessE')

    expect(mockRemember).toHaveBeenCalledWith('Alex likes tea', 'user_profile', ...REMEMBER_TAIL)
  })

  it('tolerates near-miss tags ([preference]/[factual]) and strips them', async () => {
    mockOllamaChat.mockResolvedValue('1. [preference] Alex likes tea\n2. [factual] Alex runs a Mac Mini')

    await extractAndStore('sessF')

    // Tag stripped (not embedded in the stored text) and routed by prefix.
    expect(mockRemember).toHaveBeenCalledWith('Alex likes tea', 'user_profile', ...REMEMBER_TAIL)
    expect(mockRemember).toHaveBeenCalledWith('Alex runs a Mac Mini', 'knowledge', ...REMEMBER_TAIL)
  })
})

describe('drainPendingMemory: normalize + guarded chokepoint (#863, #864)', () => {
  const runSpy = vi.fn()

  // A db() whose pending_memory SELECT returns the given rows. The count(*) depth
  // query returns a low count (no warn) and DELETE is captured by runSpy.
  function dbWithRows(rows: Array<{ id: number; detail: string }>) {
    return {
      prepare: (sql: string) => {
        if (/count\(\*\)/i.test(sql)) return { get: () => ({ n: rows.length }) }
        if (/DELETE/i.test(sql)) return { run: runSpy }
        return { all: () => rows }
      },
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockRemember.mockResolvedValue({ ok: true, id: 'doc-1' })
    mockNormalizeFact.mockResolvedValue({ text: 'Alex likes tea.', fallback: false })
  })

  it('normalizes a queued RAW fact before storing, then deletes the row (#863)', async () => {
    // queueRemaining() queues raw pre-normalization text, so the drain must
    // normalize it -- here a leading-pronoun raw fact becomes a Alex-subject one.
    const rows = [{ id: 1, detail: JSON.stringify({ text: 'he likes tea', collection: 'knowledge', session: 'S' }) }]
    mockDb.mockReturnValue(dbWithRows(rows))

    await drainPendingMemory('S')

    expect(mockNormalizeFact).toHaveBeenCalledWith('he likes tea', expect.anything())
    expect(mockRemember).toHaveBeenCalledWith('Alex likes tea.', 'knowledge', 'learning', 'jarvis_inference', undefined, undefined, expect.anything())
    expect(runSpy).toHaveBeenCalledWith(1)
  })

  it('emits memory_dedup_rejected and deletes the row on a drained dedup (#864)', async () => {
    mockRemember.mockResolvedValue({ ok: false, reason: 'dedup' })
    const rows = [{ id: 2, detail: JSON.stringify({ text: 'chris likes go', collection: 'knowledge', session: 'S' }) }]
    mockDb.mockReturnValue(dbWithRows(rows))

    await drainPendingMemory('S')

    expect(mockLogEvent).toHaveBeenCalledWith('S', 'memory_dedup_rejected', expect.objectContaining({ collection: 'knowledge' }))
    expect(runSpy).toHaveBeenCalledWith(2)
  })

  it('deletes a row on a TERMINAL remember failure so it cannot poison the queue (4xx)', async () => {
    // A persistent 4xx ('other', budget not aborted) will never succeed; leaving
    // it would loop forever and burn a normalizeFact call each cycle.
    mockRemember.mockResolvedValue({ ok: false, reason: 'other', detail: 'HTTP 400' })
    const rows = [{ id: 4, detail: JSON.stringify({ text: 'chris likes go', collection: 'knowledge', session: 'S' }) }]
    mockDb.mockReturnValue(dbWithRows(rows))

    await drainPendingMemory('S')

    expect(runSpy).toHaveBeenCalledWith(4)
  })

  it('LEAVES a row on a transient remember failure (network) for the next turn', async () => {
    mockRemember.mockResolvedValue({ ok: false, reason: 'network', detail: 'ECONNREFUSED' })
    const rows = [{ id: 5, detail: JSON.stringify({ text: 'chris likes go', collection: 'knowledge', session: 'S' }) }]
    mockDb.mockReturnValue(dbWithRows(rows))

    await drainPendingMemory('S')

    expect(runSpy).not.toHaveBeenCalledWith(5)
  })

  it('drops a queued secret via the chokepoint and removes the row (never requeues)', async () => {
    const secret = 'token ghp_abcdefghijklmnopqrstuvwxyz0123'
    // normalizeFact returns the secret unchanged; the guard inside guardedRemember
    // must reject it so it never reaches remember(), and the row is deleted.
    mockNormalizeFact.mockResolvedValue({ text: secret, fallback: true })
    const rows = [{ id: 3, detail: JSON.stringify({ text: secret, collection: 'knowledge', session: 'S' }) }]
    mockDb.mockReturnValue(dbWithRows(rows))

    await drainPendingMemory('S')

    expect(mockRemember).not.toHaveBeenCalled()
    expect(runSpy).toHaveBeenCalledWith(3)
  })
})
