import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { join } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const tmpDir = join(tmpdir(), `inbox-test-${Date.now()}-${Math.trunc(Math.random() * 1e6)}`)

let inbox: typeof import('./index')

beforeAll(async () => {
  mkdirSync(tmpDir, { recursive: true })
  process.env['AGENT_DATA_DIR'] = tmpDir
  inbox = await import('./index')
})

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
  delete process.env['AGENT_DATA_DIR']
})

function makeItem(score: number, label: string) {
  return { source: 'test', content: label, score, reason: 'unit test' }
}

describe('drain', () => {
  it('returns empty array when queue is empty', () => {
    expect(inbox.drain(5)).toEqual([])
  })

  it('returns all items when count <= n', () => {
    inbox.add(makeItem(0.9, 'item-a'))
    inbox.add(makeItem(0.5, 'item-b'))

    const result = inbox.drain(10)
    expect(result.length).toBe(2)
  })

  it('surplus items beyond n survive for the next drain call', () => {
    // Queue 5 items beyond the 2 already drained above (fresh state after previous drain).
    for (let i = 0; i < 5; i++) {
      inbox.add(makeItem(i * 0.1, `batch-${i}`))
    }

    const first = inbox.drain(3)
    expect(first.length).toBe(3)

    // Remaining 2 must be retrievable; nothing is dropped.
    const second = inbox.drain(3)
    expect(second.length).toBe(2)

    // After full drain the queue is empty.
    expect(inbox.drain(3)).toEqual([])
  })

  it('returns items sorted by score descending within each batch', () => {
    inbox.add(makeItem(0.1, 'low'))
    inbox.add(makeItem(0.9, 'high'))
    inbox.add(makeItem(0.5, 'mid'))

    const result = inbox.drain(10)
    const scores = result.map((r) => r.score)
    expect(scores).toEqual([...scores].sort((a, b) => b - a))
  })

  it('countPending reflects undraned items accurately', () => {
    for (let i = 0; i < 4; i++) {
      inbox.add(makeItem(0.5, `pending-${i}`))
    }
    const before = inbox.countPending()
    inbox.drain(2)
    const after = inbox.countPending()
    expect(after).toBe(before - 2)
  })
})
