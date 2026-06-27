import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { join } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

// AGENT_DATA_DIR must be set before the approvals module is imported because
// DB_PATH is resolved at module load time. Use dynamic import in beforeAll.
const tmpDir = join(tmpdir(), `approvals-test-${Date.now()}-${Math.trunc(Math.random() * 1e6)}`)

let approvals: typeof import('./index')

beforeAll(async () => {
  mkdirSync(tmpDir, { recursive: true })
  process.env['AGENT_DATA_DIR'] = tmpDir
  approvals = await import('./index')
})

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
  delete process.env['AGENT_DATA_DIR']
})

// Reset between tests by expiring all and creating fresh ones as needed.
beforeEach(() => {
  // Expire anything pending so tests start clean.
  approvals.expireOlderThan(0)
})

describe('createApproval', () => {
  it('inserts and returns a positive integer id', () => {
    const id = approvals.createApproval({
      kind: 'resolver',
      summary: 'fix: test change',
      risk_tier: 'safe',
    })
    expect(id).toBeGreaterThan(0)
  })

  it('stores optional fields correctly', () => {
    const id = approvals.createApproval({
      kind: 'ios_deploy',
      github_run_id: 'run-abc',
      github_issue_number: 123,
      summary: 'feat: ios build',
      files_changed: ['ios/App.swift', 'ios/Info.plist'],
      diff_excerpt: '- old\n+ new',
      risk_tier: 'risky',
    })
    const row = approvals.getById(id)
    expect(row).not.toBeNull()
    expect(row?.kind).toBe('ios_deploy')
    expect(row?.github_run_id).toBe('run-abc')
    expect(row?.github_issue_number).toBe(123)
    expect(row?.files_changed).toEqual(['ios/App.swift', 'ios/Info.plist'])
    expect(row?.diff_excerpt).toBe('- old\n+ new')
    expect(row?.risk_tier).toBe('risky')
    expect(row?.decision).toBeNull()
    expect(row?.decided_at).toBeNull()
  })
})

describe('getPending', () => {
  it('returns only undecided approvals', () => {
    const id1 = approvals.createApproval({ kind: 'resolver', summary: 'one', risk_tier: 'safe' })
    const id2 = approvals.createApproval({ kind: 'improve', summary: 'two', risk_tier: 'safe' })
    approvals.decide(id1, 'approved', 'user-1')

    const pending = approvals.getPending()
    const ids = pending.map((a) => a.id)
    expect(ids).not.toContain(id1)
    expect(ids).toContain(id2)
  })

  it('returns items ordered oldest first', () => {
    const id1 = approvals.createApproval({ kind: 'resolver', summary: 'first', risk_tier: 'safe' })
    const id2 = approvals.createApproval({ kind: 'resolver', summary: 'second', risk_tier: 'safe' })
    const pending = approvals.getPending()
    const ids = pending.map((a) => a.id)
    expect(ids.indexOf(id1)).toBeLessThan(ids.indexOf(id2))
  })
})

describe('decide', () => {
  it('records approved decision with userId and timestamp', () => {
    const id = approvals.createApproval({ kind: 'resolver', summary: 'test', risk_tier: 'safe' })
    approvals.decide(id, 'approved', 'discord-user-42')
    const row = approvals.getById(id)
    expect(row?.decision).toBe('approved')
    expect(row?.decided_by).toBe('discord-user-42')
    expect(row?.decided_at).toBeGreaterThan(0)
  })

  it('records denied decision', () => {
    const id = approvals.createApproval({ kind: 'improve', summary: 'test', risk_tier: 'risky' })
    approvals.decide(id, 'denied', 'discord-user-7')
    expect(approvals.getById(id)?.decision).toBe('denied')
  })

  it('throws when approval not found', () => {
    expect(() => approvals.decide(999999, 'approved', 'u')).toThrow('not found')
  })

  it('throws when already decided', () => {
    const id = approvals.createApproval({ kind: 'resolver', summary: 'dup', risk_tier: 'safe' })
    approvals.decide(id, 'approved', 'u')
    expect(() => approvals.decide(id, 'denied', 'u')).toThrow('already decided')
  })
})

