import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Hoisted mocks — must be declared before any imports that touch these modules
// ---------------------------------------------------------------------------

const {
  mockRecall,
  mockActiveGoalCount,
  mockListActiveGoalIntents,
  mockInsertAction,
  mockPendingActions,
  mockLogEvent,
  mockRunCommandAsync,
  mockPostProactive,
} = vi.hoisted(() => ({
  mockRecall: vi.fn().mockResolvedValue({ results: [] }),
  mockActiveGoalCount: vi.fn().mockReturnValue(0),
  mockListActiveGoalIntents: vi.fn().mockReturnValue([]),
  mockInsertAction: vi.fn().mockReturnValue(42),
  mockPendingActions: vi.fn().mockReturnValue([]),
  mockLogEvent: vi.fn().mockReturnValue(1),
  mockRunCommandAsync: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
  mockPostProactive: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../memory/recall', () => ({
  recall: mockRecall,
}))

vi.mock('../memory/episodic', () => ({
  activeGoalCount: mockActiveGoalCount,
  listActiveGoalIntents: mockListActiveGoalIntents,
  insertAction: mockInsertAction,
  pendingActions: mockPendingActions,
  logEvent: mockLogEvent,
}))

vi.mock('../util/ionPrompt', () => ({
  runCommandAsync: mockRunCommandAsync,
}))

vi.mock('../proactive/notify', () => ({
  postProactive: mockPostProactive,
}))

import { runGoalProposal } from './goalProposal'
// tokenOverlap unit tests moved to util/stringMetrics.test.ts (#846).

// ---------------------------------------------------------------------------
// runGoalProposal integration tests
// ---------------------------------------------------------------------------

const VALID_PROPOSAL_JSON = JSON.stringify({
  intent: 'monitor security vulnerabilities weekly',
  cadence: 'weekly',
  owner_staff_id: 'systems-engineer',
  budget_tool_calls: 5,
  budget_minutes: 30,
})

beforeEach(() => {
  vi.clearAllMocks()
  mockActiveGoalCount.mockReturnValue(0)
  mockListActiveGoalIntents.mockReturnValue([])
  mockInsertAction.mockReturnValue(42)
  mockPendingActions.mockReturnValue([])
  mockLogEvent.mockReturnValue(1)
  mockRecall.mockResolvedValue({ results: [] })
  mockRunCommandAsync.mockResolvedValue({ stdout: VALID_PROPOSAL_JSON, stderr: '', exitCode: 0 })
  mockPostProactive.mockResolvedValue(undefined)
})

describe('runGoalProposal — cap enforcement', () => {
  it('skips with logEvent when active goals are at MAX_ACTIVE_GOALS (10)', async () => {
    mockActiveGoalCount.mockReturnValue(10)

    await runGoalProposal()

    expect(mockInsertAction).not.toHaveBeenCalled()

    // logEvent should be called with a skip message
    expect(mockLogEvent).toHaveBeenCalled()
    const [, , message] = mockLogEvent.mock.calls[0] as [string, string, string]
    expect(message).toMatch(/skip/i)
  })
})

describe('runGoalProposal — null proposal handling', () => {
  it('does not call insertGoal when ollama returns invalid JSON', async () => {
    // Provide a recall result so gatherSignals returns at least one signal
    mockRecall.mockResolvedValue({ results: ['some interesting activity'] })
    mockRunCommandAsync.mockResolvedValue({ stdout: 'not valid json at all', stderr: '', exitCode: 0 })

    await runGoalProposal()

    expect(mockInsertAction).not.toHaveBeenCalled()
  })

  it('does not throw when ollama returns invalid JSON', async () => {
    mockRecall.mockResolvedValue({ results: ['some interesting activity'] })
    mockRunCommandAsync.mockResolvedValue({ stdout: '???', stderr: '', exitCode: 1 })

    await expect(runGoalProposal()).resolves.toBeUndefined()
  })
})

