import { db, now, SUBSTANTIVE_EXCLUDED_SESSIONS, type MessageRow } from './base'

export function logMessage(
  session: string,
  role: 'user' | 'assistant' | 'system',
  content: string,
  ionSession?: string,
): number {
  const stmt = db().prepare(
    'INSERT INTO messages (session, role, content, ts, ion_session) VALUES (?, ?, ?, ?, ?)',
  )
  const result = stmt.run(session, role, content, now(), ionSession ?? null)
  return result.lastInsertRowid as number
}

export function getRecentMessages(session: string, n: number): MessageRow[] {
  const stmt = db().prepare(
    `SELECT id, session, role, content, ts FROM messages
     WHERE session = ? ORDER BY id DESC LIMIT ?`,
  )
  const rows = stmt.all(session, n) as MessageRow[]
  // Return oldest-first (chronological) so the conversation reads naturally.
  return rows.reverse()
}

export function lastMessageTs(): string | null {
  const stmt = db().prepare(`SELECT ts FROM messages ORDER BY id DESC LIMIT 1`)
  const row = stmt.get() as { ts: string } | undefined
  return row?.ts ?? null
}

// Returns user+assistant messages from substantive (non-automated) sessions in
// the past hoursBack hours. Excludes the jarvis/default/slack-*/prompt-* sessions
// which carry only scheduled routine content, not real user conversations.
export function getSubstantiveCrossSessionMessages(
  hoursBack: number,
  maxMessages = 30,
): Array<{ role: string; content: string }> {
  const cutoff = new Date(Date.now() - hoursBack * 3600 * 1000).toISOString()
  // Build the NOT IN clause with parameter binding
  const placeholders = SUBSTANTIVE_EXCLUDED_SESSIONS.map(() => '?').join(', ')
  const rows = db()
    .prepare(
      `SELECT role, content FROM messages
       WHERE ts > ?
         AND session NOT IN (${placeholders})
         AND session NOT LIKE 'slack-%'
         AND session NOT LIKE 'prompt-%'
         AND role IN ('user', 'assistant')
       ORDER BY ts ASC
       LIMIT ?`,
    )
    .all(cutoff, ...SUBSTANTIVE_EXCLUDED_SESSIONS, maxMessages) as Array<{ role: string; content: string }>
  return rows
}

// Returns recent user message snippets from substantive sessions for before_prompt injection.
export function getRecentUserTopics(hoursBack: number, max = 15): string[] {
  const msgs = getSubstantiveCrossSessionMessages(hoursBack, max * 2)
  return msgs
    .filter((m) => m.role === 'user')
    .slice(0, max)
    .map((m) => m.content.replace(/\n/g, ' ').substring(0, 200))
}

export function getSubstantiveCrossSessionMessagesWindow(withinHours: number): MessageRow[] {
  const cutoff = new Date(Date.now() - withinHours * 60 * 60 * 1000).toISOString()
  // Issue #568: mirror the same slack-* and prompt-* exclusions used by
  // getSubstantiveCrossSessionMessages so automated/triage sessions don't
  // inflate the cross-session window with non-conversational content.
  const stmt = db().prepare(
    `SELECT id, session, role, content, ts FROM messages
     WHERE ts >= ?
       AND session NOT IN ('jarvis', 'default', '')
       AND session NOT LIKE 'slack-%'
       AND session NOT LIKE 'prompt-%'
     ORDER BY ts ASC`,
  )
  return stmt.all(cutoff) as MessageRow[]
}

/**
 * Return the first user message in `messages` whose `ion_session` matches
 * `session` and whose `ts` is strictly between `tsA` and `tsB`.
 * Returns null when no such message exists.
 */
export function getUserMessageBetween(session: string, tsA: string, tsB: string): string | null {
  const stmt = db().prepare(
    `SELECT content FROM messages
     WHERE ion_session = ? AND ts > ? AND ts < ? AND role = 'user'
     ORDER BY ts ASC LIMIT 1`,
  )
  const row = stmt.get(session, tsA, tsB) as { content: string } | undefined
  return row?.content ?? null
}
