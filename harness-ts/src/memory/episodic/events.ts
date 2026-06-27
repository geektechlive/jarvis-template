import { db, now, parseDetail, type EventRow, type RawEventRow } from './base'
import { normalizeAgentName } from '../../staff/normalize'

export function logEvent(session: string, event: string, detail?: unknown): number {
  const stmt = db().prepare(
    'INSERT INTO agent_events (session, event, detail, ts) VALUES (?, ?, ?, ?)',
  )
  const result = stmt.run(
    session,
    event,
    detail != null ? JSON.stringify(detail) : null,
    now(),
  )
  return result.lastInsertRowid as number
}

// Single structured failure convention. Writes event='harness_error' with a
// uniform detail shape { subsystem, message, fatal } so Grafana can group all
// otherwise-unstructured failures by subsystem in one query, without touching
// the existing specific error events that the dashboards already query by name.
//
// Per-turn hot paths (before_prompt / turn_end) must pass a rateKey: a sustained
// dependency outage would otherwise write one row per turn and bloat the DB.
// Mirrors the 5-min Map guard in memory/recall.ts (Issue #573).
const HARNESS_ERROR_RATE_LIMIT_MS = 5 * 60 * 1000
const _lastHarnessErrorTs = new Map<string, number>()

export function recordError(
  subsystem: string,
  err: unknown,
  opts?: { session?: string; fatal?: boolean; rateKey?: string; rateMs?: number },
): void {
  if (opts?.rateKey) {
    const windowMs = opts.rateMs ?? HARNESS_ERROR_RATE_LIMIT_MS
    const last = _lastHarnessErrorTs.get(opts.rateKey) ?? 0
    if (Date.now() - last < windowMs) return
    _lastHarnessErrorTs.set(opts.rateKey, Date.now())
  }
  try {
    logEvent(opts?.session ?? 'system', 'harness_error', {
      subsystem,
      message: err instanceof Error ? err.message : String(err),
      fatal: opts?.fatal ?? false,
    })
  } catch {
    // Recording a failure must never throw and mask the original error.
  }
}

// Test-only: reset the rate-limit window so unit tests are deterministic.
export function _resetHarnessErrorRateLimit(): void {
  _lastHarnessErrorTs.clear()
}

export function lastEvent(session: string, eventType: string): EventRow | null {
  const stmt = db().prepare(
    `SELECT id, session, event, detail, ts FROM agent_events
     WHERE session = ? AND event = ? ORDER BY id DESC LIMIT 1`,
  )
  const row = stmt.get(session, eventType) as RawEventRow | undefined
  if (!row) return null
  return { ...row, detail: parseDetail(row.detail) }
}

export function eventsSince(afterId: number, session: string, eventType: string): EventRow[] {
  const stmt = db().prepare(
    `SELECT id, session, event, detail, ts FROM agent_events
     WHERE id > ? AND session = ? AND event = ? ORDER BY id ASC`,
  )
  const rows = stmt.all(afterId, session, eventType) as RawEventRow[]
  return rows.map((row) => ({ ...row, detail: parseDetail(row.detail) }))
}

export function recentEvents(session: string, eventType: string, withinHours: number): EventRow[] {
  const cutoff = new Date(Date.now() - withinHours * 3_600_000).toISOString()
  const stmt = db().prepare(
    `SELECT id, session, event, detail, ts FROM agent_events
     WHERE session = ? AND event = ? AND ts >= ? ORDER BY id ASC`,
  )
  const rows = stmt.all(session, eventType, cutoff) as RawEventRow[]
  return rows.map((row) => ({ ...row, detail: parseDetail(row.detail) }))
}

/**
 * Return the text field from the most recent inbox_item event for a given session.
 * Used by the scheduler to write chain context to working memory after a routine completes.
 */
export function lastInboxItemText(session: string): string | null {
  const row = db().prepare(
    `SELECT detail FROM agent_events WHERE session = ? AND event = 'inbox_item' ORDER BY id DESC LIMIT 1`,
  ).get(session) as { detail: string | null } | undefined
  if (!row?.detail) return null
  try {
    const d = JSON.parse(row.detail) as { text?: string }
    return d.text?.slice(0, 400) ?? null
  } catch { return null }
}

