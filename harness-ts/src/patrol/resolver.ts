import { log } from 'ion-sdk'
import { logEvent, recentEvents } from '../memory/episodic'
import { decide, getById, getPending } from '../approvals/index'
import {
  notifyResolverAgentFailed,
  notifyResolverAllPending,
  notifyResolverStarted,
  notifyResolverDailyCap,
  notifyResolverPostApprovalCheckFailed,
} from '../discord/notify'
import { postPendingDigest } from '../discord/digest'
import {
  RESOLVER_DAILY_CAP,
  RESOLVER_MAX_RUN_MS,
  REPO,
  runInHarness,
  closeIssueAndNotify,
  pushWorktreeToMain,
  cleanupResolverApprovalBranch,
  complexityGate,
  rankIssue,
  sortByPriority,
} from './resolver-shared'
import {
  fetchEligibleIssues,
  selectNextIssue,
  runResolverAgent,
  applyResolverResult,
} from './resolver-steps'
import {
  createResolverWorktree,
  removeResolverWorktree,
  deleteResolverBranch,
  sweepOrphanResolverWorktrees,
  createWorktreeOnBranch,
  runInWorktree,
  type ResolverWorktree,
} from './worktree'

export { RESOLVER_MAX_RUN_MS, complexityGate, rankIssue, sortByPriority }

let resolverRunning = false

/** True if a pending resolver approval is backed by the given branch. */
function pendingApprovalBranch(branch: string): boolean {
  try {
    return getPending().some(a => a.kind === 'resolver' && a.github_run_id === branch)
  } catch {
    // If we cannot read approvals, err on the side of keeping the branch.
    return true
  }
}

export async function resolveNextAutoIssue(signal?: AbortSignal): Promise<void> {
  if (resolverRunning) {
    log.warn('patrol/resolver: already running, skipping concurrent invocation')
    return
  }
  resolverRunning = true
  try {
    await _resolveNextAutoIssue(signal)
  } finally {
    resolverRunning = false
  }
}

// ---------------------------------------------------------------------------
// Thin orchestrator — sequences the four steps; owns inFlightIssue + checkAbort
// and the per-issue worktree lifecycle (create → run → cleanup matrix).
// ---------------------------------------------------------------------------

