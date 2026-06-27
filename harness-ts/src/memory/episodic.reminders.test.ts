import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { join } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

// AGENT_DATA_DIR must be set before episodic is imported because DB_PATH is
// resolved at module load time (not lazily). We use a dynamic import inside
// beforeAll to guarantee the env var is set first.
const tmpDir = join(tmpdir(), `episodic-reminders-test-${Date.now()}-${Math.trunc(Math.random() * 1e6)}`)

// Lazily-loaded episodic module (typed for convenience)
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

// Wipe the reminders table between tests so rows don't leak.
// We reach this by cancelling all pending rows and verifying via listReminders.
// The cleanest approach is to insert+cancel every row, but we just use createReminder
// in each test with unique fire_at times and lean on status filtering.
// For strict isolation we use a separate describe block per logical group.

describe('createReminder', () => {
  it('inserts a reminder and returns a valid numeric id', () => {
    const id = episodic.createReminder(
      'remind me in 1 hour',
      new Date(Date.now() + 3_600_000),
      'Check in with team',
    )
    expect(typeof id).toBe('number')
    expect(id).toBeGreaterThan(0)
  })
})

describe('dueReminders', () => {
  it('returns only pending rows with fire_at in the past', () => {
    const pastTime = new Date(Date.now() - 5_000)   // 5 seconds ago
    const futureTime = new Date(Date.now() + 3_600_000)

    const idPast = episodic.createReminder('past reminder', pastTime, 'Do thing now')
    episodic.createReminder('future reminder', futureTime, 'Do thing later')

    const due = episodic.dueReminders()
    const dueIds = due.map((r) => r.id)

    expect(dueIds).toContain(idPast)
    // The future reminder must NOT appear in due results
    for (const row of due) {
      const fireAt = new Date(row.fire_at)
      expect(fireAt.getTime()).toBeLessThanOrEqual(Date.now())
    }
  })

  it('does not return fired rows', () => {
    const pastTime = new Date(Date.now() - 1_000)
    const id = episodic.createReminder('fire me', pastTime, 'Already fired')
    // Mark it fired
    episodic.markReminderFired(id)

    const due = episodic.dueReminders()
    const dueIds = due.map((r) => r.id)
    expect(dueIds).not.toContain(id)
  })
})

describe('markReminderFired', () => {
  it('returns true on first call, false on second call for the same id', () => {
    const id = episodic.createReminder(
      'fire idempotency test',
      new Date(Date.now() - 1_000),
      'Idempotency check',
    )

    const first = episodic.markReminderFired(id)
    const second = episodic.markReminderFired(id)

    expect(first).toBe(true)
    expect(second).toBe(false)
  })
})

describe('cancelReminder', () => {
  it('changes status to cancelled and returns true', () => {
    const id = episodic.createReminder(
      'cancel me',
      new Date(Date.now() + 3_600_000),
      'Cancelled task',
    )

    const result = episodic.cancelReminder(id)
    expect(result).toBe(true)

    // Confirm the row no longer appears in pending list
    const pending = episodic.listReminders('pending')
    const ids = pending.map((r) => r.id)
    expect(ids).not.toContain(id)
  })

  it('returns false for an unknown id', () => {
    const result = episodic.cancelReminder(999_999)
    expect(result).toBe(false)
  })
})

describe('requeueReminder', () => {
  it('resets a fired reminder back to pending on first two failures', () => {
    const pastTime = new Date(Date.now() - 1_000)
    const id = episodic.createReminder('requeue me', pastTime, 'Retry this')

    // Simulate tick CAS win
    expect(episodic.markReminderFired(id)).toBe(true)

    // First failure → requeued
    const outcome1 = episodic.requeueReminder(id)
    expect(outcome1).toBe('requeued')

    // Row is pending again and dueReminders picks it up
    const due1 = episodic.dueReminders()
    expect(due1.map((r) => r.id)).toContain(id)
    const row1 = due1.find((r) => r.id === id)
    expect(row1?.status).toBe('pending')
    expect(row1?.attempts).toBe(1)

    // Second tick: CAS win again
    expect(episodic.markReminderFired(id)).toBe(true)

    // Second failure → still requeued
    const outcome2 = episodic.requeueReminder(id)
    expect(outcome2).toBe('requeued')

    const due2 = episodic.dueReminders()
    expect(due2.map((r) => r.id)).toContain(id)
    const row2 = due2.find((r) => r.id === id)
    expect(row2?.attempts).toBe(2)
  })

  it('marks a reminder as failed after 3 delivery failures (cap exhausted)', () => {
    const pastTime = new Date(Date.now() - 1_000)
    const id = episodic.createReminder('cap test', pastTime, 'Should fail eventually')

    // Three cycles: CAS win then requeue
    for (let i = 0; i < 2; i++) {
      episodic.markReminderFired(id)
      const outcome = episodic.requeueReminder(id)
      expect(outcome).toBe('requeued')
    }

    // Third attempt: CAS win then cap hit → failed
    episodic.markReminderFired(id)
    const outcome3 = episodic.requeueReminder(id)
    expect(outcome3).toBe('failed')

    // Row is 'failed', not re-selected by dueReminders
    const due = episodic.dueReminders()
    expect(due.map((r) => r.id)).not.toContain(id)

    // Confirm status in listReminders (no filter) is 'failed'
    const all = episodic.listReminders()
    const row = all.find((r) => r.id === id)
    expect(row?.status).toBe('failed')
    expect(row?.attempts).toBe(3)
  })
})

