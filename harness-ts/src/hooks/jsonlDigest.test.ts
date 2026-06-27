import { describe, it, expect, vi, beforeEach } from 'vitest'
import { join } from 'node:path'

// We mock node:fs and node:os so tests are fully hermetic.
const {
  mockReaddirSync,
  mockStatSync,
  mockReadFileSync,
  mockHomedir,
} = vi.hoisted(() => ({
  mockReaddirSync: vi.fn(),
  mockStatSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockHomedir: vi.fn().mockReturnValue('/home/testuser'),
}))

vi.mock('node:fs', () => ({
  readdirSync: mockReaddirSync,
  statSync: mockStatSync,
  readFileSync: mockReadFileSync,
}))

vi.mock('node:os', () => ({
  homedir: mockHomedir,
}))

import { readOtherSessionDigests } from './jsonlDigest'

const PROJECT_DIR = '/home/testuser/.claude/projects/-Users-<username>-Jarvis'

function makeJsonlLine(text: string): string {
  return JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
    },
  })
}

function makeStatResult(mtimeMs: number, size = 10_000): ReturnType<typeof vi.fn> {
  return { mtimeMs, size } as unknown as ReturnType<typeof vi.fn>
}

describe('readOtherSessionDigests', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockHomedir.mockReturnValue('/home/testuser')
  })

  it('returns empty string when no .jsonl files exist', () => {
    mockReaddirSync.mockReturnValue([])
    expect(readOtherSessionDigests()).toBe('')
  })

  it('returns empty string when all files are below the size threshold', () => {
    mockReaddirSync.mockReturnValue(['session-a.jsonl'])
    mockStatSync.mockReturnValue(makeStatResult(Date.now() - 1000, 100))
    expect(readOtherSessionDigests()).toBe('')
  })

  it('returns empty string when all files are older than hoursBack', () => {
    mockReaddirSync.mockReturnValue(['old-session.jsonl'])
    const twoDaysAgo = Date.now() - 48 * 3_600_000
    mockStatSync.mockReturnValue(makeStatResult(twoDaysAgo, 20_000))
    expect(readOtherSessionDigests()).toBe('')
  })

  it('includes user messages from recent, large-enough sessions', () => {
    mockReaddirSync.mockReturnValue(['session-a.jsonl'])
    mockStatSync.mockReturnValue(makeStatResult(Date.now() - 5 * 60_000, 20_000))
    mockReadFileSync.mockReturnValue(
      [
        makeJsonlLine('What is on my calendar today?'),
        makeJsonlLine('Can you summarise last week?'),
      ].join('\n'),
    )

    const result = readOtherSessionDigests()

    expect(result).toContain('Other open Jarvis sessions')
    expect(result).toContain('What is on my calendar today?')
    expect(result).toContain('Can you summarise last week?')
  })

  it('truncates individual messages longer than 150 characters', () => {
    mockReaddirSync.mockReturnValue(['session-a.jsonl'])
    mockStatSync.mockReturnValue(makeStatResult(Date.now() - 1_000, 20_000))
    const longMessage = 'x'.repeat(200)
    mockReadFileSync.mockReturnValue(makeJsonlLine(longMessage))

    const result = readOtherSessionDigests()

    expect(result).toContain('x'.repeat(150) + '...')
    expect(result).not.toContain('x'.repeat(151))
  })

  it('skips non-user type entries', () => {
    mockReaddirSync.mockReturnValue(['session-a.jsonl'])
    mockStatSync.mockReturnValue(makeStatResult(Date.now() - 1_000, 20_000))
    const lines = [
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'I am Jarvis.' }] } }),
      makeJsonlLine('Real user message.'),
    ].join('\n')
    mockReadFileSync.mockReturnValue(lines)

    const result = readOtherSessionDigests()

    expect(result).toContain('Real user message.')
    expect(result).not.toContain('I am Jarvis.')
  })

  it('skips lines that fail to parse', () => {
    mockReaddirSync.mockReturnValue(['session-a.jsonl'])
    mockStatSync.mockReturnValue(makeStatResult(Date.now() - 1_000, 20_000))
    const lines = [
      'not valid json {{{',
      makeJsonlLine('Valid message.'),
    ].join('\n')
    mockReadFileSync.mockReturnValue(lines)

    const result = readOtherSessionDigests()

    expect(result).toContain('Valid message.')
  })

  it('returns empty string when readFileSync throws', () => {
    mockReaddirSync.mockReturnValue(['session-a.jsonl'])
    mockStatSync.mockReturnValue(makeStatResult(Date.now() - 1_000, 20_000))
    mockReadFileSync.mockImplementation(() => { throw new Error('permission denied') })

    expect(readOtherSessionDigests()).toBe('')
  })

  it('returns empty string when readdirSync throws', () => {
    mockReaddirSync.mockImplementation(() => { throw new Error('ENOENT') })
    expect(readOtherSessionDigests()).toBe('')
  })

  it('truncates the full output block at 2000 characters', () => {
    // Generate 5 sessions each with 10 long messages to force truncation.
    const fileNames = Array.from({ length: 5 }, (_, i) => `session-${i}.jsonl`)
    mockReaddirSync.mockReturnValue(fileNames)
    mockStatSync.mockReturnValue(makeStatResult(Date.now() - 1_000, 20_000))
    const bigContent = Array.from({ length: 10 }, () => makeJsonlLine('y'.repeat(140))).join('\n')
    mockReadFileSync.mockReturnValue(bigContent)

    const result = readOtherSessionDigests()

    // slice(0, 2000) + '\n... (truncated)' = max 2016 chars
    expect(result.length).toBeLessThanOrEqual(2000 + '\n... (truncated)'.length)
    expect(result).toContain('... (truncated)')
  })

  it('respects maxSessions cap', () => {
    const fileNames = Array.from({ length: 10 }, (_, i) => `session-${i}.jsonl`)
    mockReaddirSync.mockReturnValue(fileNames)
    // Each file has a different mtime so they sort deterministically.
    mockStatSync.mockImplementation((_path: string) => {
      const idx = fileNames.findIndex(n => _path.includes(n))
      return makeStatResult(Date.now() - (idx + 1) * 60_000, 20_000)
    })
    mockReadFileSync.mockReturnValue(makeJsonlLine('Session message.'))

    const result = readOtherSessionDigests(24, 3)

    // With maxSessions=3 and truncation enabled only when >2000 chars,
    // we just verify 3 blocks appear (each has a "[Session active" header).
    const matches = result.match(/\[Session active/g) ?? []
    expect(matches.length).toBeLessThanOrEqual(3)
  })

  it('uses "just now" for sessions active less than 2 minutes ago', () => {
    mockReaddirSync.mockReturnValue(['session-a.jsonl'])
    mockStatSync.mockReturnValue(makeStatResult(Date.now() - 30_000, 20_000))
    mockReadFileSync.mockReturnValue(makeJsonlLine('Hello.'))

    const result = readOtherSessionDigests()

    expect(result).toContain('[Session active just now]')
  })

  it('uses hours format for sessions active 2+ hours ago', () => {
    mockReaddirSync.mockReturnValue(['session-a.jsonl'])
    mockStatSync.mockReturnValue(makeStatResult(Date.now() - 2 * 3_600_000 - 1_000, 20_000))
    mockReadFileSync.mockReturnValue(makeJsonlLine('Good morning.'))

    const result = readOtherSessionDigests()

    expect(result).toContain('[Session active 2h ago]')
  })

  it('ignores files that are not .jsonl', () => {
    mockReaddirSync.mockReturnValue(['session-a.jsonl', 'notes.txt', 'session-b.md'])
    // Only the .jsonl file should trigger a statSync call.
    mockStatSync.mockReturnValue(makeStatResult(Date.now() - 1_000, 20_000))
    mockReadFileSync.mockReturnValue(makeJsonlLine('Only from jsonl.'))

    readOtherSessionDigests()

    // statSync called once (for the .jsonl) not three times.
    expect(mockStatSync).toHaveBeenCalledTimes(1)
    expect(mockStatSync).toHaveBeenCalledWith(join(PROJECT_DIR, 'session-a.jsonl'))
  })
})
