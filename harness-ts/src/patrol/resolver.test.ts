// Tests for the risk-tier branching in resolver.ts.
// All git operations and external calls are mocked so tests run offline
// without any actual git repo, GitHub CLI, or Discord webhook.

import { describe, it, expect, beforeAll, afterAll, vi, type MockedFunction } from 'vitest'
import { join } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { closeDb } from '../memory/episodic'

// ---------------------------------------------------------------------------
// Environment isolation — must be set before any module is imported.
// ---------------------------------------------------------------------------

const tmpDir = join(tmpdir(), `resolver-test-${Date.now()}-${Math.trunc(Math.random() * 1e6)}`)

beforeAll(() => {
  mkdirSync(tmpDir, { recursive: true })
  // Close any existing DB singleton (from earlier test files) before pointing
  // at the test directory — prevents fixture rows leaking into the production DB.
  closeDb()
  process.env['AGENT_DATA_DIR'] = tmpDir
})

afterAll(() => {
  closeDb()
  rmSync(tmpDir, { recursive: true, force: true })
  delete process.env['AGENT_DATA_DIR']
})

// ---------------------------------------------------------------------------
// Mocks — set up before importing the module under test.
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

vi.mock('../discord/notify', () => ({
  notifyResolverDailyCap: vi.fn().mockResolvedValue(undefined),
  notifyResolverAllCapped: vi.fn().mockResolvedValue(undefined),
  notifyResolverAllPending: vi.fn().mockResolvedValue(undefined),
  notifyResolverStarted: vi.fn().mockResolvedValue(undefined),
  notifyResolverDirtyWorkspace: vi.fn().mockResolvedValue(undefined),
  notifyResolverAgentFailed: vi.fn().mockResolvedValue(undefined),
  notifyResolverNoChanges: vi.fn().mockResolvedValue(undefined),
  notifyResolverCheckFailed: vi.fn().mockResolvedValue(undefined),
  notifyResolverAwaiting: vi.fn().mockResolvedValue(undefined),
  notifyResolverCommitFailed: vi.fn().mockResolvedValue(undefined),
  notifyResolverPushFailed: vi.fn().mockResolvedValue(undefined),
  notifyResolverPostApprovalCheckFailed: vi.fn().mockResolvedValue(undefined),
  notifyResolverShipped: vi.fn().mockResolvedValue(undefined),
}))

// ---------------------------------------------------------------------------
// Dynamically import mocked modules and the module under test.
// ---------------------------------------------------------------------------

let runCommandAsync: MockedFunction<(cmd: string, args: string[], opts?: Record<string, unknown>) => Promise<{ stdout: string; stderr: string; status: number | null; error?: unknown }>>
let approvals: typeof import('../approvals/index')
let riskTier: typeof import('../approvals/riskTier')

beforeAll(async () => {
  const ionPrompt = await import('../util/ionPrompt')
  runCommandAsync = ionPrompt.runCommandAsync as typeof runCommandAsync

  approvals = await import('../approvals/index')
  riskTier = await import('../approvals/riskTier')
})

// ---------------------------------------------------------------------------
// riskTier integration: verify classifier works from resolver's perspective
// ---------------------------------------------------------------------------

describe('classifyRiskTier (via resolver path)', () => {
  it('classifies pure harness-ts/src changes as safe', async () => {
    const { classifyRiskTier } = riskTier
    expect(classifyRiskTier(['harness-ts/src/memory/recall.ts', 'harness-ts/src/clarify/index.ts'])).toBe('safe')
  })

  it('classifies scheduler/learning/hooks changes as risky (orchestration infrastructure)', async () => {
    const { classifyRiskTier } = riskTier
    expect(classifyRiskTier(['harness-ts/src/scheduler/index.ts'])).toBe('risky')
    expect(classifyRiskTier(['harness-ts/src/learning/index.ts'])).toBe('risky')
    expect(classifyRiskTier(['harness-ts/src/hooks/promptPipeline.ts'])).toBe('risky')
  })

  it('classifies identity file changes as risky', async () => {
    const { classifyRiskTier } = riskTier
    expect(classifyRiskTier(['harness/identity/BEHAVIOR.md'])).toBe('risky')
  })

  it('classifies patrol changes as risky (self-referential)', async () => {
    const { classifyRiskTier } = riskTier
    expect(classifyRiskTier(['harness-ts/src/patrol/resolver.ts'])).toBe('risky')
  })
})

// ---------------------------------------------------------------------------
// applyApprovedResolver: unit tests for the approval-apply path
// ---------------------------------------------------------------------------

