// Stale approval scanner — surfaces resolver/improve approval stashes that have
// lingered without a user decision. Runs once per day via addDaily().
//
// Does NOT auto-reject. Only logs a stale_approval event and sends a Discord
// notification so the user can decide. Each approval is notified at most once
// per run; if it is still pending 24 hours later it will surface again.

import { log } from 'ion-sdk'
import { getPending } from '../approvals/index'
import { logEvent, recentEvents } from '../memory/episodic'
import { postProactive } from '../proactive/notify'
import { isEnabled } from '../scheduler/helpers'

const STALE_THRESHOLD_DAYS = 7
const STALE_THRESHOLD_MS = STALE_THRESHOLD_DAYS * 24 * 3_600_000

// ---------------------------------------------------------------------------
// Build a human-readable summary line for a single approval.
// ---------------------------------------------------------------------------

function approvalSummary(a: ReturnType<typeof getPending>[number]): string {
  const ageMs = Date.now() - a.requested_at
  const ageDays = Math.floor(ageMs / 86_400_000)
  const kind = a.kind
  const suffix = a.github_issue_number != null
    ? ` (issue #${a.github_issue_number})`
    : a.github_run_id != null
      ? ` (${a.github_run_id})`
      : ''
  return `#${a.id} [${kind}]${suffix}: "${a.summary.slice(0, 80)}" — ${ageDays}d pending`
}

// ---------------------------------------------------------------------------
// Public entry point — called by addDaily() in scheduler/index.ts
// ---------------------------------------------------------------------------

export async function scanStaleApprovals(): Promise<void> {
  if (!isEnabled('stale_approval_scan')) return

  let pending: ReturnType<typeof getPending>
  try {
    pending = getPending()
  } catch (err) {
    log.warn('patrol/staleApprovals: getPending failed', { err: String(err) })
    return
  }

  const stale = pending.filter(a => (Date.now() - a.requested_at) >= STALE_THRESHOLD_MS)

  if (stale.length === 0) {
    log.info('patrol/staleApprovals: no stale approvals')
    return
  }

  // Per-approval dedup: skip any approval already notified as stale today.
  // We check for a stale_approval event fired in the last 23 hours to avoid
  // double-firing when the scheduler fires slightly early on the next day.
  const recentlySurfaced = new Set<number>()
  try {
    const recent = recentEvents('patrol', 'stale_approval', 23)
    for (const row of recent) {
      const d = row.detail as Record<string, unknown> | null
      if (d && typeof d['approval_id'] === 'number') {
        recentlySurfaced.add(d['approval_id'])
      }
    }
  } catch (err) {
    log.warn('patrol/staleApprovals: could not check recent events, proceeding', { err: String(err) })
  }

  const toNotify = stale.filter(a => !recentlySurfaced.has(a.id))

  if (toNotify.length === 0) {
    log.info('patrol/staleApprovals: all stale approvals already surfaced today')
    return
  }

  log.info('patrol/staleApprovals: surfacing stale approvals', { count: toNotify.length })

  const lines = toNotify.map(approvalSummary)
  const bodyText =
    `${toNotify.length} approval${toNotify.length > 1 ? 's have' : ' has'} been pending for ` +
    `${STALE_THRESHOLD_DAYS}+ days and may need a decision.\n\n` +
    lines.join('\n') +
    `\n\nUse \`/approve <id>\` or \`/deny <id>\` in Discord to resolve.`

  for (const a of toNotify) {
    logEvent('patrol', 'stale_approval', {
      approval_id: a.id,
      kind: a.kind,
      age_ms: Date.now() - a.requested_at,
      summary: a.summary.slice(0, 120),
    })
  }

  try {
    await postProactive(null, {
      embed: {
        title: `Stale pending approval${toNotify.length > 1 ? 's' : ''}`,
        description: bodyText,
        color: 0xf59e0b, // amber — attention required but not critical
      },
    })
  } catch (err) {
    log.warn('patrol/staleApprovals: postProactive failed', { err: String(err) })
  }
}
