import { log } from 'ion-sdk'
import { logEvent, db } from '../memory/episodic'
import { runCommandAsync } from '../util/ionPrompt'
import { HARNESS_DIR } from '../config'
import { getById } from '../approvals/index'
import { runInWorktree, deleteResolverBranch } from './worktree'
import {
  notifyResolverShipped,
  notifyResolverCommitFailed,
  notifyResolverPushFailed,
  type ResolverShippedOpts,
} from '../discord/notify'

export const RESOLVER_DAILY_CAP = 10
export const RESOLVER_MAX_RUN_MS = 2_000_000
export const BODY_LIMIT = 3000
export const BODY_MIN = 10

export interface GithubIssue {
  number: number
  title: string
  body: string
  labels: { name: string }[]
  url: string
  milestone: { title: string } | null
  updatedAt: string
}

export const REPO = '<your-org>/jarvis'

// Drain order: lower rank wins. Unknown milestone/severity sort last (rank 99)
// so untriaged issues fall behind triaged ones but still eventually get picked.
export const MILESTONE_RANK: Record<string, number> = {
  'M1 — Reliability & Safety': 1,
  'M2 — Memory & Learning': 2,
  'M3 — Staff & Identity': 3,
  'M4 — Tools & Integrations': 4,
}
export const SEVERITY_RANK: Record<string, number> = {
  'severity: critical': 1,
  'severity: high': 2,
  'severity: medium': 3,
  'severity: low': 4,
}

/**
 * Returns null if the issue passes the complexity gate (eligible for autonomous fix),
 * or a short reason string if it should be skipped.
 * Exported for unit testing.
 */
export function complexityGate(issue: GithubIssue): string | null {
  if (!issue.number) return 'missing issue number'
  const body = issue.body ?? ''
  if (body.length < BODY_MIN) return `body too short (${body.length} < ${BODY_MIN})`
  if (issue.labels.some(l => l.name === 'enhancement')) return 'enhancement label'
  if (issue.title.startsWith('feat:')) return 'feat: prefix'
  // Structural work is routed to human/plan review rather than a time-boxed
  // autonomous fix. The `needs-architecture` label is applied by a human or by a
  // prior resolver run that escalated mid-investigation (its agent recognized the
  // issue as a symptom of a deeper design problem). Keeping such issues out of the
  // resolver is the whole point of escalation -- it prevents a band-aid that hides
  // the structural problem and lets it recur.
  if (issue.labels.some(l => l.name === 'needs-architecture')) return 'needs-architecture label (human/plan review)'
  return null
}

/**
 * Delete the `auto/resolver-*` branch backing a resolver approval (if any).
 * Used by both the deny path and the expiry path so an undecided approval never
 * leaves an orphaned branch behind. Non-fatal: logs on failure and a
 * `resolver_branch_deleted_on_<reason>` event on success.
 */
export async function cleanupResolverApprovalBranch(approvalId: number, reason: 'deny' | 'expire'): Promise<void> {
  let branch: string | null = null
  try {
    branch = getById(approvalId)?.github_run_id ?? null
  } catch (err) {
    log.warn(`patrol/resolver: getById failed during ${reason} cleanup`, { approvalId, err: String(err) })
    return
  }
  if (!branch) return
  await deleteResolverBranch(branch)
  logEvent('issue_resolver', `resolver_branch_deleted_on_${reason}`, { approvalId, branch })
}

export function rankIssue(i: GithubIssue): [number, number, number] {
  const m = i.milestone?.title ? (MILESTONE_RANK[i.milestone.title] ?? 99) : 99
  const sev = i.labels
    .map(l => SEVERITY_RANK[l.name])
    .filter((n): n is number => typeof n === 'number')
    .sort((a, b) => a - b)[0] ?? 99
  return [m, sev, i.number]
}

export function sortByPriority(issues: GithubIssue[]): GithubIssue[] {
  return [...issues].sort((a, b) => {
    const ra = rankIssue(a), rb = rankIssue(b)
    return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2]
  })
}

export interface RecentResolverFailures {
  failureMap: Map<number, number>
  lastFailureTs: Map<number, string>
}

export function getRecentResolverFailures(): RecentResolverFailures {
  const failureMap = new Map<number, number>()
  const lastFailureTs = new Map<number, string>()
  const cutoffTime = new Date(Date.now() - 30 * 24 * 3_600_000).toISOString()

  // Query agent_events for resolver_check_failed and resolver_agent_failed events in the last 30 days
  const sql = `
    SELECT detail, ts FROM agent_events
    WHERE event IN ('resolver_check_failed', 'resolver_agent_failed')
      AND ts > ?
    ORDER BY ts ASC
  `
  try {
    const stmt = db().prepare(sql)
    const rows = stmt.all(cutoffTime) as Array<{ detail: string | null; ts: string }>
    for (const row of rows) {
      if (!row.detail) continue
      try {
        const detail = JSON.parse(row.detail) as { issue?: number }
        const issueNum = detail.issue
        if (typeof issueNum === 'number') {
          failureMap.set(issueNum, (failureMap.get(issueNum) ?? 0) + 1)
          // Track the latest failure timestamp per issue (rows are ASC, so last write wins)
          lastFailureTs.set(issueNum, row.ts)
        }
      } catch {
        // skip malformed JSON
      }
    }
  } catch (err) {
    log.warn('patrol/resolver: getRecentResolverFailures query failed', { err: String(err) })
  }
  return { failureMap, lastFailureTs }
}