async function _resolveNextAutoIssue(signal?: AbortSignal): Promise<void> {
  // Tracks which issue is currently being resolved so timeout events are diagnosable (#612).
  let inFlightIssue: number | null = null

  const checkAbort = (phase: string): void => {
    if (signal?.aborted) {
      logEvent('issue_resolver', 'resolver_timeout', { phase, issue: inFlightIssue })
      throw new Error(`resolver aborted (timeout) at phase: ${phase}`)
    }
  }

  // Clean up any worktree/branch a prior crashed run left behind (keeps branches
  // tied to an open approval).
  await sweepOrphanResolverWorktrees()

  const resolvedToday = recentEvents('issue_resolver', 'resolver_delivered', 24)
  if (resolvedToday.length >= RESOLVER_DAILY_CAP) {
    log.info('patrol/resolver: daily cap reached, standing down', { cap: RESOLVER_DAILY_CAP, resolved: resolvedToday.length })
    try { await notifyResolverDailyCap({ resolved: resolvedToday.length, cap: RESOLVER_DAILY_CAP }) }
    catch (err) { log.warn('patrol/resolver: notifyResolverDailyCap threw', { err: String(err) }) }
    return
  }

  const slotsRemaining = RESOLVER_DAILY_CAP - resolvedToday.length
  const RUN_LIMIT = Math.min(slotsRemaining, 3)

  const ghBin = process.env['GH_BIN'] ?? 'gh'
  const claudeBin = process.env['CLAUDE_BIN'] ?? 'claude'

  // Step 1: fetch eligible issues (fires checkAbort('issue_fetch') inside)
  const fetched = await fetchEligibleIssues(ghBin, checkAbort)
  if (!fetched) return

  const { eligibleIssues } = fetched

  // Track which issues have already been processed this invocation to avoid re-selecting them.
  const processedThisRun = new Set<number>()

  for (let runCount = 0; runCount < RUN_LIMIT; runCount++) {
    // Step 2: select the next actionable issue for this iteration
    const { issue, pendingCount, gatedCount } = selectNextIssue(eligibleIssues, processedThisRun)

    if (!issue) {
      if (pendingCount > 0) {
        log.info('patrol/resolver: all remaining eligible issues have pending approvals, standing down', {
          eligible: eligibleIssues.length,
          pending: pendingCount,
          gated: gatedCount,
        })
        logEvent('issue_resolver', 'resolver_all_pending', { eligible: eligibleIssues.length, pending: pendingCount, gated: gatedCount })
        try { await notifyResolverAllPending({ eligible: eligibleIssues.length }) }
        catch (err) { log.warn('patrol/resolver: notifyResolverAllPending threw', { err: String(err) }) }
      } else if (gatedCount > 0) {
        log.info('patrol/resolver: all remaining eligible issues blocked by complexity gate, standing down', {
          eligible: eligibleIssues.length,
          gated: gatedCount,
        })
        logEvent('issue_resolver', 'resolver_all_gated', { eligible: eligibleIssues.length, gated: gatedCount })
      } else {
        log.info('patrol/resolver: no more eligible issues to process this run', {
          eligible: eligibleIssues.length,
          processedThisRun: processedThisRun.size,
        })
      }
      break
    }

    processedThisRun.add(issue.number)
    inFlightIssue = issue.number

    logEvent('issue_resolver', 'resolver_started', { issue: issue.number, title: issue.title })
    try { await notifyResolverStarted({ issueNumber: issue.number, issueUrl: issue.url, issueTitle: issue.title }) }
    catch (err) { log.warn('patrol/resolver: notifyResolverStarted threw', { err: String(err) }) }

    // Per-issue worktree lifecycle. The finally block is the cleanup matrix:
    // always remove the worktree; delete the branch UNLESS it backs a pending
    // approval (the 'break'/awaiting-approval outcome).
    let wt: ResolverWorktree | null = null
    let control: 'continue' | 'break' | 'return' = 'continue'
    let preserveBranch = false
    const titleTrunc = issue.title.slice(0, 60)

    try {
      wt = await createResolverWorktree(issue.number)

      // Step 3: dispatch the resolver agent inside the worktree
      const agentResult = await runResolverAgent(issue, ghBin, claudeBin, checkAbort, signal, wt.path)

      if (agentResult === 'stop') {
        control = 'return'
      } else if (agentResult.agentFailed) {
        try {
          await notifyResolverAgentFailed({
            issueNumber: issue.number,
            issueUrl: issue.url,
            errorSummary: agentResult.agentErrorSummary,
            usedSubprocess: agentResult.usedSubprocess,
          })
        } catch (notifyErr) {
          log.warn('patrol/resolver: notifyResolverAgentFailed threw', { err: String(notifyErr) })
        }
        control = 'return'
      } else {
        // Step 4: apply result — make check, risk-tier, commit/push or branch-for-approval
        const outcome = await applyResolverResult(issue, ghBin, titleTrunc, checkAbort, signal, wt.path, wt.branch, agentResult.agentSummary)
        if (outcome === 'break') {
          control = 'break'
          preserveBranch = true // branch backs a pending approval
        } else if (outcome === 'stop') {
          control = 'return'
        }
        // 'continue' → keep looping
      }
    } catch (err) {
      // createResolverWorktree / commitPushAndClose / checkAbort timeout all land here.
      log.warn('patrol/resolver: run iteration failed', { issue: issue.number, err: String(err) })
      control = 'return'
    } finally {
      if (wt) {
        await removeResolverWorktree(wt.path)
        // Authoritative keep-decision: preserve the branch if the risky path
        // recorded a pending approval against it — even when a post-createApproval
        // step (notify/logEvent) threw and skipped the 'break' outcome. This makes
        // cleanup robust to any throw after the approval row is committed.
        const branchBacksApproval = preserveBranch || pendingApprovalBranch(wt.branch)
        if (!branchBacksApproval) await deleteResolverBranch(wt.branch)
      }
    }

    if (control === 'return') return
    if (control === 'break') break
    // control === 'continue': loop to next eligible issue
  }
}

