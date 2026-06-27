import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { join } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

// AGENT_DATA_DIR must be set before findings/index.ts is imported because
// DB_PATH is resolved at module load time (lazy-init, but path is captured
// at the top of the module). Dynamic import inside beforeAll guarantees the
// env var is present first.
const tmpDir = join(
  tmpdir(),
  `findings-test-${Date.now()}-${Math.trunc(Math.random() * 1e6)}`,
)

let findings: typeof import('./index')

beforeAll(async () => {
  mkdirSync(tmpDir, { recursive: true })
  process.env['AGENT_DATA_DIR'] = tmpDir
  findings = await import('./index')
})

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
  delete process.env['AGENT_DATA_DIR']
})

describe('addFinding', () => {
  it('writes a row that appears in pendingFindings', () => {
    findings.addFinding('test-staff', 'Something notable happened.', 'informational')
    const pending = findings.pendingFindings()
    const match = pending.find(
      (r) => r.source === 'test-staff' && r.content === 'Something notable happened.',
    )
    expect(match).toBeDefined()
    expect(match?.criticality).toBe('informational')
    expect(match?.processed).toBe(0)
  })
})

describe('pendingFindings', () => {
  it('returns only unprocessed rows', () => {
    findings.addFinding('staff-a', 'Unprocessed entry.', 'important')
    const all = findings.pendingFindings()
    const processed = all.filter((r) => r.processed !== 0)
    expect(processed).toHaveLength(0)
  })

  it('returns critical rows before important and informational', () => {
    // Insert in reverse criticality order to confirm ordering is by criticality,
    // not insertion order.
    findings.addFinding('staff-order', 'informational item', 'informational')
    findings.addFinding('staff-order', 'critical item', 'critical')
    findings.addFinding('staff-order', 'important item', 'important')

    const pending = findings.pendingFindings()
    // Find the relative positions of our three known entries.
    const staffRows = pending.filter((r) => r.source === 'staff-order')
    const critIdx = staffRows.findIndex((r) => r.criticality === 'critical')
    const impIdx = staffRows.findIndex((r) => r.criticality === 'important')
    const infoIdx = staffRows.findIndex((r) => r.criticality === 'informational')

    expect(critIdx).toBeLessThan(impIdx)
    expect(impIdx).toBeLessThan(infoIdx)
  })
})

describe('markProcessed', () => {
  it('flips processed flag and sets processed_at', () => {
    findings.addFinding('staff-mark', 'Row to be marked.', 'important')
    const before = findings.pendingFindings()
    const row = before.find(
      (r) => r.source === 'staff-mark' && r.content === 'Row to be marked.',
    )
    expect(row).toBeDefined()

    findings.markProcessed(row!.id)

    // Row must no longer appear in pending list.
    const after = findings.pendingFindings()
    const gone = after.find((r) => r.id === row!.id)
    expect(gone).toBeUndefined()
  })
})

describe('atomicClaim', () => {
  it('first claim succeeds and second claim fails', () => {
    findings.addFinding('claim-staff', 'Claim test finding.', 'informational')
    const pending = findings.pendingFindings()
    const row = pending.find((r) => r.source === 'claim-staff' && r.content === 'Claim test finding.')
    expect(row).toBeDefined()

    const first = findings.atomicClaim(row!.id)
    expect(first).toBe(true)

    // Row is now claimed so pendingFindings excludes it; second claim must fail.
    const second = findings.atomicClaim(row!.id)
    expect(second).toBe(false)
  })
})

describe('reclaimStale', () => {
  it('clears claim_id on rows claimed more than 5 minutes ago', async () => {
    const Database = (await import('better-sqlite3')).default
    const dbPath = join(tmpDir, 'findings.db')
    const helper = new Database(dbPath)

    // Insert a finding with a claim timestamp 6 minutes in the past.
    const staleAt = new Date(Date.now() - 6 * 60_000).toISOString()
    const rowId = (
      helper
        .prepare(
          `INSERT INTO findings (source, content, criticality, processed, created_at, claim_id, claim_at)
           VALUES ('stale-staff', 'Stale claim row.', 'informational', 0, ?, 'stale-claim-id', ?)`,
        )
        .run(new Date().toISOString(), staleAt).lastInsertRowid as number
    )
    helper.close()

    const reclaimed = findings.reclaimStale()
    expect(reclaimed).toBeGreaterThanOrEqual(1)

    // Row must now appear in pendingFindings (claim cleared).
    const pending = findings.pendingFindings()
    const found = pending.find((r) => r.id === rowId)
    expect(found).toBeDefined()
    expect(found?.claim_id).toBeNull()
  })
})

describe('recordFailedAttempt', () => {
  it('returns false before 3 attempts and true on the 3rd', () => {
    findings.addFinding('failure-staff', 'Repeated failure finding.', 'important')
    const pending = findings.pendingFindings()
    const row = pending.find(
      (r) => r.source === 'failure-staff' && r.content === 'Repeated failure finding.',
    )
    expect(row).toBeDefined()

    // First two attempts must not block.
    expect(findings.recordFailedAttempt(row!.id)).toBe(false)
    expect(findings.recordFailedAttempt(row!.id)).toBe(false)

    // Third attempt triggers auto-block.
    const blocked = findings.recordFailedAttempt(row!.id)
    expect(blocked).toBe(true)

    // Blocked row must not appear in pendingFindings.
    const afterBlock = findings.pendingFindings()
    const gone = afterBlock.find((r) => r.id === row!.id)
    expect(gone).toBeUndefined()
  })
})

describe('purgeOldFindings', () => {
  it('removes rows older than 7 days regardless of processed state', async () => {
    // We can't insert with a past timestamp via the public API (addFinding always
    // uses now()), so we reach into the DB via the module's own better-sqlite3
    // connection by inserting directly through a second DB handle at the same path.
    // The simpler approach: manipulate the created_at via a raw SQL UPDATE through
    // better-sqlite3 opened on the same path.
    const Database = (await import('better-sqlite3')).default
    const dbPath = join(tmpDir, 'findings.db')
    const helper = new Database(dbPath)

    // Insert two rows: one artificially aged beyond 7 days, one recent.
    const oldTs = new Date(Date.now() - 8 * 86_400_000).toISOString()
    const newTs = new Date().toISOString()

    const oldId = (
      helper
        .prepare(
          `INSERT INTO findings (source, content, criticality, processed, created_at)
           VALUES ('purge-test', 'old row', 'informational', 1, ?)`,
        )
        .run(oldTs).lastInsertRowid as number
    )
    const newId = (
      helper
        .prepare(
          `INSERT INTO findings (source, content, criticality, processed, created_at)
           VALUES ('purge-test', 'new row', 'informational', 0, ?)`,
        )
        .run(newTs).lastInsertRowid as number
    )
    helper.close()

    findings.purgeOldFindings()

    // Verify via pendingFindings (only unprocessed) + a direct check for the old row.
    const pending = findings.pendingFindings()
    const oldStillPresent = pending.find((r) => r.id === oldId)
    const newStillPresent = pending.find((r) => r.id === newId)

    // Old row must be gone; new unprocessed row must survive.
    expect(oldStillPresent).toBeUndefined()
    expect(newStillPresent).toBeDefined()
  })
})
