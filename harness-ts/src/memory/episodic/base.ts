// Episodic logging via better-sqlite3.
// Writes to the same conversations.db as the Python harness, extending the
// messages table with an ion_session column (nullable, no Python breakage).
// Schema tables: messages, agent_events (same column names as episodic.py).

import Database from 'better-sqlite3'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdirSync } from 'node:fs'

// Sessions to exclude from substantive cross-session queries (automated/routine content only)
export const SUBSTANTIVE_EXCLUDED_SESSIONS = ['jarvis', 'default']

let _db: Database.Database | null = null

export function db(): Database.Database {
  if (!_db) {
    // Evaluate at call time so tests can override AGENT_DATA_DIR in beforeAll/beforeEach
    const dataDir = process.env['AGENT_DATA_DIR']
      ? process.env['AGENT_DATA_DIR'].replace('~', homedir())
      : join(homedir(), '.jarvis')
    const dbPath = join(dataDir, 'conversations.db')
    mkdirSync(dataDir, { recursive: true })
    _db = new Database(dbPath)
    _db.pragma('journal_mode = WAL')
    _db.pragma('foreign_keys = ON')
    initSchema(_db)
  }
  return _db
}

export function closeDb(): void {
  if (_db) {
    _db.close()
    _db = null
  }
}