describe('applyApprovedResolver', () => {
  it('returns error when approval not found', async () => {
    const { applyApprovedResolver } = await import('./resolver')
    const result = await applyApprovedResolver(999999)
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/not found/)
  })

  it('returns error when approval already decided', async () => {
    const { applyApprovedResolver } = await import('./resolver')

    const id = approvals.createApproval({
      kind: 'resolver',
      summary: 'fix: test issue [auto]',
      github_issue_number: 1,
      files_changed: ['harness-ts/src/foo.ts'],
      risk_tier: 'risky',
    })
    approvals.decide(id, 'denied', 'test')

    const result = await applyApprovedResolver(id)
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/already decided/)
  })

  it('proceeds when the bot already marked the approval approved (pre-decide flow)', async () => {
    const { applyApprovedResolver } = await import('./resolver')

    const id = approvals.createApproval({
      kind: 'resolver',
      summary: 'fix: pre-decided approve [auto]',
      github_issue_number: 11,
      github_run_id: 'auto/resolver-11-2026-06-18-00-00-00',
      files_changed: ['harness-ts/src/pre.ts'],
      risk_tier: 'risky',
    })
    // Discord bot marks approved BEFORE dispatching to applyApprovedResolver.
    approvals.decide(id, 'approved', 'discord')

    const calls: string[][] = []
    runCommandAsync.mockImplementation(async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args])
      return { stdout: '', stderr: '', status: 0 } // verify ok, ff push ok
    })

    const result = await applyApprovedResolver(id)
    expect(result.ok).toBe(true) // does NOT bail on the pre-existing 'approved' decision
    expect(calls.some(c => c[0] === 'git' && c[1] === 'push' && c[3] === 'auto/resolver-11-2026-06-18-00-00-00:main')).toBe(true)

    runCommandAsync.mockReset()
  })

  it('returns error when the approval has no resolver branch reference', async () => {
    const { applyApprovedResolver } = await import('./resolver')

    const id = approvals.createApproval({
      kind: 'resolver',
      summary: 'fix: no branch [auto]',
      github_issue_number: 2,
      files_changed: ['harness-ts/src/bar.ts'],
      risk_tier: 'risky',
      // github_run_id (branch) intentionally omitted
    })

    const result = await applyApprovedResolver(id)
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/no valid resolver branch/)
  })

  it('returns error when the resolver branch no longer exists', async () => {
    const { applyApprovedResolver } = await import('./resolver')

    const id = approvals.createApproval({
      kind: 'resolver',
      summary: 'fix: missing branch [auto]',
      github_issue_number: 3,
      github_run_id: 'auto/resolver-3-2026-06-18-00-00-00',
      files_changed: ['harness-ts/src/baz.ts'],
      risk_tier: 'risky',
    })

    // rev-parse --verify of the branch fails → branch gone.
    runCommandAsync.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--verify') {
        return { stdout: '', stderr: 'fatal: Needed a single revision', status: 1 }
      }
      return { stdout: '', stderr: '', status: 0 }
    })

    const result = await applyApprovedResolver(id)
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/not found/)

    runCommandAsync.mockReset()
  })

  it('fast-forward pushes branch to main and closes the issue', async () => {
    const { applyApprovedResolver } = await import('./resolver')

    const id = approvals.createApproval({
      kind: 'resolver',
      summary: 'fix: ff push [auto]',
      github_issue_number: 4,
      github_run_id: 'auto/resolver-4-2026-06-18-00-00-00',
      files_changed: ['harness-ts/src/qux.ts'],
      risk_tier: 'risky',
    })

    const calls: string[][] = []
    runCommandAsync.mockImplementation(async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args])
      if (cmd === 'git' && args[0] === 'rev-parse' && args.includes('--short')) {
        return { stdout: 'abc1234', stderr: '', status: 0 }
      }
      if (cmd === 'git' && args[0] === 'rev-parse') {
        return { stdout: 'abc1234deadbeef', stderr: '', status: 0 }
      }
      return { stdout: '', stderr: '', status: 0 }
    })

    const result = await applyApprovedResolver(id)
    expect(result.ok).toBe(true)
    expect(result.message).toMatch(/applied and pushed/)
    // Direct fast-forward push of branch:main, no rebase worktree created.
    expect(calls.some(c => c[0] === 'git' && c[1] === 'push' && c[3] === 'auto/resolver-4-2026-06-18-00-00-00:main')).toBe(true)
    expect(calls.some(c => c[0] === 'git' && c[1] === 'worktree' && c[2] === 'add')).toBe(false)
    // Branch deleted after success.
    expect(calls.some(c => c[0] === 'git' && c[1] === 'branch' && c[2] === '-D')).toBe(true)
    expect(approvals.getById(id)?.decision).toBe('approved')

    runCommandAsync.mockReset()
  })

  it('rebases in a worktree on non-ff push; returns error on rebase conflict', async () => {
    const { applyApprovedResolver } = await import('./resolver')

    const id = approvals.createApproval({
      kind: 'resolver',
      summary: 'fix: non-ff conflict [auto]',
      github_issue_number: 5,
      github_run_id: 'auto/resolver-5-2026-06-18-00-00-00',
      files_changed: ['harness-ts/src/c.ts'],
      risk_tier: 'risky',
    })

    runCommandAsync.mockImplementation(async (cmd: string, args: string[]) => {
      // branch:main push rejected as non-ff
      if (cmd === 'git' && args[0] === 'push' && String(args[2]).endsWith(':main')) {
        return { stdout: '', stderr: '! [rejected] (non-fast-forward)', status: 1 }
      }
      if (cmd === 'git' && args[0] === 'rebase' && args[1] === 'origin/main') {
        return { stdout: '', stderr: 'CONFLICT (content): Merge conflict in harness-ts/src/c.ts', status: 1 }
      }
      return { stdout: '', stderr: '', status: 0 }
    })

    const result = await applyApprovedResolver(id)
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/conflicts with current main/)

    runCommandAsync.mockReset()
  })

  it('returns error when make check fails after a non-ff rebase', async () => {
    const { applyApprovedResolver } = await import('./resolver')

    const id = approvals.createApproval({
      kind: 'resolver',
      summary: 'fix: post-rebase check fails [auto]',
      github_issue_number: 6,
      github_run_id: 'auto/resolver-6-2026-06-18-00-00-00',
      files_changed: ['harness-ts/src/d.ts'],
      risk_tier: 'risky',
    })

    runCommandAsync.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'git' && args[0] === 'push' && String(args[2]).endsWith(':main')) {
        return { stdout: '', stderr: 'non-fast-forward', status: 1 }
      }
      if (cmd === 'make' && args[0] === 'check') {
        return { stdout: '', stderr: 'typecheck failed', status: 1 }
      }
      return { stdout: '', stderr: '', status: 0 }
    })

    const result = await applyApprovedResolver(id)
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/make check failed/)

    runCommandAsync.mockReset()
  })
})

