import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock helpers module
vi.mock('../helpers', () => ({
  isEnabled: vi.fn().mockReturnValue(true),
  loadRoutinesConfig: vi.fn().mockReturnValue({}),
}))

// Mock episodic module
vi.mock('../../memory/episodic', () => ({
  logEvent: vi.fn(),
  db: vi.fn().mockReturnValue({
    prepare: vi.fn().mockReturnValue({
      all: vi.fn().mockReturnValue([]),
    }),
  }),
}))

// Mock ionPrompt module
vi.mock('../../util/ionPrompt', () => ({
  runCommandAsync: vi.fn(),
}))

// Mock approvals module
vi.mock('../../approvals', () => ({
  getPending: vi.fn().mockReturnValue([]),
}))

// Mock discord notify
vi.mock('../../discord/notify', () => ({
  notifyInterventionDigest: vi.fn(),
}))

import { runInterventionDigest } from './intervention'
import { isEnabled } from '../helpers'
import { logEvent, db } from '../../memory/episodic'
import { runCommandAsync } from '../../util/ionPrompt'
import { getPending } from '../../approvals'
import { notifyInterventionDigest } from '../../discord/notify'

const mockIsEnabled = vi.mocked(isEnabled)
const mockLogEvent = vi.mocked(logEvent)
const mockDb = vi.mocked(db)
const mockRunCommand = vi.mocked(runCommandAsync)
const mockGetPending = vi.mocked(getPending)
const mockNotifyDigest = vi.mocked(notifyInterventionDigest)

beforeEach(() => {
  vi.clearAllMocks()
  mockIsEnabled.mockReturnValue(true)
  mockDb.mockReturnValue({
    prepare: vi.fn().mockReturnValue({
      all: vi.fn().mockReturnValue([]),
    }),
  } as any)
  mockRunCommand.mockResolvedValue({ error: null as any, status: 0, stdout: '[]', stderr: '' })
  mockGetPending.mockReturnValue([])
  mockNotifyDigest.mockResolvedValue(undefined)
})

describe('runInterventionDigest', () => {
  it('skips when intervention_digest is disabled', async () => {
    mockIsEnabled.mockReturnValue(false)
    await runInterventionDigest()
    expect(mockLogEvent).not.toHaveBeenCalled()
  })

  it('skips and logs when all lists are empty', async () => {
    mockRunCommand.mockResolvedValue({ error: null as any, status: 0, stdout: '[]', stderr: '' })
    mockGetPending.mockReturnValue([])

    await runInterventionDigest()

    expect(mockNotifyDigest).not.toHaveBeenCalled()
    expect(mockLogEvent).toHaveBeenCalledWith(
      'intervention_digest',
      'routine_delivered',
      expect.objectContaining({ skipped: true }),
    )
  })

  it('partitions stuck issues: no jarvis-auto label and not in pending approvals', async () => {
    const issues = [
      {
        number: 1,
        title: 'Auto issue',
        url: 'http://e1',
        labels: [{ name: 'jarvis-auto' }],
      },
      {
        number: 2,
        title: 'Pending issue',
        url: 'http://e2',
        labels: [],
      },
      {
        number: 3,
        title: 'Stuck issue',
        url: 'http://e3',
        labels: [],
      },
    ]
    mockRunCommand.mockResolvedValue({ error: null as any, status: 0, stdout: JSON.stringify(issues), stderr: '' })

    const pending = [
      {
        id: 100,
        kind: 'resolver' as const,
        github_issue_number: 2,
        summary: 'Pending fix',
        github_run_id: null,
        files_changed: null,
        diff_excerpt: null,
        risk_tier: 'safe' as const,
        discord_message_id: null,
        discord_local_index: null,
        requested_at: 0,
        decided_at: null,
        decision: null,
        decided_by: null,
      },
    ]
    mockGetPending.mockReturnValue(pending)

    await runInterventionDigest()

    expect(mockNotifyDigest).toHaveBeenCalledOnce()
    const [opts] = mockNotifyDigest.mock.calls[0] as any
    expect(opts.stuck).toHaveLength(1)
    expect(opts.stuck[0]?.number).toBe(3)
  })

  it('includes pending approvals in digest', async () => {
    mockRunCommand.mockResolvedValue({ error: null as any, status: 0, stdout: '[]', stderr: '' })

    const pending = [
      {
        id: 100,
        kind: 'resolver' as const,
        github_issue_number: 123,
        summary: 'Fix for critical bug',
        github_run_id: null,
        files_changed: null,
        diff_excerpt: null,
        risk_tier: 'safe' as const,
        discord_message_id: null,
        discord_local_index: null,
        requested_at: 0,
        decided_at: null,
        decision: null,
        decided_by: null,
      },
    ]
    mockGetPending.mockReturnValue(pending)

    await runInterventionDigest()

    expect(mockNotifyDigest).toHaveBeenCalledOnce()
    const [opts] = mockNotifyDigest.mock.calls[0] as any
    expect(opts.pendingApprovals).toHaveLength(1)
    expect(opts.pendingApprovals[0]?.issueNumber).toBe(123)
  })

  it('includes recent failures from agent_events', async () => {
    mockRunCommand.mockResolvedValue({ error: null as any, status: 0, stdout: '[]', stderr: '' })
    mockGetPending.mockReturnValue([])

    const dbMock = {
      prepare: vi.fn().mockReturnValue({
        all: vi.fn().mockReturnValue([
          {
            detail: JSON.stringify({
              event_type: 'resolver_failed',
              issue_number: 456,
              error: 'Build failed',
            }),
            ts: '2026-05-25T10:00:00Z',
          },
        ]),
      }),
    }
    mockDb.mockReturnValue(dbMock as any)

    await runInterventionDigest()

    expect(mockNotifyDigest).toHaveBeenCalledOnce()
    const [opts] = mockNotifyDigest.mock.calls[0] as any
    expect(opts.recentFailures).toHaveLength(1)
    expect(opts.recentFailures[0]?.issueNumber).toBe(456)
  })

  it('logs routine_delivered on success (scheduler owns routine_started)', async () => {
    mockRunCommand.mockResolvedValue({ error: null as any, status: 0, stdout: '[]', stderr: '' })
    const pending = [
      {
        id: 100,
        kind: 'resolver' as const,
        github_issue_number: 123,
        summary: 'Fix',
        github_run_id: null,
        files_changed: null,
        diff_excerpt: null,
        risk_tier: 'safe' as const,
        discord_message_id: null,
        discord_local_index: null,
        requested_at: 0,
        decided_at: null,
        decision: null,
        decided_by: null,
      },
    ]
    mockGetPending.mockReturnValue(pending)

    await runInterventionDigest()

    expect(mockLogEvent).not.toHaveBeenCalledWith('intervention_digest', 'routine_started', expect.anything())
    expect(mockLogEvent).toHaveBeenCalledWith(
      'intervention_digest',
      'routine_delivered',
      expect.objectContaining({
        routine: 'intervention_digest',
        stuck_count: 0,
        pending_approvals_count: 1,
      }),
    )
  })
})