// Return the N most recent agent_events rows (any event type) for use in staff-log.
export function recentAgentEvents(n: number): EventRow[] {
  const stmt = db().prepare(
    `SELECT id, session, event, detail, ts FROM agent_events ORDER BY id DESC LIMIT ?`,
  )
  const rows = stmt.all(n) as RawEventRow[]
  return rows.map((row) => ({ ...row, detail: parseDetail(row.detail) }))
}

// Return recent improvement_merged / improvement_rejected events for the
// self-improvement loop to avoid re-proposing rejected changes.
export function recentImprovementEvents(days: number): {
  merged: Array<{ branch: string; files: string[]; at: string }>
  rejected: Array<{ branch: string; at: string }>
} {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString()
  const rows = db()
    .prepare(
      `SELECT event, detail, ts FROM agent_events
       WHERE session = 'improve'
         AND event IN ('improvement_merged', 'improvement_rejected')
         AND ts > ?
       ORDER BY ts DESC`,
    )
    .all(cutoff) as Array<{ event: string; detail: string; ts: string }>

  const merged: Array<{ branch: string; files: string[]; at: string }> = []
  const rejected: Array<{ branch: string; at: string }> = []

  for (const row of rows) {
    try {
      const d = JSON.parse(row.detail) as Record<string, unknown>
      if (row.event === 'improvement_merged') {
        merged.push({
          branch: String(d['branch'] ?? ''),
          files: Array.isArray(d['files']) ? (d['files'] as string[]) : [],
          at: row.ts,
        })
      } else {
        rejected.push({ branch: String(d['branch'] ?? ''), at: row.ts })
      }
    } catch {
      // malformed detail -- skip
    }
  }

  return { merged, rejected }
}

// ---------------------------------------------------------------------------
// Handoff-chain mining helpers
// ---------------------------------------------------------------------------

export interface DispatchPair {
  session: string
  agentA: string
  agentB: string
  tsA: string
  tsB: string
  minutesApart: number
}

export type RawDispatchRow = { session: string; detail: string | null; ts: string }

/**
 * Return all consecutive agent_dispatch pairs (same session, ≤10 min apart, no
 * other dispatch between them) from the past `lookbackDays` days.
 *
 * JSON extraction and consecutive-pair logic run in TypeScript to avoid
 * coupling the query to SQLite's JSON functions.
 */
export function getDispatchPairs(lookbackDays: number): DispatchPair[] {
  const cutoff = new Date(Date.now() - lookbackDays * 86_400_000).toISOString()
  const stmt = db().prepare(
    `SELECT session, detail, ts FROM agent_events
     WHERE event = 'agent_dispatch' AND ts >= ?
     ORDER BY session ASC, ts ASC`,
  )
  const rows = stmt.all(cutoff) as RawDispatchRow[]

  const pairs: DispatchPair[] = []

  for (let i = 0; i < rows.length - 1; i++) {
    const rowA = rows[i]
    const rowB = rows[i + 1]

    // Must be same session.
    if (!rowA || !rowB || rowA.session !== rowB.session) continue

    const detailA = parseDetail(rowA.detail) as Record<string, unknown> | null
    const detailB = parseDetail(rowB.detail) as Record<string, unknown> | null
    // Normalize so `chief-of-communications` and `chief_of_communications`
    // (both forms appear in raw agent_dispatch detail) collapse to one staffer.
    const agentA = normalizeAgentName(String(detailA?.['subagentType'] ?? ''))
    const agentB = normalizeAgentName(String(detailB?.['subagentType'] ?? ''))

    if (!agentA || !agentB) continue

    const msA = new Date(rowA.ts).getTime()
    const msB = new Date(rowB.ts).getTime()
    const minutesApart = (msB - msA) / 60_000

    if (minutesApart < 0 || minutesApart > 10) continue

    pairs.push({
      session: rowA.session,
      agentA,
      agentB,
      tsA: rowA.ts,
      tsB: rowB.ts,
      minutesApart,
    })
  }

  return pairs
}

/**
 * Return the N most recent agent_events rows for a given session (all event types).
 * Used by /imessage-status to show recent routing decisions.
 */
export function recentEventsBySession(session: string, limit: number): EventRow[] {
  const stmt = db().prepare(
    `SELECT id, session, event, detail, ts FROM agent_events
     WHERE session = ? ORDER BY id DESC LIMIT ?`,
  )
  const rows = stmt.all(session, limit) as RawEventRow[]
  return rows.map((row) => ({ ...row, detail: parseDetail(row.detail) }))
}

