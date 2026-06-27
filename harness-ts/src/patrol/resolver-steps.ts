import { log } from 'ion-sdk'
import { logEvent } from '../memory/episodic'
import { runCommandAsync } from '../util/ionPrompt'
import { createApproval, getPendingByIssueNumber } from '../approvals/index'
import { classifyRiskTier } from '../approvals/riskTier'
import { postPendingDigest } from '../discord/digest'
import {
  notifyResolverAwaiting,
  notifyResolverCheckFailed,
  notifyResolverNoChanges,
  notifyResolverAllCapped,
} from '../discord/notify'
import {
  type GithubIssue,
  REPO,
  BODY_LIMIT,
  complexityGate,
  sortByPriority,
  getRecentResolverFailures,
  removeAutoLabel,
  addLabel,
  commitPushAndClose,
} from './resolver-shared'
import { runInWorktree, SCAFFOLD_PATHS } from './worktree'

// ---------------------------------------------------------------------------
// Step 1: fetch issues from GitHub, sort by priority, filter by failure cap.
// Returns the eligible list, or null if the run should abort (all capped /
// no issues / fetch error). Fires checkAbort('issue_fetch') before the gh call.
// ---------------------------------------------------------------------------

export interface FetchResult {
  eligibleIssues: GithubIssue[]
}

export async function fetchEligibleIssues(
  ghBin: string,
  checkAbort: (phase: string) => void,
): Promise<FetchResult | null> {
  checkAbort('issue_fetch')

  let issues: GithubIssue[] = []
  try {
    const r = await runCommandAsync(ghBin, [
      'issue', 'list',
      '--repo', REPO,
      '--state', 'open',
      '--label', 'jarvis-auto',
      '--json', 'number,title,body,labels,url,milestone,updatedAt',
      '--limit', '100',
    ], { timeoutMs: 30_000 })
    if (r.error) {
      log.warn('patrol/resolver: gh issue list error', { err: String(r.error) })
      return null
    }
    issues = JSON.parse(r.stdout.trim()) as GithubIssue[]
  } catch (err) {
    log.warn('patrol/resolver: failed to fetch issues', { err: String(err) })
    return null
  }

  if (issues.length === 0) {
    log.info('patrol/resolver: no jarvis-auto issues, standing down')
    return null
  }

  issues = sortByPriority(issues)

  // Filter out issues with >= 3 recent failures
  const recentFailures = getRecentResolverFailures()
  const skippedIssues: Array<{ number: number; failures: number }> = []
  const eligibleIssues = issues.filter((i) => {
    const failureCount = recentFailures.failureMap.get(i.number) ?? 0
    if (failureCount >= 3) {
      // Check if the issue was updated after its last failure (human re-labeled it — reset)
      const lastTs = recentFailures.lastFailureTs.get(i.number)
      if (lastTs && i.updatedAt > lastTs) {
        logEvent('issue_resolver', 'resolver_failure_reset', { issue: i.number })
        log.info('patrol/resolver: failure count reset for issue (updated after last failure)', { issue: i.number })
        recentFailures.failureMap.set(i.number, 0)
        return true
      }
      skippedIssues.push({ number: i.number, failures: failureCount })
      return false
    }
    return true
  })

  if (eligibleIssues.length === 0) {
    log.info('patrol/resolver: all open auto issues are at failure cap, skipping run', {
      totalIssues: issues.length,
      skippedByFailure: skippedIssues,
    })
    logEvent('issue_resolver', 'resolver_all_capped', { totalIssues: issues.length, skippedByFailure: skippedIssues })
    try { await notifyResolverAllCapped({ totalIssues: issues.length, skippedByFailure: skippedIssues }) }
    catch (err) { log.warn('patrol/resolver: notifyResolverAllCapped threw', { err: String(err) }) }
    return null
  }

  return { eligibleIssues }
}