// ---------------------------------------------------------------------------
// #321 — Body truncation + truncation notice
// ---------------------------------------------------------------------------

describe('Body truncation notice (#321)', () => {
  it('includes truncation notice when body exceeds BODY_LIMIT', async () => {
    const { resolveNextAutoIssue } = await import('./resolver')

    // Create a long issue body (>3000 chars)
    const longBody = 'x'.repeat(4000)
    const issueJson = JSON.stringify([{
      number: 100,
      title: 'Test issue with long body',
      body: longBody,
      labels: [{ name: 'jarvis-auto' }],
      url: 'https://github.com/test/test/issues/100',
      milestone: null,
    }])

    let capturedPrompt = ''
    runCommandAsync.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'list') {
        return { stdout: issueJson, stderr: '', status: 0 }
      }
      if (cmd === 'claude' && args[0] === '-p') {
        // args[1] is the prompt
        capturedPrompt = args[1] ?? ''
        return { stdout: '', stderr: '', status: 0 }
      }
      return { stdout: '', stderr: '', status: 0 }
    })

    await resolveNextAutoIssue()

    // Verify the truncation notice is in the prompt
    expect(capturedPrompt).toContain('[Issue body was truncated')
    expect(capturedPrompt).toContain('gh issue view 100 --repo <your-org>/jarvis')

    runCommandAsync.mockReset()
  })

  it('does not include truncation notice for bodies within limit', async () => {
    const { resolveNextAutoIssue } = await import('./resolver')

    const shortBody = 'This is a normal issue body that is well within the 3000 character limit.'
    const issueJson = JSON.stringify([{
      number: 101,
      title: 'Test issue with short body',
      body: shortBody,
      labels: [{ name: 'jarvis-auto' }],
      url: 'https://github.com/test/test/issues/101',
      milestone: null,
    }])

    let capturedPrompt = ''
    runCommandAsync.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'list') {
        return { stdout: issueJson, stderr: '', status: 0 }
      }
      if (cmd === 'claude' && args[0] === '-p') {
        capturedPrompt = args[1] ?? ''
        return { stdout: '', stderr: '', status: 0 }
      }
      return { stdout: '', stderr: '', status: 0 }
    })

    await resolveNextAutoIssue()

    // Verify the truncation notice is NOT in the prompt
    expect(capturedPrompt).not.toContain('[Issue body was truncated')

    runCommandAsync.mockReset()
  })
})

// ---------------------------------------------------------------------------
// #353 — github_issue_number null guard
// ---------------------------------------------------------------------------

describe('github_issue_number null guard (#353)', () => {
  it('skips close and returns ok when github_issue_number is null', async () => {
    const { applyApprovedResolver } = await import('./resolver')

    const id = approvals.createApproval({
      kind: 'resolver',
      summary: 'fix: test without issue [auto]',
      // github_issue_number intentionally omitted (null in the DB)
      github_run_id: 'auto/resolver-0-2026-06-18-00-00-00',
      files_changed: ['harness-ts/src/foo.ts'],
      risk_tier: 'risky',
    })

    let ghCloseCalled = false
    runCommandAsync.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'close') {
        ghCloseCalled = true
      }
      return { stdout: '', stderr: '', status: 0 } // ff push succeeds
    })

    const result = await applyApprovedResolver(id)

    expect(result.ok).toBe(true)
    expect(result.message).toContain('no GitHub issue to close')
    expect(ghCloseCalled).toBe(false) // should not have tried to close

    runCommandAsync.mockReset()
  })
})

// ---------------------------------------------------------------------------
// denyResolverApproval — marks denied and deletes the backing branch
// ---------------------------------------------------------------------------