// ---------------------------------------------------------------------------
// Pending brief — written by scheduler, consumed by before_prompt hook
// ---------------------------------------------------------------------------

export function storePendingBrief(text: string): void {
  logEvent('system', 'pending_brief', { text })
}

export function popPendingBrief(): string | null {
  return db().transaction(() => {
    const rows = db()
      .prepare(
        `SELECT id, detail FROM agent_events
         WHERE session = 'system' AND event = 'pending_brief'
         ORDER BY id ASC`,
      )
      .all() as { id: number; detail: string | null }[]
    if (rows.length === 0) return null
    const ids = rows.map((r) => r.id)
    const texts = rows
      .map((r) => {
        const detail = parseDetail(r.detail) as Record<string, unknown> | null
        return typeof detail?.['text'] === 'string' ? detail['text'] : null
      })
      .filter((t): t is string => t !== null)
    db()
      .prepare(`DELETE FROM agent_events WHERE id IN (${ids.map(() => '?').join(',')})`)
      .run(...ids)
    return texts.length > 0 ? texts.join('\n\n---\n\n') : null
  })()
}

export function storePendingReminder(message: string): void {
  logEvent('system', 'pending_reminder', { text: message })
}

export function popPendingReminder(): string | null {
  return db().transaction(() => {
    const rows = db()
      .prepare(
        `SELECT id, detail FROM agent_events
         WHERE session = 'system' AND event = 'pending_reminder'
         ORDER BY id ASC`,
      )
      .all() as { id: number; detail: string | null }[]
    if (rows.length === 0) return null
    const ids = rows.map((r) => r.id)
    const texts = rows
      .map((r) => {
        const detail = parseDetail(r.detail) as Record<string, unknown> | null
        return typeof detail?.['text'] === 'string' ? detail['text'] : null
      })
      .filter((t): t is string => t !== null)
    db()
      .prepare(`DELETE FROM agent_events WHERE id IN (${ids.map(() => '?').join(',')})`)
      .run(...ids)
    return texts.length > 0 ? texts.join('\n') : null
  })()
}

// ---------------------------------------------------------------------------
// Pending improve flag — queued by complex sessions, drained by scheduler
// ---------------------------------------------------------------------------

export function setPendingImprove(): void {
  if (hasPendingImprove()) return  // idempotent
  logEvent('system', 'pending_improve', { queued_at: now() })
}

export function hasPendingImprove(): boolean {
  const row = db().prepare(
    `SELECT id FROM agent_events WHERE session = 'system' AND event = 'pending_improve' LIMIT 1`,
  ).get()
  return row != null
}

export function clearPendingImprove(): void {
  db().prepare(
    `UPDATE agent_events SET event = 'pending_improve_consumed' WHERE session = 'system' AND event = 'pending_improve'`,
  ).run()
}

// ---------------------------------------------------------------------------
// Briefings resource query — backing store for ion resource onQuery handler
// ---------------------------------------------------------------------------

export interface BriefingResourceItem {
  id: string
  kind: string
  title: string
  content: string
  createdAt: string
}

// Returns recent stored briefs for the ion resource subsystem onQuery handler.
// Reads pending_brief events from agent_events (written by storePendingBrief).
// The engine calls this when a client subscribes to the 'briefing' resource kind.
export function fetchBriefingsFromDb(limit = 50): BriefingResourceItem[] {
  try {
    const rows = db()
      .prepare(
        `SELECT id, detail, ts FROM agent_events
         WHERE session = 'system' AND event = 'pending_brief'
         ORDER BY id DESC LIMIT ?`,
      )
      .all(limit) as { id: number; detail: string | null; ts: string }[]

    return rows.map((row): BriefingResourceItem => {
      const detail = parseDetail(row.detail) as Record<string, unknown> | null
      const text = typeof detail?.['text'] === 'string' ? detail['text'] : ''
      return {
        id: `brief-${row.id}`,
        kind: 'briefing',
        title: text.split('\n')[0]?.slice(0, 120) ?? 'Brief',
        content: text,
        createdAt: row.ts,
      }
    })
  } catch {
    return []
  }
}
