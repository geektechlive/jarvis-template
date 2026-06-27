// Git worktree isolation for the autonomous resolver.
//
// Each resolver run gets its own worktree (sibling to HARNESS_DIR) so the agent's
// file edits and `make check` never touch HARNESS_DIR's working tree or local
// `main` — eliminating the race with the deploy-watchdog's `git pull --autostash`
// and rollback `git checkout`. The validated commit is pushed straight to
// origin/main; the watchdog remains the sole deployer.
//
// Provisioning recipe (validated on the Mini 2026-06-18 — `make check` green):
//   git worktree add -b <branch> <path> main
//   git -C <path> submodule update --init --recursive ion   (ion-sdk types; ~2s, clean status)
//   ln -s $HARNESS_DIR/harness-ts/node_modules <path>/harness-ts/node_modules
//   run make/uv with UV_PROJECT_ENVIRONMENT=$HARNESS_DIR/.venv (PATH inherited)

import { join, dirname } from 'node:path'
import { log } from 'ion-sdk'
import { runCommandAsync } from '../util/ionPrompt'
import { HARNESS_DIR } from '../config'
import { getPending } from '../approvals/index'

// Worktrees live in a sibling dir so they never appear in HARNESS_DIR's git
// status or get swept up by `make check` file globs.
export const WORKTREE_ROOT = join(dirname(HARNESS_DIR), 'jarvis-worktrees')

// Paths we provision into every worktree that must never be treated as an agent
// change. The node_modules symlink shows up as `?? harness-ts/node_modules` in
// `git status --porcelain` because .gitignore's `node_modules/` (trailing slash)
// matches dirs, not symlinks — so change-detection must filter these out.
export const SCAFFOLD_PATHS = ['harness-ts/node_modules']

// Never sweep a resolver branch younger than this (matches the 7-day gated
// approval window, approval_expire_hours_gated). Protects branches whose approval
// is decided-but-not-yet-applied from being deleted out from under recovery.
const SWEEP_BRANCH_GRACE_MS = 7 * 24 * 3_600_000

export function makeBranchTimestamp(): string {
  return new Date().toISOString().replace(/[T:.]/g, '-').slice(0, 19)
}

/** Run a git command against the main repo (HARNESS_DIR). */
function gitMain(args: string[], timeoutMs = 60_000): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return runCommandAsync('git', args, { cwd: HARNESS_DIR, timeoutMs })
}

export interface ResolverWorktree {
  path: string
  branch: string
}

/**
 * Provision shared deps into a freshly-added worktree so `make check` passes:
 * populate the ion submodule (ion-sdk types; offline — objects are local) and
 * symlink node_modules from the main repo. Throws on failure.
 */
async function provisionWorktreeDeps(path: string): Promise<void> {
  const subR = await runCommandAsync('git', ['submodule', 'update', '--init', '--recursive', 'ion'], { cwd: path, timeoutMs: 120_000 })
  if (subR.status !== 0) {
    throw new Error(`git submodule update --init ion failed in worktree: ${subR.stderr.slice(0, 500)}`)
  }
  const linkR = await runCommandAsync('ln', ['-s', join(HARNESS_DIR, 'harness-ts/node_modules'), join(path, 'harness-ts/node_modules')], { cwd: path, timeoutMs: 15_000 })
  if (linkR.status !== 0) {
    throw new Error(`node_modules symlink failed in worktree: ${linkR.stderr.slice(0, 500)}`)
  }
}

/**
 * Create an isolated worktree on a fresh `auto/resolver-<issue>-<ts>` branch off
 * main, then provision shared deps. Throws on failure (cleaning up first).
 */
export async function createResolverWorktree(issueNumber: number): Promise<ResolverWorktree> {
  const ts = makeBranchTimestamp()
  const branch = `auto/resolver-${issueNumber}-${ts}`
  const path = join(WORKTREE_ROOT, `resolver-${issueNumber}-${ts}`)

  const addR = await gitMain(['worktree', 'add', '-b', branch, path, 'main'])
  if (addR.status !== 0) {
    throw new Error(`git worktree add failed: ${addR.stderr.slice(0, 500)}`)
  }
  try {
    await provisionWorktreeDeps(path)
  } catch (err) {
    await removeResolverWorktree(path)
    await deleteResolverBranch(branch)
    throw err
  }

  log.info('patrol/resolver: created worktree', { path, branch })
  return { path, branch }
}

/**
 * Add a throwaway worktree that checks out an EXISTING `auto/resolver-*` branch
 * (used by the approval-apply path to rebase on origin/main when a fast-forward
 * push is rejected). Provisions deps so `make check` can re-run. Throws on failure.
 */
export async function createWorktreeOnBranch(branch: string): Promise<string> {
  if (!/^auto\/resolver-/.test(branch)) {
    throw new Error(`refusing to create worktree on non-resolver branch: ${branch}`)
  }
  const path = join(WORKTREE_ROOT, `apply-${branch.replace(/[^a-zA-Z0-9]/g, '-')}`)
  await removeResolverWorktree(path) // clear any stale registration at this path
  const addR = await gitMain(['worktree', 'add', path, branch])
  if (addR.status !== 0) {
    throw new Error(`git worktree add on branch failed: ${addR.stderr.slice(0, 500)}`)
  }
  try {
    await provisionWorktreeDeps(path)
  } catch (err) {
    await removeResolverWorktree(path)
    throw err
  }
  return path
}

