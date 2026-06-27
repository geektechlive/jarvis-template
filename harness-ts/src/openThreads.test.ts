import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'

vi.mock('ion-sdk', () => ({
  log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'openthreads-'))
  process.env['AGENT_DATA_DIR'] = tmpDir
  vi.resetModules()
})

afterEach(async () => {
  try {
    const mod = await import('./openThreads')
    mod._resetDbForTests()
  } catch { /* ignore */ }
  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch { /* Windows may hold file lock briefly */ }
  delete process.env['AGENT_DATA_DIR']
})

function seedDispatch(session: string, subagentType: string, tsIso: string): void {
  const dbPath = join(tmpDir, 'conversations.db')
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session TEXT NOT NULL,
      event TEXT NOT NULL,
      detail TEXT,
      ts TEXT NOT NULL
    );
  `)
  db.prepare(
    `INSERT INTO agent_events (session, event, detail, ts) VALUES (?, 'agent_dispatch', ?, ?)`,
  ).run(session, JSON.stringify({ subagentType, toolId: 't1' }), tsIso)
  db.close()
}

function iso(daysAgo: number, hoursAgo = 0): string {
  return new Date(Date.now() - daysAgo * 86_400_000 - hoursAgo * 3_600_000).toISOString()
}

describe('loadOpenThreads', () => {
  it('returns empty when no dispatches exist', async () => {
    const { loadOpenThreads } = await import('./openThreads')
    expect(loadOpenThreads()).toEqual([])
  })

  it('groups by subagentType, dedups within the window, sorts newest first', async () => {
    seedDispatch('s1', 'personal_cfo', iso(2))
    seedDispatch('s2', 'admin', iso(1))
    seedDispatch('s3', 'personal_cfo', iso(0, 4))

    const { loadOpenThreads } = await import('./openThreads')
    const out = loadOpenThreads()
    expect(out.length).toBe(2)
    // Topics are normalized to hyphen form (personal_cfo -> personal-cfo) so
    // usage analytics don't split one staffer across `-`/`_` variants.
    expect(out[0]?.topic).toBe('personal-cfo')
    expect(out[0]?.dispatchCount).toBe(2)
    expect(out[1]?.topic).toBe('admin')
  })

  it('excludes dispatches older than the maxAgeDays window', async () => {
    seedDispatch('s1', 'researcher', iso(30))

    const { loadOpenThreads } = await import('./openThreads')
    expect(loadOpenThreads(7)).toEqual([])
  })

  it('caps results at 5 threads', async () => {
    for (const t of ['a_one', 'b_two', 'c_three', 'd_four', 'e_five', 'f_six', 'g_seven']) {
      seedDispatch('s', t, iso(0, Math.floor(Math.random() * 24)))
    }
    const { loadOpenThreads } = await import('./openThreads')
    const out = loadOpenThreads()
    expect(out.length).toBe(5)
  })

  it('respects markThreadClosed for subsequent loads when no newer dispatch', async () => {
    seedDispatch('s', 'researcher', iso(1))
    const { loadOpenThreads, markThreadClosed } = await import('./openThreads')
    expect(loadOpenThreads().length).toBe(1)
    markThreadClosed('researcher')
    expect(loadOpenThreads()).toEqual([])
  })

  it('keeps a thread open when a fresh dispatch lands after a close', async () => {
    seedDispatch('s', 'admin', iso(2))
    const { loadOpenThreads, markThreadClosed } = await import('./openThreads')
    markThreadClosed('admin')
    seedDispatch('s', 'admin', iso(0))
    expect(loadOpenThreads().length).toBe(1)
  })
})

describe('formatOpenThreadsBlock', () => {
  it('returns empty for no threads', async () => {
    const { formatOpenThreadsBlock } = await import('./openThreads')
    expect(formatOpenThreadsBlock([])).toBe('')
  })

  it('renders a terse block with topic / age / count', async () => {
    const { formatOpenThreadsBlock } = await import('./openThreads')
    const out = formatOpenThreadsBlock([
      {
        topic: 'personal_cfo',
        lastTouchedAt: iso(2),
        lastSession: 's',
        dispatchCount: 2,
      },
    ])
    expect(out).toContain('Personal Cfo')
    expect(out).toContain('2d ago')
    expect(out).toContain('2 dispatches')
    expect(out).toContain('/close <topic>')
  })
})
