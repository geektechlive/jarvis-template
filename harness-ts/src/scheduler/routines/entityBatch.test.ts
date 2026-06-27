import { describe, it, expect } from 'vitest'
import { extractEntities, groupByEntity } from './entityBatch'
import type { FindingRow } from '../../findings'

// ---------------------------------------------------------------------------
// extractEntities
// ---------------------------------------------------------------------------

describe('extractEntities', () => {
  it('extracts ticker and company name from a typical sentence', () => {
    const entities = extractEntities('Apple stock dropped 8% after AAPL earnings miss')
    expect(entities).toContain('aapl')
    // "Apple" is >4 chars and title-case — should be extracted as company name
    expect(entities).toContain('apple')
  })

  it('filters common English acronyms', () => {
    const entities = extractEntities('THE stock WAS NOT performing well')
    expect(entities).not.toContain('the')
    expect(entities).not.toContain('was')
    expect(entities).not.toContain('not')
  })

  it('returns at most 10 entities', () => {
    const text = 'AAPL MSFT GOOGL AMZN TSLA META NVDA AMD INTC QCOM ORCL IBM'
    const entities = extractEntities(text)
    expect(entities.length).toBeLessThanOrEqual(10)
  })

  it('returns lowercase canonical form', () => {
    const entities = extractEntities('NVDA reported record revenue')
    for (const e of entities) {
      expect(e).toBe(e.toLowerCase())
    }
  })
})

// ---------------------------------------------------------------------------
// groupByEntity
// ---------------------------------------------------------------------------

function makeRow(overrides: Partial<FindingRow> & { id: number; created_at: string }): FindingRow {
  return {
    source: 'test-source',
    content: 'AAPL stock moved significantly',
    criticality: 'important',
    processed: 0,
    processed_at: null,
    claim_id: null,
    claim_at: null,
    attempt_count: 0,
    blocked: 0,
    ...overrides,
  }
}

describe('groupByEntity', () => {
  const now = new Date('2025-01-01T10:00:00.000Z').getTime()

  it('groups two findings that share an entity within 30 minutes', () => {
    const f1 = makeRow({ id: 1, content: 'AAPL stock dropped 8%', created_at: new Date(now).toISOString() })
    const f2 = makeRow({ id: 2, content: 'AAPL earnings miss reported', created_at: new Date(now + 15 * 60_000).toISOString() })

    const groups = groupByEntity([f1, f2])
    const aapl = groups.find(g => g.entity === 'aapl')
    expect(aapl).toBeDefined()
    expect(aapl!.findings).toHaveLength(2)
    expect(aapl!.findings.map(f => f.id)).toContain(1)
    expect(aapl!.findings.map(f => f.id)).toContain(2)
  })

  it('does NOT group findings that are 45 minutes apart', () => {
    const f1 = makeRow({ id: 1, content: 'AAPL stock dropped 8%', created_at: new Date(now).toISOString() })
    const f2 = makeRow({ id: 2, content: 'AAPL earnings miss reported', created_at: new Date(now + 45 * 60_000).toISOString() })

    const groups = groupByEntity([f1, f2])
    const aapl = groups.find(g => g.entity === 'aapl')
    expect(aapl).toBeUndefined()
  })

  it('does NOT group if only 1 finding mentions an entity', () => {
    const f1 = makeRow({ id: 1, content: 'AAPL stock dropped 8%', created_at: new Date(now).toISOString() })
    const f2 = makeRow({ id: 2, content: 'Treasury yields rose today', created_at: new Date(now + 5 * 60_000).toISOString() })

    const groups = groupByEntity([f1, f2])
    const aapl = groups.find(g => g.entity === 'aapl')
    expect(aapl).toBeUndefined()
  })

  it('returns empty array for empty input', () => {
    expect(groupByEntity([])).toEqual([])
  })

  it('returns empty array when no entity appears in 2+ findings', () => {
    const f1 = makeRow({ id: 1, content: 'AAPL dropped', created_at: new Date(now).toISOString() })
    expect(groupByEntity([f1])).toEqual([])
  })
})
