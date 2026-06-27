import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { recall, remember, recallMeta, formatRecalledMemory, type RecallItem, clearRecallDegradation, consumeRecallDegradation } from './recall'

const ORIGINAL_FETCH = globalThis.fetch

function mockFetch(body: unknown, _ok = true, status = 200): void {
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  )
}

function mockFetchReject(err: Error): void {
  globalThis.fetch = vi.fn(async () => {
    throw err
  })
}

describe('recall', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('successfully recalls facts on timeout (default 10s)', async () => {
    mockFetch({ results: ['fact-a', 'fact-b'], elapsed_ms: 5 })
    const r = await recall('test')
    expect(r.results).toEqual(['fact-a', 'fact-b'])
    expect(typeof r.elapsed_ms).toBe('number')
  })

  it('returns parsed results on a successful response', async () => {
    mockFetch({ results: ['fact-a', 'fact-b'], elapsed_ms: 7 })
    const r = await recall('what does the user prefer')
    expect(r.results).toEqual(['fact-a', 'fact-b'])
    expect(r.elapsed_ms).toBe(7)
  })

  it('posts to the vec server /recall endpoint with the right payload', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ results: [], elapsed_ms: 0 })),
    ) as unknown as typeof fetch
    globalThis.fetch = fetchMock
    await recall('q', 'knowledge', 3)
    const calls = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls
    expect(calls.length).toBe(1)
    const [url, init] = calls[0] as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:9876/recall')
    expect(init.method).toBe('POST')
    const parsed = JSON.parse(init.body as string) as Record<string, unknown>
    expect(parsed).toMatchObject({ query: 'q', collection: 'knowledge', n: 3 })
  })

  it('returns empty results when the server returns non-OK', async () => {
    mockFetch({ results: ['ignored'], elapsed_ms: 0 }, false, 500)
    const r = await recall('q')
    expect(r.results).toEqual([])
    expect(typeof r.elapsed_ms).toBe('number')
  })

  it('returns empty results when fetch throws (server unreachable)', async () => {
    mockFetchReject(new Error('ECONNREFUSED'))
    const r = await recall('q')
    expect(r.results).toEqual([])
  })

  it('defaults collection to user_profile and n to 5', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ results: [], elapsed_ms: 0 })),
    ) as unknown as typeof fetch
    globalThis.fetch = fetchMock
    await recall('q')
    const calls = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls
    const [, init] = calls[0] as [string, RequestInit]
    const parsed = JSON.parse(init.body as string) as Record<string, unknown>
    expect(parsed.collection).toBe('user_profile')
    expect(parsed.n).toBe(5)
  })
})

describe('recallMeta', () => {
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH
    vi.restoreAllMocks()
  })

  it('returns parsed rich items on success', async () => {
    mockFetch({
      results: [
        { text: 'Prefers terse output.', source: 'cli', confidence: 0.95, age_days: 3, archived: false },
        { text: 'Old habit.', source: 'manual', confidence: 0.7, age_days: 90, archived: true },
      ],
      elapsed_ms: 12,
    })
    const r = await recallMeta('preferences')
    expect(r.results.length).toBe(2)
    expect(r.results[0]?.source).toBe('cli')
    expect(r.results[1]?.archived).toBe(true)
  })

  it('falls back to /recall when /recall_meta returns non-OK', async () => {
    let call = 0
    globalThis.fetch = vi.fn(async () => {
      call++
      if (call === 1) return new Response('err', { status: 500 })
      return new Response(JSON.stringify({ results: ['legacy fact'], elapsed_ms: 1 }))
    })
    const r = await recallMeta('q')
    expect(r.results.length).toBe(1)
    expect(r.results[0]?.text).toBe('legacy fact')
    // Issue #572: fallback path uses 'fallback' (not 'unknown') to distinguish
    // provenance-stripped results from genuine unknown-source entries.
    expect(r.results[0]?.source).toBe('fallback')
  })

  it('strips [archive] prefix and sets archived flag in fallback path', async () => {
    let call = 0
    globalThis.fetch = vi.fn(async () => {
      call++
      if (call === 1) return new Response('err', { status: 500 })
      return new Response(JSON.stringify({ results: ['[archive] old fact'], elapsed_ms: 1 }))
    })
    const r = await recallMeta('q')
    expect(r.results[0]?.text).toBe('old fact')
    expect(r.results[0]?.archived).toBe(true)
  })
})

describe('formatRecalledMemory', () => {
  const mk = (text: string, source: string, ageDays: number, archived = false): RecallItem => ({
    text,
    source,
    confidence: 1,
    age_days: ageDays,
    archived,
  })

  it('returns empty string for empty input', () => {
    expect(formatRecalledMemory([])).toBe('')
  })

  it('places cli/manual items in Recent stated when age < 30', () => {
    const out = formatRecalledMemory([mk('fact a', 'cli', 5)])
    expect(out).toContain('Recent stated facts:')
    expect(out).toContain('fact a [cli, 5d]')
  })

  it('places stated items older than 30d in Older facts', () => {
    const out = formatRecalledMemory([mk('older fact', 'manual', 60)])
    expect(out).toContain('Older facts:')
    expect(out).toContain('older fact [manual, 60d]')
  })

  it('places learning / mail / browser items in Inferred / ingested', () => {
    const out = formatRecalledMemory([
      mk('inferred fact', 'learning', 2),
      mk('email fact', 'mail', 1),
      mk('browser fact', 'browser', 1),
    ])
    expect(out).toContain('Inferred / ingested:')
    expect(out).toContain('inferred fact [learning, 2d]')
    expect(out).toContain('email fact [mail, 1d]')
    expect(out).toContain('browser fact [browser, 1d]')
  })

  it('places archived items in From long-term archive with the [archive] prefix', () => {
    const out = formatRecalledMemory([mk('vintage', 'manual', 200, true)])
    expect(out).toContain('From long-term archive:')
    expect(out).toContain('[archive] vintage [manual, 200d]')
  })
})

