// Digest inbox accumulator for ambient triage batch items.
// Mirrors harness/inbox.py; uses the same agent_events table in conversations.db.
//
// Note: Python inbox.py emits overflow notifications via the in-process events bus
// (harness.interfaces.events.emit). This TS port writes the overflow event directly
// to agent_events as an "inbox_item" row. The Python TUI does not currently poll
// SQLite for inbox_item rows -- this is a known gap until the Slack/TUI bridge lands.
//
// Not yet wired into extension.ts -- staging for scheduler/Slack bridge work.

import { log } from 'ion-sdk'
import { logEvent, lastEvent, eventsSince } from '../memory/episodic'

export const MAX_BATCH_BEFORE_PROMPT = 20
const BATCH_EVENT = 'inbox_batch'
const DRAIN_EVENT = 'inbox_drained'
const SESSION = 'inbox'

export interface BatchItem {
  source: string
  content: string
  score: number
  reason: string
}

function drainCursorId(): number {
  const row = lastEvent(SESSION, DRAIN_EVENT)
  if (row && typeof row.detail === 'object' && row.detail !== null) {
    const detail = row.detail as Record<string, unknown>
    const id = detail['after_id']
    return typeof id === 'number' ? id : 0
  }
  return 0
}

export function countPending(): number {
  const cursor = drainCursorId()
  return eventsSince(cursor, SESSION, BATCH_EVENT).length
}

export function add(item: BatchItem): void {
  if (countPending() >= 500) {
    log.warn('inbox: hard cap reached, dropping item', { source: item.source })
    return
  }
  logEvent(SESSION, BATCH_EVENT, {
    source: item.source,
    content: item.content.slice(0, 500),
    score: item.score,
    reason: item.reason,
  })

  const count = countPending()
  if (count === MAX_BATCH_BEFORE_PROMPT) {
    logEvent(SESSION, 'inbox_item', {
      routine: 'inbox',
      text: `I have ${count} items waiting in the batch digest. Say 'what's new' for them now, or they will appear in the morning brief.`,
    })
    log.info('inbox: overflow threshold reached', { count })
  }
}

export function drain(n = 200): BatchItem[] {
  const cursor = drainCursorId()
  // eventsSince returns rows ORDER BY id ASC (oldest first, no LIMIT).
  const rows = eventsSince(cursor, SESSION, BATCH_EVENT)

  if (rows.length === 0) return []

  // Take the oldest n rows by id so surplus items stay queued for the next drain.
  // Advance the cursor only past the rows we are actually returning.
  const taken = rows.slice(0, n)
  const maxTakenId = taken.reduce((m, r) => Math.max(m, r.id), 0)
  logEvent(SESSION, DRAIN_EVENT, { after_id: maxTakenId })

  const items: BatchItem[] = taken.map((row) => {
    const detail =
      typeof row.detail === 'object' && row.detail !== null
        ? (row.detail as Record<string, unknown>)
        : {}
    return {
      source: String(detail['source'] ?? ''),
      content: String(detail['content'] ?? ''),
      score: typeof detail['score'] === 'number' ? detail['score'] : 0.0,
      reason: String(detail['reason'] ?? ''),
    }
  })

  // Sort by score descending for presentation; cursor math is already settled above.
  items.sort((a, b) => b.score - a.score)
  return items
}
