// staff_tools_sync (#849): auto-commit agent-created tools under staff-tools/ to
// origin via a PR, WITHOUT touching the live ~/Jarvis checkout's git HEAD/branch.
//
// Hard constraints (learned the hard way -- see #849):
//   1. Never `checkout`/`checkout -b` the live checkout: the watchdog git-pulls it
//      every 10 min and the improve loop also operates there. Use a /tmp worktree.
//   2. Never commit to main on the Mini (diverges from origin -> wedges pull).
//   3. After opening the PR, REMOVE the local untracked copies. Otherwise, once the
//      PR merges, the watchdog's `git pull` aborts with "untracked working tree
//      files would be overwritten by merge" -- the exact wedge this routine exists
//      to avoid. The tool returns tracked after the PR merges.
import { join, dirname } from 'node:path'
import { mkdirSync, copyFileSync, rmSync } from 'node:fs'
import { log } from 'ion-sdk'
import { runCommandAsync } from '../../util/ionPrompt'
import { HARNESS_DIR } from '../../config'
import { logEvent } from '../../memory/episodic'
import { isEnabled } from '../helpers'

const REPO = '<your-org>/jarvis'
const STAFF_TOOLS_DIR = 'staff-tools'

function git(args: string[], cwd: string) {
  return runCommandAsync('git', args, { cwd, timeoutMs: 60_000 })
}

function ok(r: { status: number | null; error?: Error }): boolean {
  return !r.error && r.status === 0
}

/** Untracked file paths under staff-tools/ (porcelain '?? ' lines). */
function parseUntracked(porcelain: string): string[] {
  return porcelain
    .split('\n')
    .filter((l) => l.startsWith('?? '))
    .map((l) => l.slice(3).trim())
    .filter((p) => p.startsWith(`${STAFF_TOOLS_DIR}/`))
}

export async function runStaffToolsSync(): Promise<void> {
  if (!isEnabled('staff_tools_sync')) return
  const live = HARNESS_DIR
  const ghBin = process.env['GH_BIN'] ?? 'gh'

  // 1. Detect untracked staff-tools files (read-only on the live checkout).
  const status = await git(['status', '--porcelain', '--', STAFF_TOOLS_DIR], live)
  if (!ok(status)) {
    log.warn('scheduler: staff_tools_sync: git status failed', { err: String(status.error ?? status.stderr) })
    return
  }
  const untracked = parseUntracked(status.stdout)
  if (untracked.length === 0) {
    log.info('scheduler: staff_tools_sync: nothing to sync')
    return
  }

  // 2. Fetch origin and create a /tmp worktree on a fresh branch off origin/main.
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const branch = `auto/staff-tools-${ts}`
  const wt = `/tmp/staff-tools-sync-${ts}`

  if (!ok(await git(['fetch', 'origin', 'main'], live))) {
    log.warn('scheduler: staff_tools_sync: git fetch failed')
    return
  }
  if (!ok(await git(['worktree', 'add', '-b', branch, wt, 'origin/main'], live))) {
    log.warn('scheduler: staff_tools_sync: worktree add failed')
    return
  }

  try {
    // 3. Copy untracked files into the worktree (preserve subpaths).
    for (const rel of untracked) {
      const dest = join(wt, rel)
      mkdirSync(dirname(dest), { recursive: true })
      copyFileSync(join(live, rel), dest)
    }

    // 4. Commit + push from the worktree (never the live checkout).
    const body = untracked.join('\n')
    await git(['add', '--', STAFF_TOOLS_DIR], wt)
    await git(['commit', '-m', `chore(staff-tools): sync ${untracked.length} agent-created tool(s)\n\n${body}`], wt)
    // --no-verify: skip the repo's pre-push hook. It runs the full ~70s make check
    // (a code gate for interactive dev pushes) which exceeds this push's timeout in
    // the daemon and would silently fail the push. The PR review is the gate here.
    if (!ok(await git(['push', '--no-verify', '-u', 'origin', branch], wt))) {
      log.warn('scheduler: staff_tools_sync: push failed')
      return
    }

    // 5. Open the PR.
    const pr = await runCommandAsync(ghBin, [
      'pr', 'create', '--repo', REPO, '--head', branch, '--base', 'main',
      '--title', `chore(staff-tools): sync ${untracked.length} agent-created tool(s)`,
      '--body', `Auto-synced agent-created tools from \`staff-tools/\` on the Mini:\n\n${untracked.map((f) => `- \`${f}\``).join('\n')}\n\nOpened by the staff_tools_sync routine (#849).`,
    ], { cwd: wt, timeoutMs: 30_000 })
    if (!ok(pr)) {
      log.warn('scheduler: staff_tools_sync: gh pr create failed', { err: String(pr.error ?? pr.stderr) })
      return
    }
    const prUrl = pr.stdout.trim()

    // 6. Remove the local untracked copies so the post-merge `git pull` is clean.
    for (const rel of untracked) {
      try {
        rmSync(join(live, rel))
      } catch (err) {
        log.warn('scheduler: staff_tools_sync: failed to remove local copy', { rel, err: String(err) })
      }
    }

    log.info('scheduler: staff_tools_sync: opened PR', { branch, count: untracked.length, pr: prUrl })
    logEvent('staff_tools_sync', 'routine_delivered', {
      routine: 'staff_tools_sync',
      synced: untracked.length,
      branch,
      pr: prUrl,
    })
  } finally {
    // 7. Always tear down the worktree (cleanup), success or not.
    await git(['worktree', 'remove', '--force', wt], live)
  }
}