// ---------------------------------------------------------------------------
// denyResolverApproval: called when an approval is denied.
// Marks the approval decided and deletes the associated resolver branch.
// ---------------------------------------------------------------------------

export async function denyResolverApproval(approvalId: number, caller: string): Promise<void> {
  // Tolerate a concurrent apply having already decided this approval (the apply
  // path runs under the single-flight guard; deny does not). If it is already
  // decided, do not override or delete the branch — the apply owns it.
  try {
    decide(approvalId, 'denied', caller)
  } catch (err) {
    log.warn('patrol/resolver: denyResolverApproval skipped — already decided', { approvalId, err: String(err) })
    return
  }
  await cleanupResolverApprovalBranch(approvalId, 'deny')
}

// ---------------------------------------------------------------------------
// applyApprovedResolver: called by Discord bot when an approval is granted.
// Wired to the Discord 'approve' command in discord/bot.ts.
// ---------------------------------------------------------------------------

export async function applyApprovedResolver(approvalId: number): Promise<{ ok: boolean; message: string }> {
  // Honour the same single-flight guard as the main resolver.
  if (resolverRunning) {
    return { ok: false, message: 'Resolver is currently running; retry in a moment.' }
  }
  resolverRunning = true
  try {
    return await _applyApprovedResolver(approvalId)
  } finally {
    resolverRunning = false
  }
}

