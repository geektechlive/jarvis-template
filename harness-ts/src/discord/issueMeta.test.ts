import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../util/ionPrompt', () => ({
  runCommandAsync: vi.fn(),
}))

import { runCommandAsync } from '../util/ionPrompt'
import { fetchIssueMetadata, metadataBadges, firstParagraph, _resetCache } from './issueMeta'

const mockRun = runCommandAsync as unknown as ReturnType<typeof vi.fn>

const ghJson = {
  title: 'bug(webhooks): validateToken prefix-match bypass',
  body: 'Affected: relay/auth.ts\n\nany bearer value starting with the real token authenticates.',
  labels: [
    { name: 'severity: critical' },
    { name: 'area: security' },
    { name: 'area: typescript' },
    { name: 'jarvis-patrol' },
  ],
  milestone: { title: 'M1 — Reliability & Safety' },
}

beforeEach(() => {
  _resetCache()
  mockRun.mockReset()
})

describe('fetchIssueMetadata', () => {
  it('parses gh output into structured metadata', async () => {
    mockRun.mockResolvedValueOnce({ status: 0, stdout: JSON.stringify(ghJson), stderr: '' })
    const m = await fetchIssueMetadata(337)
    expect(m).not.toBeNull()
    expect(m!.title).toContain('validateToken')
    expect(m!.severity).toBe('critical')
    expect(m!.area).toBe('security')
    expect(m!.milestone).toBe('M1 — Reliability & Safety')
    expect(m!.labels).toContain('jarvis-patrol')
  })

  it('returns null on gh failure', async () => {
    mockRun.mockResolvedValueOnce({ status: 1, stdout: '', stderr: 'rate limited' })
    const m = await fetchIssueMetadata(337)
    expect(m).toBeNull()
  })

  it('returns null when gh throws', async () => {
    mockRun.mockRejectedValueOnce(new Error('ENOENT'))
    const m = await fetchIssueMetadata(337)
    expect(m).toBeNull()
  })

  it('caches subsequent calls inside the TTL window', async () => {
    mockRun.mockResolvedValueOnce({ status: 0, stdout: JSON.stringify(ghJson), stderr: '' })
    const t0 = 1_000_000
    const a = await fetchIssueMetadata(337, { now: () => t0 })
    const b = await fetchIssueMetadata(337, { now: () => t0 + 60_000 })
    expect(a).toBe(b)
    expect(mockRun).toHaveBeenCalledTimes(1)
  })

  it('re-fetches after TTL expiry', async () => {
    mockRun.mockResolvedValue({ status: 0, stdout: JSON.stringify(ghJson), stderr: '' })
    const t0 = 1_000_000
    await fetchIssueMetadata(337, { now: () => t0 })
    await fetchIssueMetadata(337, { now: () => t0 + 6 * 60_000 })
    expect(mockRun).toHaveBeenCalledTimes(2)
  })
})

describe('metadataBadges', () => {
  it('emits milestone, severity, area in order', () => {
    expect(
      metadataBadges({
        number: 1,
        title: 't',
        body: '',
        labels: [],
        milestone: 'M1 — Reliability & Safety',
        severity: 'critical',
        area: 'security',
      }),
    ).toEqual(['M1 — Reliability & Safety', 'severity: critical', 'area: security'])
  })

  it('returns empty when metadata is null', () => {
    expect(metadataBadges(null)).toEqual([])
  })

  it('omits missing fields gracefully', () => {
    expect(
      metadataBadges({
        number: 1,
        title: 't',
        body: '',
        labels: [],
        milestone: null,
        severity: 'low',
        area: null,
      }),
    ).toEqual(['severity: low'])
  })
})

describe('firstParagraph', () => {
  it('returns the first blank-line-delimited paragraph', () => {
    expect(firstParagraph('one line.\n\nsecond paragraph.')).toBe('one line.')
  })

  it('falls back to the whole text when no blank line', () => {
    expect(firstParagraph('one\ntwo\nthree')).toBe('one\ntwo\nthree')
  })

  it('truncates when over maxChars', () => {
    expect(firstParagraph('x'.repeat(600), 100)).toHaveLength(100)
  })

  it('handles empty input', () => {
    expect(firstParagraph('')).toBe('')
  })
})
