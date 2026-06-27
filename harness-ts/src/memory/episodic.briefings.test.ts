import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { join } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const tmpDir = join(tmpdir(), `episodic-briefings-test-${Date.now()}-${Math.trunc(Math.random() * 1e6)}`)

let episodic: typeof import('./episodic')

beforeAll(async () => {
  mkdirSync(tmpDir, { recursive: true })
  process.env['AGENT_DATA_DIR'] = tmpDir
  episodic = await import('./episodic')
})

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
  delete process.env['AGENT_DATA_DIR']
})

describe('fetchBriefingsFromDb', () => {
  it('returns empty array when no pending_brief events exist', () => {
    const items = episodic.fetchBriefingsFromDb()
    expect(Array.isArray(items)).toBe(true)
    expect(items.length).toBe(0)
  })

  it('returns a BriefingResourceItem for each stored brief', () => {
    episodic.storePendingBrief('Line one of brief\nLine two of brief')
    episodic.storePendingBrief('Second brief content')

    const items = episodic.fetchBriefingsFromDb()
    expect(items.length).toBeGreaterThanOrEqual(2)

    const first = items[0]!
    expect(first.kind).toBe('briefing')
    expect(first.id).toMatch(/^brief-\d+$/)
    expect(typeof first.content).toBe('string')
    expect(typeof first.createdAt).toBe('string')
    expect(typeof first.title).toBe('string')
  })

  it('derives title from first line of content', () => {
    episodic.storePendingBrief('Morning Brief\nSome detail here')
    const items = episodic.fetchBriefingsFromDb()
    const relevant = items.find((i) => i.content.includes('Morning Brief'))
    expect(relevant?.title).toBe('Morning Brief')
  })

  it('truncates long first-line titles to 120 chars', () => {
    const longLine = 'A'.repeat(200)
    episodic.storePendingBrief(longLine)
    const items = episodic.fetchBriefingsFromDb()
    const relevant = items.find((i) => i.content === longLine)
    expect(relevant?.title.length).toBeLessThanOrEqual(120)
  })

  it('respects the limit parameter', () => {
    // Insert several more briefs
    for (let i = 0; i < 5; i++) {
      episodic.storePendingBrief(`Brief number ${i}`)
    }
    const limited = episodic.fetchBriefingsFromDb(3)
    expect(limited.length).toBeLessThanOrEqual(3)
  })
})
