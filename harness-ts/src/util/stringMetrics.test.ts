import { describe, it, expect } from 'vitest'
import { tokenOverlap } from './stringMetrics'

// Moved from autonomy/goalProposal.test.ts when tokenOverlap was extracted to a
// domain-neutral util shared by goal dedup and memory-correction matching (#846).

describe('tokenOverlap', () => {
  it('returns >= 0.6 for heavily overlapping strings (security monitoring)', () => {
    // 3 shared tokens (security, alerts, weekly) out of max(4, 4) = 4 → 0.75
    const score = tokenOverlap(
      'check security alerts weekly',
      'monitor security alerts weekly',
    )
    expect(score).toBeGreaterThanOrEqual(0.6)
  })

  it('returns < 0.6 for unrelated strings', () => {
    const score = tokenOverlap(
      'morning brief priorities',
      'portfolio rebalancing check',
    )
    expect(score).toBeLessThan(0.6)
  })

  it('returns 1.0 for identical strings', () => {
    expect(tokenOverlap('monitor security weekly', 'monitor security weekly')).toBe(1)
  })

  it('returns 0 when one string is empty', () => {
    expect(tokenOverlap('', 'check security alerts')).toBe(0)
    expect(tokenOverlap('monitor security', '')).toBe(0)
  })

  it('is case-insensitive', () => {
    const lower = tokenOverlap('security check', 'Security Check')
    expect(lower).toBe(1)
  })

  it('strips punctuation before tokenizing', () => {
    // Punctuation should not produce separate tokens that lower the score
    const score = tokenOverlap('check security!', 'check security')
    expect(score).toBe(1)
  })
})
