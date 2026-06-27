import { describe, it, expect } from 'vitest'
import { buildRichEmbed, truncateWords } from './format'

describe('truncateWords', () => {
  it('returns the string unchanged when within the limit', () => {
    expect(truncateWords('short text', 200)).toBe('short text')
  })

  it('cuts at a word boundary and appends an ellipsis, never mid-word', () => {
    const text = 'Relay health check blocked. SSH to Mini unreachable cannot verify cloudflared tunnel status'
    const out = truncateWords(text, 60)
    expect(out.endsWith('…')).toBe(true)
    // The cut text (minus the ellipsis) must be a clean prefix ending on a full word.
    const body = out.slice(0, -1)
    expect(text.startsWith(body)).toBe(true)
    expect(text[body.length]).toBe(' ')
    expect(out.length).toBeLessThanOrEqual(61)
  })

  it('hard-cuts when there is no whitespace within the budget', () => {
    expect(truncateWords('superlongunbrokentoken', 10)).toBe('superlongu…')
  })
})

describe('buildRichEmbed', () => {
  it('puts emoji+title in embed.title and subtitle bolded at top of description', () => {
    const e = buildRichEmbed({
      emoji: '✅',
      title: 'Resolver shipped fix for #337',
      subtitle: 'fix: use timingSafeEqual with length check',
      color: 0x4caf50,
    })
    expect(e.title).toBe('✅ Resolver shipped fix for #337')
    expect(e.description).toMatch(/^\*\*fix: use timingSafeEqual/)
  })

  it('renders badges as a single ·-separated line', () => {
    const e = buildRichEmbed({
      emoji: '🔍',
      title: 't',
      badges: ['M1 — Reliability & Safety', 'severity: critical', 'area: security'],
      color: 0,
    })
    expect(e.description).toContain('M1 — Reliability & Safety · severity: critical · area: security')
  })

  it('renders sections with bold headings and bodies', () => {
    const e = buildRichEmbed({
      emoji: '🔍',
      title: 't',
      sections: [
        { heading: 'bug(scheduler): silent drop', body: 'comms_pulse dispatchAgent failed.' },
        { heading: 'bug(patrol): cursor advance', body: 'Cursor moves on failure.' },
      ],
      color: 0,
    })
    expect(e.description).toContain('**bug(scheduler): silent drop**')
    expect(e.description).toContain('comms_pulse dispatchAgent failed.')
    expect(e.description).toContain('**bug(patrol): cursor advance**')
  })

  it('renders bullets with optional description after em-dash', () => {
    const e = buildRichEmbed({
      emoji: '✅',
      title: 't',
      bullets: [
        { label: '`harness-ts/src/relay/auth.ts`', description: 'fast-fail on length mismatch' },
        { label: '`harness-ts/src/relay/auth.test.ts`' },
      ],
      color: 0,
    })
    expect(e.description).toContain('• `harness-ts/src/relay/auth.ts` — fast-fail on length mismatch')
    expect(e.description).toContain('• `harness-ts/src/relay/auth.test.ts`')
  })

  it('appends footer links one per line', () => {
    const e = buildRichEmbed({
      emoji: '✅',
      title: 't',
      footerLinks: [
        { name: 'Diff', url: 'https://github.com/o/r/commit/abc' },
        { name: 'Issue', url: 'https://github.com/o/r/issues/337' },
      ],
      color: 0,
    })
    expect(e.description).toContain('Diff: https://github.com/o/r/commit/abc')
    expect(e.description).toContain('Issue: https://github.com/o/r/issues/337')
  })

  it('renders footerText as standalone line above footer links', () => {
    const e = buildRichEmbed({
      emoji: '🔍',
      title: 't',
      footerText: 'Open backlog: 12',
      footerLinks: [
        { name: 'View', url: 'https://example.com' },
      ],
      color: 0,
    })
    const d = e.description!
    const footerTextIdx = d.indexOf('Open backlog: 12')
    const linkIdx = d.indexOf('View: https://example.com')
    expect(footerTextIdx).toBeGreaterThan(-1)
    expect(linkIdx).toBeGreaterThan(-1)
    expect(footerTextIdx).toBeLessThan(linkIdx)
  })

  it('truncates an over-long narrative without dropping later sections', () => {
    const longNarrative = 'x'.repeat(2000)
    const e = buildRichEmbed({
      emoji: '✅',
      title: 't',
      narrative: longNarrative,
      sections: [{ heading: 'After', body: 'still here' }],
      color: 0,
    })
    expect(e.description!.length).toBeLessThanOrEqual(4096)
    expect(e.description).toContain('**After**')
    expect(e.description).toContain('still here')
  })

  it('preserves ordering: subtitle → badges → narrative → sections → bullets → links', () => {
    const e = buildRichEmbed({
      emoji: 'x',
      title: 't',
      subtitle: 'SUB',
      badges: ['B1'],
      narrative: 'NARR',
      sections: [{ heading: 'SEC', body: 'SECBODY' }],
      bullets: [{ label: 'BUL' }],
      footerLinks: [{ name: 'LN', url: 'http://e.com' }],
      color: 0,
    })
    const d = e.description!
    const order = ['**SUB**', 'B1', 'NARR', '**SEC**', 'SECBODY', '• BUL', 'LN: http://e.com']
    let last = -1
    for (const needle of order) {
      const idx = d.indexOf(needle)
      expect(idx, `expected to find ${needle}`).toBeGreaterThan(last)
      last = idx
    }
  })

  it('escapes stray backticks in subtitle to avoid breaking later inline-code', () => {
    const e = buildRichEmbed({
      emoji: 'x',
      title: 't',
      subtitle: 'fix: ` broke my code span',
      color: 0,
    })
    expect(e.description).not.toContain('` ')
    expect(e.description).toContain('ˋ')
  })

  it('omits sections / bullets / footer when not provided', () => {
    const e = buildRichEmbed({ emoji: '💤', title: 'idle', color: 0 })
    expect(e.title).toBe('💤 idle')
    expect(e.description).toBe('')
  })
})
