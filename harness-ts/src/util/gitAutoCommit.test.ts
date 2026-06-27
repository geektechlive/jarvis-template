import { describe, it, expect, vi, beforeEach } from 'vitest'

// Record every git invocation so we can assert on the push flags.
const calls: string[][] = []

vi.mock('ion-sdk', () => ({
  log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

vi.mock('node:fs', () => ({ existsSync: () => true }))

vi.mock('../memory/episodic', () => ({ logEvent: vi.fn() }))

vi.mock('node:child_process', () => ({
  execFile: (
    cmd: string,
    args: string[],
    _opts: unknown,
    cb: (err: Error | null, res?: { stdout: string; stderr: string }) => void,
  ) => {
    calls.push([cmd, ...args])
    // `git diff --cached --quiet` exits non-zero when something IS staged; throw so
    // autoCommitPush proceeds to commit + push instead of early-returning.
    if (args[0] === 'diff' && args.includes('--quiet')) {
      cb(new Error('staged changes present'))
      return
    }
    cb(null, { stdout: '', stderr: '' })
  },
}))

import { autoCommitPush } from './gitAutoCommit'

beforeEach(() => {
  calls.length = 0
})

describe('autoCommitPush', () => {
  it('pushes with --no-verify to bypass the daemon-incompatible pre-push make-check hook', async () => {
    await autoCommitPush('harness/identity/PROJECTS.md', 'chore: refresh')

    const push = calls.find((c) => c[0] === 'git' && c[1] === 'push')
    expect(push).toBeDefined()
    expect(push).toContain('--no-verify')
    expect(push).toContain('HEAD:main')
  })

  it('scopes add/commit/push to the single pathspec (never a bare commit -a)', async () => {
    await autoCommitPush('harness/identity/PROJECTS.md', 'chore: refresh')
    const add = calls.find((c) => c[0] === 'git' && c[1] === 'add')
    const commit = calls.find((c) => c[0] === 'git' && c[1] === 'commit')
    expect(add).toContain('harness/identity/PROJECTS.md')
    expect(commit).toContain('harness/identity/PROJECTS.md')
    expect(calls.every((c) => !c.includes('-a'))).toBe(true)
  })
})
