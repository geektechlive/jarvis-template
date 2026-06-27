// Pending-approval digest batcher for Discord.
// Gathers all pending approvals, formats a single message, posts via webhook,
// then binds the returned message ID and per-approval local indices.

import { getPending, bindDigest, type Approval } from '../approvals/index'
import { postToChannel } from './webhook'

const RISK_LABELS: Record<string, string> = {
  risky: '⚠️',
  safe: '',
}

/**
 * Format a human-readable digest message for the given pending approvals.
 * Pure function — no I/O, safe to unit test.
 */
export function formatDigestMessage(pending: Approval[]): string {
  if (pending.length === 0) return 'Jarvis · no changes waiting approval.'

  const header = `Jarvis · ${pending.length} change${pending.length === 1 ? '' : 's'} waiting approval:\n`

  const items = pending.map((a, i) => {
    const num = i + 1
    const issueRef = a.github_issue_number != null ? `#${a.github_issue_number} — ` : ''
    const riskMark = RISK_LABELS[a.risk_tier] ? ` ${RISK_LABELS[a.risk_tier]}` : ''
    const filesLine =
      a.files_changed && a.files_changed.length > 0
        ? `\n     touches: ${a.files_changed.slice(0, 3).join(', ')}${a.files_changed.length > 3 ? ` (+${a.files_changed.length - 3} more)` : ''}`
        : ''
    return `  ${num}) ${issueRef}${a.summary}\n     ${a.kind}${riskMark}${filesLine}`
  })

  const footer = [
    '',
    'Reply: approve 1 / deny 2 / approve #<issue> / approve all / status / pending',
  ].join('\n')

  return header + '\n' + items.join('\n\n') + footer
}

/**
 * Fetch all pending approvals, post a digest to Discord, and bind the
 * returned message ID + local indices back into the approvals table.
 */
export async function postPendingDigest(): Promise<void> {
  const pending = getPending()
  if (pending.length === 0) return

  const content = formatDigestMessage(pending)
  const { messageId } = await postToChannel(content)

  const indexMap: Record<number, number> = {}
  const ids: number[] = []
  pending.forEach((a, i) => {
    ids.push(a.id)
    indexMap[a.id] = i + 1
  })

  bindDigest(ids, messageId, indexMap)
}
