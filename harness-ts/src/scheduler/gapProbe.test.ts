import { describe, it, expect, vi, beforeEach } from 'vitest'
import { prospectiveGapProbe } from './gapProbe'
import * as recall from '../memory/recall'
import * as episodic from '../memory/episodic'

vi.mock('../memory/recall')
vi.mock('../memory/episodic')

beforeEach(() => {
  vi.clearAllMocks()
  // Default: no prior cooldown events -- allow gap detection to proceed.
  vi.mocked(episodic.recentEvents).mockReturnValue([])
})

describe('prospectiveGapProbe', () => {
  it('returns null when 2 or more results found', async () => {
    vi.mocked(recall.recall).mockResolvedValue({
      results: ['fact 1', 'fact 2'],
      elapsed_ms: 100,
    })

    const gap = await prospectiveGapProbe('morning_brief')
    expect(gap).toBeNull()
  })

  it('returns gap description when 0 results found', async () => {
    vi.mocked(recall.recall).mockResolvedValue({
      results: [],
      elapsed_ms: 100,
    })

    const gap = await prospectiveGapProbe('morning_brief')
    expect(gap).toMatch(/Low context for Morning Brief/)
    expect(gap).toMatch(/0 facts/)
  })

  it('returns gap description when 1 result found', async () => {
    vi.mocked(recall.recall).mockResolvedValue({
      results: ['single fact'],
      elapsed_ms: 100,
    })

    const gap = await prospectiveGapProbe('midday_checkin')
    expect(gap).toMatch(/Low context for Midday Checkin/)
    expect(gap).toMatch(/1 fact/)
  })

  it('uses correct topic query for routines', async () => {
    vi.mocked(recall.recall).mockResolvedValue({
      results: [],
      elapsed_ms: 100,
    })

    await prospectiveGapProbe('weekly_curator')
    expect(vi.mocked(recall.recall)).toHaveBeenCalledWith(
      'knowledge patterns weekly themes',
      'knowledge',
      5,
    )
  })

  it('logs gap_probe event when gap detected', async () => {
    vi.mocked(recall.recall).mockResolvedValue({
      results: [],
      elapsed_ms: 100,
    })

    await prospectiveGapProbe('cfo_watch')
    expect(vi.mocked(episodic.logEvent)).toHaveBeenCalledWith(
      'cfo_watch',
      'gap_probe',
      expect.objectContaining({
        routine: 'cfo_watch',
        results_found: 0,
        gap: true,
      }),
    )
  })

  it('returns null and logs nothing for unmapped routines', async () => {
    const gap = await prospectiveGapProbe('unknown_routine')
    expect(gap).toBeNull()
    expect(vi.mocked(episodic.logEvent)).not.toHaveBeenCalled()
  })

  it('returns null gracefully on recall error', async () => {
    vi.mocked(recall.recall).mockRejectedValue(new Error('vec-server down'))

    const gap = await prospectiveGapProbe('morning_brief')
    expect(gap).toBeNull()
  })

  it('returns null and skips log when gap already logged within cooldown window', async () => {
    // Simulate a prior gap_probe event within the cooldown window (#563).
    vi.mocked(recall.recall).mockResolvedValue({
      results: [],
      elapsed_ms: 100,
    })
    vi.mocked(episodic.recentEvents).mockReturnValue([
      { id: 1, ts: new Date().toISOString(), detail: { routine: 'meeting_prep', gap: true } },
    ] as ReturnType<typeof episodic.recentEvents>)

    const gap = await prospectiveGapProbe('meeting_prep')
    expect(gap).toBeNull()
    // logEvent must not have been called -- cooldown prevented it
    expect(vi.mocked(episodic.logEvent)).not.toHaveBeenCalled()
  })

  it('includes meeting_prep topic in mapping', async () => {
    vi.mocked(recall.recall).mockResolvedValue({
      results: [],
      elapsed_ms: 100,
    })

    await prospectiveGapProbe('meeting_prep')
    expect(vi.mocked(recall.recall)).toHaveBeenCalledWith(
      'upcoming meetings calendar events people',
      'knowledge',
      5,
    )
  })
})
