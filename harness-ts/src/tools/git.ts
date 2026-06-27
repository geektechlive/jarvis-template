// Git tools -- diff and patch apply.
// Ports harness/tools/__init__.py: git_diff, git_apply_patch.
// Patch application is gated by IMPROVABLE_PATHS allowlist imported from improve.

import { spawnSync } from 'node:child_process'
import { writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

import { HARNESS_DIR } from '../config'
import { IMPROVABLE_PATHS } from '../improve'

const DIFF_TRUNCATE = 8_000

export function gitDiff(staged = false): string {
  const args = staged ? ['diff', '--staged'] : ['diff']
  const r = spawnSync('git', args, {
    cwd: HARNESS_DIR,
    encoding: 'utf8',
    timeout: 15_000,
  })
  if (r.status !== 0) return `git diff failed: ${(r.stderr).slice(0, 200)}`
  const out = r.stdout
  if (!out.trim()) return '(no changes)'
  return out.length > DIFF_TRUNCATE ? out.slice(0, DIFF_TRUNCATE) + '...' : out
}

export function gitApplyPatch(patch: string): string {
  const paths = new Set<string>()
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++ b/')) paths.add(line.slice(6).trim())
    else if (line.startsWith('--- a/')) {
      const p = line.slice(6).trim()
      if (p !== '/dev/null') paths.add(p)
    }
  }

  const blocked = [...paths].filter((p) => !IMPROVABLE_PATHS.has(p))
  if (blocked.length) {
    return `Patch rejected: path(s) not in IMPROVABLE_PATHS allowlist: ${blocked.join(', ')}`
  }

  const tmpPath = join(tmpdir(), `git-patch-${randomBytes(6).toString('hex')}.patch`)
  try {
    writeFileSync(tmpPath, patch, 'utf8')

    const check = spawnSync('git', ['apply', '--check', tmpPath], {
      cwd: HARNESS_DIR,
      encoding: 'utf8',
      timeout: 15_000,
    })
    if (check.status !== 0) {
      return `Patch check failed: ${(check.stderr).trim()}`
    }

    const apply = spawnSync('git', ['apply', tmpPath], {
      cwd: HARNESS_DIR,
      encoding: 'utf8',
      timeout: 15_000,
    })
    if (apply.status !== 0) {
      return `Patch apply failed: ${(apply.stderr).trim()}`
    }

    return `Patch applied. Files changed: ${[...paths].join(', ')}`
  } finally {
    try { unlinkSync(tmpPath) } catch { /* best-effort cleanup */ }
  }
}