describe('escalating reminders (#542)', () => {
  it('createReminder defaults to one-shot (escalation_cap 0)', () => {
    const id = episodic.createReminder('one-shot', new Date(Date.now() + 3_600_000), 'msg')
    const row = episodic.listReminders().find((r) => r.id === id)
    expect(row?.escalation_cap).toBe(0)
    expect(row?.escalation_level).toBe(0)
    expect(row?.next_remind_at).toBeNull()
  })

  it('createReminder with escalating sets the default cap of 10', () => {
    const id = episodic.createReminder('nag', new Date(Date.now() + 3_600_000), 'msg', { escalating: true })
    const row = episodic.listReminders().find((r) => r.id === id)
    expect(row?.escalation_cap).toBe(10)
  })

  it('createReminder honors an explicit escalation_cap', () => {
    const id = episodic.createReminder('nag', new Date(Date.now() + 3_600_000), 'msg', { escalating: true, escalationCap: 3 })
    const row = episodic.listReminders().find((r) => r.id === id)
    expect(row?.escalation_cap).toBe(3)
  })

  it('clamps a non-positive explicit escalation_cap to 1', () => {
    const id = episodic.createReminder('nag', new Date(Date.now() + 3_600_000), 'msg', { escalating: true, escalationCap: 0 })
    expect(episodic.listReminders().find((r) => r.id === id)?.escalation_cap).toBe(1)
  })

  it('escalateReminder bumps level, stamps next_remind_at, and re-pends', () => {
    const id = episodic.createReminder('nag', new Date(Date.now() - 1_000), 'msg', { escalating: true })
    episodic.markReminderFired(id) // -> fired
    const next = new Date(Date.now() + 15 * 60_000)
    episodic.escalateReminder(id, next)
    const row = episodic.listReminders().find((r) => r.id === id)
    expect(row?.status).toBe('pending')
    expect(row?.escalation_level).toBe(1)
    expect(row?.next_remind_at).toBe(next.toISOString())
  })

  it('escalateReminder resets attempts so transient failures do not accumulate across re-fires', () => {
    const id = episodic.createReminder('nag', new Date(Date.now() - 1_000), 'msg', { escalating: true })
    // Simulate two delivery failures on this fire (attempts -> 2).
    episodic.markReminderFired(id)
    expect(episodic.requeueReminder(id)).toBe('requeued')
    episodic.markReminderFired(id)
    expect(episodic.requeueReminder(id)).toBe('requeued')
    expect(episodic.listReminders().find((r) => r.id === id)?.attempts).toBe(2)

    // A subsequent successful delivery escalates -> attempts must reset to 0,
    // otherwise one more lifetime failure would flip the row to terminal 'failed'.
    episodic.markReminderFired(id)
    episodic.escalateReminder(id, new Date(Date.now() + 15 * 60_000))
    expect(episodic.listReminders().find((r) => r.id === id)?.attempts).toBe(0)
  })

  it('dueReminders honors next_remind_at: a future re-fire is not due even with a past fire_at', () => {
    const id = episodic.createReminder('nag', new Date(Date.now() - 10_000), 'msg', { escalating: true })
    episodic.markReminderFired(id)
    episodic.escalateReminder(id, new Date(Date.now() + 3_600_000)) // 1h out
    expect(episodic.dueReminders().map((r) => r.id)).not.toContain(id)
  })

  it('dueReminders selects a row whose next_remind_at is in the past', () => {
    const id = episodic.createReminder('nag', new Date(Date.now() - 10_000), 'msg', { escalating: true })
    episodic.markReminderFired(id)
    episodic.escalateReminder(id, new Date(Date.now() - 1_000)) // past
    expect(episodic.dueReminders().map((r) => r.id)).toContain(id)
  })
})

describe('listReminders', () => {
  it('listReminders("pending") returns only pending rows', () => {
    // Create one pending and one cancelled
    const pendingId = episodic.createReminder(
      'list pending test',
      new Date(Date.now() + 7_200_000),
      'List test — pending',
    )
    const cancelId = episodic.createReminder(
      'list cancel test',
      new Date(Date.now() + 7_200_000),
      'List test — cancel',
    )
    episodic.cancelReminder(cancelId)

    const pending = episodic.listReminders('pending')
    const pendingIds = pending.map((r) => r.id)

    expect(pendingIds).toContain(pendingId)
    expect(pendingIds).not.toContain(cancelId)
    for (const row of pending) {
      expect(row.status).toBe('pending')
    }
  })

  it('listReminders() with no filter returns rows of multiple statuses', () => {
    // Create a fired row and a pending row
    const firedId = episodic.createReminder(
      'all-list fired',
      new Date(Date.now() - 2_000),
      'All list — fired',
    )
    const pendingId = episodic.createReminder(
      'all-list pending',
      new Date(Date.now() + 3_600_000),
      'All list — pending',
    )
    episodic.markReminderFired(firedId)

    const all = episodic.listReminders()
    const allIds = all.map((r) => r.id)

    expect(allIds).toContain(firedId)
    expect(allIds).toContain(pendingId)

    const statuses = new Set(all.map((r) => r.status))
    // Both 'fired' and 'pending' must be present
    expect(statuses.has('fired')).toBe(true)
    expect(statuses.has('pending')).toBe(true)
  })
})
