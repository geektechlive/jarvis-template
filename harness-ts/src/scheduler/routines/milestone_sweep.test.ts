import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { runMilestoneSweep } from './milestone_sweep'
import * as ionPrompt from '../../util/ionPrompt'
import * as helpers from '../helpers'
import * as episodic from '../../memory/episodic'

interface MockCommandResult {
  status: number
  stdout: string
  stderr: string
  error?: Error
}

const MOCK_UNMILESTONED_ISSUES = [
  {
    number: 320,
    title: 'fix: git clean -fd in rollback (harness-ts/src/patrol/resolver.ts)',
    body: 'The git clean -f command misses untracked directories.',
    milestone: null,
    labels: [],
  },
  {
    number: 352,
    title: 'Resolver leaves dirty tree on check-fail (harness-ts/src/patrol/resolver.ts)',
    body: 'After stash pop, dirty tree persists.',
    milestone: null,
    labels: [],
  },
  {
    number: 399,
    title: 'milestone_sweep routine (harness-ts/src/scheduler)',
    body: 'New routine to auto-assign milestones.',
    milestone: null,
    labels: [],
  },
  {
    number: 400,
    title: 'Memory consolidation issue (harness-ts/src/learning)',
    body: 'Fact extraction gaps.',
    milestone: null,
    labels: [],
  },
  {
    number: 401,
    title: 'Staff agent missing (harness/agents)',
    body: 'Need a new staff spec.',
    milestone: null,
    labels: [],
  },
  {
    number: 402,
    title: 'Calendar tool timeout (harness-ts/src/tools)',
    body: 'Need better retry logic.',
    milestone: null,
    labels: [],
  },
  {
    number: 403,
    title: 'Random unrelated issue',
    body: 'No file hints here.',
    milestone: null,
    labels: [],
  },
]

