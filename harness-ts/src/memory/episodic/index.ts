export * from './base'
export * from './events'
export * from './messages'
export * from './goals'
export * from './habits'

// ---------------------------------------------------------------------------
// Remaining small leaf groups — depend only on base
// ---------------------------------------------------------------------------

import { log } from 'ion-sdk'
import { db, now } from './base'

// ---------------------------------------------------------------------------
// Reminders — durable scheduled reminders
// ---------------------------------------------------------------------------

export interface ReminderRow {
  id: number
  user_text: string
  fire_at: string
  message: string
  status: string
  attempts: number
  // #542: escalation. escalation_cap = 0 means one-shot (legacy). escalation_level
  // counts successful re-fires (distinct from `attempts`, which counts delivery
  // failures). next_remind_at drives subsequent ticks once escalation begins.
  escalation_level: number
  escalation_cap: number
  next_remind_at: string | null
  created_at: string
}

export interface CreateReminderOptions {
  // #542: when true, the reminder re-fires on an urgency-tiered schedule until
  // the cap is reached or it is cancelled. Default false (one-shot).
  escalating?: boolean
  // Max number of re-fires before escalation stops. Defaults to 10 when
  // escalating; ignored when escalating is false.
  escalationCap?: number
}

const DEFAULT_ESCALATION_CAP = 10

export function createReminder(
  userText: string,
  fireAt: Date,
  message: string,
  opts?: CreateReminderOptions,
): number {
  // escalating with an explicit cap clamps to >= 1 (a 0/negative cap with
  // escalating:true is contradictory -- give one re-fire, not a silent 10);
  // escalating with no cap defaults to 10; non-escalating is one-shot (0).
  const escalationCap = opts?.escalating
    ? (typeof opts.escalationCap === 'number' ? Math.max(1, Math.trunc(opts.escalationCap)) : DEFAULT_ESCALATION_CAP)
    : 0
  const stmt = db().prepare(
    `INSERT INTO reminders (user_text, fire_at, message, status, escalation_cap, created_at)
     VALUES (?, ?, ?, 'pending', ?, ?)`,
  )
  const result = stmt.run(
    userText,
    fireAt.toISOString(),
    message,
    escalationCap,
    new Date().toISOString(),
  )
  return result.lastInsertRowid as number
}

export function dueReminders(): ReminderRow[] {
  // #542: an escalating reminder's next due time is next_remind_at once it has
  // fired at least once; fall back to fire_at for the initial fire.
  return db()
    .prepare(
      `SELECT * FROM reminders
       WHERE status = 'pending' AND COALESCE(next_remind_at, fire_at) <= ?
       ORDER BY COALESCE(next_remind_at, fire_at) ASC LIMIT 20`,
    )
    .all(new Date().toISOString()) as ReminderRow[]
}

/**
 * #542: re-queue an escalating reminder for its next follow-up. Flips status
 * back to 'pending', stamps next_remind_at, and bumps escalation_level.
 *
 * Resets `attempts` to 0: a successful delivery just occurred, so the
 * delivery-failure retry counter must not carry over. Without this, transient
 * push failures spread across a long (days-long) escalation accumulate and flip
 * the reminder to terminal 'failed' mid-escalation -- killing exactly the
 * must-not-miss reminders this feature exists for. attempts caps a single
 * delivery's retries; escalation_level counts successful re-fires.
 */
export function escalateReminder(id: number, nextRemindAt: Date): void {
  db()
    .prepare(
      `UPDATE reminders
         SET status = 'pending',
             escalation_level = escalation_level + 1,
             attempts = 0,
             next_remind_at = ?
       WHERE id = ?`,
    )
    .run(nextRemindAt.toISOString(), id)
}

export function markReminderFired(id: number): boolean {
  const result = db()
    .prepare(`UPDATE reminders SET status = 'fired' WHERE id = ? AND status = 'pending'`)
    .run(id)
  return (result.changes) > 0
}

const MAX_REMINDER_ATTEMPTS = 3

/**
 * Revert a fired reminder back to 'pending' so the next tick retries delivery,
 * or flip it to 'failed' (terminal) once the attempt cap is reached.
 *
 * Returns 'requeued' when the row is reset to pending, 'failed' when the cap
 * is exhausted. Caller should emit log.error on 'failed'.
 */
export function requeueReminder(id: number): 'requeued' | 'failed' {
  // Wrap the read-modify-write in a transaction so the attempts increment is
  // atomic and self-contained, independent of the caller's CAS gate.
  return db().transaction((): 'requeued' | 'failed' => {
    const row = db()
      .prepare(`SELECT attempts FROM reminders WHERE id = ?`)
      .get(id) as { attempts: number } | undefined

    const attempts = (row?.attempts ?? 0) + 1

    if (attempts >= MAX_REMINDER_ATTEMPTS) {
      db()
        .prepare(`UPDATE reminders SET status = 'failed', attempts = ? WHERE id = ?`)
        .run(attempts, id)
      return 'failed'
    }

    db()
      .prepare(`UPDATE reminders SET status = 'pending', attempts = ? WHERE id = ?`)
      .run(attempts, id)
    return 'requeued'
  })()
}