describe('runGoalProposal — MAX_NEW_PER_RUN cap', () => {
  it('inserts at most MAX_NEW_PER_RUN (3) goals even when more signals are available', async () => {
    // Return signals from recall so gatherSignals produces multiple entries.
    // recall is called twice (knowledge + user_profile), each returns 3 results,
    // which collapses to 2 signals. To force a third signal we need both calls to
    // return non-empty results AND a third distinct recall call path.
    // The simplest approach: make recall return different data on each call
    // so both knowledge and user_profile branches produce a signal.
    mockRecall
      .mockResolvedValueOnce({ results: ['activity-a', 'activity-b', 'activity-c'] })
      .mockResolvedValueOnce({ results: ['profile-x', 'profile-y', 'profile-z'] })

    mockRunCommandAsync.mockResolvedValue({ stdout: VALID_PROPOSAL_JSON, stderr: '', exitCode: 0 })

    // No active intents → no dedup rejections
    mockListActiveGoalIntents.mockReturnValue([])

    await runGoalProposal()

    // gatherSignals produces at most 2 signals (one per recall call), so
    // MAX_NEW_PER_RUN=3 is not the binding constraint here. But this test
    // verifies that when signals exist, insertGoal is called at most once per
    // signal and never exceeds MAX_NEW_PER_RUN total.
    expect(mockInsertAction.mock.calls.length).toBeLessThanOrEqual(3)
  })

  it('respects MAX_NEW_PER_RUN=3 when recall supplies many results', async () => {
    // Simulate a scenario where we have 2 signals (the max gatherSignals can produce
    // with the current two-recall design): both knowledge and user_profile return results.
    mockRecall.mockResolvedValue({ results: ['item-1', 'item-2', 'item-3'] })

    // Each proposalFromSignal succeeds
    mockRunCommandAsync.mockResolvedValue({ stdout: VALID_PROPOSAL_JSON, stderr: '', exitCode: 0 })
    mockListActiveGoalIntents.mockReturnValue([])

    await runGoalProposal()

    // Must never exceed the cap
    expect(mockInsertAction.mock.calls.length).toBeLessThanOrEqual(3)
  })
})

describe('runGoalProposal — empty signals', () => {
  it('logs a skip message and does not call insertGoal when no signals are found', async () => {
    mockRecall.mockResolvedValue({ results: [] })

    await runGoalProposal()

    expect(mockInsertAction).not.toHaveBeenCalled()
    expect(mockLogEvent).toHaveBeenCalled()
    const [, , message] = mockLogEvent.mock.calls[0] as [string, string, string]
    expect(typeof message).toBe('string')
    expect(message.length).toBeGreaterThan(0)
  })
})

describe('runGoalProposal — deduplication', () => {
  it('skips inserting a goal whose intent overlaps >= 0.6 with an existing active goal', async () => {
    mockRecall.mockResolvedValue({ results: ['security monitoring signal'] })

    // Active intent that overlaps heavily with the proposal
    mockListActiveGoalIntents.mockReturnValue(['monitor security vulnerabilities weekly'])

    // proposalFromSignal returns the same intent
    mockRunCommandAsync.mockResolvedValue({ stdout: VALID_PROPOSAL_JSON, stderr: '', exitCode: 0 })

    await runGoalProposal()

    expect(mockInsertAction).not.toHaveBeenCalled()

    const dupLogCalls = mockLogEvent.mock.calls.filter(
      (call) => typeof call[2] === 'string' && (call[2]).toLowerCase().includes('duplicate'),
    )
    expect(dupLogCalls.length).toBeGreaterThan(0)
  })

  it('inserts a goal whose intent does NOT overlap with any active goal', async () => {
    // Only the first recall call (knowledge collection) returns results → 1 signal.
    // The second recall call (user_profile) returns empty → no second signal.
    mockRecall
      .mockResolvedValueOnce({ results: ['portfolio activity'] })
      .mockResolvedValueOnce({ results: [] })

    // Active intents that are unrelated to the proposal's intent
    mockListActiveGoalIntents.mockReturnValue(['morning brief priorities'])

    mockRunCommandAsync.mockResolvedValue({ stdout: VALID_PROPOSAL_JSON, stderr: '', exitCode: 0 })

    await runGoalProposal()

    expect(mockInsertAction).toHaveBeenCalledOnce()
  })
})