function initSchema(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session     TEXT    NOT NULL,
      role        TEXT    NOT NULL,
      content     TEXT    NOT NULL,
      ts          TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session);
  `)

  // Add ion_session column if not present (migration-safe: Python ignores it).
  const cols = d.pragma('table_info(messages)') as Array<{ name: string }>
  if (!cols.some((c) => c.name === 'ion_session')) {
    d.exec(`ALTER TABLE messages ADD COLUMN ion_session TEXT`)
  }

  d.exec(`
    CREATE TABLE IF NOT EXISTS agent_events (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      session TEXT    NOT NULL,
      event   TEXT    NOT NULL,
      detail  TEXT,
      ts      TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_events_ses_evt_ts ON agent_events(session, event, ts);
  `)

  // actions mirrors Python's schema so TS can query it before the vec server starts.
  d.exec(`
    CREATE TABLE IF NOT EXISTS actions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      action        TEXT    NOT NULL,
      tier          TEXT    NOT NULL,
      payload       TEXT,
      state         TEXT    NOT NULL DEFAULT 'Proposed',
      rollback_data TEXT,
      ts            TEXT    NOT NULL
    );
  `)

  // goals and goal_runs mirror Python's schema exactly.
  d.exec(`
    CREATE TABLE IF NOT EXISTS goals (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      intent            TEXT    NOT NULL,
      cadence           TEXT    NOT NULL DEFAULT 'daily',
      owner_staff_id    TEXT    NOT NULL,
      status            TEXT    NOT NULL DEFAULT 'proposed',
      budget_tool_calls INTEGER NOT NULL DEFAULT 5,
      budget_minutes    INTEGER NOT NULL DEFAULT 30,
      last_run_at       TEXT,
      next_run_at       TEXT,
      created_at        TEXT    NOT NULL
    );
    CREATE TABLE IF NOT EXISTS goal_runs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      goal_id      INTEGER NOT NULL REFERENCES goals(id),
      started_at   TEXT    NOT NULL,
      completed_at TEXT,
      iterations   INTEGER NOT NULL DEFAULT 0,
      status       TEXT    NOT NULL DEFAULT 'running',
      result_text  TEXT,
      error        TEXT
    );
    CREATE TABLE IF NOT EXISTS external_actions_audit (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      goal_id      INTEGER NOT NULL REFERENCES goals(id),
      goal_run_id  INTEGER NOT NULL REFERENCES goal_runs(id),
      intent       TEXT    NOT NULL,
      result_text  TEXT,
      started_at   TEXT    NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_external_audit_goal_id
      ON external_actions_audit (goal_id, started_at);
  `)

  // Schema migrations — idempotent, column-already-exists is swallowed
  for (const ddl of [
    `ALTER TABLE goals ADD COLUMN goal_type TEXT NOT NULL DEFAULT 'write'`,
    // Consecutive-failure counter drives the auto-retry-with-cap policy: a blocked
    // goal retries at its next cadence until this hits MAX_GOAL_FAILURES, after
    // which it stays blocked until manually re-activated. Reset to 0 on success.
    `ALTER TABLE goals ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0`,
    `CREATE INDEX IF NOT EXISTS idx_messages_ion_session ON messages(ion_session)`,
    // Prevent duplicate concurrent goal_runs for the same goal. SQLite partial
    // unique indexes enforce this at the DB level, independent of in-memory guards.
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_goal_runs_one_running
       ON goal_runs (goal_id) WHERE status = 'running'`,
  ]) {
    try { d.exec(ddl) } catch { /* already exists */ }
  }

  d.exec(`
    CREATE TABLE IF NOT EXISTS reminders (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      user_text        TEXT    NOT NULL,
      fire_at          TEXT    NOT NULL,
      message          TEXT    NOT NULL,
      status           TEXT    NOT NULL DEFAULT 'pending',
      attempts         INTEGER NOT NULL DEFAULT 0,
      escalation_level INTEGER NOT NULL DEFAULT 0,
      escalation_cap   INTEGER NOT NULL DEFAULT 0,
      next_remind_at   TEXT,
      created_at       TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS reminders_fire_at ON reminders (fire_at, status);
  `)

  // Migration: add columns to existing reminders tables that pre-date them.
  {
    const reminderCols = d.pragma('table_info(reminders)') as Array<{ name: string }>
    const hasCol = (name: string) => reminderCols.some((c) => c.name === name)
    if (!hasCol('attempts')) {
      d.exec(`ALTER TABLE reminders ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0`)
    }
    // #542: escalating reminders. escalation_cap = 0 means one-shot (legacy
    // behavior); > 0 enables escalation up to that many re-fires.
    if (!hasCol('escalation_level')) {
      d.exec(`ALTER TABLE reminders ADD COLUMN escalation_level INTEGER NOT NULL DEFAULT 0`)
    }
    if (!hasCol('escalation_cap')) {
      d.exec(`ALTER TABLE reminders ADD COLUMN escalation_cap INTEGER NOT NULL DEFAULT 0`)
    }
    if (!hasCol('next_remind_at')) {
      d.exec(`ALTER TABLE reminders ADD COLUMN next_remind_at TEXT`)
    }
  }

  d.exec(`
    CREATE TABLE IF NOT EXISTS working_memory (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      content     TEXT    NOT NULL,
      written_by  TEXT    NOT NULL,
      written_at  TEXT    NOT NULL,
      expires_at  TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS working_memory_expires ON working_memory (expires_at);
  `)

  d.exec(`
    CREATE TABLE IF NOT EXISTS perf_metrics (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      phase       TEXT    NOT NULL,
      latency_ms  REAL    NOT NULL,
      session     TEXT    NOT NULL DEFAULT 'default',
      metadata    TEXT,
      created_at  TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS perf_metrics_phase ON perf_metrics (phase, created_at);
  `)

  d.exec(`
    CREATE TABLE IF NOT EXISTS processed_imessages (
      guid            TEXT PRIMARY KEY,
      rowid           INTEGER,
      sender          TEXT,
      processed_at    TEXT NOT NULL,
      triage_decision TEXT
    );
  `)

  d.exec(`
    CREATE TABLE IF NOT EXISTS conversation_summaries (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      granularity   TEXT    NOT NULL,
      period_start  TEXT    NOT NULL,
      period_end    TEXT    NOT NULL,
      summary       TEXT    NOT NULL,
      session_count INTEGER,
      message_count INTEGER,
      created_at    TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_conv_summaries_gran_ts
      ON conversation_summaries(granularity, created_at DESC);
  `)

  d.exec(`
    CREATE TABLE IF NOT EXISTS approvals (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      kind                  TEXT    NOT NULL,
      github_run_id         TEXT,
      github_issue_number   INTEGER,
      summary               TEXT    NOT NULL,
      files_changed         TEXT,
      diff_excerpt          TEXT,
      risk_tier             TEXT    NOT NULL,
      discord_message_id    TEXT,
      discord_local_index   INTEGER,
      requested_at          INTEGER NOT NULL,
      decided_at            INTEGER,
      decision              TEXT,
      decided_by            TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_approvals_pending ON approvals(decided_at) WHERE decided_at IS NULL;
  `)

  // Habit tracking (#546): structured data so the Wellness Coach can reference
  // completion rates ("workout 2 of 7 days, target 5/week") instead of guessing.
  d.exec(`
    CREATE TABLE IF NOT EXISTS habits (
      id              TEXT    PRIMARY KEY,
      name            TEXT    NOT NULL,
      category        TEXT,
      target_per_week INTEGER NOT NULL DEFAULT 1,
      active          INTEGER NOT NULL DEFAULT 1,
      created_at      TEXT    NOT NULL
    );
    CREATE TABLE IF NOT EXISTS habit_completions (
      id         TEXT    PRIMARY KEY,
      habit_id   TEXT    NOT NULL REFERENCES habits(id),
      logged_at  TEXT    NOT NULL,
      notes      TEXT,
      count      INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS habit_completions_habit ON habit_completions (habit_id, logged_at);
  `)
}

export function now(): string {
  return new Date().toISOString()
}

export function parseDetail(raw: string | null): unknown {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

export function chicagoStartOfDay(): Date {
  const now = new Date()
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'America/Chicago',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(now)
  const get = (type: string) =>
    parseInt(parts.find(p => p.type === type)?.value ?? '0', 10)
  const elapsedMs =
    (get('hour') * 3600 + get('minute') * 60 + get('second')) * 1000 +
    now.getMilliseconds()
  return new Date(now.getTime() - elapsedMs)
}

export interface EventRow {
  id: number
  session: string
  event: string
  detail: unknown
  ts: string
}

export type RawEventRow = { id: number; session: string; event: string; detail: string | null; ts: string }

export interface MessageRow {
  id: number
  session: string
  role: string
  content: string
  ts: string
}