export function cancelReminder(id: number): boolean {
  const result = db()
    .prepare(`UPDATE reminders SET status = 'cancelled' WHERE id = ? AND status = 'pending'`)
    .run(id)
  return (result.changes) > 0
}

export function listReminders(status?: 'pending' | 'fired' | 'cancelled'): ReminderRow[] {
  if (status) {
    return db()
      .prepare(`SELECT * FROM reminders WHERE status = ? ORDER BY fire_at DESC LIMIT 50`)
      .all(status) as ReminderRow[]
  }
  return db()
    .prepare(`SELECT * FROM reminders ORDER BY fire_at DESC LIMIT 50`)
    .all() as ReminderRow[]
}

// ---------------------------------------------------------------------------
// Conversation summaries — multi-granularity narrative digests
// ---------------------------------------------------------------------------

export interface ConversationSummaryRow {
  id: number
  granularity: string
  period_start: string
  period_end: string
  summary: string
  session_count: number | null
  message_count: number | null
  created_at: string
}

export function storeConversationSummary(
  granularity: string,
  periodStart: string,
  periodEnd: string,
  summary: string,
  sessionCount?: number,
  messageCount?: number,
): number {
  const stmt = db().prepare(
    `INSERT INTO conversation_summaries (granularity, period_start, period_end, summary, session_count, message_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  const result = stmt.run(granularity, periodStart, periodEnd, summary, sessionCount ?? null, messageCount ?? null, new Date().toISOString())
  return result.lastInsertRowid as number
}

export function getLatestSummary(granularity: string): ConversationSummaryRow | null {
  const stmt = db().prepare(
    `SELECT * FROM conversation_summaries WHERE granularity = ? ORDER BY created_at DESC LIMIT 1`,
  )
  return (stmt.get(granularity) as ConversationSummaryRow | undefined) ?? null
}

export function getRecentSummaries(granularity: string, limit: number): ConversationSummaryRow[] {
  const stmt = db().prepare(
    `SELECT * FROM conversation_summaries WHERE granularity = ? ORDER BY created_at DESC LIMIT ?`,
  )
  return stmt.all(granularity, limit) as ConversationSummaryRow[]
}

// ---------------------------------------------------------------------------
// Working memory — short-lived hot context injected into before_prompt
// ---------------------------------------------------------------------------

export function writeWorkingMemory(content: string, writtenBy: string, ttlHours = 4): void {
  const expiresAt = new Date(Date.now() + ttlHours * 3_600_000).toISOString()
  db().prepare(
    `INSERT INTO working_memory (content, written_by, written_at, expires_at) VALUES (?, ?, ?, ?)`,
  ).run(content, writtenBy, now(), expiresAt)
  // Purge expired entries on every write (cheap on small table)
  db().prepare(`DELETE FROM working_memory WHERE expires_at < ?`).run(now())
}

export function readWorkingMemory(): Array<{ content: string; written_by: string; written_at: string }> {
  return db().prepare(
    `SELECT content, written_by, written_at FROM working_memory
     WHERE expires_at > ? ORDER BY written_at ASC`,
  ).all(now()) as Array<{ content: string; written_by: string; written_at: string }>
}

// ---------------------------------------------------------------------------
// Performance metrics
// ---------------------------------------------------------------------------

/**
 * Record a latency measurement for a named phase (e.g., 'reflection', 'mail_parse').
 * Aligns with Python episodic.record_perf_metric().
 */
export function recordPerfMetric(phase: string, latencyMs: number, session = 'default'): void {
  const metadata: Record<string, unknown> = {}
  const stmt = db().prepare(
    `INSERT INTO perf_metrics (phase, latency_ms, session, metadata, created_at) VALUES (?, ?, ?, ?, ?)`,
  )
  stmt.run(phase, latencyMs, session, JSON.stringify(metadata), now())
}

// Prune perf_metrics older than retentionDays.
export function prunePerfMetrics(retentionDays = 90): number {
  try {
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString()
    const result = db().prepare(
      `DELETE FROM perf_metrics WHERE created_at < ?`,
    ).run(cutoff)
    return result.changes
  } catch {
    return 0
  }
}

// ---------------------------------------------------------------------------
// iMessage dedup / processed tracking
// ---------------------------------------------------------------------------

export function isImessageProcessed(guid: string): boolean {
  return !!db().prepare('SELECT 1 FROM processed_imessages WHERE guid = ?').get(guid)
}

export function markImessageProcessed(guid: string, rowid: number, sender: string, decision: string): void {
  db().prepare(
    `INSERT OR IGNORE INTO processed_imessages (guid, rowid, sender, processed_at, triage_decision)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(guid, rowid, sender, new Date().toISOString(), decision)
}

// ---------------------------------------------------------------------------
// Scheduler advisory lock — ensures only one scheduler runs at a time across
// N ion extension subprocesses that share the same SQLite DB.
// ---------------------------------------------------------------------------

export function tryAcquireSchedulerLock(): boolean {
  const pid = process.pid
  try {
    db().exec(`
      CREATE TABLE IF NOT EXISTS scheduler_lock (
        id   INTEGER PRIMARY KEY CHECK (id = 1),
        pid  INTEGER NOT NULL,
        acquired_at TEXT NOT NULL
      )
    `)
    // Wrap SELECT -> DELETE -> INSERT in an IMMEDIATE transaction so two processes
    // can't both read the stale row and both insert, causing duplicate scheduler runs.
    const TWO_HOURS_MS = 2 * 60 * 60 * 1000
    const doAcquire = db().transaction((): boolean => {
      const row = db()
        .prepare('SELECT pid, acquired_at FROM scheduler_lock WHERE id = 1')
        .get() as { pid: number; acquired_at: string } | undefined
      if (row) {
        // Treat locks older than 2 hours as stale -- prevents indefinite blockage
        // from zombie sessions that died without releasing (seen in production: 9 failed
        // acquisitions after a session crashed and held the lock for 30+ hours).
        const lockedAt = new Date(row.acquired_at).getTime()
        if (Date.now() - lockedAt > TWO_HOURS_MS) {
          // stale lock — fall through to cleanup and re-acquire
          db().prepare('DELETE FROM scheduler_lock WHERE id = 1').run()
        } else {
          try {
            process.kill(row.pid, 0)
            return false
          } catch {
            // PID is dead — fall through and re-acquire
          }
        }
      }
      db()
        .prepare(`INSERT OR REPLACE INTO scheduler_lock (id, pid, acquired_at) VALUES (1, ?, ?)`)
        .run(pid, new Date().toISOString())
      return true
    })
    return doAcquire.immediate()
  } catch {
    return false
  }
}

export function releaseSchedulerLock(): void {
  try {
    db().prepare('DELETE FROM scheduler_lock WHERE pid = ?').run(process.pid)
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Pruning
// ---------------------------------------------------------------------------

export function pruneOldEvents(retentionDays = 90): number {
  try {
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString()
    const result = db().prepare(
      `DELETE FROM agent_events WHERE ts < ?`,
    ).run(cutoff)
    return result.changes
  } catch {
    return 0
  }
}

/** High-frequency internal poller routines whose routine_started/routine_delivered
 *  rows are operational heartbeats, not memory. They dominate agent_events
 *  (~67% of rows) and have no analytical value past a few days — the only
 *  consumer of old routine_started is "last-fired" seeding, which reads just the
 *  most recent row per routine (admin/server.ts, scheduler start). A short
 *  retention here keeps the table from growing unbounded while leaving the
 *  90-day blanket retention intact for meaningful events (agent_dispatch,
 *  goal_*, persona_violation, etc.). */
const HIGH_FREQUENCY_POLLER_ROUTINES = [
  'briefing_drain',
  'resolver_feedback_poll',
  'meeting_prep',
  'findings_dispatcher',
  'proactive_check',
  'comms_pulse',
  'briefing_watchdog',
] as const

export function pruneHighFrequencyEvents(retentionDays = 14): number {
  try {
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString()
    const placeholders = HIGH_FREQUENCY_POLLER_ROUTINES.map(() => '?').join(',')
    const result = db().prepare(
      `DELETE FROM agent_events
       WHERE event IN ('routine_started', 'routine_delivered')
         AND json_extract(detail, '$.routine') IN (${placeholders})
         AND ts < ?`,
    ).run(...HIGH_FREQUENCY_POLLER_ROUTINES, cutoff)
    return result.changes
  } catch {
    return 0
  }
}

/** Prune pending_memory rows older than ttlDays. Facts that haven't been written
 *  to ChromaDB in this window are stale context — the conversation is long past.
 *  The drain retries failed writes on every session; this is the only intentional
 *  deletion path for rows that never succeed. (#719) */
export function pruneStalePendingMemory(ttlDays = 30): number {
  try {
    const cutoff = new Date(Date.now() - ttlDays * 86_400_000).toISOString()
    const result = db().prepare(
      `DELETE FROM agent_events WHERE event = 'pending_memory' AND ts < ?`,
    ).run(cutoff)
    return result.changes
  } catch {
    return 0
  }
}

export function pruneOldMessages(keepDays = 90): number {
  try {
    const result = db().prepare(`DELETE FROM messages WHERE ts < datetime('now', '-' || ? || ' days')`).run(keepDays)
    return result.changes
  } catch (err) {
    log.warn('episodic: pruneOldMessages failed', { err: String(err) })
    return 0
  }
}

export function pruneOldGoalRuns(keepDays = 90): number {
  try {
    const result = db().prepare(`DELETE FROM goal_runs WHERE started_at < datetime('now', '-' || ? || ' days')`).run(keepDays)
    return result.changes
  } catch (err) {
    log.warn('episodic: pruneOldGoalRuns failed', { err: String(err) })
    return 0
  }
}
