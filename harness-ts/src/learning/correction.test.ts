import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Regression coverage for Issue #793: deepReencodeOnCorrection's cascade must
// skip "[archive] "-prefixed recall hits. Those documents live in the `archive`
// collection, so forget(text, 'knowledge'|'user_profile') would always miss
// (deleted:false) and leave the stale fact; they are also already superseded.

const ORIGINAL_FETCH = globalThis.fetch

const { mockLogEvent, mockRecallMeta, mockRemember, mockForget } = vi.hoisted(() => ({
  mockLogEvent: vi.fn(),
  mockRecallMeta: vi.fn(),
  mockRemember: vi.fn().mockResolvedValue({ ok: true, id: 'new-id' }),
  mockForget: vi.fn().mockResolvedValue({ deleted: true, id: 'old-id' }),
}))

// Build a recallMeta RecallItem. archived defaults false; source/confidence are
// the provenance the #845 cascade threads into checkInvalidation.
function item(text: string, archived = false, source = 'jarvis_inference', confidence = 0.7) {
  return { text, source, confidence, age_days: null, archived }
}

vi.mock('ion-sdk', () => ({
  log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

vi.mock('../config', () => ({
  OLLAMA_HOST: 'http://127.0.0.1:11434',
  isAllowedHost: () => true,
  loadModelForRole: () => 'qwen2.5:14b',
  loadBackendForRole: () => 'ollama',
}))

vi.mock('../memory/episodic', () => ({ logEvent: mockLogEvent }))
vi.mock('../memory/recall', () => ({ recallMeta: mockRecallMeta, remember: mockRemember, forget: mockForget }))
vi.mock('../util/claudeAgent', () => ({ runClaudeAgent: vi.fn() }))

import { deepReencodeOnCorrection } from './correction'

function ollamaInvalidates(updated: string) {
  return {
    ok: true,
    json: async () => ({ message: { content: JSON.stringify({ invalidates: true, updated_fact: updated }) } }),
  }
}

describe('deepReencodeOnCorrection archive filtering (#793)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRemember.mockResolvedValue({ ok: true, id: 'new-id' })
    mockForget.mockResolvedValue({ deleted: true, id: 'old-id' })
    // The classifier says every fact it sees is invalidated.
    globalThis.fetch = vi.fn().mockResolvedValue(ollamaInvalidates('Alex now prefers espresso'))
  })

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH
  })

  it('never cascades or forgets an [archive]-prefixed recall hit', async () => {
    mockRecallMeta.mockImplementation((_q: string, collection: string) => {
      if (collection === 'knowledge') {
        return Promise.resolve({ results: [item('Alex likes tea'), item('[archive] Alex used to like coffee', true)], elapsed_ms: 0 })
      }
      return Promise.resolve({ results: [], elapsed_ms: 0 })
    })

    await deepReencodeOnCorrection('sess', 'I prefer espresso now', 'Alex likes tea')

    // The live fact is processed...
    expect(mockForget).toHaveBeenCalledWith('Alex likes tea', 'knowledge')
    // ...but the archive hit is never touched (no doomed forget, no cascade work).
    for (const call of mockForget.mock.calls) {
      expect(String(call[0]).startsWith('[archive] ')).toBe(false)
    }
    // checkInvalidation (the fetch) ran once: only the non-archive fact.
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
  })

  it('processes all hits normally when none are archived', async () => {
    mockRecallMeta.mockImplementation((_q: string, collection: string) =>
      collection === 'knowledge'
        ? Promise.resolve({ results: [item('Alex likes tea')], elapsed_ms: 0 })
        : Promise.resolve({ results: [item('Alex drinks it black')], elapsed_ms: 0 }),
    )

    await deepReencodeOnCorrection('sess', 'I prefer espresso now', 'Alex likes tea')

    expect(mockForget).toHaveBeenCalledWith('Alex likes tea', 'knowledge')
    expect(mockForget).toHaveBeenCalledWith('Alex drinks it black', 'user_profile')
  })
})

describe('deepReencodeOnCorrection cascade fixes (#845)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRemember.mockResolvedValue({ ok: true, id: 'new-id' })
    mockForget.mockResolvedValue({ deleted: true, id: 'old-id' })
    globalThis.fetch = vi.fn().mockResolvedValue(ollamaInvalidates('Alex now prefers espresso'))
    mockRecallMeta.mockImplementation((_q: string, collection: string) =>
      collection === 'knowledge'
        ? Promise.resolve({ results: [item('Alex likes tea', false, 'user_stated', 0.95)], elapsed_ms: 0 })
        : Promise.resolve({ results: [], elapsed_ms: 0 }),
    )
  })

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH
  })

  it('does not tombstone the active replacement fact (#838)', async () => {
    await deepReencodeOnCorrection('sess', 'I prefer espresso now', 'Alex likes tea')
    // The replacement remember() must not carry superseded_by -- that belongs on
    // the old fact, retired by forget(). The metadata arg (5th) should be absent.
    expect(mockRemember).toHaveBeenCalled()
    const metaArg = mockRemember.mock.calls[0]?.[4]
    expect(metaArg).toBeUndefined()
  })

  it('threads source + confidence into the invalidation check (#842)', async () => {
    await deepReencodeOnCorrection('sess', 'I prefer espresso now', 'Alex likes tea')
    const firstCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, { body: string }] | undefined
    if (!firstCall) throw new Error('fetch was not called')
    const body = JSON.parse(firstCall[1].body) as { messages: { role: string; content: string }[] }
    const userMsg = body.messages.find((m) => m.role === 'user')?.content ?? ''
    expect(userMsg).toContain('source=user_stated')
    expect(userMsg).toContain('confidence=0.95')
  })
})
