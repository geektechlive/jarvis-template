// Habit tracking CRUD + stats (#546).
// Lightweight habit log so the Wellness Coach can reference real completion data
// during check-ins instead of asking open-ended questions. All timezone math is
// in America/Chicago (the Mini's local zone) so "this week" and day streaks line
// up with the user's actual days.

import { randomUUID } from 'node:crypto'
import { log } from 'ion-sdk'
import { db, now } from './base'

const TZ = 'America/Chicago'

export interface HabitRow {
  id: string
  name: string
  category: string | null
  target_per_week: number
  active: number
  created_at: string
}

export interface HabitStats {
  id: string
  name: string
  category: string | null
  target_per_week: number
  /** Completions since the start of the current week (Mon 00:00 Chicago). */
  completions_this_week: number
  /** Completions within the requested rolling window. */
  completions_in_window: number
  /** Consecutive calendar days (Chicago) with at least one completion, ending today or yesterday. */
  streak_days: number
  last_logged_at: string | null
}

// ---------------------------------------------------------------------------
// Chicago-local date helpers (YYYY-MM-DD day keys)
// ---------------------------------------------------------------------------

/** YYYY-MM-DD for an ISO timestamp, in America/Chicago. */
function chicagoDayKey(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ })
}

/** Today's YYYY-MM-DD in America/Chicago. */
function todayKey(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: TZ })
}

/** Shift a YYYY-MM-DD key by `delta` days (parsed at UTC noon to avoid DST drift). */
function shiftDayKey(key: string, delta: number): string {
  const d = new Date(`${key}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + delta)
  return d.toISOString().slice(0, 10)
}

/**
 * ISO timestamp for the start of the current week (Monday 00:00 America/Chicago).
 * Returns the UTC instant of that local midnight so it compares correctly against
 * stored UTC `logged_at` values — using a literal `T00:00Z` would misbucket the
 * ~5-6h Chicago/UTC offset around the week boundary.
 */
function startOfWeekIso(): string {
  const today = todayKey()
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay() // 0=Sun..6=Sat
  const daysSinceMonday = (weekday + 6) % 7
  const monday = shiftDayKey(today, -daysSinceMonday)
  return chicagoMidnightUtc(monday)
}

/**
 * UTC ISO instant of local midnight (America/Chicago) for a YYYY-MM-DD day key.
 *
 * Computes Chicago's UTC offset for the day via Intl.DateTimeFormat#formatToParts
 * rather than parsing a toLocaleString() output with new Date() — the latter is
 * implementation-defined and silently wrong on any host not set to Chicago (#832).
 * Exported for the timezone-independence regression test.
 */
export function chicagoMidnightUtc(dayKey: string): string {
  // Sample noon UTC (safely inside the day for any plausible offset) and read its
  // Chicago wall-clock parts. offset = (Chicago wall as if UTC) - actual instant;
  // negative for Chicago (behind UTC). Local midnight is |offset| after 00:00 UTC.
  const noon = new Date(`${dayKey}T12:00:00Z`)
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const p = Object.fromEntries(dtf.formatToParts(noon).map(({ type, value }) => [type, value]))
  let hour = Number(p['hour'])
  if (hour === 24) hour = 0 // some engines emit '24' for midnight
  const chicagoWallMs = Date.UTC(
    Number(p['year']),
    Number(p['month']) - 1,
    Number(p['day']),
    hour,
    Number(p['minute']),
    Number(p['second']),
  )
  const offsetMs = chicagoWallMs - noon.getTime()
  const naiveMidnightUtc = new Date(`${dayKey}T00:00:00Z`).getTime()
  return new Date(naiveMidnightUtc - offsetMs).toISOString()
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

function rowToHabit(r: Record<string, unknown>): HabitRow {
  return {
    id: String(r['id']),
    name: String(r['name']),
    category: r['category'] == null ? null : String(r['category']),
    target_per_week: Number(r['target_per_week'] ?? 1),
    active: Number(r['active'] ?? 1),
    created_at: String(r['created_at']),
  }
}

/** Define a new habit. Returns the created row. */
export function createHabit(name: string, category?: string, targetPerWeek = 1): HabitRow {
  const id = randomUUID()
  const ts = now()
  const target = Number.isFinite(targetPerWeek) && targetPerWeek > 0 ? Math.trunc(targetPerWeek) : 1
  db().prepare(`
    INSERT INTO habits (id, name, category, target_per_week, active, created_at)
    VALUES (?, ?, ?, ?, 1, ?)
  `).run(id, name.trim(), category?.trim() || null, target, ts)
  return { id, name: name.trim(), category: category?.trim() || null, target_per_week: target, active: 1, created_at: ts }
}

/** List habits, active-only by default. */
export function listHabits(activeOnly = true): HabitRow[] {
  const sql = activeOnly
    ? `SELECT * FROM habits WHERE active = 1 ORDER BY created_at ASC`
    : `SELECT * FROM habits ORDER BY created_at ASC`
  return (db().prepare(sql).all() as Record<string, unknown>[]).map(rowToHabit)
}

/**
 * Resolve a habit by id or fuzzy name match (active habits only).
 * Match precedence: exact id → case-insensitive exact name → startsWith → includes.
 * Returns null when nothing matches.
 */
export function findHabit(nameOrId: string): HabitRow | null {
  const q = nameOrId.trim().toLowerCase()
  if (!q) return null
  const habits = listHabits(true)
  const byId = habits.find(h => h.id.toLowerCase() === q)
  if (byId) return byId
  const exact = habits.find(h => h.name.toLowerCase() === q)
  if (exact) return exact
  const starts = habits.find(h => h.name.toLowerCase().startsWith(q))
  if (starts) return starts
  const includes = habits.find(h => h.name.toLowerCase().includes(q) || q.includes(h.name.toLowerCase()))
  return includes ?? null
}

export type LogHabitResult =
  | { ok: true; habit: HabitRow; completionId: string }
  | { ok: false; error: string; available: string[] }

/** Log a completion for a habit, fuzzy-matched by name (or id). */
export function logHabitCompletion(nameOrId: string, notes?: string, count = 1): LogHabitResult {
  const habit = findHabit(nameOrId)
  if (!habit) {
    return { ok: false, error: `No active habit matches "${nameOrId}".`, available: listHabits(true).map(h => h.name) }
  }
  const id = randomUUID()
  const c = Number.isFinite(count) && count > 0 ? Math.trunc(count) : 1
  db().prepare(`
    INSERT INTO habit_completions (id, habit_id, logged_at, notes, count)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, habit.id, now(), notes?.trim() || null, c)
  return { ok: true, habit, completionId: id }
}