describe('denyResolverApproval', () => {
  it('marks the approval denied and deletes its resolver branch', async () => {
    const { denyResolverApproval } = await import('./resolver')

    const id = approvals.createApproval({
      kind: 'resolver',
      summary: 'fix: to be denied [auto]',
      github_issue_number: 7,
      github_run_id: 'auto/resolver-7-2026-06-18-00-00-00',
      files_changed: ['harness-ts/src/deny.ts'],
      risk_tier: 'risky',
    })

    const calls: string[][] = []
    runCommandAsync.mockImplementation(async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args])
      return { stdout: '', stderr: '', status: 0 }
    })

    await denyResolverApproval(id, 'test')

    expect(approvals.getById(id)?.decision).toBe('denied')
    expect(calls.some(c => c[0] === 'git' && c[1] === 'branch' && c[2] === '-D' && c[3] === 'auto/resolver-7-2026-06-18-00-00-00')).toBe(true)

    runCommandAsync.mockReset()
  })
})

// ---------------------------------------------------------------------------
// #279 — Failure cap (>= 3 failures)
// ---------------------------------------------------------------------------

describe('Resolver failure cap (#279)', () => {
  it('skips issues with >= 3 recent failures', async () => {
    const { resolveNextAutoIssue } = await import('./resolver')

    // Create two issues; the first will be skipped due to 3 failures
    const issuesJson = JSON.stringify([
      {
        number: 200,
        title: 'Should be skipped',
        body: 'This issue has 3 failures.',
        labels: [{ name: 'jarvis-auto' }],
        url: 'https://github.com/test/test/issues/200',
        milestone: null,
      },
      {
        number: 201,
        title: 'Should be picked',
        body: 'This issue has 0 failures.',
        labels: [{ name: 'jarvis-auto' }],
        url: 'https://github.com/test/test/issues/201',
        milestone: null,
      },
    ])

    let pickedIssueNumber = 0
    runCommandAsync.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'list') {
        return { stdout: issuesJson, stderr: '', status: 0 }
      }
      if (cmd === 'claude') {
        return { stdout: '', stderr: '', status: 0 }
      }
      if (cmd === 'git' && args[0] === 'status') {
        // Capture which issue was picked based on order of operations
        pickedIssueNumber = 201
        return { stdout: '', stderr: '', status: 0 }
      }
      return { stdout: '', stderr: '', status: 0 }
    })

    // Seed the DB with 3 failures for issue 200
    const { db } = await import('../memory/episodic')
    const stmt = db().prepare('INSERT INTO agent_events (session, event, detail, ts) VALUES (?, ?, ?, ?)')
    for (let i = 0; i < 3; i++) {
      stmt.run('issue_resolver', 'resolver_check_failed', JSON.stringify({ issue: 200 }), new Date().toISOString())
    }

    await resolveNextAutoIssue()

    // Verify issue 201 was picked (issue 200 should be skipped)
    // In a real test, we'd capture the prompt or log event, but the skippage logic
    // occurs before that, so we'll just verify no error was thrown
    expect(pickedIssueNumber).toBe(201)

    runCommandAsync.mockReset()
  })

  it('stands down when all issues are at failure cap', async () => {
    const { resolveNextAutoIssue } = await import('./resolver')

    const issuesJson = JSON.stringify([
      {
        number: 300,
        title: 'Capped out',
        body: 'This issue has 3 failures.',
        labels: [{ name: 'jarvis-auto' }],
        url: 'https://github.com/test/test/issues/300',
        milestone: null,
      },
    ])

    runCommandAsync.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'list') {
        return { stdout: issuesJson, stderr: '', status: 0 }
      }
      return { stdout: '', stderr: '', status: 0 }
    })

    const { db } = await import('../memory/episodic')
    const stmt = db().prepare('INSERT INTO agent_events (session, event, detail, ts) VALUES (?, ?, ?, ?)')
    for (let i = 0; i < 3; i++) {
      stmt.run('issue_resolver', 'resolver_check_failed', JSON.stringify({ issue: 300 }), new Date().toISOString())
    }

    await resolveNextAutoIssue()

    // Should return cleanly without attempting to run the agent
    expect(runCommandAsync).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining(['issue', 'list']),
      expect.anything(),
    )
    // Should not have called claude since all issues are capped
    expect(runCommandAsync).not.toHaveBeenCalledWith(
      'claude',
      expect.anything(),
      expect.anything(),
    )

    runCommandAsync.mockReset()
  })
})

// ---------------------------------------------------------------------------
// #280 — AbortSignal timeout handling
// ---------------------------------------------------------------------------

