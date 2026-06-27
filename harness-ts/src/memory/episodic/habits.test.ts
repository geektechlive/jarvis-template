import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDb, db } from './base'
import {
  createHabit,
  logHabitCompletion,
  listHabits,
  findHabit,
  deactivateHabit,
  getHabitsWithStats,
  getHabitStats,
  chicagoMidnightUtc,
} from './habits'

// Integration test against a throwaway SQLite DB. Exercises CRUD, fuzzy match,
// and the stats/streak math. Completions are inserted directly with controlled
// timestamps where the test needs specific days.

let dataDir: string
let prevDataDir: string | undefined

beforeEach(() => {
  prevDataDir = process.env['AGENT_DATA_DIR']
  dataDir = mkdtempSync(join(tmpdir(), 'jarvis-habits-'))
  process.env['AGENT_DATA_DIR'] = dataDir
  closeDb()
})

afterEach(() => {
  closeDb()
  if (prevDataDir === undefined) delete process.env['AGENT_DATA_DIR']
  else process.env['AGENT_DATA_DIR'] = prevDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

// Insert a completion at a specific ISO timestamp (bypasses logHabitCompletion's "now").
function seedCompletion(habitId: string, iso: string): void {
  db().prepare(
    `INSERT INTO habit_completions (id, habit_id, logged_at, count) VALUES (?, ?, ?, 1)`,
  ).run(`${habitId}-${iso}`, habitId, iso)
}

describe('chicagoMidnightUtc (#832)', () => {
  // These exact UTC instants are correct independent of the host's system timezone
  // because the function uses Intl with an explicit America/Chicago zone + absolute
  // UTC math. The previous toLocaleString()+new Date() version produced wrong values
  // on any non-Chicago host (e.g. CI under UTC).
  it('maps summer (CDT, UTC-5) local midnight to 05:00Z', () => {
    expect(chicagoMidnightUtc('2026-06-17')).toBe('2026-06-17T05:00:00.000Z')
  })

  it('maps winter (CST, UTC-6) local midnight to 06:00Z', () => {
    expect(chicagoMidnightUtc('2026-01-15')).toBe('2026-01-15T06:00:00.000Z')
  })
})

describe('habit CRUD', () => {
  it('creates and lists habits', () => {
    createHabit('workout', 'fitness', 5)
    createHabit('meditation', 'health', 7)
    const habits = listHabits(true)
    expect(habits).toHaveLength(2)
    expect(habits.map(h => h.name)).toContain('workout')
    expect(habits.find(h => h.name === 'workout')?.target_per_week).toBe(5)
  })

  it('defaults target_per_week to 1 and clamps invalid targets', () => {
    const h = createHabit('floss')
    expect(h.target_per_week).toBe(1)
    const h2 = createHabit('stretch', undefined, -3)
    expect(h2.target_per_week).toBe(1)
  })

  it('deactivates a habit so it drops out of active lists', () => {
    createHabit('soda-free')
    expect(deactivateHabit('soda-free')).toBe(true)
    expect(listHabits(true)).toHaveLength(0)
    expect(listHabits(false)).toHaveLength(1)
  })
})

describe('findHabit fuzzy match', () => {
  beforeEach(() => {
    createHabit('morning workout', 'fitness', 5)
    createHabit('meditation', 'health', 7)
  })

  it('matches case-insensitively and by substring', () => {
    expect(findHabit('MEDITATION')?.name).toBe('meditation')
    expect(findHabit('workout')?.name).toBe('morning workout')
  })

  it('returns null when nothing matches', () => {
    expect(findHabit('skydiving')).toBeNull()
  })
})

describe('logHabitCompletion', () => {
  it('logs against a fuzzy-matched habit', () => {
    createHabit('workout', 'fitness', 5)
    const res = logHabitCompletion('work', 'felt great')
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.habit.name).toBe('workout')
  })

  it('returns an error with the available habit names when no match', () => {
    createHabit('workout', 'fitness', 5)
    const res = logHabitCompletion('nonexistent')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.available).toContain('workout')
  })
})

describe('stats and streak', () => {
  it('counts completions this week and reports a day streak', () => {
    const h = createHabit('workout', 'fitness', 5)
    // Seed completions for today and the two prior days (Chicago) → 3-day streak.
    const now = new Date()
    for (let i = 0; i < 3; i++) {
      const d = new Date(now.getTime() - i * 86_400_000)
      seedCompletion(h.id, d.toISOString())
    }
    const stats = getHabitStats('workout', 30)
    expect(stats).not.toBeNull()
    expect(stats!.streak_days).toBeGreaterThanOrEqual(3)
    expect(stats!.completions_in_window).toBe(3)
    expect(stats!.last_logged_at).not.toBeNull()
  })

  it('reports zero streak when there is a gap before today and yesterday', () => {
    const h = createHabit('reading')
    // A completion 5 days ago only — streak should be 0 (nothing today/yesterday).
    seedCompletion(h.id, new Date(Date.now() - 5 * 86_400_000).toISOString())
    const stats = getHabitStats('reading', 30)
    expect(stats!.streak_days).toBe(0)
    expect(stats!.completions_in_window).toBe(1)
  })

  it('getHabitsWithStats returns a row per active habit', () => {
    createHabit('a')
    createHabit('b')
    const all = getHabitsWithStats(7)
    expect(all).toHaveLength(2)
    expect(all.every(s => s.completions_this_week === 0)).toBe(true)
  })
})
