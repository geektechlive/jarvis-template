import { log } from 'ion-sdk'
import { db, chicagoStartOfDay } from './base'

// A goal that fails this many times in a row stops auto-retrying and stays
// 'blocked' until manually re-activated. Prevents a genuinely broken goal from
// retrying forever and re-spamming notifications. Reset to 0 on any success.
export const MAX_GOAL_FAILURES = 3

export function pendingActions(): Array<Record<string, unknown>> {
  try {
    const stmt = db().prepare(
      `SELECT id, action, tier, payload, state, ts
       FROM actions WHERE state = 'Proposed' ORDER BY id ASC`,
    )
    return stmt.all() as Array<Record<string, unknown>>
  } catch (err) {
    log.warn('episodic: pendingActions failed — actions table may not exist yet', { err: String(err) })
    return []
  }
}

// Update an action's state in the Python-owned actions table.
// The Python schema uses column 'state' with values: Approved, Rejected, Executed, RolledBack.
// Guards on state = 'Proposed' so double-approving the same action is a no-op (issue #476).
export function updateActionState(actionId: number, state: 'Approved' | 'Rejected'): boolean {
  try {
    const result = db().prepare(
      `UPDATE actions SET state = ? WHERE id = ? AND state = 'Proposed'`,
    ).run(state, actionId)
    return (result.changes) > 0
  } catch (err) {
    log.warn('episodic: updateActionState failed', { actionId, state, err: String(err) })
    return false
  }
}

/**
 * Atomically approve a goal_proposal action and create the goal in a single
 * SQLite transaction (issue #477). If insertGoal throws, the state update is
 * rolled back and the action stays in 'Proposed' so a retry can re-run.
 *
 * Returns { changed: false } when the action is not in Proposed state (no-op).
 * Returns { changed: true, goalId } on success.
 * Throws on unexpected errors so the caller can surface them.
 */
export function approveGoalProposalAtomic(
  actionId: number,
  intent: string,
  cadence: string,
  ownerStaffId: string,
  budgetToolCalls: number,
  budgetMinutes: number,
): { changed: boolean; goalId: number | null } {
  return db().transaction((): { changed: boolean; goalId: number | null } => {
    const result = db().prepare(
      `UPDATE actions SET state = 'Approved' WHERE id = ? AND state = 'Proposed'`,
    ).run(actionId)
    if ((result.changes) === 0) {
      return { changed: false, goalId: null }
    }
    const goalNow = new Date().toISOString()
    const goalResult = db().prepare(`
      INSERT INTO goals (intent, cadence, owner_staff_id, status, budget_tool_calls, budget_minutes, created_at)
      VALUES (?, ?, ?, 'active', ?, ?, ?)
    `).run(intent, cadence, ownerStaffId, budgetToolCalls, budgetMinutes, goalNow)
    return { changed: true, goalId: Number(goalResult.lastInsertRowid) }
  })()
}

/** Insert a new action in Proposed state, return its auto-incremented id. */
export function insertAction(action: string, tier: string, payload?: string): number {
  const result = db().prepare(
    `INSERT INTO actions (action, tier, payload, state, ts) VALUES (?, ?, ?, 'Proposed', ?)`,
  ).run(action, tier, payload ?? null, new Date().toISOString())
  return result.lastInsertRowid as number
}

/** Retrieve a single action row by id. Returns null if not found. */
export function getActionById(id: number): Record<string, unknown> | null {
  try {
    const row = db().prepare(
      `SELECT id, action, tier, payload, state, ts FROM actions WHERE id = ?`,
    ).get(id)
    return (row as Record<string, unknown>) ?? null
  } catch {
    return null
  }
}

export interface GoalRow {
  id: number
  intent: string
  cadence: string
  owner_staff_id: string
  status: string
  goal_type: string
  budget_tool_calls: number
  budget_minutes: number
  last_run_at: string | null
  next_run_at: string | null
  created_at: string
}

