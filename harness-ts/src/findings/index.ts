// Findings queue — separate SQLite DB for staff-reported findings.
// Staff members call addFinding(); the dispatcher routine drains the queue
// and routes by criticality to phone push, storePendingBrief, or both.
//
// DB: ~/.jarvis/findings.db (NOT conversations.db — separate file for
// clean querying without touching the episodic schema).

import Database from 'better-sqlite3'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdirSync } from 'node:fs'
import { log } from 'ion-sdk'

const DATA_DIR = process.env['AGENT_DATA_DIR']
  ? process.env['AGENT_DATA_DIR'].replace('~', homedir())
  : join(homedir(), '.jarvis')
const DB_PATH = join(DATA_DIR, 'findings.db')

let _db: Database.Database | null = null

function db(): Database.Database {
  if (!_db) {
    mkdirSync(DATA_DIR, { recursive: true })
    _db = new Database(DB_PATH)
    _db.pragma('journal_mode = WAL')
    _db.pragma('foreign_keys = ON')
    initSchema(_db)
  }
  return _db
}

function initSchema(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS findings (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      source       TEXT    NOT NULL,
      content      TEXT    NOT NULL,
      criticality  TEXT    NOT NULL,
      processed    INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT    NOT NULL,
      processed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS findings_pending ON findings (processed, criticality, created_at);
  `)

  // Schema migrations for Kanban claim fields (idempotent)
  for (const ddl of [
    `ALTER TABLE findings ADD COLUMN claim_id TEXT`,
    `ALTER TABLE findings ADD COLUMN claim_at TEXT`,
    `ALTER TABLE findings ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE findings ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0`,
  ]) {
    try { d.exec(ddl) } catch { /* column already exists */ }
  }
}

function now(): string {
  return new Date().toISOString()
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type Criticality = 'critical' | 'important' | 'informational'

export interface FindingRow {
  id: number
  source: string
  content: string
  criticality: Criticality
  processed: number
  created_at: string
  processed_at: string | null
  claim_id: string | null
  claim_at: string | null
  attempt_count: number
  blocked: number
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function addFinding(
  source: string,
  content: string,
  criticality: Criticality,
): void {
  try {
    db().prepare(
      `INSERT INTO findings (source, content, criticality, processed, created_at)
       VALUES (?, ?, ?, 0, ?)`,
    ).run(source, content, criticality, now())
  } catch (err) {
    log.warn('findings: addFinding failed', { source, criticality, err: String(err) })
  }
}

/**
 * Returns all unprocessed findings ordered by criticality descending
 * (critical first), then created_at ascending (oldest first within a tier).
 */
export function pendingFindings(): FindingRow[] {
  try {
    return db().prepare(
      `SELECT id, source, content, criticality, processed, created_at, processed_at,
              claim_id, claim_at, attempt_count, blocked
       FROM findings
       WHERE processed = 0 AND blocked = 0 AND claim_id IS NULL
       ORDER BY
         CASE criticality
           WHEN 'critical'      THEN 0
           WHEN 'important'     THEN 1
           WHEN 'informational' THEN 2
           ELSE 3
         END ASC,
         created_at ASC`,
    ).all() as FindingRow[]
  } catch (err) {
    log.warn('findings: pendingFindings failed', { err: String(err) })
    return []
  }
}

export function markProcessed(id: number): void {
  try {
    db().prepare(
      `UPDATE findings SET processed = 1, processed_at = ? WHERE id = ?`,
    ).run(now(), id)
  } catch (err) {
    log.warn('findings: markProcessed failed', { id, err: String(err) })
  }
}

/** Delete all findings older than 7 days regardless of processed state. */
export function purgeOldFindings(): void {
  try {
    const cutoff = new Date(Date.now() - 7 * 86_400_000).toISOString()
    db().prepare(`DELETE FROM findings WHERE created_at < ?`).run(cutoff)
  } catch (err) {
    log.warn('findings: purgeOldFindings failed', { err: String(err) })
  }
}

/**
 * Atomically claim a finding for processing. Returns true if claimed, false if
 * another caller already holds the claim.
 */
export function atomicClaim(id: number): boolean {
  try {
    const claimId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const result = db().prepare(
      `UPDATE findings SET claim_id = ?, claim_at = ? WHERE id = ? AND claim_id IS NULL AND processed = 0`,
    ).run(claimId, now(), id)
    return (result.changes ?? 0) > 0
  } catch (err) {
    log.warn('findings: atomicClaim failed', { id, err: String(err) })
    return false
  }
}

/**
 * Reclaim stale claims older than 5 minutes. Call at the start of each
 * dispatcher run to recover from a previous crashed run.
 */
export function reclaimStale(): number {
  try {
    const cutoff = new Date(Date.now() - 5 * 60_000).toISOString()
    const result = db().prepare(
      `UPDATE findings SET claim_id = NULL, claim_at = NULL
       WHERE claim_at < ? AND processed = 0 AND blocked = 0`,
    ).run(cutoff)
    return result.changes ?? 0
  } catch (err) {
    log.warn('findings: reclaimStale failed', { err: String(err) })
    return 0
  }
}

/**
 * Increment attempt count and auto-block after 3 or more failed attempts.
 * Clears the claim so the finding re-enters the queue (or gets blocked).
 * Returns true if the finding was blocked.
 */
export function recordFailedAttempt(id: number): boolean {
  try {
    db().prepare(
      `UPDATE findings SET attempt_count = attempt_count + 1, claim_id = NULL, claim_at = NULL WHERE id = ?`,
    ).run(id)
    const row = db().prepare(
      `SELECT attempt_count FROM findings WHERE id = ?`,
    ).get(id) as { attempt_count: number } | undefined
    if ((row?.attempt_count ?? 0) >= 3) {
      db().prepare(`UPDATE findings SET blocked = 1 WHERE id = ?`).run(id)
      return true
    }
    return false
  } catch (err) {
    log.warn('findings: recordFailedAttempt failed', { id, err: String(err) })
    return false
  }
}
