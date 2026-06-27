// Open threads — "where were we" continuity index.
//
// Auto-derived from agent_events. An agent_dispatch event opens a thread keyed by
// subagentType. The thread closes when:
//   - the user types /close <topic> (via markThreadClosed())
//   - a session_end event lands within 90 minutes of the last dispatch in the
//     same session AND the last user message in that session does not reference
//     the topic — handled implicitly by the time-decay cap (7 days by default)
//
// This is a derived view, not a parallel store. If accuracy becomes a problem,
// promote to a dedicated table at that point — until then the events table
// already has the data.

import Database from 'better-sqlite3'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdirSync } from 'node:fs'
import { log } from 'ion-sdk'
import { normalizeAgentName } from './staff/normalize'

function dbPath(): string {
  const raw = process.env['AGENT_DATA_DIR']
  const dir = raw ? raw.replace('~', homedir()) : join(homedir(), '.jarvis')
  return join(dir, 'conversations.db')
}

let _db: Database.Database | null = null

function db(): Database.Database {
  if (!_db) {
    const path = dbPath()
    try {
      mkdirSync(join(path, '..'), { recursive: true })
    } catch { /* ignore */ }
    _db = new Database(path, { readonly: false, fileMustExist: false })
    _db.pragma('journal_mode = WAL')
  }
  return _db
}

export interface OpenThread {
  topic: string
  lastTouchedAt: string
  lastSession: string
  dispatchCount: number
}

interface DispatchRow {
  id: number
  session: string
  detail: string | null
  ts: string
}

interface ClosedRow {
  topic: string
  closed_at: string
}

function ensureClosedTable(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS open_threads_closed (
      topic     TEXT PRIMARY KEY,
      closed_at TEXT NOT NULL
    )
  `)
}

const MAX_THREADS = 5

// Hard-set scan window: 7 days. Anything older than that gets dropped from the
// "still open" view by design. Stale threads from last month are not load-bearing.
const MAX_AGE_DAYS_DEFAULT = 7

export function loadOpenThreads(maxAgeDays = MAX_AGE_DAYS_DEFAULT): OpenThread[] {
  try {
    ensureClosedTable(db())
    const cutoffIso = new Date(Date.now() - maxAgeDays * 86_400_000).toISOString()

    const dispatchRows = db()
      .prepare(
        `SELECT id, session, detail, ts FROM agent_events
         WHERE event = 'agent_dispatch' AND ts >= ?
         ORDER BY id ASC`,
      )
      .all(cutoffIso) as DispatchRow[]
    if (!dispatchRows.length) return []

    const closedRows = db()
      .prepare(`SELECT topic, closed_at FROM open_threads_closed`)
      .all() as ClosedRow[]
    const closedAt = new Map(closedRows.map((r) => [r.topic.toLowerCase(), r.closed_at]))

    const byTopic = new Map<string, OpenThread>()
    for (const row of dispatchRows) {
      let detail: Record<string, unknown> = {}
      if (row.detail) {
        try {
          detail = JSON.parse(row.detail) as Record<string, unknown>
        } catch {
          continue
        }
      }
      const topic = normalizeAgentName(String(detail['subagentType'] ?? detail['subagent_type'] ?? ''))
      if (!topic) continue
      const closedTs = closedAt.get(topic.toLowerCase())
      if (closedTs && closedTs > row.ts) {
        // dispatch happened before user closed the topic → ignore
        continue
      }
      const existing = byTopic.get(topic)
      if (!existing) {
        byTopic.set(topic, {
          topic,
          lastTouchedAt: row.ts,
          lastSession: row.session,
          dispatchCount: 1,
        })
      } else if (row.ts > existing.lastTouchedAt) {
        existing.lastTouchedAt = row.ts
        existing.lastSession = row.session
        existing.dispatchCount += 1
      } else {
        existing.dispatchCount += 1
      }
    }
    return [...byTopic.values()]
      .sort((a, b) => (a.lastTouchedAt < b.lastTouchedAt ? 1 : -1))
      .slice(0, MAX_THREADS)
  } catch (err) {
    log.warn('openThreads: load failed', { err: String(err) })
    return []
  }
}

function ageLabel(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 0) return 'just now'
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function prettyTopic(topic: string): string {
  return topic
    .split(/[_-]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

export function formatOpenThreadsBlock(threads: OpenThread[]): string {
  if (!threads.length) return ''
  const lines = threads.map(
    (t) =>
      `- ${prettyTopic(t.topic)} (last touched ${ageLabel(t.lastTouchedAt)}, ${t.dispatchCount} dispatch${t.dispatchCount === 1 ? '' : 'es'})`,
  )
  return (
    '\n\n---\nOpen threads from prior sessions (carried context -- mention only if relevant):\n' +
    lines.join('\n') +
    "\nIf the principal returns to one of these, pick up where you left off. Use /close <topic> to retire one."
  )
}

export function markThreadClosed(topic: string): void {
  if (!topic) return
  ensureClosedTable(db())
  db()
    .prepare(`INSERT OR REPLACE INTO open_threads_closed (topic, closed_at) VALUES (?, ?)`)
    .run(topic.trim(), new Date().toISOString())
}

// Internal — test hook to use a fresh DB connection after AGENT_DATA_DIR changes.
export function _resetDbForTests(): void {
  if (_db) {
    try { _db.close() } catch { /* ignore */ }
    _db = null
  }
}