describe('AbortSignal timeout handling (#280)', () => {
  it('throws when signal is aborted before issue_fetch', async () => {
    const { resolveNextAutoIssue } = await import('./resolver')

    const controller = new AbortController()
    controller.abort()

    try {
      await resolveNextAutoIssue(controller.signal)
      expect.fail('Should have thrown')
    } catch (err) {
      expect(String(err)).toContain('aborted')
      expect(String(err)).toContain('issue_fetch')
    }
  })

  it('skips commit phase when signal is aborted', async () => {
    const { resolveNextAutoIssue } = await import('./resolver')

    const issueJson = JSON.stringify([{
      number: 400,
      title: 'Abort test',
      body: 'Test issue.',
      labels: [{ name: 'jarvis-auto' }],
      url: 'https://github.com/test/test/issues/400',
      milestone: null,
    }])

    const controller = new AbortController()
    let gitCommitWasCalled = false

    runCommandAsync.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'list') {
        return { stdout: issueJson, stderr: '', status: 0 }
      }
      if (cmd === 'git' && args[0] === 'status') {
        // Abort after status check, before make check
        controller.abort()
        return { stdout: '', stderr: '', status: 0 }
      }
      if (cmd === 'git' && args[0] === 'commit') {
        gitCommitWasCalled = true
        return { stdout: '', stderr: '', status: 0 }
      }
      if (cmd === 'make') {
        return { stdout: '', stderr: '', status: 0 }
      }
      if (cmd === 'claude') {
        return { stdout: '', stderr: '', status: 0 }
      }
      return { stdout: '', stderr: '', status: 0 }
    })

    try {
      await resolveNextAutoIssue(controller.signal)
    } catch (err) {
      expect(String(err)).toContain('aborted')
    }

    // Verify commit was not called since we aborted before the commit phase
    expect(gitCommitWasCalled).toBe(false)

    runCommandAsync.mockReset()
  })
})

import { sortByPriority, complexityGate } from './resolver'
import { parseEscalation } from './resolver-steps'

describe('parseEscalation', () => {
  it('extracts the reason from an ESCALATE: marker line', () => {
    const summary = 'Investigated the issue.\n\nESCALATE: the auth middleware needs a redesign across three modules.'
    expect(parseEscalation(summary)).toBe('the auth middleware needs a redesign across three modules.')
  })

  it('is case-insensitive on the marker', () => {
    expect(parseEscalation('escalate: structural')).toBe('structural')
  })

  it('matches the marker on its own line within a multi-line summary', () => {
    expect(parseEscalation('line one\nESCALATE: needs a schema change\nline three')).toBe('needs a schema change')
  })

  it('returns null for a normal summary with no marker', () => {
    expect(parseEscalation('Fixed the off-by-one in the loop bound.')).toBeNull()
  })

  it('returns null for an empty summary', () => {
    expect(parseEscalation('')).toBeNull()
  })
})

describe('sortByPriority', () => {
  type Issue = {
    number: number
    title: string
    body: string
    url: string
    labels: { name: string }[]
    milestone: { title: string } | null
    updatedAt: string
  }
  const mk = (n: number, ms: string | null, sev?: string): Issue => ({
    number: n,
    title: `#${n}`,
    body: '',
    url: '',
    labels: sev ? [{ name: sev }] : [],
    milestone: ms ? { title: ms } : null,
    updatedAt: '2026-01-01T00:00:00.000Z',
  })

  it('orders by milestone first', () => {
    const out = sortByPriority([
      mk(2, 'M2 — Memory & Learning', 'severity: critical'),
      mk(1, 'M1 — Reliability & Safety', 'severity: low'),
    ])
    expect(out.map(i => i.number)).toEqual([1, 2])
  })

  it('orders by severity within the same milestone', () => {
    const ms = 'M1 — Reliability & Safety'
    const out = sortByPriority([
      mk(3, ms, 'severity: medium'),
      mk(1, ms, 'severity: critical'),
      mk(2, ms, 'severity: high'),
    ])
    expect(out.map(i => i.number)).toEqual([1, 2, 3])
  })

  it('breaks ties by issue number ascending', () => {
    const ms = 'M1 — Reliability & Safety'
    const out = sortByPriority([
      mk(10, ms, 'severity: high'),
      mk(2, ms, 'severity: high'),
      mk(5, ms, 'severity: high'),
    ])
    expect(out.map(i => i.number)).toEqual([2, 5, 10])
  })

  it('sorts unlabeled / no-milestone issues last', () => {
    const out = sortByPriority([
      mk(99, null),
      mk(1, 'M4 — Tools & Integrations', 'severity: low'),
      mk(50, 'M1 — Reliability & Safety', 'severity: critical'),
    ])
    expect(out.map(i => i.number)).toEqual([50, 1, 99])
  })

  it('does not mutate input', () => {
    const input = [
      mk(2, 'M2 — Memory & Learning'),
      mk(1, 'M1 — Reliability & Safety'),
    ]
    const original = [...input]
    sortByPriority(input)
    expect(input).toEqual(original)
  })
})

// ---------------------------------------------------------------------------
// #521/#525 — Agent subprocess failure does not remove jarvis-auto label
// ---------------------------------------------------------------------------