beforeEach(() => {
  vi.spyOn(helpers, 'isEnabled').mockReturnValue(true)
  vi.spyOn(episodic, 'logEvent').mockImplementation(() => 1)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('milestone_sweep', () => {
  it('skips when disabled', async () => {
    vi.spyOn(helpers, 'isEnabled').mockReturnValue(false)
    const runCommandSpy = vi.spyOn(ionPrompt, 'runCommandAsync')

    await runMilestoneSweep()

    expect(runCommandSpy).not.toHaveBeenCalled()
  })

  it('assigns M1 to issues mentioning harness-ts/src/scheduler or patrol', async () => {
    let editCount = 0
    vi.spyOn(ionPrompt, 'runCommandAsync').mockImplementation(async (cmd, args): Promise<MockCommandResult> => {
      if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'list') {
        return {
          status: 0,
          stdout: JSON.stringify([MOCK_UNMILESTONED_ISSUES[0], MOCK_UNMILESTONED_ISSUES[1]]),
          stderr: '',
        }
      }
      if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'edit') {
        editCount++
        // Verify that edit is called with M1
        const index = args.findIndex((a) => a === '--milestone')
        if (index !== -1) {
          const milestone = args[index + 1]
          expect(milestone).toBe('M1 — Reliability & Safety')
        }
        return { status: 0, stdout: '', stderr: '' }
      }
      return { status: 0, stdout: '', stderr: '' }
    })

    await runMilestoneSweep()

    expect(editCount).toBe(2)
  })

  it('assigns M2 to issues mentioning memory/learning paths', async () => {
    let editCount = 0
    vi.spyOn(ionPrompt, 'runCommandAsync').mockImplementation(async (cmd, args): Promise<MockCommandResult> => {
      if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'list') {
        return {
          status: 0,
          stdout: JSON.stringify([MOCK_UNMILESTONED_ISSUES[3]]),
          stderr: '',
        }
      }
      if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'edit') {
        editCount++
        const index = args.findIndex((a) => a === '--milestone')
        if (index !== -1) {
          const milestone = args[index + 1]
          expect(milestone).toBe('M2 — Memory & Learning')
        }
        return { status: 0, stdout: '', stderr: '' }
      }
      return { status: 0, stdout: '', stderr: '' }
    })

    await runMilestoneSweep()

    expect(editCount).toBe(1)
  })

  it('assigns M3 to issues mentioning staff/agents/identity paths', async () => {
    let editCount = 0
    vi.spyOn(ionPrompt, 'runCommandAsync').mockImplementation(async (cmd, args): Promise<MockCommandResult> => {
      if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'list') {
        return {
          status: 0,
          stdout: JSON.stringify([MOCK_UNMILESTONED_ISSUES[4]]),
          stderr: '',
        }
      }
      if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'edit') {
        editCount++
        const index = args.findIndex((a) => a === '--milestone')
        if (index !== -1) {
          const milestone = args[index + 1]
          expect(milestone).toBe('M3 — Staff & Identity')
        }
        return { status: 0, stdout: '', stderr: '' }
      }
      return { status: 0, stdout: '', stderr: '' }
    })

    await runMilestoneSweep()

    expect(editCount).toBe(1)
  })

  it('assigns M4 to issues mentioning tools/integrations paths', async () => {
    let editCount = 0
    vi.spyOn(ionPrompt, 'runCommandAsync').mockImplementation(async (cmd, args): Promise<MockCommandResult> => {
      if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'list') {
        return {
          status: 0,
          stdout: JSON.stringify([MOCK_UNMILESTONED_ISSUES[5]]),
          stderr: '',
        }
      }
      if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'edit') {
        editCount++
        const index = args.findIndex((a) => a === '--milestone')
        if (index !== -1) {
          const milestone = args[index + 1]
          expect(milestone).toBe('M4 — Tools & Integrations')
        }
        return { status: 0, stdout: '', stderr: '' }
      }
      return { status: 0, stdout: '', stderr: '' }
    })

    await runMilestoneSweep()

    expect(editCount).toBe(1)
  })

  it('assigns M1 fallback to issues with no file-path hints', async () => {
    let editCount = 0
    vi.spyOn(ionPrompt, 'runCommandAsync').mockImplementation(async (cmd, args): Promise<MockCommandResult> => {
      if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'list') {
        return {
          status: 0,
          stdout: JSON.stringify([MOCK_UNMILESTONED_ISSUES[6]]),
          stderr: '',
        }
      }
      if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'edit') {
        editCount++
        const index = args.findIndex((a) => a === '--milestone')
        if (index !== -1) {
          const milestone = args[index + 1]
          expect(milestone).toBe('M1 — Reliability & Safety')
        }
        return { status: 0, stdout: '', stderr: '' }
      }
      return { status: 0, stdout: '', stderr: '' }
    })

    await runMilestoneSweep()

    expect(editCount).toBe(1)
  })

  it('does not touch issues that already have a milestone', async () => {
    const withMilestone = [
      {
        number: 200,
        title: 'Some issue',
        body: 'Already has milestone.',
        milestone: { title: 'M1 — Reliability & Safety' },
        labels: [],
      },
    ]

    let editCount = 0
    vi.spyOn(ionPrompt, 'runCommandAsync').mockImplementation(async (cmd, args): Promise<MockCommandResult> => {
      if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'list') {
        return {
          status: 0,
          stdout: JSON.stringify(withMilestone),
          stderr: '',
        }
      }
      if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'edit') {
        editCount++
        return { status: 0, stdout: '', stderr: '' }
      }
      return { status: 0, stdout: '', stderr: '' }
    })

    await runMilestoneSweep()

    expect(editCount).toBe(0)
  })

  it('continues sweep on individual edit failure', async () => {
    let editCount = 0
    let successCount = 0

    vi.spyOn(ionPrompt, 'runCommandAsync').mockImplementation(async (cmd, args): Promise<MockCommandResult> => {
      if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'list') {
        // Return 3 unmilestoned issues
        return {
          status: 0,
          stdout: JSON.stringify([
            MOCK_UNMILESTONED_ISSUES[0],
            MOCK_UNMILESTONED_ISSUES[1],
            MOCK_UNMILESTONED_ISSUES[3],
          ]),
          stderr: '',
        }
      }
      if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'edit') {
        editCount++
        // Fail the second edit, succeed others
        if (editCount === 2) {
          return { status: 1, stdout: '', stderr: 'Edit failed' }
        }
        successCount++
        return { status: 0, stdout: '', stderr: '' }
      }
      return { status: 0, stdout: '', stderr: '' }
    })

    await runMilestoneSweep()

    // Should have attempted all 3 edits
    expect(editCount).toBe(3)
    // Should have succeeded on 2
    expect(successCount).toBe(2)
  })
})
