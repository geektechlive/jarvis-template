import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDb } from './base'
import {
  insertGoal,
  goalsDueNow,
  markGoalFailed,
  markGoalSucceeded,
  listGoals,
  MAX_GOAL_FAILURES,
} from './goals'

// Integration test against a throwaway SQLite DB. Exercises the auto-retry-with-cap
// policy: blocked goals stay schedulable until the failure streak hits the cap,
// and a success re-activates the goal and clears the streak.

let dataDir: string
let prevDataDir: string | undefined

beforeEach(() => {
  prevDataDir = process.env['AGENT_DATA_DIR']
  dataDir = mkdtempSync(join(tmpdir(), 'jarvis-goals-'))
  process.env['AGENT_DATA_DIR'] = dataDir
  closeDb() // force a fresh connection bound to the temp dir
})

afterEach(() => {
  closeDb()
  if (prevDataDir === undefined) delete process.env['AGENT_DATA_DIR']
  else process.env['AGENT_DATA_DIR'] = prevDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

function statusOf(id: number): string {
  return listGoals().find((g) => g.id === id)!.status
}

describe('goal auto-retry with cap', () => {
  it('selects a freshly inserted active goal', () => {
    const id = insertGoal('test goal', 'daily', 'admin', 5, 30)
    const due = goalsDueNow()
    expect(due.map((g) => g.id)).toContain(id)
    expect(statusOf(id)).toBe('active')
  })

  it('keeps a blocked goal schedulable until the failure cap, then parks it', () => {
    const id = insertGoal('flaky goal', 'daily', 'admin', 5, 30)

    // First failure: blocked, but still due immediately (past next_run_at).
    const c1 = markGoalFailed(id, new Date(Date.now() - 1000).toISOString())
    expect(c1).toBe(1)
    expect(statusOf(id)).toBe('blocked')
    expect(goalsDueNow().map((g) => g.id)).toContain(id)

    // Walk the streak up to one below the cap; still schedulable each time.
    let count = c1
    while (count < MAX_GOAL_FAILURES - 1) {
      count = markGoalFailed(id, new Date(Date.now() - 1000).toISOString())
      expect(goalsDueNow().map((g) => g.id)).toContain(id)
    }

    // The failure that reaches the cap parks the goal: no longer selected.
    const capped = markGoalFailed(id, new Date(Date.now() - 1000).toISOString())
    expect(capped).toBe(MAX_GOAL_FAILURES)
    expect(statusOf(id)).toBe('blocked')
    expect(goalsDueNow().map((g) => g.id)).not.toContain(id)
  })

  it('does not select a blocked goal whose next_run_at is still in the future', () => {
    const id = insertGoal('future goal', 'weekly', 'admin', 5, 30)
    markGoalFailed(id, new Date(Date.now() + 86_400_000).toISOString())
    expect(goalsDueNow().map((g) => g.id)).not.toContain(id)
  })

  it('re-activates and clears the failure streak on success', () => {
    const id = insertGoal('recovering goal', 'daily', 'admin', 5, 30)

    // Fail up to the cap so it is parked.
    for (let i = 0; i < MAX_GOAL_FAILURES; i++) {
      markGoalFailed(id, new Date(Date.now() - 1000).toISOString())
    }
    expect(goalsDueNow().map((g) => g.id)).not.toContain(id)

    // A success resets the counter and flips status back to active.
    markGoalSucceeded(id, new Date(Date.now() - 1000).toISOString())
    expect(statusOf(id)).toBe('active')
    expect(goalsDueNow().map((g) => g.id)).toContain(id)

    // And a subsequent single failure starts the streak over from 1.
    expect(markGoalFailed(id, new Date(Date.now() - 1000).toISOString())).toBe(1)
  })
})