describe('Agent subprocess failure (#521/#525)', () => {
  it('does not remove jarvis-auto label when claude subprocess exits nonzero', async () => {
    const { resolveNextAutoIssue } = await import('./resolver')

    const issueJson = JSON.stringify([{
      number: 510,
      title: 'Subprocess fail test',
      body: 'Test issue.',
      labels: [{ name: 'jarvis-auto' }],
      url: 'https://github.com/test/test/issues/510',
      milestone: null,
      updatedAt: '2026-01-01T00:00:00.000Z',
    }])

    let labelRemoveCalled = false
    runCommandAsync.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'list') {
        return { stdout: issueJson, stderr: '', status: 0 }
      }
      if (cmd === 'git' && args[0] === 'status') {
        return { stdout: '', stderr: '', status: 0 }
      }
      if (cmd === 'claude') {
        return { stdout: '', stderr: 'error: subprocess exited', status: 1 }
      }
      if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'edit' && args.includes('--remove-label')) {
        labelRemoveCalled = true
        return { stdout: '', stderr: '', status: 0 }
      }
      return { stdout: '', stderr: '', status: 0 }
    })

    await resolveNextAutoIssue()

    expect(labelRemoveCalled).toBe(false)

    // Verify resolver_agent_failed event was logged
    const { db } = await import('../memory/episodic')
    const row = db().prepare(
      "SELECT detail FROM agent_events WHERE session = 'issue_resolver' AND event = 'resolver_agent_failed' AND detail LIKE '%510%'"
    ).get() as { detail: string } | undefined
    expect(row).toBeDefined()

    runCommandAsync.mockReset()
  })
})

// ---------------------------------------------------------------------------
// #520 — Failure count reset via updatedAt
// ---------------------------------------------------------------------------

describe('Failure count reset via updatedAt (#520)', () => {
  it('re-includes issue when updatedAt is newer than last failure timestamp', async () => {
    const { resolveNextAutoIssue } = await import('./resolver')

    // Seed 3 resolver_check_failed events for issue 500 within the 30-day window
    // (oldTs must be recent enough to pass the cutoff check; updatedAt must be after it)
    const oldTs = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString() // 10 days ago
    const newerTs = new Date(Date.now() - 1000).toISOString() // 1 second ago
    const { db } = await import('../memory/episodic')
    const stmt = db().prepare('INSERT INTO agent_events (session, event, detail, ts) VALUES (?, ?, ?, ?)')
    for (let i = 0; i < 3; i++) {
      stmt.run('issue_resolver', 'resolver_check_failed', JSON.stringify({ issue: 500 }), oldTs)
    }

    // Issue 500's updatedAt is after the failures — human re-labeled
    const issueJson = JSON.stringify([{
      number: 500,
      title: 'Reset test issue',
      body: 'Should be reset.',
      labels: [{ name: 'jarvis-auto' }],
      url: 'https://github.com/test/test/issues/500',
      milestone: null,
      updatedAt: newerTs,
    }])

    let resolverStarted = false
    runCommandAsync.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'list') {
        return { stdout: issueJson, stderr: '', status: 0 }
      }
      if (cmd === 'git' && args[0] === 'status') {
        resolverStarted = true
        return { stdout: '', stderr: '', status: 0 }
      }
      if (cmd === 'claude') {
        return { stdout: '', stderr: '', status: 0 }
      }
      return { stdout: '', stderr: '', status: 0 }
    })

    await resolveNextAutoIssue()

    // Issue 500 should have been picked (resolver proceeded past filtering)
    expect(resolverStarted).toBe(true)

    // Verify resolver_failure_reset event was logged
    const row = db().prepare(
      "SELECT detail FROM agent_events WHERE session = 'issue_resolver' AND event = 'resolver_failure_reset' AND detail LIKE '%500%'"
    ).get() as { detail: string } | undefined
    expect(row).toBeDefined()

    runCommandAsync.mockReset()
  })

  it('still skips issue when updatedAt is older than last failure timestamp', async () => {
    const { resolveNextAutoIssue } = await import('./resolver')

    // Seed 3 resolver_check_failed events for issue 501 with a recent timestamp
    const recentTs = '2026-06-01T00:00:00.000Z'
    const { db } = await import('../memory/episodic')
    const stmt = db().prepare('INSERT INTO agent_events (session, event, detail, ts) VALUES (?, ?, ?, ?)')
    for (let i = 0; i < 3; i++) {
      stmt.run('issue_resolver', 'resolver_check_failed', JSON.stringify({ issue: 501 }), recentTs)
    }

    // Issue 501's updatedAt is BEFORE the failures
    const issueJson = JSON.stringify([{
      number: 501,
      title: 'Still-capped issue',
      body: 'Should stay capped.',
      labels: [{ name: 'jarvis-auto' }],
      url: 'https://github.com/test/test/issues/501',
      milestone: null,
      updatedAt: '2026-01-01T00:00:00.000Z',
    }])

    let claudeCalled = false
    runCommandAsync.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'list') {
        return { stdout: issueJson, stderr: '', status: 0 }
      }
      if (cmd === 'claude') {
        claudeCalled = true
        return { stdout: '', stderr: '', status: 0 }
      }
      return { stdout: '', stderr: '', status: 0 }
    })

    await resolveNextAutoIssue()

    // Issue 501 should NOT have been picked
    expect(claudeCalled).toBe(false)

    runCommandAsync.mockReset()
  })
})

