import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockLogEvent, mockRecentEvents } = vi.hoisted(() => ({
  mockLogEvent: vi.fn(),
  mockRecentEvents: vi.fn().mockReturnValue([]),
}))

const { mockOllamaChatJson, mockBuildRosterSummary } = vi.hoisted(() => ({
  mockOllamaChatJson: vi.fn().mockResolvedValue({ gap: false }),
  mockBuildRosterSummary: vi.fn().mockReturnValue('roster summary'),
}))

const { mockIsAllowedHost } = vi.hoisted(() => ({
  mockIsAllowedHost: vi.fn().mockReturnValue(true),
}))

vi.mock('ion-sdk', () => ({
  log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

vi.mock('../config', () => ({
  OLLAMA_HOST: 'http://127.0.0.1:11434',
  HARNESS_DIR: '/tmp',
  isAllowedHost: mockIsAllowedHost,
  loadModelForRole: vi.fn().mockReturnValue('qwen2.5:14b'),
  loadBackendForRole: vi.fn().mockReturnValue('ollama'),
  loadStaff: vi.fn().mockReturnValue([]),
}))

vi.mock('../memory/episodic', () => ({
  logEvent: mockLogEvent,
  recentEvents: mockRecentEvents,
  recentAgentEvents: vi.fn().mockReturnValue([]),
  getRecentMessages: vi.fn().mockReturnValue([]),
}))

vi.mock('./shared', () => ({
  ollamaChatJson: mockOllamaChatJson,
  buildRosterSummary: mockBuildRosterSummary,
}))

import { detectGapForMessage, clearGapCheckSession, SUPPRESSION_WINDOW_HOURS } from './gapDetection'

const SESSION = 'test-session-abc'

describe('detectGapForMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsAllowedHost.mockReturnValue(true)
    mockRecentEvents.mockReturnValue([])
    mockOllamaChatJson.mockResolvedValue({ gap: false })
    mockBuildRosterSummary.mockReturnValue('roster summary')
  })

  it('returns early without any calls when isAllowedHost is false', async () => {
    mockIsAllowedHost.mockReturnValue(false)

    await detectGapForMessage('help me with rust systems', SESSION)

    expect(mockRecentEvents).not.toHaveBeenCalled()
    expect(mockLogEvent).not.toHaveBeenCalled()
    expect(mockOllamaChatJson).not.toHaveBeenCalled()
  })

  it('skips LLM call and does not log gap_check when rate-limited (gap_check in window)', async () => {
    // gap_check event present in the 1-hour window => rate-limited
    mockRecentEvents.mockImplementation((_session: string, eventType: string) => {
      if (eventType === 'gap_check') return [{ detail: {} }]
      return []
    })

    await detectGapForMessage('help me with rust systems', SESSION)

    expect(mockOllamaChatJson).not.toHaveBeenCalled()
    // logEvent should NOT have been called for gap_check again
    const gapCheckCalls = mockLogEvent.mock.calls.filter((c) => c[1] === 'gap_check')
    expect(gapCheckCalls).toHaveLength(0)
  })

  it('logs gap_check event with source=per_turn on a non-rate-limited turn (gap:false LLM result)', async () => {
    // All recentEvents return [] -- no rate limit, no prior proposals
    mockOllamaChatJson.mockResolvedValue({ gap: false })

    await detectGapForMessage('how are you today', SESSION)

    expect(mockLogEvent).toHaveBeenCalledWith(SESSION, 'gap_check', { source: 'per_turn' })
  })

  it('checks rate limit with the 1-hour window for the session bucket key', async () => {
    await detectGapForMessage('help me with rust', SESSION)

    // Must call recentEvents with the session bucket key and event 'gap_check' with window=1
    expect(mockRecentEvents).toHaveBeenCalledWith(SESSION, 'gap_check', 1)
  })

  it('uses __global__ bucket key when no session is provided', async () => {
    await detectGapForMessage('help me with rust')

    expect(mockRecentEvents).toHaveBeenCalledWith('__global__', 'gap_check', 1)
  })

  // Word-split suppression: borderline case where suppression fires
  it('word-split SUPPRESSES when 2 of 3 cluster words match (borderline: matchCount >= min(2,3))', async () => {
    // cluster = 'machine_learning_systems', split words >= 4 chars: ['machine','learning','systems'] (all 3)
    // message contains 'machine' and 'learning' (2/3) => min(2,3)=2 => suppressed
    mockRecentEvents.mockImplementation((_session: string, eventType: string) => {
      if (eventType === 'staff_gap_proposed')
        return [{ detail: { topic_cluster: 'machine_learning_systems' } }]
      return []
    })

    await detectGapForMessage('help me with machine learning today', SESSION)

    expect(mockOllamaChatJson).not.toHaveBeenCalled()
    expect(mockLogEvent).toHaveBeenCalledWith(
      SESSION,
      'gap_detection_suppressed',
      expect.objectContaining({ cluster: 'machine_learning_systems', reason: 'word_split_match' }),
    )
  })

  // Word-split suppression: borderline case where suppression does NOT fire (only 1 word matches)
  it('word-split does NOT suppress when only 1 of 3 cluster words match (borderline: matchCount < min(2,3))', async () => {
    // cluster = 'machine_learning_systems', message only contains 'machine' (1/3) < min(2,3)=2
    mockRecentEvents.mockImplementation((_session: string, eventType: string) => {
      if (eventType === 'staff_gap_proposed')
        return [{ detail: { topic_cluster: 'machine_learning_systems' } }]
      return []
    })
    mockOllamaChatJson.mockResolvedValue({ gap: false })

    await detectGapForMessage('help me with machine vision tips', SESSION)

    // LLM WAS called (not suppressed)
    expect(mockOllamaChatJson).toHaveBeenCalled()
    // No suppression event emitted
    const suppressedCalls = mockLogEvent.mock.calls.filter(
      (c) => c[1] === 'gap_detection_suppressed',
    )
    expect(suppressedCalls).toHaveLength(0)
  })

  it('word-split suppression uses session arg for gap_detection_suppressed event (falls back to "gap_detection")', async () => {
    mockRecentEvents.mockImplementation((_session: string, eventType: string) => {
      if (eventType === 'staff_gap_proposed')
        return [{ detail: { topic_cluster: 'machine_learning_systems' } }]
      return []
    })

    // Call with no session -- should use 'gap_detection' as the session key
    await detectGapForMessage('help me with machine learning today')

    expect(mockLogEvent).toHaveBeenCalledWith(
      'gap_detection',
      'gap_detection_suppressed',
      expect.objectContaining({ cluster: 'machine_learning_systems' }),
    )
  })

  it('LLM failure path: resolves silently without throwing or emitting per_turn_gap_detected', async () => {
    mockOllamaChatJson.mockRejectedValue(new Error('ollama unreachable'))

    await expect(detectGapForMessage('help me with rust systems', SESSION)).resolves.toBeUndefined()

    const gapDetectedCalls = mockLogEvent.mock.calls.filter(
      (c) => c[1] === 'per_turn_gap_detected',
    )
    expect(gapDetectedCalls).toHaveLength(0)
  })

  it('happy path: emits per_turn_gap_detected with cluster and description when gap:true', async () => {
    mockOllamaChatJson.mockResolvedValue({
      gap: true,
      topic_cluster: 'rust_systems',
      description: 'User needs low-level Rust assistance',
    })

    await detectGapForMessage('help me with rust systems programming', SESSION)

    expect(mockLogEvent).toHaveBeenCalledWith(
      '',
      'per_turn_gap_detected',
      expect.objectContaining({
        topic_cluster: 'rust_systems',
        description: 'User needs low-level Rust assistance',
        source: 'per_turn',
      }),
    )
  })

  it('gap:false from LLM: no per_turn_gap_detected emitted', async () => {
    mockOllamaChatJson.mockResolvedValue({ gap: false, topic_cluster: 'rust', description: 'x' })

    await detectGapForMessage('tell me about rust', SESSION)

    const gapDetectedCalls = mockLogEvent.mock.calls.filter(
      (c) => c[1] === 'per_turn_gap_detected',
    )
    expect(gapDetectedCalls).toHaveLength(0)
  })

  it('gap:true but empty topic_cluster: no per_turn_gap_detected emitted', async () => {
    mockOllamaChatJson.mockResolvedValue({ gap: true, topic_cluster: '', description: 'something' })

    await detectGapForMessage('help me with rust', SESSION)

    const gapDetectedCalls = mockLogEvent.mock.calls.filter(
      (c) => c[1] === 'per_turn_gap_detected',
    )
    expect(gapDetectedCalls).toHaveLength(0)
  })

  it('cross-session dedup via per_turn_gap_detected: skips emit when cluster already detected in 7-day window', async () => {
    mockOllamaChatJson.mockResolvedValue({
      gap: true,
      topic_cluster: 'rust_systems',
      description: 'User needs rust help',
    })
    // Already detected in this window
    mockRecentEvents.mockImplementation((_session: string, eventType: string) => {
      if (eventType === 'per_turn_gap_detected')
        return [{ detail: { topic_cluster: 'rust_systems' } }]
      return []
    })

    await detectGapForMessage('help me with rust systems', SESSION)

    const gapDetectedCalls = mockLogEvent.mock.calls.filter(
      (c) => c[1] === 'per_turn_gap_detected',
    )
    expect(gapDetectedCalls).toHaveLength(0)
  })

  it('cross-session dedup via staff_gap_proposed: skips emit when cluster was already proposed in 7-day window', async () => {
    mockOllamaChatJson.mockResolvedValue({
      gap: true,
      topic_cluster: 'kubernetes',
      description: 'User needs k8s help',
    })
    // Proposed in the 7-day window, but message does NOT contain 'kubernetes' words
    // (so word-split at the early check does not fire first)
    mockRecentEvents.mockImplementation((_session: string, eventType: string) => {
      if (eventType === 'staff_gap_proposed')
        return [{ detail: { topic_cluster: 'kubernetes' } }]
      return []
    })

    // Message deliberately does not contain 'kubernetes'
    await detectGapForMessage('I need help with container orchestration platforms', SESSION)

    const gapDetectedCalls = mockLogEvent.mock.calls.filter(
      (c) => c[1] === 'per_turn_gap_detected',
    )
    expect(gapDetectedCalls).toHaveLength(0)
  })

  it('SUPPRESSION_WINDOW_HOURS export equals 168 (7 days)', () => {
    expect(SUPPRESSION_WINDOW_HOURS).toBe(168)
  })
})

describe('clearGapCheckSession', () => {
  it('is a no-op that does not throw', () => {
    expect(() => clearGapCheckSession('any-session')).not.toThrow()
  })
})
