// Intervention digest: daily survey of patrol issues needing human action.
// Aggregates stuck issues (no jarvis-auto label, not in pending approvals),
// pending approval items, and recent failures. Posts a single Discord digest.

import { log } from 'ion-sdk'
import { logEvent, db } from '../../memory/episodic'
import { isEnabled } from '../helpers'
import { runCommandAsync } from '../../util/ionPrompt'
import { notifyInterventionDigest } from '../../discord/notify'
import { getPending } from '../../approvals'

interface GithubIssue {
  number: number
  title: string
  labels: Array<{ name: string }>
  url: string
}

interface PendingApproval {
  approvalId: number
  issueNumber: number | null
  issueUrl: string
  summary: string
}

interface RecentFailure {
  issueNumber: number
  eventType: string
  reasonSnippet: string
  createdAt: string
}

export async function runInterventionDigest(): Promise<void> {
  if (!isEnabled('intervention_digest')) return
  try {
    // Step A: Fetch open patrol issues
    let openIssues: GithubIssue[] = []
    try {
      const r = await runCommandAsync('gh', [
        'issue', 'list',
        '--repo', '<your-org>/jarvis',
        '--label', 'jarvis-patrol',
        '--state', 'open',
        '--limit', '200',
        '--json', 'number,title,url,labels',
      ], { timeoutMs: 30_000 })
      if (!r.error) {
        openIssues = JSON.parse(r.stdout.trim()) as GithubIssue[]
      }
    } catch (err) {
      log.warn('scheduler: intervention_digest: failed to fetch open patrol issues', { err: String(err) })
    }

    // Step B: Fetch pending approvals (kind='resolver' only, not decided)
    let pendingApprovals: PendingApproval[] = []
    try {
      const pending = getPending().filter(a => a.kind === 'resolver')
      pendingApprovals = pending.map(p => ({
        approvalId: p.id,
        issueNumber: p.github_issue_number,
        issueUrl: p.github_issue_number
          ? `https://github.com/<your-org>/jarvis/issues/${p.github_issue_number}`
          : '',
        summary: p.summary,
      }))
    } catch (err) {
      log.warn('scheduler: intervention_digest: failed to fetch pending approvals', { err: String(err) })
    }

    // Step C: Fetch recent failures from agent_events (last 24h)
    const recentFailures: RecentFailure[] = []
    try {
      const rows = db().prepare(`
        SELECT detail, ts FROM agent_events
        WHERE event IN ('resolver_check_failed', 'resolver_no_changes', 'resolver_failed')
        AND ts > datetime('now', '-24 hours')
        ORDER BY ts DESC
      `).all() as Array<{ detail: string | null; ts: string }>

      for (const row of rows) {
        try {
          const detail = row.detail ? JSON.parse(row.detail) : {}
          const issueNumber = detail.issue_number ?? detail.issueNumber
          if (issueNumber) {
            recentFailures.push({
              issueNumber,
              eventType: row.detail ? (JSON.parse(row.detail).event_type || 'unknown') : 'unknown',
              reasonSnippet: String(detail.error || detail.reason || 'no details').slice(0, 100),
              createdAt: row.ts,
            })
          }
        } catch {
          // Skip rows with malformed detail
        }
      }
    } catch (err) {
      log.warn('scheduler: intervention_digest: failed to fetch recent failures', { err: String(err) })
    }

    // Step D: Partition stuck issues
    // Stuck = no jarvis-auto label AND not in pending-approval issue numbers
    const pendingIssueNumbers = new Set(
      pendingApprovals
        .map(p => p.issueNumber)
        .filter((n): n is number => n !== null && n !== undefined),
    )

    const stuck = openIssues.filter(issue => {
      const hasAutoLabel = issue.labels.some(l => l.name === 'jarvis-auto')
      const isPendingApproval = pendingIssueNumbers.has(issue.number)
      return !hasAutoLabel && !isPendingApproval
    }).map(i => ({
      number: i.number,
      title: i.title,
      url: i.url,
    }))

    // Step E: Skip if all lists are empty
    if (stuck.length === 0 && pendingApprovals.length === 0 && recentFailures.length === 0) {
      logEvent('intervention_digest', 'routine_delivered', {
        routine: 'intervention_digest',
        skipped: true,
      })
      return
    }

    // Step F: Notify
    await notifyInterventionDigest({
      stuck,
      pendingApprovals,
      recentFailures,
    })

    logEvent('intervention_digest', 'routine_delivered', {
      routine: 'intervention_digest',
      stuck_count: stuck.length,
      pending_approvals_count: pendingApprovals.length,
      recent_failures_count: recentFailures.length,
    })
  } catch (err) {
    log.warn('scheduler: intervention_digest failed', { err: String(err) })
    logEvent('intervention_digest', 'routine_delivered', {
      routine: 'intervention_digest',
      exit_code: -1,
      error: String(err),
    })
  }
}
