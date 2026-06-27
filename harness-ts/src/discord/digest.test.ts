import { describe, it, expect } from 'vitest'
import { formatDigestMessage } from './digest'
import type { Approval } from '../approvals/index'

function makeApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: 1,
    kind: 'resolver',
    github_run_id: null,
    github_issue_number: null,
    summary: 'fix: test summary',
    files_changed: null,
    diff_excerpt: null,
    risk_tier: 'safe',
    discord_message_id: null,
    discord_local_index: null,
    requested_at: Date.now(),
    decided_at: null,
    decision: null,
    decided_by: null,
    ...overrides,
  }
}

describe('formatDigestMessage', () => {
  it('returns no-items message for empty list', () => {
    expect(formatDigestMessage([])).toBe('Jarvis · no changes waiting approval.')
  })

  it('formats single-item message with correct header', () => {
    const msg = formatDigestMessage([makeApproval({ id: 1, summary: 'fix: one change' })])
    expect(msg).toContain('1 change waiting approval')
    expect(msg).toContain('1) fix: one change')
    expect(msg).toContain('resolver')
  })

  it('uses plural header for multiple items', () => {
    const msg = formatDigestMessage([
      makeApproval({ id: 1 }),
      makeApproval({ id: 2, summary: 'chore: second' }),
    ])
    expect(msg).toContain('2 changes waiting approval')
  })

  it('includes issue reference when github_issue_number is set', () => {
    const msg = formatDigestMessage([
      makeApproval({ github_issue_number: 247, summary: 'fix: gap timeout' }),
    ])
    expect(msg).toContain('#247')
    expect(msg).toContain('fix: gap timeout')
  })

  it('shows warning marker for risky tier', () => {
    const msg = formatDigestMessage([makeApproval({ risk_tier: 'risky' })])
    expect(msg).toContain('⚠️')
  })

  it('shows no warning marker for safe tier', () => {
    const msg = formatDigestMessage([makeApproval({ risk_tier: 'safe' })])
    expect(msg).not.toContain('⚠️')
  })

  it('lists up to 3 files, then shows overflow count', () => {
    const msg = formatDigestMessage([
      makeApproval({
        files_changed: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'],
      }),
    ])
    expect(msg).toContain('a.ts, b.ts, c.ts')
    expect(msg).toContain('+2 more')
  })

  it('includes reply instructions footer', () => {
    const msg = formatDigestMessage([makeApproval()])
    expect(msg).toContain('Reply:')
    expect(msg).toContain('approve 1')
    expect(msg).toContain('deny 2')
  })

  it('numbers items 1-based', () => {
    const items = [
      makeApproval({ id: 10, summary: 'first' }),
      makeApproval({ id: 11, summary: 'second' }),
      makeApproval({ id: 12, summary: 'third' }),
    ]
    const msg = formatDigestMessage(items)
    expect(msg).toContain('1) ')
    expect(msg).toContain('2) ')
    expect(msg).toContain('3) ')
  })
})
