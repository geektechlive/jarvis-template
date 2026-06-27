import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { readLogSlice } from './log-patrol-cursor'

const TEMP_DIR = path.join(os.tmpdir(), 'log-patrol-cursor-test')
const TEST_LOG = path.join(TEMP_DIR, 'test.log')
const CURSOR_PATH = path.join(os.homedir(), '.jarvis', 'log-patrol-cursor.json')

// Strip any cursor entry for TEST_LOG before each test so cold-start
// semantics are exercised cleanly per case.
function clearTestCursorEntry(): void {
  try {
    if (!fs.existsSync(CURSOR_PATH)) return
    const state = JSON.parse(fs.readFileSync(CURSOR_PATH, 'utf8')) as Record<string, unknown>
    if (TEST_LOG in state) {
      delete state[TEST_LOG]
      fs.writeFileSync(CURSOR_PATH, JSON.stringify(state, null, 2), 'utf8')
    }
  } catch {
    // ignore — best-effort cleanup
  }
}

beforeEach(() => {
  fs.mkdirSync(TEMP_DIR, { recursive: true })
  clearTestCursorEntry()
})

afterEach(() => {
  if (fs.existsSync(TEMP_DIR)) {
    fs.rmSync(TEMP_DIR, { recursive: true })
  }
  clearTestCursorEntry()
})

describe('log-patrol-cursor', () => {
  it('returns empty on cold start and seeds cursor at EOF', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `historical line ${i}`)
    fs.writeFileSync(TEST_LOG, lines.join('\n'), 'utf8')

    // Cold start: no prior cursor entry. Should NOT replay history.
    const firstSlice = readLogSlice(TEST_LOG, 100)
    expect(firstSlice).toBe('')

    // Cursor should now be seeded at EOF.
    const state = JSON.parse(fs.readFileSync(CURSOR_PATH, 'utf8'))
    expect(state[TEST_LOG]).toBeDefined()
    expect(state[TEST_LOG].lastByteOffset).toBe(fs.statSync(TEST_LOG).size)
  })

  it('reads only new lines appended after cold-start seed', () => {
    const initial = Array.from({ length: 50 }, (_, i) => `historical-${i}`)
    fs.writeFileSync(TEST_LOG, initial.join('\n'), 'utf8')
    expect(readLogSlice(TEST_LOG, 100)).toBe('')  // cold-start seed

    const appended = Array.from({ length: 30 }, (_, i) => `new-${i}`)
    fs.appendFileSync(TEST_LOG, '\n' + appended.join('\n'), 'utf8')

    const slice = readLogSlice(TEST_LOG, 100)
    expect(slice).not.toContain('historical-0')
    expect(slice).toContain('new-0')
    expect(slice).toContain('new-29')
  })

  it('caps output to max lines on a warm cursor', () => {
    fs.writeFileSync(TEST_LOG, '', 'utf8')
    readLogSlice(TEST_LOG, 100)  // seed cursor at 0

    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`)
    fs.appendFileSync(TEST_LOG, lines.join('\n'), 'utf8')

    const slice = readLogSlice(TEST_LOG, 50)
    const sliceLines = slice.split('\n').filter(Boolean)
    expect(sliceLines.length).toBeLessThanOrEqual(50)
    expect(slice).toContain('line 199')
  })

  it('resets cursor on file rotation (size shrink)', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`)
    fs.writeFileSync(TEST_LOG, lines.join('\n'), 'utf8')
    readLogSlice(TEST_LOG, 100)  // seed cursor at EOF

    // Append something so the cursor advances past the historical content.
    fs.appendFileSync(TEST_LOG, '\nextra original line', 'utf8')
    readLogSlice(TEST_LOG, 100)

    // File rotated (size shrank below the cursor offset).
    const newLines = Array.from({ length: 20 }, (_, i) => `rotated line ${i}`)
    fs.writeFileSync(TEST_LOG, newLines.join('\n'), 'utf8')

    const slice = readLogSlice(TEST_LOG, 100)
    expect(slice).toContain('rotated line 0')
    expect(slice).not.toContain('line 49')
  })

  it('handles missing file gracefully', () => {
    const slice = readLogSlice('/nonexistent/file.log', 100)
    expect(slice).toBe('')
  })

  it('caches last N lines when file has more than max lines since last read', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`)
    fs.writeFileSync(TEST_LOG, lines.join('\n'), 'utf8')
    readLogSlice(TEST_LOG, 100)

    const newLines = Array.from({ length: 200 }, (_, i) => `new line ${i}`)
    const allLines = [...lines, ...newLines]
    fs.writeFileSync(TEST_LOG, allLines.join('\n'), 'utf8')

    const slice = readLogSlice(TEST_LOG, 50)
    const sliceLines = slice.split('\n').filter(Boolean)
    expect(sliceLines.length).toBeLessThanOrEqual(50)
    expect(slice).toContain('new line 199')
  })

  it('handles empty file', () => {
    fs.writeFileSync(TEST_LOG, '', 'utf8')
    const slice = readLogSlice(TEST_LOG, 100)
    expect(slice).toBe('')
  })
})