/**
 * Run a command inside a worktree with UV_PROJECT_ENVIRONMENT pointed at the
 * shared venv (so uv reuses it instead of re-syncing). PATH and the rest of the
 * environment are inherited from the ion daemon process.
 */
export async function runInWorktree(
  path: string,
  cmd: string,
  args: string[],
  timeoutMs = 30_000,
): Promise<{ stdout: string; stderr: string; status: number | null }> {
  const r = await runCommandAsync(cmd, args, {
    cwd: path,
    timeoutMs,
    env: { UV_PROJECT_ENVIRONMENT: join(HARNESS_DIR, '.venv') },
  })
  return { stdout: r.stdout, stderr: r.stderr, status: r.status }
}

/** Best-effort: remove a worktree and prune stale registrations. Never throws. */
export async function removeResolverWorktree(path: string): Promise<void> {
  try {
    await gitMain(['worktree', 'remove', '--force', path], 30_000)
  } catch (err) {
    log.warn('patrol/resolver: git worktree remove failed (non-fatal)', { path, err: String(err) })
  }
  try {
    await gitMain(['worktree', 'prune'], 15_000)
  } catch (err) {
    log.warn('patrol/resolver: git worktree prune failed (non-fatal)', { err: String(err) })
  }
}

/** Best-effort: delete a local resolver branch. Never throws. */
export async function deleteResolverBranch(branch: string): Promise<void> {
  if (!/^auto\/resolver-/.test(branch)) {
    log.warn('patrol/resolver: refusing to delete non-resolver branch', { branch })
    return
  }
  try {
    await gitMain(['branch', '-D', branch], 15_000)
  } catch (err) {
    log.warn('patrol/resolver: git branch -D failed (non-fatal)', { branch, err: String(err) })
  }
}

/**
 * On resolver entry: prune orphaned `resolver-*` worktrees (a crashed run leaves
 * one behind) and delete any `auto/resolver-*` branch with no matching open
 * approval. Held-approval branches are preserved (their name is on the approval's
 * github_run_id). Best-effort — never throws.
 */
export async function sweepOrphanResolverWorktrees(): Promise<void> {
  // Branches referenced by an open (pending) resolver approval must survive.
  let keepBranches = new Set<string>()
  try {
    keepBranches = new Set(
      getPending()
        .filter(a => a.kind === 'resolver' && typeof a.github_run_id === 'string')
        .map(a => a.github_run_id as string),
    )
  } catch (err) {
    log.warn('patrol/resolver: sweep could not read pending approvals, aborting sweep', { err: String(err) })
    return
  }

  // 1) Remove every registered worktree under WORKTREE_ROOT (resolver-* and
  //    apply-*) — at sweep time (single-flight guard held) none can be in active use.
  try {
    const listR = await gitMain(['worktree', 'list', '--porcelain'], 15_000)
    for (const line of listR.stdout.split('\n')) {
      if (!line.startsWith('worktree ')) continue
      const wtPath = line.slice('worktree '.length).trim()
      if (wtPath.startsWith(`${WORKTREE_ROOT}/`)) {
        log.info('patrol/resolver: sweeping orphan worktree', { wtPath })
        await removeResolverWorktree(wtPath)
      }
    }
  } catch (err) {
    log.warn('patrol/resolver: worktree sweep failed (non-fatal)', { err: String(err) })
  }

  // 2) Delete orphan auto/resolver-* branches not tied to an open approval.
  try {
    const brR = await gitMain(['branch', '--list', 'auto/resolver-*'], 15_000)
    for (const raw of brR.stdout.split('\n')) {
      const branch = raw.trim().replace(/^\* /, '')
      if (!branch) continue
      if (keepBranches.has(branch)) continue
      // Age grace: never delete a branch younger than the approval window. This
      // protects a risky branch whose approval was decided (no longer pending,
      // so not in keepBranches) but whose apply has not yet pushed it — and gives
      // a recovery window if an apply fails after the bot marked it approved.
      const ageMs = await branchAgeMs(branch)
      if (ageMs !== null && ageMs < SWEEP_BRANCH_GRACE_MS) {
        log.info('patrol/resolver: keeping recent orphan branch (within grace)', { branch, ageDays: Math.floor(ageMs / 86_400_000) })
        continue
      }
      log.info('patrol/resolver: sweeping orphan branch', { branch })
      await deleteResolverBranch(branch)
    }
  } catch (err) {
    log.warn('patrol/resolver: branch sweep failed (non-fatal)', { err: String(err) })
  }
}

/** Age of a branch tip in ms (from committer date), or null if it cannot be read. */
async function branchAgeMs(branch: string): Promise<number | null> {
  try {
    const r = await gitMain(['log', '-1', '--format=%ct', branch], 15_000)
    const epochSec = parseInt(r.stdout.trim(), 10)
    if (isNaN(epochSec)) return null
    return Date.now() - epochSec * 1000
  } catch {
    return null
  }
}