// ---------------------------------------------------------------------------
// Step 2: per-iteration inner loop — pick the next actionable issue.
// Returns the selected issue plus per-iteration counters for stand-down
// diagnostics (#656). The orchestrator calls this once per runCount iteration.
// Mutates processedThisRun indirectly: orchestrator marks the chosen issue
// after selection (not here) so the Set stays owned by the orchestrator.
// ---------------------------------------------------------------------------

export interface SelectResult {
  issue: GithubIssue | undefined
  pendingCount: number
  gatedCount: number
}

export function selectNextIssue(
  eligibleIssues: GithubIssue[],
  processedThisRun: Set<number>,
): SelectResult {
  let issue: GithubIssue | undefined
  let pendingCount = 0
  let gatedCount = 0

  for (const candidate of eligibleIssues) {
    if (processedThisRun.has(candidate.number)) continue

    const pending = getPendingByIssueNumber(candidate.number)
    if (pending) {
      log.info('patrol/resolver: issue has pending approval, trying next', {
        issue: candidate.number,
        approvalId: pending.id,
      })
      logEvent('issue_resolver', 'resolver_skipped_pending_approval', {
        issue: candidate.number,
        approvalId: pending.id,
      })
      pendingCount++
      continue
    }

    // Complexity gate: skip issues the resolver should not attempt autonomously.
    const gateResult = complexityGate(candidate)
    if (gateResult !== null) {
      log.info('patrol/resolver: skipped — complexity gate', { number: candidate.number, title: candidate.title, reason: gateResult })
      gatedCount++
      continue
    }

    issue = candidate
    break
  }

  return { issue, pendingCount, gatedCount }
}

// ---------------------------------------------------------------------------
// Step 3: dispatch the resolver agent for a chosen issue.
// Returns { agentFailed, agentErrorSummary, usedSubprocess }.
// Does NOT return on the 'stop' path — returns agentFailed=true so the
// orchestrator can issue the notify + return. Fires checkAbort before agent run.
// Precondition: dirty-workspace check, prompt build, and checkAbort('before_agent_run')
// all happen inside here so they stay co-located with the agent dispatch.
// ---------------------------------------------------------------------------

export interface AgentRunResult {
  agentFailed: boolean
  agentErrorSummary: string
  usedSubprocess: boolean
  /** The agent's final summary (subprocess stdout). Carries the escalation
   * diagnosis on a deliberate no-change run so it is not silently dropped. */
  agentSummary: string
}

/**
 * Parse a resolver agent summary for the escalation marker. The agent ends its
 * summary with a line beginning `ESCALATE:` when it judges the issue structural
 * and deliberately makes no changes. Returns the reason text, or null when the
 * summary is a normal (non-escalation) run.
 */
export function parseEscalation(summary: string): string | null {
  const m = summary.match(/^ESCALATE:\s*(.+)$/im)
  return m && m[1] ? m[1].trim() : null
}

