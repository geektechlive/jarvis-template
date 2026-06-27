import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('node:fs', () => ({
  mkdirSync: vi.fn(),
  copyFileSync: vi.fn(),
  rmSync: vi.fn(),
}))

import { runStaffToolsSync } from './staff_tools_sync'
import { rmSync } from 'node:fs'
import * as ionPrompt from '../../util/ionPrompt'
import * as helpers from '../helpers'
import * as episodic from '../../memory/episodic'

interface MockCommandResult {
  status: number
  stdout: string
  stderr: string
  error?: Error
}

const PR_URL = 'https://github.com/<your-org>/jarvis/pull/999'

// Dispatch a git/gh invocation to a canned result. Defaults to success.
function fakeRun(untracked: string): typeof ionPrompt.runCommandAsync {
  return async (cmd: string, args: string[]): Promise<MockCommandResult> => {
    if (cmd === 'git' && args[0] === 'status') {
      return { status: 0, stdout: untracked, stderr: '' }
    }
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'create') {
      return { status: 0, stdout: PR_URL, stderr: '' }
    }
    // git fetch / worktree add / add / commit / push / worktree remove
    return { status: 0, stdout: '', stderr: '' }
  }
}

beforeEach(() => {
  vi.spyOn(helpers, 'isEnabled').mockReturnValue(true)
  vi.spyOn(episodic, 'logEvent').mockImplementation(() => 1)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('staff_tools_sync', () => {
  it('skips when disabled', async () => {
    vi.spyOn(helpers, 'isEnabled').mockReturnValue(false)
    const spy = vi.spyOn(ionPrompt, 'runCommandAsync')

    await runStaffToolsSync()

    expect(spy).not.toHaveBeenCalled()
  })

  it('no-ops when no untracked staff-tools files', async () => {
    const spy = vi.spyOn(ionPrompt, 'runCommandAsync').mockImplementation(fakeRun(''))

    await runStaffToolsSync()

    // Only the status probe runs; no fetch/worktree/PR.
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0]?.[1]?.[0]).toBe('status')
    expect(rmSync).not.toHaveBeenCalled()
  })

  it('opens a PR and removes the local copy on the happy path', async () => {
    const spy = vi
      .spyOn(ionPrompt, 'runCommandAsync')
      .mockImplementation(fakeRun('?? staff-tools/hello.py\n'))

    await runStaffToolsSync()

    const calls = spy.mock.calls.map((c) => `${c[0]} ${(c[1]).slice(0, 2).join(' ')}`)
    // Worktree-based git ops (never a live-checkout checkout/branch switch).
    expect(calls).toContain('git worktree add')
    expect(calls).toContain('gh pr create')
    expect(calls).toContain('git worktree remove')
    // Never mutate the live checkout's HEAD.
    expect(calls.some((c) => c.startsWith('git checkout'))).toBe(false)
    // The local untracked copy is removed so the post-merge pull stays clean.
    expect(rmSync).toHaveBeenCalledTimes(1)
    const rmArg = (rmSync as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(String(rmArg)).toContain('staff-tools/hello.py')
  })

  it('does not remove local copies if push fails', async () => {
    vi.spyOn(ionPrompt, 'runCommandAsync').mockImplementation(
      async (cmd: string, args: string[]): Promise<MockCommandResult> => {
        if (cmd === 'git' && args[0] === 'status') {
          return { status: 0, stdout: '?? staff-tools/hello.py\n', stderr: '' }
        }
        if (cmd === 'git' && args[0] === 'push') {
          return { status: 1, stdout: '', stderr: 'push rejected' }
        }
        return { status: 0, stdout: '', stderr: '' }
      },
    )

    await runStaffToolsSync()

    // No gh pr create, no local rm -- but the worktree is still torn down.
    expect(rmSync).not.toHaveBeenCalled()
  })
})
