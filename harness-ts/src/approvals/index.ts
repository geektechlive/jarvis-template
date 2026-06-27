// Approval state machine for the Jarvis CI/CD Discord loop.
// All DB access routes through the shared episodic SQLite connection.
// Schema is created in harness-ts/src/memory/episodic.ts initSchema().

import { db } from '../memory/episodic'

export type ApprovalKind = 'resolver' | 'improve' | 'desktop_deploy' | 'ios_deploy'
export type RiskTier = 'safe' | 'risky'
export type ApprovalDecision = 'approved' | 'denied' | 'expired'

export interface Approval {
  id: number
  kind: ApprovalKind
  github_run_id: string | null
  github_issue_number: number | null
  summary: string
  files_changed: string[] | null
  diff_excerpt: string | null
  risk_tier: RiskTier
  discord_message_id: string | null
  discord_local_index: number | null
  requested_at: number
  decided_at: number | null
  decision: ApprovalDecision | null
  decided_by: string | null
}

export interface CreateApprovalOpts {
  kind: ApprovalKind
  github_run_id?: string
  github_issue_number?: number
  summary: string
  files_changed?: string[]
  diff_excerpt?: string
  risk_tier: RiskTier
}

// ---------------------------------------------------------------------------
// Raw DB row type (all values come back as SQLite primitives).
// ---------------------------------------------------------------------------

type ApprovalRow = {
  id: number
  kind: string
  github_run_id: string | null
  github_issue_number: number | null
  summary: string
  files_changed: string | null
  diff_excerpt: string | null
  risk_tier: string
  discord_message_id: string | null
  discord_local_index: number | null
  requested_at: number
  decided_at: number | null
  decision: string | null
  decided_by: string | null
}

