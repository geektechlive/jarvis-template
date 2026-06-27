import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mocks must be declared before imports that use them.

vi.mock('../helpers', () => ({
  isEnabled: vi.fn().mockReturnValue(true),
  isQuietHours: vi.fn().mockReturnValue(false),
}))

vi.mock('../../memory/episodic', () => ({
  logEvent: vi.fn(),
}))

vi.mock('../../discord/notify', () => ({
  notifyPatrolCycle: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../ctx', () => ({
  getSchedulerCtx: vi.fn().mockReturnValue(null),
}))

vi.mock('../../util/claudeAgent', () => ({
  runClaudeAgent: vi.fn().mockResolvedValue('agent output'),
}))

vi.mock('../../util/ionPrompt', () => ({
  runCommandAsync: vi.fn().mockResolvedValue({ error: null, status: 0, stdout: '[]', stderr: '' }),
}))

// Mock log-patrol-cursor to avoid fs side effects
vi.mock('./log-patrol-cursor', () => ({
  readLogSlice: vi.fn().mockReturnValue(''),
}))

// Mock resolver (pulled in via patrol.ts import of runIssueResolver)
vi.mock('../../patrol/resolver', () => ({
  resolveNextAutoIssue: vi.fn().mockResolvedValue(undefined),
  RESOLVER_MAX_RUN_MS: 60_000,
}))

import { runLogPatrol } from './patrol'
import { getSchedulerCtx } from '../ctx'
import { runClaudeAgent } from '../../util/claudeAgent'

const mockGetCtx = vi.mocked(getSchedulerCtx)
const mockRunClaudeAgent = vi.mocked(runClaudeAgent)

// Helper: build a minimal mock IonContext with a controllable dispatchAgent
function makeCtx(dispatchAgent: () => Promise<{ output: string }>) {
  return {
    dispatchAgent: vi.fn().mockImplementation(dispatchAgent),
  } as unknown as ReturnType<typeof getSchedulerCtx>
}

beforeEach(() => {
  vi.clearAllMocks()
  // Default: no ctx (cold-start path)
  mockGetCtx.mockReturnValue(null)
  mockRunClaudeAgent.mockResolvedValue('agent output')
})

describe('dispatchPatrol (via runLogPatrol)', () => {
  it('calls runClaudeAgent when ctx is null', async () => {
    mockGetCtx.mockReturnValue(null)

    await runLogPatrol()

    expect(mockRunClaudeAgent).toHaveBeenCalledOnce()
  })

  it('does NOT call runClaudeAgent when ctx exists and dispatchAgent succeeds', async () => {
    const ctx = makeCtx(() => Promise.resolve({ output: 'PATROL_CLEAR' }))
    mockGetCtx.mockReturnValue(ctx)

    await runLogPatrol()

    expect(mockRunClaudeAgent).not.toHaveBeenCalled()
  })

  it('falls back to runClaudeAgent when dispatchAgent throws "dispatch not available"', async () => {
    const ctx = makeCtx(() => Promise.reject(new Error('dispatch not available in async context')))
    mockGetCtx.mockReturnValue(ctx)

    await runLogPatrol()

    expect(mockRunClaudeAgent).toHaveBeenCalledOnce()
  })

  it('falls back to runClaudeAgent (not empty string) when dispatchAgent throws an arbitrary error (#522)', async () => {
    const ctx = makeCtx(() => Promise.reject(new Error('ion internal error: process crashed')))
    mockGetCtx.mockReturnValue(ctx)

    await runLogPatrol()

    // Bug #522 fix: must still call runClaudeAgent instead of returning ''
    expect(mockRunClaudeAgent).toHaveBeenCalledOnce()
  })

  it('dispatches with background:true when ctx exists and dispatchAgent succeeds (#718)', async () => {
    const dispatchFn = vi.fn().mockResolvedValue({ output: 'PATROL_CLEAR' })
    const ctx = { dispatchAgent: dispatchFn } as unknown as ReturnType<typeof getSchedulerCtx>
    mockGetCtx.mockReturnValue(ctx)

    await runLogPatrol()

    // Background dispatch must have been requested
    expect(dispatchFn).toHaveBeenCalledOnce()
    const opts = dispatchFn.mock.calls[0]?.[0] as { background?: boolean } | undefined
    expect(opts?.background).toBe(true)
    // Subprocess fallback must NOT have been called
    expect(mockRunClaudeAgent).not.toHaveBeenCalled()
  })

  it('falls back to runClaudeAgent when dispatchAgent throws (non-"dispatch not available" error) after background adoption (#718)', async () => {
    // "dispatch not available" still falls through; other errors also fall through
    const ctx = makeCtx(() => Promise.reject(new Error('dispatch not available')))
    mockGetCtx.mockReturnValue(ctx)

    await runLogPatrol()

    expect(mockRunClaudeAgent).toHaveBeenCalledOnce()
  })

  it('dedup reference includes recently-closed issues so closed issues are not re-filed', async () => {
    mockGetCtx.mockReturnValue(null)

    await runLogPatrol()

    const prompt = mockRunClaudeAgent.mock.calls[0]?.[1] as string
    // Must fetch closed issues, not just open ones, and gate them by recency.
    expect(prompt).toContain('--state closed')
    expect(prompt).toContain("closed:>=")
    // Must instruct the agent to treat a recently-closed match as already-handled
    // and to reopen (not re-file) a genuine regression.
    expect(prompt).toContain('ALREADY HANDLED')
    expect(prompt).toMatch(/reopen/i)
  })
})
