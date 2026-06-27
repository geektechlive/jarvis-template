import { describe, it, expect, vi } from 'vitest'

vi.mock('ion-sdk', () => ({
  log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

vi.mock('../memory/episodic', () => ({
  logEvent: vi.fn(),
}))

vi.mock('../staff/normalize', () => ({
  normalizeAgentName: (name: string) => name.toLowerCase().replace(/_/g, '-'),
}))

import { formatDispatchReceipts, formatDegradationNote } from './index'
import type { DispatchReceipt } from './index'

describe('formatDispatchReceipts', () => {
  it('formats two receipts with correct middots, arrows, and durations', () => {
    const receipts: DispatchReceipt[] = [
      { name: 'chief-of-communications', task: 'triage last 5 emails', durationMs: 4200 },
      { name: 'personal-cfo', task: 'review MoMA charge', durationMs: 6100 },
    ]
    const result = formatDispatchReceipts(receipts)
    expect(result).toBe(
      'Delegated this turn.\n' +
        '→ chief-of-communications · triage last 5 emails · 4.2s\n' +
        '→ personal-cfo · review MoMA charge · 6.1s'
    )
  })

  it('renders sub-second durations in ms', () => {
    const receipts: DispatchReceipt[] = [
      { name: 'news-desk', task: 'check headlines', durationMs: 850 },
    ]
    const result = formatDispatchReceipts(receipts)
    expect(result).toContain('850ms')
    expect(result).not.toContain('0.8s')
  })

  it('omits task field when task is absent', () => {
    const receipts: DispatchReceipt[] = [{ name: 'news-desk', durationMs: 8000 }]
    const result = formatDispatchReceipts(receipts)
    expect(result).toBe('Delegated this turn.\n→ news-desk · 8.0s')
  })

  it('omits task field when task is empty string', () => {
    const receipts: DispatchReceipt[] = [{ name: 'news-desk', task: '', durationMs: 500 }]
    const result = formatDispatchReceipts(receipts)
    expect(result).toBe('Delegated this turn.\n→ news-desk · 500ms')
  })

  it('contains no em dashes', () => {
    const receipts: DispatchReceipt[] = [
      { name: 'chief-of-communications', task: 'some task', durationMs: 1000 },
    ]
    const result = formatDispatchReceipts(receipts)
    expect(result).not.toContain('—')
  })

  it('contains no exclamation marks', () => {
    const receipts: DispatchReceipt[] = [
      { name: 'personal-cfo', task: 'review charge', durationMs: 3000 },
    ]
    const result = formatDispatchReceipts(receipts)
    expect(result).not.toContain('!')
  })
})

describe('formatDegradationNote', () => {
  it('returns the degraded note for reason=degraded', () => {
    const note = formatDegradationNote('degraded')
    expect(note).toBe(
      'Note: memory recall ran degraded this turn, so context may be thinner than usual.'
    )
  })

  it('returns the failed note for reason=failed', () => {
    const note = formatDegradationNote('failed')
    expect(note).toBe(
      'Note: memory recall failed this turn, so I may be missing relevant context.'
    )
  })

  it('contains no em dashes for degraded', () => {
    expect(formatDegradationNote('degraded')).not.toContain('—')
  })

  it('contains no em dashes for failed', () => {
    expect(formatDegradationNote('failed')).not.toContain('—')
  })

  it('contains no exclamation marks for degraded', () => {
    expect(formatDegradationNote('degraded')).not.toContain('!')
  })

  it('contains no exclamation marks for failed', () => {
    expect(formatDegradationNote('failed')).not.toContain('!')
  })
})
