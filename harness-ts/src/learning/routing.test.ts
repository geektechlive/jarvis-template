import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockLogEvent, mockRecentEvents, mockRemember } = vi.hoisted(() => ({
  mockLogEvent: vi.fn(),
  mockRecentEvents: vi.fn().mockReturnValue([]),
  mockRemember: vi.fn().mockResolvedValue({ ok: true, id: 'doc-id-123' }),
}))

vi.mock('ion-sdk', () => ({
  log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

vi.mock('../memory/episodic', () => ({
  logEvent: mockLogEvent,
  recentEvents: mockRecentEvents,
}))

vi.mock('../memory/recall', () => ({
  remember: mockRemember,
}))

import { detectRoutingCorrection } from './index'

describe('detectRoutingCorrection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does not store correction for casual "actually ask" without staff vocab', async () => {
    await detectRoutingCorrection('Actually, ask John to join us.', 'test-session')
    expect(mockLogEvent).not.toHaveBeenCalled()
    expect(mockRemember).not.toHaveBeenCalled()
  })

  it('does not store correction for "more of a Monday thing"', async () => {
    await detectRoutingCorrection("That's more of a Monday thing to discuss.", 'test-session')
    expect(mockLogEvent).not.toHaveBeenCalled()
    expect(mockRemember).not.toHaveBeenCalled()
  })

  it('does not store correction when pattern matches but no staff vocab present', async () => {
    await detectRoutingCorrection('You should have asked someone else.', 'test-session')
    expect(mockLogEvent).not.toHaveBeenCalled()
  })

  it('stores correction when staff vocab is present', async () => {
    await detectRoutingCorrection(
      'Actually, ask the CFO to handle this.',
      'test-session',
    )
    expect(mockLogEvent).toHaveBeenCalledWith(
      '',
      'routing_correction',
      expect.objectContaining({ correction: expect.stringContaining('CFO') }),
    )
    expect(mockRemember).toHaveBeenCalledOnce()
  })

  it('stores correction for "more of a CFO thing"', async () => {
    await detectRoutingCorrection(
      "That's more of a CFO question honestly.",
      'test-session',
    )
    expect(mockLogEvent).toHaveBeenCalled()
  })

  it('stores correction for explicit routing with researcher', async () => {
    await detectRoutingCorrection(
      'Next time send this to the researcher.',
      'test-session',
    )
    expect(mockLogEvent).toHaveBeenCalled()
    expect(mockRemember).toHaveBeenCalledOnce()
  })

  it('stores correction when message matches pattern and has staff vocab', async () => {
    await detectRoutingCorrection(
      'That should have gone to the backend engineer.',
      'test-session',
    )
    expect(mockLogEvent).toHaveBeenCalled()
  })

  it('does not fire when message has no routing pattern at all', async () => {
    await detectRoutingCorrection('What is the weather today?', 'test-session')
    expect(mockLogEvent).not.toHaveBeenCalled()
  })

  // Issue #393: remember() failure emits routing_correction_dropped event
  it('#393 remember returns ok:false -- emits routing_correction_dropped event', async () => {
    mockRemember.mockResolvedValue({ ok: false, reason: 'network' })

    await detectRoutingCorrection(
      'Actually, ask the CFO to handle this.',
      'test-session',
    )

    // routing_correction SQLite event still fires (observability)
    const correctionEvents = mockLogEvent.mock.calls.filter(
      (call) => call[1] === 'routing_correction',
    )
    expect(correctionEvents.length).toBeGreaterThan(0)

    // knowledge write failure emits dropped event
    const droppedEvents = mockLogEvent.mock.calls.filter(
      (call) => call[1] === 'routing_correction_dropped',
    )
    expect(droppedEvents.length).toBeGreaterThan(0)
    expect(droppedEvents[0]?.[2]).toMatchObject({ reason: 'network' })
  })

  // Issue #393: remember() success -- no dropped event
  it('#393 remember returns ok:true -- no routing_correction_dropped event', async () => {
    mockRemember.mockResolvedValue({ ok: true, id: 'abc123' })

    await detectRoutingCorrection(
      'Next time send this to the researcher.',
      'test-session',
    )

    const droppedEvents = mockLogEvent.mock.calls.filter(
      (call) => call[1] === 'routing_correction_dropped',
    )
    expect(droppedEvents.length).toBe(0)
  })
})
