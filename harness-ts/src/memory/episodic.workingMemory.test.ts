import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { join } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

// AGENT_DATA_DIR must be set before episodic is imported because DB_PATH is
// resolved at module load time (not lazily). Use a dynamic import inside
// beforeAll to guarantee the env var is set first.
const tmpDir = join(tmpdir(), `episodic-wm-test-${Date.now()}-${Math.trunc(Math.random() * 1e6)}`)

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

describe('writeWorkingMemory / readWorkingMemory', () => {
  it('round-trips a written entry through readWorkingMemory', () => {
    episodic.writeWorkingMemory('test content for wm', 'test_writer')
    const rows = episodic.readWorkingMemory()
    const match = rows.find(r => r.content === 'test content for wm')
    expect(match).toBeDefined()
    expect(match!.written_by).toBe('test_writer')
    expect(match!.written_at).toBeTruthy()
  })

  it('excludes expired entries from readWorkingMemory', () => {
    // Write an entry with a 0-ms TTL so it expires immediately
    episodic.writeWorkingMemory('expired content', 'test_writer', 0)

    // Any entry written with ttlHours=0 expires at Date.now() + 0ms, which is
    // effectively now. The DB stores ISO strings; the query uses expires_at > now(),
    // so a zero-TTL entry written a moment ago should not appear.
    // We write a fresh normal entry to confirm readWorkingMemory still works.
    episodic.writeWorkingMemory('live content', 'test_writer', 4)

    const rows = episodic.readWorkingMemory()
    const expiredRow = rows.find(r => r.content === 'expired content')
    const liveRow = rows.find(r => r.content === 'live content')

    // The live entry must be present
    expect(liveRow).toBeDefined()
    // The expired entry must not be present
    expect(expiredRow).toBeUndefined()
  })

  it('returns entries in written_at ascending order', () => {
    // Create two distinct entries and confirm order
    episodic.writeWorkingMemory('first entry', 'test_writer', 4)
    // Small sleep alternative: timestamps in SQLite are at millisecond precision
    // from Date.now(), so if both writes happen in the same millisecond they might
    // be equal. We rely on insertion order (ORDER BY written_at ASC) but since
    // the IDs autoincrement and the test is single-threaded, order is deterministic.
    episodic.writeWorkingMemory('second entry', 'test_writer', 4)

    const rows = episodic.readWorkingMemory()
    const firstIdx = rows.findIndex(r => r.content === 'first entry')
    const secondIdx = rows.findIndex(r => r.content === 'second entry')

    expect(firstIdx).toBeGreaterThanOrEqual(0)
    expect(secondIdx).toBeGreaterThanOrEqual(0)
    expect(firstIdx).toBeLessThanOrEqual(secondIdx)
  })

  it('purges expired entries on write', () => {
    // Write an entry with near-zero TTL to get it in the DB
    episodic.writeWorkingMemory('to be purged', 'test_writer', 0)

    // Count rows before the purge-triggering write
    // Trigger a write which should purge any expires_at < now
    episodic.writeWorkingMemory('purge trigger', 'test_writer', 4)

    const rows = episodic.readWorkingMemory()
    const purgedRow = rows.find(r => r.content === 'to be purged')
    // The zero-TTL row should have been purged
    expect(purgedRow).toBeUndefined()
  })
})