function rowToApproval(row: ApprovalRow): Approval {
  let files_changed: string[] | null = null
  if (row.files_changed) {
    try {
      files_changed = JSON.parse(row.files_changed) as string[]
    } catch {
      files_changed = null
    }
  }
  return {
    id: row.id,
    kind: row.kind as ApprovalKind,
    github_run_id: row.github_run_id,
    github_issue_number: row.github_issue_number,
    summary: row.summary,
    files_changed,
    diff_excerpt: row.diff_excerpt,
    risk_tier: row.risk_tier as RiskTier,
    discord_message_id: row.discord_message_id,
    discord_local_index: row.discord_local_index,
    requested_at: row.requested_at,
    decided_at: row.decided_at,
    decision: (row.decision ?? null) as ApprovalDecision | null,
    decided_by: row.decided_by,
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Insert a new approval, returning its auto-incremented id. */
export function createApproval(opts: CreateApprovalOpts): number {
  const stmt = db().prepare(`
    INSERT INTO approvals (kind, github_run_id, github_issue_number, summary, files_changed, diff_excerpt, risk_tier, requested_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const result = stmt.run(
    opts.kind,
    opts.github_run_id ?? null,
    opts.github_issue_number ?? null,
    opts.summary,
    opts.files_changed != null ? JSON.stringify(opts.files_changed) : null,
    opts.diff_excerpt ?? null,
    opts.risk_tier,
    Date.now(),
  )
  return result.lastInsertRowid as number
}

/** Return all pending approvals (decided_at IS NULL), oldest first. */
export function getPending(): Approval[] {
  const rows = db()
    .prepare(`SELECT * FROM approvals WHERE decided_at IS NULL ORDER BY requested_at ASC`)
    .all() as ApprovalRow[]
  return rows.map(rowToApproval)
}

/** Record a decision on an approval. Throws if already decided. */
export function decide(id: number, decision: ApprovalDecision, byUserId: string): void {
  const existing = db()
    .prepare(`SELECT decided_at FROM approvals WHERE id = ?`)
    .get(id) as { decided_at: number | null } | undefined

  if (!existing) throw new Error(`Approval ${id} not found`)
  if (existing.decided_at !== null) throw new Error(`Approval ${id} already decided`)

  db().prepare(`
    UPDATE approvals SET decision = ?, decided_by = ?, decided_at = ? WHERE id = ?
  `).run(decision, byUserId, Date.now(), id)
}

export interface ExpireResult {
  /** Total approvals expired across all kinds. */
  expiredCount: number
  /** Ids of expired `resolver`-kind approvals, so callers can delete their branches. */
  expiredResolverIds: number[]
}

/**
 * Expire pending approvals past their per-kind window.
 *
 * `resolver` and `improve` are human-gated and stage non-regenerating work as an
 * `auto/resolver-*` / `auto/improve-*` branch, so both get the longer `gatedHoursAgo`
 * window; every other kind uses `defaultHoursAgo`. Returns the total expired plus the
 * ids of expired `resolver` approvals — the caller deletes their orphaned branches.
 * (improve branches survive expiry, so nothing to clean up.)
 */
export function expireOlderThan(
  defaultHoursAgo: number,
  gatedHoursAgo: number = defaultHoursAgo,
): ExpireResult {
  const now = Date.now()
  const defaultCutoff = now - defaultHoursAgo * 3_600_000
  const gatedCutoff = now - gatedHoursAgo * 3_600_000

  // Capture resolver ids BEFORE the UPDATE so callers can clean up their stashes.
  const resolverRows = db()
    .prepare(`
      SELECT id FROM approvals
      WHERE decided_at IS NULL AND kind = 'resolver' AND requested_at <= ?
    `)
    .all(gatedCutoff) as { id: number }[]
  const expiredResolverIds = resolverRows.map(r => r.id)

  const run = db().transaction(() => {
    const gatedResult = db().prepare(`
      UPDATE approvals
      SET decision = 'expired', decided_at = ?
      WHERE decided_at IS NULL AND kind IN ('resolver', 'improve') AND requested_at <= ?
    `).run(now, gatedCutoff)
    const otherResult = db().prepare(`
      UPDATE approvals
      SET decision = 'expired', decided_at = ?
      WHERE decided_at IS NULL AND kind NOT IN ('resolver', 'improve') AND requested_at <= ?
    `).run(now, defaultCutoff)
    return gatedResult.changes + otherResult.changes
  })

  return { expiredCount: run(), expiredResolverIds }
}

/**
 * After posting a digest, bind the Discord message ID and per-approval local index.
 * indexMap maps approval_id → 1-based local index within the digest message.
 */
export function bindDigest(
  approvalIds: number[],
  messageId: string,
  indexMap: Record<number, number>,
): void {
  const update = db().prepare(`
    UPDATE approvals SET discord_message_id = ?, discord_local_index = ? WHERE id = ?
  `)
  const transaction = db().transaction(() => {
    for (const id of approvalIds) {
      const localIndex = indexMap[id]
      if (localIndex !== undefined) {
        update.run(messageId, localIndex, id)
      }
    }
  })
  transaction()
}

/** Get an approval by id. Returns null if not found. */
export function getById(id: number): Approval | null {
  const row = db()
    .prepare(`SELECT * FROM approvals WHERE id = ?`)
    .get(id) as ApprovalRow | undefined
  return row ? rowToApproval(row) : null
}

/**
 * Find a pending approval by its local index within the most recent digest message.
 * Returns null if not found or already decided.
 */
export function findByLocalIndex(localIndex: number): Approval | null {
  const row = db().prepare(`
    SELECT * FROM approvals
    WHERE discord_local_index = ? AND decided_at IS NULL
    ORDER BY requested_at DESC
    LIMIT 1
  `).get(localIndex) as ApprovalRow | undefined
  return row ? rowToApproval(row) : null
}

/**
 * Find a pending approval by GitHub issue number.
 * Returns null if not found or already decided.
 */
export function findByIssueNumber(issueNumber: number): Approval | null {
  const row = db().prepare(`
    SELECT * FROM approvals
    WHERE github_issue_number = ? AND decided_at IS NULL
    ORDER BY requested_at DESC
    LIMIT 1
  `).get(issueNumber) as ApprovalRow | undefined
  return row ? rowToApproval(row) : null
}

/**
 * Get a pending approval by GitHub issue number.
 * Returns null if not found or already decided.
 */
export function getPendingByIssueNumber(issueNumber: number): Approval | null {
  return findByIssueNumber(issueNumber)
}

/**
 * Find the most recent pending approval by github_run_id.
 * For improve approvals, github_run_id stores the branch name.
 * Returns null if not found or already decided.
 */
export function findByRunId(runId: string): Approval | null {
  const row = db().prepare(`
    SELECT * FROM approvals
    WHERE github_run_id = ? AND decided_at IS NULL
    ORDER BY requested_at DESC
    LIMIT 1
  `).get(runId) as ApprovalRow | undefined
  return row ? rowToApproval(row) : null
}