describe('expireOlderThan', () => {
  it('returns 0 when no pending items exist', () => {
    const { expiredCount, expiredResolverIds } = approvals.expireOlderThan(24)
    expect(expiredCount).toBe(0)
    expect(expiredResolverIds).toEqual([])
  })

  it('expires all pending when called with 0 hours', () => {
    approvals.createApproval({ kind: 'resolver', summary: 'x', risk_tier: 'safe' })
    approvals.createApproval({ kind: 'improve', summary: 'y', risk_tier: 'safe' })
    const { expiredCount } = approvals.expireOlderThan(0)
    expect(expiredCount).toBeGreaterThanOrEqual(2)
    expect(approvals.getPending()).toHaveLength(0)
  })

  it('returns the ids of expired resolver approvals so callers can drop their stashes', () => {
    const resolverId = approvals.createApproval({ kind: 'resolver', summary: 'r', risk_tier: 'risky' })
    approvals.createApproval({ kind: 'desktop_deploy', summary: 'd', risk_tier: 'risky' })
    const { expiredResolverIds } = approvals.expireOlderThan(0)
    expect(expiredResolverIds).toContain(resolverId)
    expect(expiredResolverIds).toHaveLength(1)
  })

  it('applies the longer window to gated kinds (resolver + improve) but not others', () => {
    // All rows are brand new (age ~0h). Default window 0h expires non-gated kinds
    // immediately; the gated window of 168h spares both resolver and improve.
    const resolverId = approvals.createApproval({ kind: 'resolver', summary: 'r', risk_tier: 'risky' })
    const improveId = approvals.createApproval({ kind: 'improve', summary: 'i', risk_tier: 'risky' })
    const deployId = approvals.createApproval({ kind: 'desktop_deploy', summary: 'd', risk_tier: 'risky' })
    const { expiredCount, expiredResolverIds } = approvals.expireOlderThan(0, 168)
    expect(expiredCount).toBe(1)
    // improve is gated for the window but uses a branch, not a stash — never in the drop list.
    expect(expiredResolverIds).toEqual([])
    const pendingIds = approvals.getPending().map(a => a.id)
    expect(pendingIds).toContain(resolverId)
    expect(pendingIds).toContain(improveId)
    expect(pendingIds).not.toContain(deployId)
  })
})

describe('bindDigest', () => {
  it('stores message id and local index for each approval', () => {
    const id1 = approvals.createApproval({ kind: 'resolver', summary: 'a', risk_tier: 'safe' })
    const id2 = approvals.createApproval({ kind: 'improve', summary: 'b', risk_tier: 'risky' })

    approvals.bindDigest([id1, id2], 'msg-99', { [id1]: 1, [id2]: 2 })

    const r1 = approvals.getById(id1)
    const r2 = approvals.getById(id2)
    expect(r1?.discord_message_id).toBe('msg-99')
    expect(r1?.discord_local_index).toBe(1)
    expect(r2?.discord_message_id).toBe('msg-99')
    expect(r2?.discord_local_index).toBe(2)
  })
})

describe('findByLocalIndex', () => {
  it('returns matching pending approval by local index', () => {
    const id = approvals.createApproval({ kind: 'resolver', summary: 'find me', risk_tier: 'safe' })
    approvals.bindDigest([id], 'msg-find', { [id]: 3 })
    const found = approvals.findByLocalIndex(3)
    expect(found?.id).toBe(id)
  })

  it('returns null when index not found', () => {
    expect(approvals.findByLocalIndex(999)).toBeNull()
  })
})

describe('findByIssueNumber', () => {
  it('finds pending approval by issue number', () => {
    const id = approvals.createApproval({
      kind: 'resolver',
      github_issue_number: 336,
      summary: 'issue 336',
      risk_tier: 'safe',
    })
    expect(approvals.findByIssueNumber(336)?.id).toBe(id)
  })

  it('returns null when no match', () => {
    expect(approvals.findByIssueNumber(99999)).toBeNull()
  })
})
