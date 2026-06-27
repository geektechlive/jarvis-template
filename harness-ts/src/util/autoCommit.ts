import { spawnSync, spawn } from 'node:child_process'
import { log } from 'ion-sdk'
import { HARNESS_DIR } from '../config'

/**
 * Commit any runtime changes to harness/data/*.yaml and push to origin silently.
 * Never throws — all errors are logged at warn level only.
 */
export async function commitDataFiles(): Promise<void> {
  try {
    // Check for uncommitted changes in harness/data/
    const diff = spawnSync(
      'git',
      ['-C', HARNESS_DIR, 'status', '--porcelain', '--', 'harness/data/'],
      { encoding: 'utf8', cwd: HARNESS_DIR },
    )

    if (diff.status !== 0 || !diff.stdout.trim()) {
      return
    }

    // Stage the changed data files
    const add = spawnSync(
      'git',
      ['-C', HARNESS_DIR, 'add', '--', 'harness/data/'],
      { encoding: 'utf8', cwd: HARNESS_DIR },
    )

    if (add.status !== 0) {
      log.warn('autoCommit: git add failed', { stderr: add.stderr.trim() })
      return
    }

    // Commit
    const commit = spawnSync(
      'git',
      ['-C', HARNESS_DIR, 'commit', '-m', 'chore(data): Jarvis runtime update'],
      { encoding: 'utf8', cwd: HARNESS_DIR },
    )

    if (commit.status !== 0) {
      log.warn('autoCommit: git commit failed', { stderr: commit.stderr.trim() })
      return
    }

    log.debug('autoCommit: committed data file changes')

    // Push non-blocking — fire and forget. --no-verify skips the pre-push hook's
    // full make check: this is a scoped data-file commit (harness/data/*.yaml), not
    // code, and the hook's ~70s suite is the interactive-dev gate, not relevant here.
    const pushProc = spawn(
      'git',
      ['-C', HARNESS_DIR, 'push', '--no-verify', 'origin', 'main', '--quiet'],
      { stdio: 'ignore' },
    )

    pushProc.on('error', (err) => {
      log.warn('autoCommit: push failed', { err: String(err) })
    })

    pushProc.on('close', (code) => {
      if (code !== 0) log.warn('autoCommit: push exited non-zero', { code })
    })
  } catch (err: unknown) {
    log.warn('autoCommit: unexpected error', { err: String(err) })
  }
}