export function activeGoalCount(): number {
  try {
    const row = db().prepare(`SELECT COUNT(*) as cnt FROM goals WHERE status = 'active'`).get() as { cnt: number } | undefined
    return row?.cnt ?? 0
  } catch {
    return 0
  }
}

export function listActiveGoalIntents(): string[] {
  try {
    return (db().prepare(`SELECT intent FROM goals WHERE status = 'active'`).all() as { intent: string }[])
      .map((r) => r.intent.toLowerCase())
  } catch {
    return []
  }
}

export function insertGoal(intent: string, cadence: string, ownerStaffId: string, budgetToolCalls: number, budgetMinutes: number): number {
  const now = new Date().toISOString()
  const result = db().prepare(`
    INSERT INTO goals (intent, cadence, owner_staff_id, status, budget_tool_calls, budget_minutes, created_at)
    VALUES (?, ?, ?, 'active', ?, ?, ?)
  `).run(intent, cadence, ownerStaffId, budgetToolCalls, budgetMinutes, now)
  return Number(result.lastInsertRowid)
}

export function goalsDueNow(): GoalRow[] {
  const nowIso = new Date().toISOString()
  const stmt = db().prepare(
    // Exclude goals that already have a running goal_run row so that a DB-level
    // check prevents re-queuing even if the in-memory _goalInFlight guard is bypassed
    // (e.g. direct calls from tests, future multi-process scenarios).
    `SELECT g.id, g.intent, g.cadence, g.owner_staff_id, g.status, g.goal_type,
            g.budget_tool_calls, g.budget_minutes, g.last_run_at, g.next_run_at, g.created_at
     FROM goals g
     WHERE g.status IN ('active', 'blocked')
       AND (g.next_run_at IS NULL OR g.next_run_at <= ?)
       AND g.consecutive_failures < ?
       AND NOT EXISTS (
         SELECT 1 FROM goal_runs r
         WHERE r.goal_id = g.id AND r.status = 'running'
       )
     ORDER BY g.id ASC`,
  )
  return stmt.all(nowIso, MAX_GOAL_FAILURES) as GoalRow[]
}

export function goalRunsToday(): number {
  const cutoff = chicagoStartOfDay().toISOString()
  const stmt = db().prepare(`SELECT COUNT(*) as n FROM goal_runs WHERE started_at >= ?`)
  const row = stmt.get(cutoff) as { n: number }
  return row.n
}

export function logGoalRun(goalId: number): number {
  const stmt = db().prepare(
    `INSERT INTO goal_runs (goal_id, started_at, status) VALUES (?, ?, 'running')`,
  )
  return stmt.run(goalId, new Date().toISOString()).lastInsertRowid as number
}

export function updateGoalRun(
  runId: number,
  status: string,
  iterations = 0,
  resultText?: string,
  error?: string,
): void {
  db().prepare(
    `UPDATE goal_runs SET status=?, iterations=?, result_text=?, error=?, completed_at=? WHERE id=?`,
  ).run(status, iterations, resultText ?? null, error ?? null, new Date().toISOString(), runId)
}

export interface ExternalAuditRow {
  id: number
  goal_id: number
  goal_run_id: number
  intent: string
  result_text: string | null
  started_at: string
  completed_at: string | null
}

export function logExternalAudit(
  goalId: number,
  goalRunId: number,
  intent: string,
  startedAt: string,
): number {
  const result = db().prepare(
    `INSERT INTO external_actions_audit (goal_id, goal_run_id, intent, started_at)
     VALUES (?, ?, ?, ?)`,
  ).run(goalId, goalRunId, intent, startedAt)
  return result.lastInsertRowid as number
}

export function updateExternalAudit(
  auditId: number,
  resultText: string,
  completedAt: string,
): void {
  db().prepare(
    `UPDATE external_actions_audit SET result_text = ?, completed_at = ? WHERE id = ?`,
  ).run(resultText, completedAt, auditId)
}

export function recentExternalAudit(limit = 10): ExternalAuditRow[] {
  return db().prepare(
    `SELECT id, goal_id, goal_run_id, intent, result_text, started_at, completed_at
     FROM external_actions_audit
     ORDER BY id DESC LIMIT ?`,
  ).all(limit) as ExternalAuditRow[]
}