export async function runResolverAgent(
  issue: GithubIssue,
  ghBin: string,
  claudeBin: string,
  checkAbort: (phase: string) => void,
  signal: AbortSignal | undefined,
  worktreePath: string,
): Promise<AgentRunResult | 'stop'> {
  const wasTruncated = !!issue.body && issue.body.length > BODY_LIMIT
  const bodySnippet = issue.body ? issue.body.slice(0, BODY_LIMIT) : '(no description)'
  const truncationNote = wasTruncated
    ? `\n\n[Issue body was truncated. Read the full issue via: gh issue view ${issue.number} --repo <your-org>/jarvis]`
    : ''

  const prompt =
    `You are the Engineering Lead for Jarvis.\n` +
    `IMPORTANT: an isolated git worktree for this task is checked out at ${worktreePath}, which is your current working directory. Make ALL file edits there using relative paths. Do NOT edit files under ~/Jarvis directly -- that is a separate working copy.\n\n` +
    `Implement a fix for GitHub issue #${issue.number}: ${issue.title}\n\n` +
    `Issue description:\n${bodySnippet}${truncationNote}\n\n` +
    `Instructions:\n` +
    `1. DIAGNOSE the root cause first. Read the relevant code until you understand WHY this happens, not just where the symptom appears. State the root cause explicitly in your summary.\n` +
    `2. Fix the root cause, not the symptom. If the same class of bug can recur elsewhere because of a shared gap (a missing guard, an inconsistent helper, a copy-pasted block, an unchecked boundary), fix it at the source so it cannot recur -- do not patch only the single line the issue points at. A correct fix that touches a few more files is better than a narrow one that leaves the underlying defect in place.\n` +
    `3. Make the edits with the file tools. Do NOT commit -- the resolver handles git after validation. Do NOT run make check yourself -- the resolver validates after you finish.\n` +
    `4. In your summary, name the root cause and briefly defend your fix against the obvious minimal/band-aid alternative: say why yours is correct, not merely expedient.\n` +
    `5. ESCALATE instead of guessing. If the correct fix is structural -- it spans multiple modules, needs a schema/interface/state-machine change, or is one symptom of a deeper design problem -- or the issue is too vague or risky to fix safely, then STOP and make NO file changes. A clean escalation is a better outcome than a band-aid that hides the problem and lets it recur. When you escalate, end your summary with a single line beginning EXACTLY with \`ESCALATE:\` followed by a one-sentence statement of the root cause and what the correct fix requires -- the resolver detects that marker, labels the issue for human/plan review, and stops retrying it.\n\n` +
    `When done, output a summary: the root cause, the fix you made (or the escalation reason), and why it is the correct resolution rather than a symptomatic patch.`

  checkAbort('before_agent_run')

  // Always run via the Claude CLI subprocess with cwd set to the worktree.
  // dispatchAgent cannot be redirected to a non-HARNESS_DIR cwd (ion dispatches
  // in-process against the engine's working dir), and it is unavailable in the
  // async scheduler context the resolver runs in anyway, so it bought nothing.
  let agentFailed = false
  let agentErrorSummary = ''
  let agentSummary = ''

  try {
    const r = await runCommandAsync(claudeBin, ['-p', prompt, '--model', 'claude-sonnet-4-6'], {
      cwd: worktreePath,
      timeoutMs: 1_500_000,
      ...(signal !== undefined ? { signal } : {}),
    })
    // Keep the agent's final summary so a deliberate no-change escalation carries
    // its root-cause diagnosis downstream instead of being silently dropped.
    agentSummary = (r.stdout ?? '').trim()
    if (r.status !== 0 || r.error) {
      log.warn('patrol/resolver: claude subprocess failed', { issue: issue.number, status: r.status, err: String(r.error ?? '') })
      logEvent('issue_resolver', 'resolver_agent_failed', { issue: issue.number, status: r.status, err: String(r.error ?? ''), usedSubprocess: true })
      agentFailed = true
      agentErrorSummary = r.error ? String(r.error) : `exit status ${r.status}`
    }
  } catch (err) {
    log.warn('patrol/resolver: agent run failed', { err: String(err) })
    logEvent('issue_resolver', 'resolver_agent_failed', { issue: issue.number, status: null, err: String(err), usedSubprocess: true })
    agentFailed = true
    agentErrorSummary = String(err)
  }

  return { agentFailed, agentErrorSummary, usedSubprocess: true, agentSummary }
}

// ---------------------------------------------------------------------------
// Step 4: apply the agent's output — make check, risk-tier, commit/stash/notify.
// Returns:
//   'continue' — loop to the next eligible issue
//   'break'    — stop the run loop (risky path; awaiting approval)
//   'stop'     — abort the entire run (risky git failure; propagate up)
// commitPushAndClose THROWS on git failure — let it propagate (not caught here).
// Fires checkAbort at before_make_check, before_risk_tier_check, before_commit_push.
// ---------------------------------------------------------------------------

export type ApplyOutcome = 'continue' | 'break' | 'stop'

