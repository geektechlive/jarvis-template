import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../helpers', () => ({
  isEnabled: () => true,
}))
vi.mock('../../memory/episodic', () => ({
  logEvent: vi.fn(),
}))
vi.mock('../../discord/webhook', () => ({
  postToChannel: vi.fn(),
}))

import { runTriageCheck, needsTriage } from './triageCheck'

const mk = (n: number, opts: { labels?: string[]; milestone?: string | null; title?: string } = {}) => ({
  number: n,
  title: opts.title ?? `Issue #${n}`,
  labels: (opts.labels ?? []).map(name => ({ name })),
  milestone: opts.milestone === undefined ? { title: 'M1 — Reliability & Safety' } : (opts.milestone ? { title: opts.milestone } : null),
})

describe('needsTriage', () => {
  it('returns null when both severity and milestone present', () => {
    expect(needsTriage(mk(1, { labels: ['severity: high', 'area: typescript'] }))).toBeNull()
  })

  it('flags missing severity', () => {
    expect(needsTriage(mk(2, { labels: ['area: typescript'] }))).toEqual({
      missingSeverity: true,
      missingMilestone: false,
    })
  })

  it('flags missing milestone', () => {
    expect(needsTriage(mk(3, { labels: ['severity: low'], milestone: null }))).toEqual({
      missingSeverity: false,
      missingMilestone: true,
    })
  })

  it('excludes parked issues even when unlabeled', () => {
    expect(needsTriage(mk(4, { labels: ['parked'], milestone: null }))).toBeNull()
  })

  it('excludes research issues even when unlabeled', () => {
    expect(needsTriage(mk(5, { labels: ['research'], milestone: null }))).toBeNull()
  })
})

describe('runTriageCheck', () => {
  let posted: string[]

  beforeEach(() => {
    posted = []
  })

  const post = async (content: string) => {
    posted.push(content)
  }

  it('posts the all-clear when nothing needs triage', async () => {
    await runTriageCheck({
      fetchIssues: async () => [
        mk(1, { labels: ['severity: high'] }),
        mk(2, { labels: ['severity: low'] }),
      ],
      post,
    })
    expect(posted).toHaveLength(1)
    expect(posted[0]).toMatch(/all 2 open issues are labeled/)
  })

  it('lists flagged issues with their missing dimensions', async () => {
    await runTriageCheck({
      fetchIssues: async () => [
        mk(10, { labels: ['area: typescript'], title: 'no severity' }),
        mk(11, { labels: ['severity: low'], milestone: null, title: 'no milestone' }),
        mk(12, { labels: ['parked'], milestone: null, title: 'should be skipped' }),
        mk(13, { labels: ['severity: critical', 'area: go'] }),
      ],
      post,
    })
    const msg = posted[0]!
    expect(msg).toMatch(/2 issues need labels/)
    expect(msg).toContain('#10')
    expect(msg).toContain('missing severity')
    expect(msg).toContain('#11')
    expect(msg).toContain('missing milestone')
    expect(msg).not.toContain('#12')
    expect(msg).not.toContain('#13')
  })

  it('truncates the list past 30 and notes the remainder', async () => {
    const many = Array.from({ length: 35 }, (_, i) =>
      mk(100 + i, { labels: [], milestone: null }),
    )
    await runTriageCheck({ fetchIssues: async () => many, post })
    expect(posted[0]).toContain('35 issues need labels')
    expect(posted[0]).toContain('(+5 more)')
  })
})