export async function runInHarness(cmd: string, args: string[], timeoutMs = 30_000): Promise<{ stdout: string; stderr: string; status: number | null }> {
  const r = await runCommandAsync(cmd, args, { cwd: HARNESS_DIR, timeoutMs })
  return { stdout: r.stdout, stderr: r.stderr, status: r.status }
}

export async function removeAutoLabel(ghBin: string, issueNumber: number): Promise<void> {
  try {
    await runCommandAsync(ghBin, [
      'issue', 'edit', String(issueNumber),
      '--repo', REPO,
      '--remove-label', 'jarvis-auto',
    ], { timeoutMs: 30_000 })
  } catch (err) {
    log.warn('patrol/resolver: failed to remove jarvis-auto label', { issue: issueNumber, err: String(err) })
  }
}

export async function addLabel(ghBin: string, issueNumber: number, label: string): Promise<void> {
  try {
    await runCommandAsync(ghBin, [
      'issue', 'edit', String(issueNumber),
      '--repo', REPO,
      '--add-label', label,
    ], { timeoutMs: 30_000 })
  } catch (err) {
    log.warn('patrol/resolver: failed to add label', { issue: issueNumber, label, err: String(err) })
  }
}

// ---------------------------------------------------------------------------
// Push helpers — operate inside an isolated worktree, never touching
// HARNESS_DIR's working tree or local main.
// ---------------------------------------------------------------------------

export type PushResult = { ok: true; sha: string; shortSha: string } | { ok: false; err: string }

/**
 * Push the worktree's current HEAD straight to origin/main. If the push is
 * rejected as non-fast-forward (origin/main advanced since the worktree was
 * created), fetch + rebase on origin/main inside the worktree and retry once.
 * The rebase is safe because the worktree is fully isolated.
 */
export async function pushWorktreeToMain(worktreePath: string): Promise<PushResult> {
  let pushR = await runInWorktree(worktreePath, 'git', ['push', 'origin', 'HEAD:main'], 60_000)
  if (pushR.status !== 0) {
    const fetchR = await runInWorktree(worktreePath, 'git', ['fetch', 'origin', 'main'], 60_000)
    if (fetchR.status !== 0) {
      return { ok: false, err: `git fetch origin main failed: ${fetchR.stderr.slice(0, 400)}` }
    }
    const rebaseR = await runInWorktree(worktreePath, 'git', ['rebase', 'origin/main'], 60_000)
    if (rebaseR.status !== 0) {
      await runInWorktree(worktreePath, 'git', ['rebase', '--abort'], 15_000)
      return { ok: false, err: `rebase on origin/main conflicted: ${rebaseR.stderr.slice(0, 400)}` }
    }
    pushR = await runInWorktree(worktreePath, 'git', ['push', 'origin', 'HEAD:main'], 60_000)
    if (pushR.status !== 0) {
      return { ok: false, err: `git push after rebase failed: ${pushR.stderr.slice(0, 400)}` }
    }
  }
  const shaR = await runInWorktree(worktreePath, 'git', ['rev-parse', 'HEAD'])
  const shortR = await runInWorktree(worktreePath, 'git', ['rev-parse', '--short', 'HEAD'])
  return { ok: true, sha: shaR.stdout.trim() || 'unknown', shortSha: shortR.stdout.trim() || 'unknown' }
}

/**
 * Close the GitHub issue and fire the Discord "shipped" notification. The commit
 * is already on origin/main, so commit metadata is read from the shared object
 * store via HARNESS_DIR (no worktree required).
 */
