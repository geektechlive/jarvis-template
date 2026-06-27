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

import { runHomeMaintenanceCheck } from './home_maintenance_check'
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

describe('runHomeMaintenanceCheck', () => {
  it('returns immediately without dispatching when home_maintenance_check is disabled', async () => {
    mockIsEnabled.mockReturnValue(false)
    await runHomeMaintenanceCheck()
    expect(mockDispatchObserver).not.toHaveBeenCalled()
    expect(mockLogEvent).not.toHaveBeenCalled()
  })

  it('dispatches home-property when enabled', async () => {
    await runHomeMaintenanceCheck()
    expect(mockDispatchObserver).toHaveBeenCalledOnce()
    const call = mockDispatchObserver.mock.calls[0]
    expect(call?.[0]).toBe('home_maintenance_check')
    expect(call?.[1]).toBe('home-property')
    expect(typeof call?.[2]).toBe('string')
    expect(call?.[2]).toContain('property/property.yaml')
  })

  it('does not throw and completes when dispatchObserver resolves', async () => {
    mockDispatchObserver.mockResolvedValue(undefined)
    await expect(runHomeMaintenanceCheck()).resolves.toBeUndefined()
  })
})
