// Tests for applyApprovedImprove in improve/index.ts.
// All git operations and external calls are mocked so tests run offline.

import { describe, it, expect, beforeAll, afterAll, vi, type MockedFunction } from 'vitest'
import { join } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

// ---------------------------------------------------------------------------
// Environment isolation — must be set before any module is imported.
// ---------------------------------------------------------------------------

const tmpDir = join(tmpdir(), `improve-approved-test-${Date.now()}-${Math.trunc(Math.random() * 1e6)}`)

beforeAll(() => {
  mkdirSync(tmpDir, { recursive: true })
  process.env['AGENT_DATA_DIR'] = tmpDir
})

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
  delete process.env['AGENT_DATA_DIR']
})

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../util/ionPrompt', () => ({
  runCommandAsync: vi.fn(),
}))

vi.mock('../scheduler/ctx', () => ({
  getSchedulerCtx: vi.fn().mockReturnValue(null),
}))

vi.mock('../discord/digest', () => ({
  postPendingDigest: vi.fn().mockResolvedValue(undefined),
}))

// ---------------------------------------------------------------------------
// Dynamic imports (after env + mocks are in place)
// ---------------------------------------------------------------------------

let runCommandAsync: MockedFunction<(cmd: string, args: string[], opts?: Record<string, unknown>) => Promise<{ stdout: string; stderr: string; status: number | null; error?: unknown }>>
let approvals: typeof import('../approvals/index')

beforeAll(async () => {
  const ionPrompt = await import('../util/ionPrompt')
  runCommandAsync = ionPrompt.runCommandAsync as typeof runCommandAsync

  approvals = await import('../approvals/index')
})

// ---------------------------------------------------------------------------
// applyApprovedImprove
// ---------------------------------------------------------------------------