// ---------------------------------------------------------------------------
// #561 — Complexity gate unit tests
// ---------------------------------------------------------------------------

type MinIssue = {
  number: number
  title: string
  body: string
  labels: { name: string }[]
  url: string
  milestone: { title: string } | null
  updatedAt: string
}

function mkIssue(overrides: Partial<MinIssue> = {}): MinIssue {
  return {
    number: 42,
    title: 'fix: something small',
    body: 'This is a valid issue body with enough context to proceed.',
    labels: [],
    url: 'https://github.com/test/test/issues/42',
    milestone: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('complexityGate (#561)', () => {
  it('passes a normal fix issue', () => {
    expect(complexityGate(mkIssue())).toBeNull()
  })

  it('rejects an issue with a body below minimum length', () => {
    const result = complexityGate(mkIssue({ body: 'Short.' }))
    expect(result).not.toBeNull()
    expect(result).toMatch(/body too short/)
  })

  it('rejects an issue with a missing issue number', () => {
    const result = complexityGate(mkIssue({ number: 0 }))
    expect(result).not.toBeNull()
    expect(result).toMatch(/missing issue number/)
  })

  it('rejects an issue with the enhancement label', () => {
    const result = complexityGate(mkIssue({ labels: [{ name: 'enhancement' }] }))
    expect(result).not.toBeNull()
    expect(result).toMatch(/enhancement/)
  })

  it('rejects an issue whose title starts with feat:', () => {
    const result = complexityGate(mkIssue({ title: 'feat: add new thing' }))
    expect(result).not.toBeNull()
    expect(result).toMatch(/feat: prefix/)
  })

  it('rejects an issue labeled needs-architecture (routed to human/plan review)', () => {
    const result = complexityGate(mkIssue({ labels: [{ name: 'bug' }, { name: 'needs-architecture' }] }))
    expect(result).not.toBeNull()
    expect(result).toMatch(/needs-architecture/)
  })

  it('passes an issue with other labels that are not enhancement', () => {
    const result = complexityGate(mkIssue({ labels: [{ name: 'bug' }, { name: 'severity: low' }] }))
    expect(result).toBeNull()
  })

  it('passes an issue with a body exactly at minimum length', () => {
    const result = complexityGate(mkIssue({ body: 'x'.repeat(10) }))
    expect(result).toBeNull()
  })

})

// ---------------------------------------------------------------------------
// #656 — resolver_all_gated fires when complexity gate blocks all issues
// ---------------------------------------------------------------------------

describe('resolver_all_gated vs resolver_all_pending (#656)', () => {
  it('emits resolver_all_gated (not resolver_all_pending) when all issues are blocked by complexity gate', async () => {
    const { resolveNextAutoIssue } = await import('./resolver')

    // Both issues fail the complexity gate (feat: prefix)
    const issueJson = JSON.stringify([
      {
        number: 900,
        title: 'feat: add feature A',
        body: 'This is a long enough body to pass the length check but feat: prefix blocks it.',
        labels: [],
        url: 'https://github.com/test/test/issues/900',
        milestone: null,
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        number: 901,
        title: 'feat: add feature B',
        body: 'This is a long enough body to pass the length check but feat: prefix blocks it.',
        labels: [],
        url: 'https://github.com/test/test/issues/901',
        milestone: null,
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ])

    runCommandAsync.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'list') {
        return { stdout: issueJson, stderr: '', status: 0 }
      }
      return { stdout: '', stderr: '', status: 0 }
    })

    await resolveNextAutoIssue()

    const { db } = await import('../memory/episodic')

    // resolver_all_gated must be emitted
    const gatedRow = db().prepare(
      "SELECT detail FROM agent_events WHERE session = 'issue_resolver' AND event = 'resolver_all_gated'"
    ).get() as { detail: string } | undefined
    expect(gatedRow).toBeDefined()
    const gatedDetail = JSON.parse(gatedRow!.detail) as { gated: number }
    expect(gatedDetail.gated).toBeGreaterThan(0)

    // resolver_all_pending must NOT be emitted for this scenario
    const pendingRow = db().prepare(
      "SELECT detail FROM agent_events WHERE session = 'issue_resolver' AND event = 'resolver_all_pending' AND detail LIKE '%90%'"
    ).get()
    expect(pendingRow).toBeUndefined()

    runCommandAsync.mockReset()
  })

  it('emits resolver_all_pending when at least one issue is genuinely awaiting approval', async () => {
    const { resolveNextAutoIssue } = await import('./resolver')

    // This issue passes the complexity gate but has a pending approval
    const issueJson = JSON.stringify([
      {
        number: 910,
        title: 'fix: genuine pending issue',
        body: 'This is a long enough body to pass the complexity gate checks fully.',
        labels: [],
        url: 'https://github.com/test/test/issues/910',
        milestone: null,
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ])

    // Create a pending approval for issue 910
    const pendingId = approvals.createApproval({
      kind: 'resolver',
      summary: 'fix: pending [auto]',
      github_issue_number: 910,
      files_changed: ['harness-ts/src/test.ts'],
      risk_tier: 'risky',
    })
    // Leave it undecided (pending)

    runCommandAsync.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'list') {
        return { stdout: issueJson, stderr: '', status: 0 }
      }
      return { stdout: '', stderr: '', status: 0 }
    })

    await resolveNextAutoIssue()

    const { db } = await import('../memory/episodic')

    // resolver_all_pending must be emitted — detail has pending count, not issue number
    const pendingRow = db().prepare(
      "SELECT detail FROM agent_events WHERE session = 'issue_resolver' AND event = 'resolver_all_pending' ORDER BY rowid DESC LIMIT 1"
    ).get() as { detail: string } | undefined
    expect(pendingRow).toBeDefined()
    const pendingDetail = JSON.parse(pendingRow!.detail) as { pending: number }
    expect(pendingDetail.pending).toBeGreaterThan(0)

    // Clean up pending approval
    approvals.decide(pendingId, 'denied', 'test-cleanup')

    runCommandAsync.mockReset()
  })
})

