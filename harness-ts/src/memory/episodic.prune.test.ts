import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { join } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'

// AGENT_DATA_DIR must be set before episodic is imported (DB_PATH resolves at
// module load). Mirror the perfMetrics test setup.
const tmpDir = join(tmpdir(), `episodic-prune-test-${Date.now()}-${Math.trunc(Math.random() * 1e6)}`)

let episodic: typeof import('./episodic')

function dbFile(): string {
  return join(tmpDir, 'conversations.db')
}

function insertEvent(event: string, routine: string, daysAgo: number): void {
  const ts = new Date(Date.now() - daysAgo * 86_400_000).toISOString()
  const db = new Database(dbFile())
  db.prepare(`INSERT INTO agent_events (session, event, detail, ts) VALUES (?, ?, ?, ?)`).run(
    'jarvis',
    event,
    JSON.stringify({ routine }),
    ts,
  )
  db.close()
}

function countEvents(): number {
  const db = new Database(dbFile(), { readonly: true })
  const row = db.prepare('SELECT COUNT(*) AS c FROM agent_events').get() as { c: number }
  db.close()
  return row.c
}

beforeAll(async () => {
  mkdirSync(tmpDir, { recursive: true })
  process.env['AGENT_DATA_DIR'] = tmpDir
  episodic = await import('./episodic')
  // Schema is created lazily on the first episodic db() call. Force it so the
  // raw connection used for backdated inserts can see the agent_events table.
  episodic.logEvent('jarvis', 'schema_init')
})

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
  delete process.env['AGENT_DATA_DIR']
})

describe('pruneHighFrequencyEvents', () => {
  it('deletes only old high-frequency poller rows, keeps recent and meaningful events', () => {
    insertEvent('routine_started', 'briefing_drain', 30) // old poller  -> delete
    insertEvent('routine_delivered', 'resolver_feedback_poll', 20) // old poller  -> delete
    insertEvent('routine_started', 'briefing_drain', 2) // recent poller -> keep
    insertEvent('routine_started', 'morning_brief', 30) // old non-poller routine -> keep
    insertEvent('agent_dispatch', 'n/a', 30) // old meaningful event -> keep

    const before = countEvents()
    const deleted = episodic.pruneHighFrequencyEvents(14)
    const after = countEvents()

    expect(deleted).toBe(2)
    expect(before - after).toBe(2)
  })
})