export async function closeIssueAndNotify(
  ghBin: string,
  issueNumber: number,
  issueTitle: string,
  changedFiles: string[],
  sha: string,
  shortSha: string,
): Promise<void> {
  const closeMsg =
    `Resolved autonomously. Commit ${shortSha}. Watchdog will deploy.\n\nFiles changed:\n${changedFiles.map(f => `- ${f}`).join('\n')}`

  try {
    await runCommandAsync(ghBin, [
      'issue', 'close', String(issueNumber),
      '--repo', REPO,
      '--comment', closeMsg,
    ], { timeoutMs: 30_000 })
  } catch (err) {
    log.warn('patrol/resolver: gh issue close failed', { err: String(err) })
  }

  const notifyOpts: ResolverShippedOpts = {
    commitSha: sha,
    commitShort: shortSha,
    filesChanged: changedFiles,
    issueNumber,
    issueUrl: `https://github.com/${REPO}/issues/${issueNumber}`,
  }

  try {
    const logR = await runInHarness('git', ['log', '-1', '--format=%s%n%n%b', sha], 10_000)
    const logOutput = logR.stdout.trim()
    if (logOutput) {
      const lines = logOutput.split('\n')
      const subject = lines[0]?.trim()
      if (subject) notifyOpts.commitSubject = subject
      const blankIdx = lines.findIndex((l, i) => i > 0 && l.trim() === '')
      if (blankIdx >= 0) {
        const bodyText = lines.slice(blankIdx + 1).join('\n').trim()
        if (bodyText) notifyOpts.commitBody = bodyText
      }
    }
  } catch (err) {
    log.warn('patrol/resolver: git log failed, proceeding without commit details', { err: String(err) })
  }

  try {
    await notifyResolverShipped(notifyOpts)
  } catch (err) {
    log.warn('patrol/resolver: notifyResolverShipped failed', { err: String(err) })
  }

  logEvent('issue_resolver', 'resolver_delivered', { issue: issueNumber, sha, files: changedFiles })
  logEvent('issue_resolver', 'inbox_item', {
    routine: 'issue_resolver',
    text: `Autonomous resolver closed #${issueNumber}: ${issueTitle}. Commit ${sha}.`,
    priority: 0.5,
  })
}

// ---------------------------------------------------------------------------
// Safe inline path: commit the worktree changes to its branch, push HEAD:main,
// then close + notify. THROWS on git failure so the orchestrator's finally block
// runs the cleanup matrix (remove worktree + delete branch).
// ---------------------------------------------------------------------------

export async function commitPushAndClose(
  ghBin: string,
  issueNumber: number,
  issueTitle: string,
  changedFiles: string[],
  commitMsg: string,
  worktreePath: string,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    throw new Error('commitPushAndClose: aborted before start')
  }

  // Commit the agent's changes onto the worktree's auto/resolver-* branch.
  const addR = await runInWorktree(worktreePath, 'git', ['add', '--', ...changedFiles])
  const commitR = addR.status === 0
    ? await runInWorktree(worktreePath, 'git', ['commit', '-m', commitMsg])
    : addR
  if (addR.status !== 0 || commitR.status !== 0) {
    const errText = [addR.stderr, commitR.stderr].filter(Boolean).join('\n')
    log.warn('patrol/resolver: git commit failed in worktree', { err: errText })
    logEvent('issue_resolver', 'resolver_commit_failed', { issue: issueNumber, err: errText })
    try { await notifyResolverCommitFailed({ issueNumber, issueUrl: `https://github.com/${REPO}/issues/${issueNumber}`, errorSummary: errText }) }
    catch (notifyErr) { log.warn('patrol/resolver: notifyResolverCommitFailed threw', { err: String(notifyErr) }) }
    const commitFailMsg =
      `Autonomous resolver failed at commit stage. Worktree discarded.\n\n` +
      `Re-add \`jarvis-auto\` once the underlying issue is understood.\n\nerror:\n${errText.slice(0, 1000)}`
    try {
      await runCommandAsync(ghBin, ['issue', 'comment', String(issueNumber), '--repo', REPO, '--body', commitFailMsg], { timeoutMs: 30_000 })
    } catch (commentErr) {
      log.warn('patrol/resolver: gh comment failed after commit failure', { err: String(commentErr) })
    }
    await removeAutoLabel(ghBin, issueNumber)
    throw new Error(`commitPushAndClose: git commit failed: ${errText}`)
  }

  if (signal?.aborted) {
    throw new Error('commitPushAndClose: aborted before push')
  }

  const pushed = await pushWorktreeToMain(worktreePath)
  if (!pushed.ok) {
    log.warn('patrol/resolver: push to origin/main failed', { err: pushed.err })
    logEvent('issue_resolver', 'resolver_push_failed', { issue: issueNumber, err: pushed.err })
    try { await notifyResolverPushFailed({ issueNumber, issueUrl: `https://github.com/${REPO}/issues/${issueNumber}`, errorSummary: pushed.err }) }
    catch (notifyErr) { log.warn('patrol/resolver: notifyResolverPushFailed threw', { err: String(notifyErr) }) }
    const pushFailMsg =
      `Autonomous resolver failed at push stage. No commit landed on main.\n\n` +
      `Re-add \`jarvis-auto\` once the underlying issue is understood.\n\nerror:\n${pushed.err.slice(0, 1000)}`
    try {
      await runCommandAsync(ghBin, ['issue', 'comment', String(issueNumber), '--repo', REPO, '--body', pushFailMsg], { timeoutMs: 30_000 })
    } catch (commentErr) {
      log.warn('patrol/resolver: gh comment failed after push failure', { err: String(commentErr) })
    }
    await removeAutoLabel(ghBin, issueNumber)
    throw new Error(`commitPushAndClose: push failed: ${pushed.err}`)
  }

  await closeIssueAndNotify(ghBin, issueNumber, issueTitle, changedFiles, pushed.sha, pushed.shortSha)
}
