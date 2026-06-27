import { describe, it, expect, beforeEach, vi } from 'vitest'

const { mockRecentEvents } = vi.hoisted(() => ({
  mockRecentEvents: vi.fn(),
}))

vi.mock('../memory/episodic', () => ({
  recentEvents: mockRecentEvents,
}))

vi.mock('ion-sdk', () => ({
  log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

import { summariseSafari, buildAmbientSafariSection } from './safari'

function row(event: string, detail: unknown, tsOffsetMin = 0): unknown {
  const ts = new Date(Date.now() - tsOffsetMin * 60_000).toISOString()
  return { id: Math.floor(Math.random() * 1e9), session: 'ambient', event, detail, ts }
}

describe('summariseSafari', () => {
  beforeEach(() => {
    mockRecentEvents.mockReset()
  })

  it('returns empty summary when no data', () => {
    mockRecentEvents.mockReturnValue([])
    const out = summariseSafari()
    expect(out.totalVisits).toBe(0)
    expect(out.domainsAggregated).toEqual([])
    expect(out.openTabsByHost).toEqual([])
  })

  it('aggregates visits by domain, sorts descending', () => {
    mockRecentEvents.mockImplementation((_session: string, event: string) => {
      if (event === 'ambient_safari') {
        return [
          row('ambient_safari', { url: 'https://example.com/a', title: 'A' }),
          row('ambient_safari', { url: 'https://example.com/b', title: 'B' }),
          row('ambient_safari', { url: 'https://other.org/x', title: 'X' }),
        ]
      }
      return []
    })
    const out = summariseSafari()
    expect(out.totalVisits).toBe(3)
    expect(out.domainsAggregated[0]?.domain).toBe('example.com')
    expect(out.domainsAggregated[0]?.count).toBe(2)
    expect(out.domainsAggregated[1]?.domain).toBe('other.org')
  })

  it('captures latest tab snapshot per host', () => {
    mockRecentEvents.mockImplementation((_session: string, event: string) => {
      if (event === 'ambient_safari_tabs') {
        return [
          row('ambient_safari_tabs', {
            host: 'macbook',
            tabs: [{ url: 'a', title: 'Tab A' }],
            captured_at: '2025-01-01T00:00:00Z',
          }, 60),
          row('ambient_safari_tabs', {
            host: 'macbook',
            tabs: [{ url: 'a', title: 'Tab A2' }, { url: 'b', title: 'Tab B' }],
            captured_at: '2025-01-02T00:00:00Z',
          }, 10),
        ]
      }
      return []
    })
    const out = summariseSafari()
    expect(out.openTabsByHost.length).toBe(1)
    expect(out.openTabsByHost[0]?.titles).toEqual(['Tab A2', 'Tab B'])
  })
})

describe('buildAmbientSafariSection', () => {
  beforeEach(() => {
    mockRecentEvents.mockReset()
  })

  it('returns a stale notice when there is no data at all', () => {
    mockRecentEvents.mockReturnValue([])
    expect(buildAmbientSafariSection()).toContain('No browser activity')
  })

  it('renders aggregated domains with visit counts', () => {
    mockRecentEvents.mockImplementation((_session: string, event: string) => {
      if (event === 'ambient_safari') {
        return [
          row('ambient_safari', { url: 'https://news.ycombinator.com/x', title: 'HN' }),
          row('ambient_safari', { url: 'https://news.ycombinator.com/y', title: 'HN2' }),
        ]
      }
      return []
    })
    const out = buildAmbientSafariSection()
    expect(out).toContain('news.ycombinator.com (2 visits)')
  })
})