/** Deactivate a habit (kept for history; excluded from active lists/stats). */
export function deactivateHabit(nameOrId: string): boolean {
  const habit = findHabit(nameOrId)
  if (!habit) return false
  const r = db().prepare(`UPDATE habits SET active = 0 WHERE id = ?`).run(habit.id)
  return r.changes > 0
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

function completionTimestamps(habitId: string, sinceIso?: string): string[] {
  const rows = sinceIso
    ? db().prepare(`SELECT logged_at FROM habit_completions WHERE habit_id = ? AND logged_at >= ? ORDER BY logged_at ASC`).all(habitId, sinceIso)
    : db().prepare(`SELECT logged_at FROM habit_completions WHERE habit_id = ? ORDER BY logged_at ASC`).all(habitId)
  return (rows as Array<{ logged_at: string }>).map(r => r.logged_at)
}

/** Consecutive calendar days (Chicago) with a completion, ending today or yesterday. */
function streakDays(timestamps: string[]): number {
  if (timestamps.length === 0) return 0
  const days = new Set(timestamps.map(chicagoDayKey))
  let cursor = todayKey()
  if (!days.has(cursor)) {
    cursor = shiftDayKey(cursor, -1)
    if (!days.has(cursor)) return 0 // streak broken (nothing today or yesterday)
  }
  let streak = 0
  while (days.has(cursor)) {
    streak++
    cursor = shiftDayKey(cursor, -1)
  }
  return streak
}

function statsForHabit(habit: HabitRow, windowDays: number): HabitStats {
  const all = completionTimestamps(habit.id)
  const weekStart = startOfWeekIso()
  const windowStart = new Date(Date.now() - windowDays * 86_400_000).toISOString()
  const completionsThisWeek = all.filter(ts => ts >= weekStart).length
  const completionsInWindow = all.filter(ts => ts >= windowStart).length
  return {
    id: habit.id,
    name: habit.name,
    category: habit.category,
    target_per_week: habit.target_per_week,
    completions_this_week: completionsThisWeek,
    completions_in_window: completionsInWindow,
    streak_days: streakDays(all),
    last_logged_at: all.length ? all[all.length - 1] ?? null : null,
  }
}

/** Stats for every active habit (used by the Wellness Coach check-in). */
export function getHabitsWithStats(windowDays = 7): HabitStats[] {
  try {
    return listHabits(true).map(h => statsForHabit(h, windowDays))
  } catch (err) {
    log.warn('episodic: getHabitsWithStats failed', { err: String(err) })
    return []
  }
}

/** Detailed stats for a single habit, fuzzy-matched by name. Null if no match. */
export function getHabitStats(nameOrId: string, windowDays = 30): HabitStats | null {
  const habit = findHabit(nameOrId)
  if (!habit) return null
  return statsForHabit(habit, windowDays)
}