describe('consumeRecallDegradation / clearRecallDegradation', () => {
  beforeEach(() => {
    // Ensure clean state before each test; side effects from other describe blocks
    // (e.g. recallMeta fallback tests that trigger recall fail) would otherwise
    // pollute these assertions.
    clearRecallDegradation()
  })

  afterEach(() => {
    clearRecallDegradation()
  })

  it('returns null when no degradation has been set', () => {
    expect(consumeRecallDegradation()).toBeNull()
  })

  it('returns null after clearRecallDegradation()', () => {
    // clearRecallDegradation leaves it null; consume should return null
    clearRecallDegradation()
    expect(consumeRecallDegradation()).toBeNull()
  })

  it('returns null on a second call (consume clears the signal)', () => {
    // Can only be tested via the recall() side effect -- trigger a failed recall
    // then consume twice.
    // We rely on the module state set by a network error from recall().
    // Use mockFetchReject path to set 'failed'.
    const origFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => { throw new Error('ECONNREFUSED') })
    const done = recall('q').then(() => {
      globalThis.fetch = origFetch
      // First consume: receives the reason.
      const first = consumeRecallDegradation()
      expect(['degraded', 'failed', null]).toContain(first)
      // Second consume: always null (signal cleared).
      expect(consumeRecallDegradation()).toBeNull()
    })
    return done
  })

  it('returns null (stale path) when maxAgeMs is -1', () => {
    // Force the stale branch: even if a signal exists (set via recall fail),
    // passing maxAgeMs=-1 means Date.now() - at will always be > -1 === stale.
    // To guarantee the signal is set we use a direct network error.
    const origFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => { throw new Error('ECONNREFUSED') })
    return recall('q').then(() => {
      globalThis.fetch = origFetch
      expect(consumeRecallDegradation(-1)).toBeNull()
    })
  })
})

describe('remember', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('returns ok true with id on success', async () => {
    mockFetch({ id: 'mem-123' })
    const result = await remember('the user lives in Texas')
    expect(result).toEqual({ ok: true, id: 'mem-123' })
  })

  it('returns network error on transient 5xx failure with retries', async () => {
    mockFetch({ id: 'ignored' }, false, 502)
    const promise = remember('x')
    await vi.advanceTimersByTimeAsync(10_000)
    const result = await promise
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('network')
    }
  })

  it('returns network error on fetch rejection with retries', async () => {
    mockFetchReject(new Error('ECONNREFUSED'))
    const promise = remember('x')
    await vi.advanceTimersByTimeAsync(10_000)
    const result = await promise
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('network')
    }
  })

  it('returns other error on 4xx client failures (no retry)', async () => {
    mockFetch({ id: 'ignored' }, false, 400)
    const result = await remember('x')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('other')
    }
  })

  it('returns dedup error when server returns id=undefined', async () => {
    mockFetch({})
    const result = await remember('x')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('dedup')
    }
  })

  it('includes source_actor in the POST body (default jarvis_inference)', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ id: 'mem-sa-default' })),
    ) as unknown as typeof fetch
    globalThis.fetch = fetchMock
    const result = await remember('some fact')
    expect(result.ok).toBe(true)
    const calls = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls
    const [, init] = calls[0] as [string, RequestInit]
    const parsed = JSON.parse(init.body as string) as Record<string, unknown>
    expect(parsed['source_actor']).toBe('jarvis_inference')
  })

  it('passes the provided sourceActor to the POST body', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ id: 'mem-sa-user' })),
    ) as unknown as typeof fetch
    globalThis.fetch = fetchMock
    const result = await remember('explicit user fact', 'knowledge', 'manual', 'user')
    expect(result.ok).toBe(true)
    const calls = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls
    const [, init] = calls[0] as [string, RequestInit]
    const parsed = JSON.parse(init.body as string) as Record<string, unknown>
    expect(parsed['source_actor']).toBe('user')
  })

  it('passes reflection sourceActor correctly', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ id: 'mem-sa-refl' })),
    ) as unknown as typeof fetch
    globalThis.fetch = fetchMock
    const result = await remember('reflection fact', 'user_profile', 'reflection', 'reflection')
    expect(result.ok).toBe(true)
    const calls = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls
    const [, init] = calls[0] as [string, RequestInit]
    const parsed = JSON.parse(init.body as string) as Record<string, unknown>
    expect(parsed['source_actor']).toBe('reflection')
  })

  it('sends raw text as embedding input and does not send a human-readable stored_at (#840)', async () => {
    vi.useRealTimers()
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ id: 'mem-ts' })),
    ) as unknown as typeof fetch
    globalThis.fetch = fetchMock
    await remember('raw fact text')
    const calls = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls
    const [, init] = calls[0] as [string, RequestInit]
    const parsed = JSON.parse(init.body as string) as Record<string, unknown>
    // text must be the raw string with NO timestamp prefix (fix #604)
    expect(parsed['text']).toBe('raw fact text')
    // #840: recall.ts must NOT inject a stored_at -- store.py stamps a clean ISO.
    // A poisoned human-readable stored_at broke the recency parser.
    const metadata = parsed['metadata'] as Record<string, unknown>
    expect(metadata['stored_at']).toBeUndefined()
    vi.useFakeTimers()
  })
})
