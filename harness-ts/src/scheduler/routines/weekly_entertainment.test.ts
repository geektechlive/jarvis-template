import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../helpers', () => ({
  isEnabled: vi.fn().mockReturnValue(true),
  OBSERVER_DECISION_FRAMEWORK: 'OBSERVER_DECISION_FRAMEWORK',
  loadRoutinesConfig: vi.fn().mockReturnValue({}),
}))

vi.mock('../../memory/episodic', () => ({
  logEvent: vi.fn(),
}))

vi.mock('./_dispatch', () => ({
  dispatchObserver: vi.fn().mockResolvedValue(undefined),
}))

import { runWeeklyEntertainment } from './weekly_entertainment'
import { isEnabled } from '../helpers'
import { logEvent } from '../../memory/episodic'
import { dispatchObserver } from './_dispatch'

const mockIsEnabled = vi.mocked(isEnabled)
const mockLogEvent = vi.mocked(logEvent)
const mockDispatchObserver = vi.mocked(dispatchObserver)

beforeEach(() => {
  vi.clearAllMocks()
  mockIsEnabled.mockReturnValue(true)
  mockDispatchObserver.mockResolvedValue(undefined)
})

describe('runWeeklyEntertainment', () => {
  it('returns immediately without dispatching when weekly_entertainment is disabled', async () => {
    mockIsEnabled.mockReturnValue(false)
    await runWeeklyEntertainment()
    expect(mockDispatchObserver).not.toHaveBeenCalled()
    expect(mockLogEvent).not.toHaveBeenCalled()
  })

  it('dispatches entertainment-advisor when enabled', async () => {
    await runWeeklyEntertainment()
    expect(mockDispatchObserver).toHaveBeenCalledOnce()
    const call = mockDispatchObserver.mock.calls[0]
    expect(call?.[0]).toBe('weekly_entertainment')
    expect(call?.[1]).toBe('entertainment-advisor')
    expect(typeof call?.[2]).toBe('string')
    expect(call?.[2]).toContain('taste profile')
  })

  it('does not throw and completes when dispatchObserver resolves', async () => {
    mockDispatchObserver.mockResolvedValue(undefined)
    await expect(runWeeklyEntertainment()).resolves.toBeUndefined()
  })
})
