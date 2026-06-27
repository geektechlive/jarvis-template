// Git plumbing, auto/improve-* branch management, the pytest gate, and
// agent-script creation. The shared low-level git() helper lives here and is
// used by run.ts and approval.ts.

import { writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { HARNESS_DIR } from '../config'
import { runCommandAsync } from '../util/ionPrompt'
import { registerAgentScript } from './curator'
import { isCreatable } from './paths'

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

export function git(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return runCommandAsync('git', args, { cwd: HARNESS_DIR, timeoutMs: 60_000 })
}

export async function branchesToday(): Promise<string[]> {
  const today = new Date().toISOString().slice(0, 10)
  const r = await git(['branch', '--list', `auto/improve-${today}-*`])
  return r.stdout
    .split('\n')
    .map((l) => l.trim().replace(/^\* /, ''))
    .filter(Boolean)
}

export async function getAllImproveBranches(): Promise<string[]> {
  const r = await git(['branch', '--list', 'auto/improve-*'])
  return r.stdout
    .split('\n')
    .map((l) => l.trim().replace(/^\* /, ''))
    .filter(Boolean)
}

export async function branchDiffVsMain(branch: string): Promise<string> {
  const r = await git(['diff', `main...${branch}`])
  return r.stdout.trim()
}

export function makeBranchTimestamp(): string {
  return new Date().toISOString().replace(/[T:.]/g, '-').slice(0, 19)
}

export async function createBranch(): Promise<string> {
  const branch = `auto/improve-${makeBranchTimestamp()}`
  await git(['checkout', '-b', branch])
  return branch
}

export async function checkoutMain(): Promise<void> {
  await git(['checkout', 'main'])
}

export async function deleteBranch(branch: string): Promise<void> {
  await git(['branch', '-D', branch])
}

export async function gitCommit(filepath: string, reason: string): Promise<void> {
  await git(['add', filepath])
  await git(['commit', '-m', `improve: ${reason.slice(0, 100)} [auto]`])
}

export async function gitRevert(filepath: string): Promise<void> {
  await git(['checkout', 'HEAD', '--', filepath])
}

export async function hasImproveBranchToday(): Promise<boolean> {
  const branches = await branchesToday()
  return branches.length > 0
}

export const MAX_RETRIES = 2

export async function runTestsWithOutput(): Promise<{ passed: boolean; output: string }> {
  const r = await runCommandAsync('uv', ['run', 'pytest', 'tests/', '-q', '--tb=short'], {
    cwd: HARNESS_DIR,
    timeoutMs: 120_000,
  })
  const raw = (r.stdout + r.stderr).trim()
  const output = raw.length > 600 ? raw.slice(0, 600) + '\n…(truncated)' : raw
  return { passed: r.status === 0, output }
}

// ---------------------------------------------------------------------------
// Script creation
// ---------------------------------------------------------------------------

export async function createScript(filepath: string, content: string): Promise<string> {
  if (!isCreatable(filepath)) {
    return `Error: ${filepath} is not in the CREATABLE_PATHS allowlist`
  }
  if (!content.includes('# created_by: agent')) {
    return 'Error: script content missing required "# created_by: agent" header'
  }
  const abs = join(HARNESS_DIR, filepath)
  if (existsSync(abs)) {
    return `Error: ${filepath} already exists -- use edit action to modify it`
  }
  try {
    writeFileSync(abs, content, 'utf8')
  } catch {
    return `Error: could not write ${filepath}`
  }

  // shellcheck gate for shell scripts
  if (filepath.endsWith('.sh')) {
    const checkResult = await runCommandAsync('shellcheck', [abs], { cwd: HARNESS_DIR, timeoutMs: 15_000 })
    if (checkResult.status !== 0 && checkResult.status !== null) {
      // shellcheck found errors -- revert and report
      try { unlinkSync(abs) } catch { /* best effort */ }
      return `Error: shellcheck failed:\n${checkResult.stdout}\n${checkResult.stderr}`.slice(0, 500)
    }
    // status null = shellcheck not installed; proceed without shellcheck
  }

  // Register in .usage.json with state: candidate
  const basename = filepath.split('/').at(-1) ?? filepath
  registerAgentScript(basename)

  return 'ok'
}