export async function applyResolverResult(
  issue: GithubIssue,
  ghBin: string,
  titleTrunc: string,
  checkAbort: (phase: string) => void,
  signal: AbortSignal | undefined,
  worktreePath: string,
  branch: string,
  agentSummary = '',
): Promise<ApplyOutcome> {
  let changedFiles: string[] = []
  try {
    const statusR = await runInWorktree(worktreePath, 'git', ['status', '--porcelain'])
    changedFiles = statusR.stdout
      .split('\n')
      .filter(l => l.trim().length > 0)
      .map(l => l.slice(3).trim())
      // Drop provisioned scaffolding (the node_modules symlink shows as untracked
      // because .gitignore's `node_modules/` matches dirs, not symlinks).
      .filter(f => !SCAFFOLD_PATHS.includes(f) && !SCAFFOLD_PATHS.some(s => f.startsWith(`${s}/`)))
  } catch (err) {
    log.warn('patrol/resolver: git status failed', { err: String(err) })
  }

  if (changedFiles.length === 0) {
    // Distinguish a deliberate ESCALATION (agent judged the issue structural and
    // chose not to band-aid it) from a plain no-op. On escalation, preserve the
    // agent's root-cause diagnosis in the issue, label it `needs-architecture` so
    // the complexity gate keeps it out of future autonomous runs, and remove
    // jarvis-auto so the resolver stops retrying it.
    const escalation = parseEscalation(agentSummary)
    if (escalation) {
      const msg =
        'Autonomous resolver ESCALATED: this needs human/plan review, not a minimal automated fix. ' +
        'Labeled `needs-architecture` and removed `jarvis-auto` so it will not be retried as a band-aid.\n\n' +
        `Root-cause diagnosis from the resolver:\n\n${agentSummary.slice(0, 2000)}`
      try {
        await runCommandAsync(ghBin, ['issue', 'comment', String(issue.number), '--repo', REPO, '--body', msg], { timeoutMs: 30_000 })
      } catch (err) {
        log.warn('patrol/resolver: gh comment failed (escalation)', { err: String(err) })
      }
      await addLabel(ghBin, issue.number, 'needs-architecture')
      await removeAutoLabel(ghBin, issue.number)
      logEvent('issue_resolver', 'resolver_escalated', { issue: issue.number, reason: escalation.slice(0, 300) })
      return 'continue'
    }
    const msg =
      'Autonomous resolver made no changes. Removing `jarvis-auto` label to prevent retry loop. ' +
      'Re-add the label once the issue description has enough context for an automated fix.'
    try {
      await runCommandAsync(ghBin, [
        'issue', 'comment', String(issue.number),
        '--repo', REPO,
        '--body', msg,
      ], { timeoutMs: 30_000 })
    } catch (err) {
      log.warn('patrol/resolver: gh comment failed', { err: String(err) })
    }
    await removeAutoLabel(ghBin, issue.number)
    logEvent('issue_resolver', 'resolver_no_changes', { issue: issue.number })
    try { await notifyResolverNoChanges({ issueNumber: issue.number, issueUrl: issue.url }) }
    catch (err) { log.warn('patrol/resolver: notifyResolverNoChanges threw', { err: String(err) }) }
    return 'continue'
  }

  checkAbort('before_make_check')

  const checkR = await runInWorktree(worktreePath, 'make', ['check'], 300_000).catch((err: unknown) => ({
    stdout: '',
    stderr: String(err),
    status: 1,
  }))

  if (checkR.status !== 0) {
    // No manual cleanup: the orchestrator discards the entire worktree + branch.
    const checkOutput = [checkR.stdout, checkR.stderr].filter(Boolean).join('\n').slice(0, 1500)
    const failMsg =
      `Autonomous resolver \`make check\` failed. Changes discarded. Removing \`jarvis-auto\` label to prevent retry loop.\n\n` +
      `Re-add the label once the underlying issue is understood.\n\ncheck output:\n${checkOutput}`
    try {
      await runCommandAsync(ghBin, [
        'issue', 'comment', String(issue.number),
        '--repo', REPO,
        '--body', failMsg,
      ], { timeoutMs: 30_000 })
    } catch (err) {
      log.warn('patrol/resolver: gh comment failed', { err: String(err) })
    }
    await removeAutoLabel(ghBin, issue.number)
    logEvent('issue_resolver', 'resolver_check_failed', { issue: issue.number, checkOutput })
    try {
      await notifyResolverCheckFailed({
        issueNumber: issue.number,
        issueUrl: issue.url,
        checkOutput,
      })
    } catch (notifyErr) {
      log.warn('patrol/resolver: notifyResolverCheckFailed threw', { err: String(notifyErr) })
    }
    return 'continue'
  }

  // ---------------------------------------------------------------------------
  // Risk-tier check: safe = commit+push directly; risky = commit to the worktree's
  // branch and await approval (the branch survives; the worktree is removed).
  // ---------------------------------------------------------------------------

  checkAbort('before_risk_tier_check')

  const tier = classifyRiskTier(changedFiles)
  const commitMsg = `fix: resolve #${issue.number} ${titleTrunc} [auto]`

  if (tier === 'safe') {
    checkAbort('before_commit_push')
    await commitPushAndClose(ghBin, issue.number, issue.title, changedFiles, commitMsg, worktreePath, signal)
    return 'continue'
  }

  // Risky path: commit to the worktree's branch and capture the diff, then create
  // an approval keyed to the branch name. The orchestrator removes the worktree
  // but keeps the branch; on approval the branch is pushed to origin/main.
  let diffExcerpt = ''
  try {
    await runInWorktree(worktreePath, 'git', ['add', '--', ...changedFiles])
    const diffR = await runInWorktree(worktreePath, 'git', ['diff', '--staged'])
    diffExcerpt = diffR.stdout.slice(0, 2000)
    const commitR = await runInWorktree(worktreePath, 'git', ['commit', '-m', commitMsg])
    if (commitR.status !== 0) {
      log.warn('patrol/resolver: git commit failed in risky path', { err: commitR.stderr })
      logEvent('issue_resolver', 'resolver_branch_commit_failed', { issue: issue.number, err: commitR.stderr.slice(0, 500) })
      return 'stop'
    }
  } catch (err) {
    log.warn('patrol/resolver: git add/commit failed in risky path', { err: String(err) })
    return 'stop'
  }

  const approvalId = createApproval({
    kind: 'resolver',
    github_run_id: branch,
    github_issue_number: issue.number,
    summary: commitMsg,
    files_changed: changedFiles,
    diff_excerpt: diffExcerpt,
    risk_tier: 'risky',
  })

  try {
    await postPendingDigest()
  } catch (err) {
    log.warn('patrol/resolver: postPendingDigest failed', { err: String(err) })
  }

  // Notify Discord of pending approval
  try {
    await notifyResolverAwaiting({
      approvalId,
      summary: commitMsg,
      filesChanged: changedFiles,
      issueNumber: issue.number,
      issueUrl: `https://github.com/${REPO}/issues/${issue.number}`,
    })
  } catch (err) {
    log.warn('patrol/resolver: notifyResolverAwaiting failed', { err: String(err) })
  }

  const awaitingMsg =
    `Resolver committed a fix to branch \`${branch}\` awaiting approval (approval #${approvalId}). ` +
    `Reply in Discord to approve or deny.`
  try {
    await runCommandAsync(ghBin, [
      'issue', 'comment', String(issue.number),
      '--repo', REPO,
      '--body', awaitingMsg,
    ], { timeoutMs: 30_000 })
  } catch (err) {
    log.warn('patrol/resolver: gh comment failed for awaiting approval', { err: String(err) })
  }

  logEvent('issue_resolver', 'resolver_awaiting_approval', {
    issue: issue.number,
    approvalId,
    files: changedFiles,
  })
  log.info('patrol/resolver: risky change committed to branch, awaiting approval', { approvalId, issue: issue.number, branch })
  // Don't pile up more work while approval is pending — exit the run loop.
  return 'break'
}
