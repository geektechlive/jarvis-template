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

import { runWeeklyDocTriage } from './weekly_doc_triage'
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

describe('runWeeklyDocTriage', () => {
  it('returns immediately without dispatching when weekly_doc_triage is disabled', async () => {
    mockIsEnabled.mockReturnValue(false)
    await runWeeklyDocTriage()
    expect(mockDispatchObserver).not.toHaveBeenCalled()
    expect(mockLogEvent).not.toHaveBeenCalled()
  })

  it('dispatches doc-steward when enabled', async () => {
    await runWeeklyDocTriage()
    expect(mockDispatchObserver).toHaveBeenCalledOnce()
    const call = mockDispatchObserver.mock.calls[0]
    expect(call?.[0]).toBe('weekly_doc_triage')
    expect(call?.[1]).toBe('doc-steward')
    expect(typeof call?.[2]).toBe('string')
    expect(call?.[2]).toContain('Downloads')
  })

  it('does not throw and completes when dispatchObserver resolves', async () => {
    mockDispatchObserver.mockResolvedValue(undefined)
    await expect(runWeeklyDocTriage()).resolves.toBeUndefined()
  })
})