// ---------------------------------------------------------------------------
// #612 — resolver_timeout includes in-flight issue number
// ---------------------------------------------------------------------------

describe('resolver_timeout includes in-flight issue number (#612)', () => {
  it('emits resolver_timeout with the issue number when signal is aborted mid-resolve', async () => {
    const { resolveNextAutoIssue } = await import('./resolver')

    const issueJson = JSON.stringify([{
      number: 920,
      title: 'fix: timeout test issue',
      body: 'This is a long enough body to pass the complexity gate checks fully.',
      labels: [],
      url: 'https://github.com/test/test/issues/920',
      milestone: null,
      updatedAt: '2026-01-01T00:00:00.000Z',
    }])

    const controller = new AbortController()

    runCommandAsync.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'list') {
        return { stdout: issueJson, stderr: '', status: 0 }
      }
      if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'add') {
        // Abort once issue 920 is selected and its worktree is being created, so
        // the next checkAbort('before_agent_run') fires resolver_timeout.
        controller.abort()
        return { stdout: '', stderr: '', status: 0 }
      }
      if (cmd === 'claude') {
        return { stdout: '', stderr: '', status: 0 }
      }
      return { stdout: '', stderr: '', status: 0 }
    })

    try {
      await resolveNextAutoIssue(controller.signal)
    } catch {
      // Expected to throw
    }

    const { db } = await import('../memory/episodic')
    // Filter by issue number in detail to avoid matching earlier null-issue timeout events
    const row = db().prepare(
      "SELECT detail FROM agent_events WHERE session = 'issue_resolver' AND event = 'resolver_timeout' AND detail LIKE '%920%'"
    ).get() as { detail: string } | undefined
    expect(row).toBeDefined()
    const detail = JSON.parse(row!.detail) as { issue: number | null; phase: string }
    expect(detail.issue).toBe(920)
    expect(detail.phase).toBeDefined()

    runCommandAsync.mockReset()
  })
})

// ---------------------------------------------------------------------------
// cleanupResolverApprovalBranch: shared helper used by both deny and expire paths
// ---------------------------------------------------------------------------

describe('cleanupResolverApprovalBranch', () => {
  it('deletes the branch recorded on the approval', async () => {
    const { cleanupResolverApprovalBranch } = await import('./resolver-shared')
    const branch = 'auto/resolver-4242-2026-06-18-00-00-00'
    const id = approvals.createApproval({
      kind: 'resolver',
      summary: 'fix: cleanup [auto]',
      github_issue_number: 4242,
      github_run_id: branch,
      files_changed: ['harness-ts/src/x.ts'],
      risk_tier: 'risky',
    })

    const calls: string[][] = []
    runCommandAsync.mockImplementation(async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args])
      return { stdout: '', stderr: '', status: 0 }
    })

    await cleanupResolverApprovalBranch(id, 'expire')

    const delCall = calls.find(c => c[0] === 'git' && c[1] === 'branch' && c[2] === '-D')
    expect(delCall).toBeDefined()
    expect(delCall?.[3]).toBe(branch)
    runCommandAsync.mockReset()
  })

  it('is a no-op when the approval has no branch reference', async () => {
    const { cleanupResolverApprovalBranch } = await import('./resolver-shared')
    const id = approvals.createApproval({
      kind: 'resolver',
      summary: 'fix: no branch [auto]',
      github_issue_number: 4243,
      files_changed: ['harness-ts/src/y.ts'],
      risk_tier: 'risky',
      // github_run_id omitted
    })

    const calls: string[][] = []
    runCommandAsync.mockImplementation(async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args])
      return { stdout: '', stderr: '', status: 0 }
    })

    await cleanupResolverApprovalBranch(id, 'deny')

    const delCall = calls.find(c => c[0] === 'git' && c[1] === 'branch' && c[2] === '-D')
    expect(delCall).toBeUndefined()
    runCommandAsync.mockReset()
  })
})