describe('applyApprovedImprove', () => {
  it('returns error when approval not found', async () => {
    const { applyApprovedImprove } = await import('./index')
    const result = await applyApprovedImprove(999999)
    expect(result.ok).toBe(false)
    expect(result.diff).toMatch(/not found/)
  })

  it('returns error when approval already decided', async () => {
    const { applyApprovedImprove } = await import('./index')

    const id = approvals.createApproval({
      kind: 'improve',
      github_run_id: 'auto/improve-2026-05-23T12-00-00',
      summary: 'improve: test branch',
      files_changed: ['harness/identity/BEHAVIOR.md'],
      risk_tier: 'risky',
    })
    approvals.decide(id, 'denied', 'test')

    const result = await applyApprovedImprove(id)
    expect(result.ok).toBe(false)
    expect(result.diff).toMatch(/already decided/)
  })

  it('returns error when github_run_id is null (no branch reference)', async () => {
    const { applyApprovedImprove } = await import('./index')

    const id = approvals.createApproval({
      kind: 'improve',
      // no github_run_id
      summary: 'improve: no branch',
      files_changed: ['harness/config/staff.yaml'],
      risk_tier: 'risky',
    })

    const result = await applyApprovedImprove(id)
    expect(result.ok).toBe(false)
    expect(result.diff).toMatch(/no valid branch reference/)
  })

  it('returns error when github_run_id has invalid branch name pattern', async () => {
    const { applyApprovedImprove } = await import('./index')

    const id = approvals.createApproval({
      kind: 'improve',
      github_run_id: 'main',  // not auto/improve-* pattern
      summary: 'improve: bad branch',
      files_changed: ['harness/config/models.yaml'],
      risk_tier: 'risky',
    })

    const result = await applyApprovedImprove(id)
    expect(result.ok).toBe(false)
    expect(result.diff).toMatch(/no valid branch reference/)
  })

  it('returns ok and marks approval decided on successful merge', async () => {
    const { applyApprovedImprove } = await import('./index')

    const branch = 'auto/improve-2026-05-23T12-30-00'
    const id = approvals.createApproval({
      kind: 'improve',
      github_run_id: branch,
      summary: `improve: 2 change(s) on ${branch}`,
      files_changed: ['harness/identity/BEHAVIOR.md'],
      risk_tier: 'risky',
    })

    // Mock the git calls that mergeBranch makes.
    runCommandAsync.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'git') {
        // diff --stat
        if (args[0] === 'diff' && args.includes('--stat')) {
          return { stdout: 'harness/identity/BEHAVIOR.md | 2 +-\n 1 file changed', stderr: '', status: 0 }
        }
        // full diff
        if (args[0] === 'diff' && !args.includes('--stat') && !args.includes('--name-only')) {
          return { stdout: '- old line\n+ new line', stderr: '', status: 0 }
        }
        // checkout main
        if (args[0] === 'checkout') {
          return { stdout: '', stderr: '', status: 0 }
        }
        // merge
        if (args[0] === 'merge') {
          return { stdout: '', stderr: '', status: 0 }
        }
        // push origin main
        if (args[0] === 'push' && args[1] === 'origin' && args[2] === 'main') {
          return { stdout: '', stderr: '', status: 0 }
        }
        // push --delete (remote branch cleanup)
        if (args[0] === 'push' && args.includes('--delete')) {
          return { stdout: '', stderr: '', status: 0 }
        }
        // branch -D (local branch delete)
        if (args[0] === 'branch' && args[1] === '-D') {
          return { stdout: '', stderr: '', status: 0 }
        }
        // diff --name-only (for logEvent in mergeBranch)
        if (args[0] === 'diff' && args.includes('--name-only')) {
          return { stdout: 'harness/identity/BEHAVIOR.md', stderr: '', status: 0 }
        }
      }
      return { stdout: '', stderr: '', status: 0 }
    })

    const result = await applyApprovedImprove(id)
    expect(result.ok).toBe(true)

    // Approval row should now be decided=approved
    const row = approvals.getById(id)
    expect(row?.decision).toBe('approved')
    expect(row?.decided_by).toBe('discord')

    runCommandAsync.mockReset()
  })

  it('returns error when workspace is dirty before merge', async () => {
    const { applyApprovedImprove } = await import('./index')

    const branch = 'auto/improve-2026-05-23T14-00-00'
    const id = approvals.createApproval({
      kind: 'improve',
      github_run_id: branch,
      summary: `improve: 1 change(s) on ${branch}`,
      files_changed: ['harness/identity/BEHAVIOR.md'],
      risk_tier: 'risky',
    })

    runCommandAsync.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'git' && args[0] === 'status') {
        return { stdout: ' M harness/identity/BEHAVIOR.md\n', stderr: '', status: 0 }
      }
      return { stdout: '', stderr: '', status: 0 }
    })

    const result = await applyApprovedImprove(id)
    expect(result.ok).toBe(false)
    expect(result.diff).toMatch(/workspace is dirty/)

    // Approval should still be pending
    const row = approvals.getById(id)
    expect(row?.decided_at).toBeNull()

    runCommandAsync.mockReset()
  })

  it('returns error (not ok) and does not mark decided when merge fails', async () => {
    const { applyApprovedImprove } = await import('./index')

    const branch = 'auto/improve-2026-05-23T13-00-00'
    const id = approvals.createApproval({
      kind: 'improve',
      github_run_id: branch,
      summary: `improve: 1 change(s) on ${branch}`,
      files_changed: ['harness/config/staff.yaml'],
      risk_tier: 'risky',
    })

    runCommandAsync.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'git') {
        if (args[0] === 'diff') {
          return { stdout: '', stderr: '', status: 0 }
        }
        if (args[0] === 'checkout') {
          return { stdout: '', stderr: '', status: 0 }
        }
        // merge fails
        if (args[0] === 'merge') {
          return { stdout: '', stderr: 'CONFLICT (content)', status: 1 }
        }
      }
      return { stdout: '', stderr: '', status: 0 }
    })

    const result = await applyApprovedImprove(id)
    expect(result.ok).toBe(false)

    // Approval should still be pending (decided_at = null)
    const row = approvals.getById(id)
    expect(row?.decided_at).toBeNull()

    runCommandAsync.mockReset()
  })
})
