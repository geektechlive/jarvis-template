// Human-in-the-loop approval flow: merge an approved auto/improve-* branch to
// main, reject (delete) one, or apply an approval record from the Discord bot.

import { log } from 'ion-sdk'
import { logEvent } from '../memory/episodic'
import { decide, getById } from '../approvals/index'
import { BRANCH_RE } from './paths'
import { git, deleteBranch } from './branches'

// ---------------------------------------------------------------------------
// Public API: mergeBranch()
// ---------------------------------------------------------------------------

export async function mergeBranch(branch: string): Promise<{ ok: boolean; diff: string }> {
  if (!BRANCH_RE.test(branch)) {
    return { ok: false, diff: `Invalid branch name: ${branch}` }
  }

  // Pre-flight: abort if the working tree is dirty.
  // A dirty workspace causes `git stash apply` (and merge) to produce unexpected
  // conflicts or silently corrupt staged state. Fail fast with a clear error
  // so the caller can surface it rather than proceeding with a broken merge. (#578)
  const statusResult = await git(['status', '--porcelain'])
  if (statusResult.stdout.trim().length > 0) {
    const dirty = statusResult.stdout.trim().split('\n').slice(0, 5).join(', ')
    log.error('improve: mergeBranch aborted -- workspace is dirty', { dirty })
    return {
      ok: false,
      diff: `Cannot merge: workspace is dirty (${dirty}). Commit or discard changes first.`,
    }
  }

  const diffResult = await git(['diff', `main...${branch}`, '--stat'])
  const fullDiff = await git(['diff', `main...${branch}`])
  const diffSummary = (diffResult.stdout || '').trim()
  const diffBody = (fullDiff.stdout || '').trim()
  const truncated = diffBody.length > 3000
  const diffSnippet = truncated ? diffBody.slice(0, 3000) + '\n... (truncated)' : diffBody
  const diff = diffSummary
    ? `Changes in ${branch}:\n\`\`\`\n${diffSummary}\n\`\`\`\nFull diff:\n\`\`\`diff\n${diffSnippet}\n\`\`\``
    : '(no diff available)'

  const checkout = await git(['checkout', 'main'])
  if (checkout.status !== 0) {
    log.error('improve: could not checkout main', { stderr: checkout.stderr })
    return { ok: false, diff }
  }

  const merge = await git(['merge', '--no-ff', '-m', `merge: ${branch} [approved]`, '--', branch])
  if (merge.status !== 0) {
    log.error('improve: merge failed', { stderr: merge.stderr })
    return { ok: false, diff }
  }

  const push = await git(['push', 'origin', 'main'])
  if (push.status !== 0) {
    log.warn('improve: push to main failed', { stderr: push.stderr })
  }

  await git(['push', 'origin', '--delete', '--', branch])
  await deleteBranch(branch)

  let changedFiles: string[] = []
  try {
    const filesResult = await git(['diff', '--name-only', 'main~1', 'main'])
    changedFiles = filesResult.stdout.trim().split('\n').filter(Boolean)
  } catch {
    // best effort -- fall back to empty list
  }
  logEvent('improve', 'improvement_merged', { branch, files: changedFiles })
  logEvent('', 'feedback_endorsement', { target: branch, source: 'auto_merge', ts: new Date().toISOString() })
  return { ok: true, diff }
}

export async function rejectBranch(branch: string): Promise<void> {
  if (!BRANCH_RE.test(branch)) {
    log.warn('rejectBranch: invalid branch name rejected', { branch })
    return
  }

  await deleteBranch(branch)
  await git(['push', 'origin', '--delete', '--', branch])
  logEvent('improve', 'improvement_rejected', { branch })
  logEvent('', 'feedback_correction', { text: 'auto-improve branch rejected: ' + branch, detector: 'human_reject', confidence: 1.0, ts: new Date().toISOString() })
  log.info('improve: branch rejected and deleted', { branch })
}

// ---------------------------------------------------------------------------
// applyApprovedImprove: called by Discord bot when an improve approval is granted.
// Wired to the Discord 'approve' command in discord/bot.ts.
// ---------------------------------------------------------------------------

export async function applyApprovedImprove(approvalId: number): Promise<{ ok: boolean; diff: string }> {
  const approval = getById(approvalId)
  if (!approval) {
    return { ok: false, diff: `Approval ${approvalId} not found.` }
  }
  if (approval.decided_at !== null) {
    return { ok: false, diff: `Approval ${approvalId} already decided (${approval.decision ?? 'unknown'}).` }
  }

  // github_run_id stores the branch name for improve approvals.
  const branch = approval.github_run_id
  if (!branch || !BRANCH_RE.test(branch)) {
    return { ok: false, diff: `Approval ${approvalId} has no valid branch reference (github_run_id=${branch ?? 'null'}).` }
  }

  const { ok, diff } = await mergeBranch(branch)
  if (!ok) {
    return { ok: false, diff }
  }

  decide(approvalId, 'approved', 'discord')
  return { ok: true, diff }
}