async function _applyApprovedResolver(approvalId: number): Promise<{ ok: boolean; message: string }> {
  const approval = getById(approvalId)
  if (!approval) {
    return { ok: false, message: `Approval ${approvalId} not found.` }
  }
  // The Discord bot marks the approval 'approved' in the DB *before* dispatching
  // here, so an 'approved' decision is the normal entry condition — proceed. Bail
  // only when it was denied or expired (no work should ship).
  if (approval.decided_at !== null && approval.decision !== 'approved') {
    return { ok: false, message: `Approval ${approvalId} already decided (${approval.decision ?? 'unknown'}).` }
  }

  const branch = approval.github_run_id
  if (!branch || !/^auto\/resolver-/.test(branch)) {
    return { ok: false, message: `Approval ${approvalId} has no valid resolver branch (github_run_id=${branch ?? 'null'}).` }
  }

  // The branch must still exist locally.
  const verifyR = await runInHarness('git', ['rev-parse', '--verify', `refs/heads/${branch}`])
  if (verifyR.status !== 0) {
    return { ok: false, message: `Branch ${branch} for approval ${approvalId} not found (deleted?).` }
  }

  const ghBin = process.env['GH_BIN'] ?? 'gh'
  const changedFiles = approval.files_changed ?? []
  const issueNumber = approval.github_issue_number
  const issueTitle = approval.summary

  // Fast path: try a direct fast-forward push of branch:main without a worktree
  // (no HARNESS_DIR working-tree mutation). If origin/main has not advanced past
  // the branch base, this succeeds and nothing new was merged in, so make check
  // already passed when the branch was created.
  let sha = 'unknown'
  let shortSha = 'unknown'
  const ffPush = await runInHarness('git', ['push', 'origin', `${branch}:main`])
  if (ffPush.status === 0) {
    const shaR = await runInHarness('git', ['rev-parse', branch])
    const shortR = await runInHarness('git', ['rev-parse', '--short', branch])
    sha = shaR.stdout.trim() || 'unknown'
    shortSha = shortR.stdout.trim() || 'unknown'
  } else {
    // Non-ff: origin/main advanced. Rebase the branch on origin/main inside a
    // throwaway worktree, re-run make check (main moved), then push HEAD:main.
    let path: string
    try {
      path = await createWorktreeOnBranch(branch)
    } catch (err) {
      return { ok: false, message: `Could not create rebase worktree for ${branch}: ${String(err).slice(0, 300)}` }
    }
    try {
      const fetchR = await runInWorktree(path, 'git', ['fetch', 'origin', 'main'], 60_000)
      if (fetchR.status !== 0) {
        return { ok: false, message: `git fetch failed during approval rebase: ${fetchR.stderr.slice(0, 400)}` }
      }
      const rebaseR = await runInWorktree(path, 'git', ['rebase', 'origin/main'], 60_000)
      if (rebaseR.status !== 0) {
        await runInWorktree(path, 'git', ['rebase', '--abort'], 15_000)
        return { ok: false, message: `Branch ${branch} conflicts with current main. Rebase manually.\n${rebaseR.stderr.slice(0, 400)}` }
      }

      const checkR = await runInWorktree(path, 'make', ['check'], 300_000).catch((err: unknown) => ({
        stdout: '', stderr: String(err), status: 1,
      }))
      if (checkR.status !== 0) {
        const checkOutput = [checkR.stdout, checkR.stderr].filter(Boolean).join('\n').slice(0, 1000)
        logEvent('issue_resolver', 'resolver_post_approval_check_failed', { approvalId, checkOutput })
        try {
          await notifyResolverPostApprovalCheckFailed({
            approvalId,
            issueNumber: issueNumber ?? null,
            issueUrl: issueNumber != null ? `https://github.com/${REPO}/issues/${issueNumber}` : null,
            checkOutput,
          })
        } catch (notifyErr) { log.warn('patrol/resolver: notifyResolverPostApprovalCheckFailed threw', { err: String(notifyErr) }) }
        try { await postPendingDigest() } catch { /* best effort */ }
        return { ok: false, message: `make check failed after rebasing ${branch} on current main. Nothing pushed.\ncheck output:\n${checkOutput}` }
      }

      const pushed = await pushWorktreeToMain(path)
      if (!pushed.ok) {
        return { ok: false, message: `Push failed after rebase: ${pushed.err}` }
      }
      sha = pushed.sha
      shortSha = pushed.shortSha
    } finally {
      await removeResolverWorktree(path)
    }
  }

  // Pushed to origin/main. Close + notify, delete the branch, record the decision.
  // markApprovedIdempotent tolerates the bot having already set decided_at='approved'.
  if (issueNumber == null) {
    markApprovedIdempotent(approvalId)
    await deleteResolverBranch(branch)
    return { ok: true, message: `Approval ${approvalId} applied (${shortSha}); no GitHub issue to close.` }
  }

  try {
    await closeIssueAndNotify(ghBin, issueNumber, issueTitle, changedFiles, sha, shortSha)
  } catch (err) {
    // The commit already landed on main; closing/notifying is best-effort.
    log.warn('patrol/resolver: closeIssueAndNotify failed after push', { approvalId, err: String(err) })
  }
  markApprovedIdempotent(approvalId)
  await deleteResolverBranch(branch)
  return { ok: true, message: `Approval ${approvalId} applied and pushed (${shortSha}).` }
}

/** Record 'approved' on an approval the bot may have already decided. Never throws. */
function markApprovedIdempotent(approvalId: number): void {
  try {
    if (getById(approvalId)?.decision !== 'approved') {
      decide(approvalId, 'approved', 'discord')
    }
  } catch (err) {
    log.warn('patrol/resolver: markApprovedIdempotent failed (non-fatal)', { approvalId, err: String(err) })
  }
}