export function updateGoal(
  goalId: number,
  fields: Partial<Pick<GoalRow, 'status' | 'goal_type' | 'last_run_at' | 'next_run_at'>>,
): void {
  const allowed = ['status', 'goal_type', 'last_run_at', 'next_run_at'] as const
  const entries = (Object.keys(fields) as Array<typeof allowed[number]>)
    .filter((k) => allowed.includes(k))
    .map((k) => [k, fields[k]] as const)
  if (!entries.length) return
  const set = entries.map(([k]) => `${k} = ?`).join(', ')
  const values = [...entries.map(([, v]) => v ?? null), goalId]
  db().prepare(`UPDATE goals SET ${set} WHERE id = ?`).run(...values)
}

/**
 * Record a failed goal run: increment the consecutive-failure counter, mark the
 * goal 'blocked', and stamp last_run_at + next_run_at (cadence backoff). Returns
 * the new failure count so the caller can tell whether the cap has been hit.
 * Once the count reaches MAX_GOAL_FAILURES, goalsDueNow() stops selecting it.
 */
export function markGoalFailed(goalId: number, nextRunAtIso: string | null): number {
  const now = new Date().toISOString()
  db().prepare(
    `UPDATE goals
       SET consecutive_failures = consecutive_failures + 1,
           status = 'blocked',
           last_run_at = ?,
           next_run_at = ?
     WHERE id = ?`,
  ).run(now, nextRunAtIso, goalId)
  const row = db().prepare(`SELECT consecutive_failures AS n FROM goals WHERE id = ?`).get(goalId) as { n: number } | undefined
  return row?.n ?? 0
}

/**
 * Record a successful goal run: reset the failure counter and re-activate the
 * goal (a goal that had been auto-retrying out of 'blocked' returns to 'active'),
 * stamping last_run_at + next_run_at for the next cadence.
 */
export function markGoalSucceeded(goalId: number, nextRunAtIso: string | null): void {
  const now = new Date().toISOString()
  db().prepare(
    `UPDATE goals
       SET consecutive_failures = 0,
           status = 'active',
           last_run_at = ?,
           next_run_at = ?
     WHERE id = ?`,
  ).run(now, nextRunAtIso, goalId)
}

/**
 * Manually un-park a goal. markGoalFailed() blocks a goal and increments its
 * failure streak; once consecutive_failures reaches MAX_GOAL_FAILURES,
 * goalsDueNow() stops selecting it and it stays blocked until a *successful* run
 * resets it (markGoalSucceeded) -- which can never happen because it is no longer
 * scheduled. This is the only recovery path that does not require manual SQL:
 * reset status='active' and the failure counter so goalsDueNow() picks it up
 * again. Returns false if the id does not exist.
 */
export function reactivateGoal(goalId: number): boolean {
  const info = db().prepare(
    `UPDATE goals SET status = 'active', consecutive_failures = 0 WHERE id = ?`,
  ).run(goalId)
  return info.changes > 0
}

export function listGoals(status?: string): GoalRow[] {
  const stmt = status
    ? db().prepare(
        `SELECT id, intent, cadence, owner_staff_id, status, goal_type, budget_tool_calls,
                budget_minutes, last_run_at, next_run_at, created_at
         FROM goals WHERE status = ? ORDER BY id ASC`,
      )
    : db().prepare(
        `SELECT id, intent, cadence, owner_staff_id, status, goal_type, budget_tool_calls,
                budget_minutes, last_run_at, next_run_at, created_at
         FROM goals ORDER BY id ASC`,
      )
  return (status ? stmt.all(status) : stmt.all()) as GoalRow[]
}

export function getActiveGoalIds(): string[] {
  try {
    const stmt = db().prepare(`SELECT id FROM goals WHERE status = 'active' ORDER BY id ASC`)
    const rows = stmt.all() as Array<{ id: number }>
    return rows.map((r) => String(r.id))
  } catch {
    return []
  }
}
