import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { parseCommand, dispatchDeployWorkflow } from './bot'
import type { Approval } from '../approvals/index'
import type { spawnSync as SpawnSyncFn } from 'node:child_process'

// ---------------------------------------------------------------------------
// parseCommand tests (unchanged)
// ---------------------------------------------------------------------------

describe('parseCommand', () => {
  it('parses approve <N>', () => {
    expect(parseCommand('approve 1')).toEqual({ type: 'approve_index', index: 1 })
    expect(parseCommand('approve 3')).toEqual({ type: 'approve_index', index: 3 })
    expect(parseCommand('APPROVE 2')).toEqual({ type: 'approve_index', index: 2 })
  })

  it('parses deny <N>', () => {
    expect(parseCommand('deny 2')).toEqual({ type: 'deny_index', index: 2 })
    expect(parseCommand('DENY 1')).toEqual({ type: 'deny_index', index: 1 })
  })

  it('parses approve #<issue>', () => {
    expect(parseCommand('approve #247')).toEqual({ type: 'approve_issue', issueNumber: 247 })
    expect(parseCommand('APPROVE #336')).toEqual({ type: 'approve_issue', issueNumber: 336 })
  })

  it('parses approve all without filter', () => {
    expect(parseCommand('approve all')).toEqual({ type: 'approve_all', filter: undefined })
    expect(parseCommand('APPROVE ALL')).toEqual({ type: 'approve_all', filter: undefined })
  })

  it('parses approve all with filter', () => {
    expect(parseCommand('approve all engine')).toEqual({ type: 'approve_all', filter: 'engine' })
    expect(parseCommand('approve all resolver')).toEqual({ type: 'approve_all', filter: 'resolver' })
  })

  it('parses status', () => {
    expect(parseCommand('status')).toEqual({ type: 'status' })
    expect(parseCommand('STATUS')).toEqual({ type: 'status' })
  })

  it('parses pending', () => {
    expect(parseCommand('pending')).toEqual({ type: 'pending' })
    expect(parseCommand('PENDING')).toEqual({ type: 'pending' })
  })

  it('returns unknown for unrecognized input', () => {
    expect(parseCommand('hello')).toEqual({ type: 'unknown' })
    expect(parseCommand('')).toEqual({ type: 'unknown' })
    expect(parseCommand('approve')).toEqual({ type: 'unknown' })
    expect(parseCommand('deny')).toEqual({ type: 'unknown' })
  })

  it('parses help and ? alias', () => {
    expect(parseCommand('help')).toEqual({ type: 'help' })
    expect(parseCommand('HELP')).toEqual({ type: 'help' })
    expect(parseCommand('?')).toEqual({ type: 'help' })
    expect(parseCommand('  help  ')).toEqual({ type: 'help' })
  })

  it('handles leading and trailing whitespace', () => {
    expect(parseCommand('  approve 1  ')).toEqual({ type: 'approve_index', index: 1 })
    expect(parseCommand('  status  ')).toEqual({ type: 'status' })
  })
})

// ---------------------------------------------------------------------------
// dispatchDeployWorkflow tests
// ---------------------------------------------------------------------------

function makeApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: 42,
    kind: 'desktop_deploy',
    github_run_id: 'abc1234def5678901234567890123456789012345',
    github_issue_number: null,
    summary: 'Ion Desktop build abc1234 (3 files)',
    files_changed: ['ion/desktop/src/main.ts'],
    diff_excerpt: null,
    risk_tier: 'risky',
    discord_message_id: null,
    discord_local_index: 1,
    requested_at: Date.now(),
    decided_at: null,
    decision: null,
    decided_by: null,
    ...overrides,
  }
}

function makeSpawnResult(status: number, stderr = ''): ReturnType<typeof SpawnSyncFn> {
  return {
    stdout: Buffer.from(''),
    stderr: Buffer.from(stderr),
    status,
    pid: 0,
    output: [],
    signal: null,
  }
}

describe('dispatchDeployWorkflow', () => {
  let consoleError: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleError.mockRestore()
  })

  it('calls gh with correct args for desktop_deploy with valid SHA', () => {
    const spawn = vi.fn().mockReturnValue(makeSpawnResult(0)) as unknown as typeof SpawnSyncFn
    const approval = makeApproval()

    const result = dispatchDeployWorkflow(approval, spawn)

    expect(result).toBe(true)
    expect(spawn).toHaveBeenCalledOnce()
    const [bin, args] = (spawn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string[]]
    expect(bin).toMatch(/gh$/)
    expect(args).toContain('workflow')
    expect(args).toContain('run')
    expect(args).toContain('desktop-deploy.yml')
    expect(args).toContain(`sha=${approval.github_run_id}`)
    expect(args).toContain(`approve_id=${String(approval.id)}`)
    expect(args).toContain('<your-org>/jarvis')
  })

  it('returns false and logs error when github_run_id is null', () => {
    const spawn = vi.fn() as unknown as typeof SpawnSyncFn
    const approval = makeApproval({ github_run_id: null })

    const result = dispatchDeployWorkflow(approval, spawn)

    expect(result).toBe(false)
    expect(spawn).not.toHaveBeenCalled()
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('no github_run_id'))
  })

  it('returns false for kind=improve without calling gh', () => {
    const spawn = vi.fn() as unknown as typeof SpawnSyncFn
    const approval = makeApproval({ kind: 'improve' })

    const result = dispatchDeployWorkflow(approval, spawn)

    expect(result).toBe(false)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('returns false for kind=resolver without calling gh', () => {
    const spawn = vi.fn() as unknown as typeof SpawnSyncFn
    const approval = makeApproval({ kind: 'resolver' })

    const result = dispatchDeployWorkflow(approval, spawn)

    expect(result).toBe(false)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('returns false and logs error when gh subprocess fails', () => {
    const spawn = vi.fn().mockReturnValue(makeSpawnResult(1, 'gh: unauthorized')) as unknown as typeof SpawnSyncFn
    const approval = makeApproval()

    const result = dispatchDeployWorkflow(approval, spawn)

    expect(result).toBe(false)
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('gh workflow run failed'),
      expect.anything(),
    )
  })
})
