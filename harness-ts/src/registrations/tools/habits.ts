import type { IonSDK } from 'ion-sdk'
import {
  createHabit,
  logHabitCompletion,
  getHabitsWithStats,
  getHabitStats,
  type HabitStats,
} from '../../memory/episodic'

// Render one habit's stats as a compact, coach-readable line.
function formatStatLine(s: HabitStats): string {
  const cat = s.category ? ` [${s.category}]` : ''
  const streak = s.streak_days > 0 ? `, streak ${s.streak_days}d` : ''
  return `${s.name}${cat}: ${s.completions_this_week} this week (target ${s.target_per_week}/wk)${streak}`
}

// R13: habit tracking tools (#546)
export function registerHabitToolsR13(ion: IonSDK): void {
  ion.registerTool({
    name: 'create_habit',
    description:
      'Define a new habit to track for Alex. ' +
      'Use when Alex says he wants to start tracking something (e.g. "track my workouts, target 5 a week").',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Habit name, e.g. "workout", "meditation", "water intake".' },
        category: { type: 'string', description: "Optional category: 'fitness', 'health', 'productivity', or 'personal'." },
        target_per_week: { type: 'number', description: 'Weekly completion target (default 1).' },
      },
      required: ['name'],
    },
    execute: async (params) => {
      const target = typeof params['target_per_week'] === 'number' ? params['target_per_week'] : 1
      const habit = createHabit(
        params['name'] as string,
        params['category'] as string | undefined,
        target,
      )
      return { content: `Tracking "${habit.name}" (target ${habit.target_per_week}/week).` }
    },
  })

  ion.registerTool({
    name: 'log_habit',
    description:
      'Log a completion of one of Alex\'s habits. Fuzzy-matches the habit by name. ' +
      'Use when Alex mentions doing a tracked activity ("I worked out today", "did my meditation").',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Habit name to log (fuzzy-matched against existing habits).' },
        notes: { type: 'string', description: 'Optional note about this completion.' },
        count: { type: 'number', description: 'Number of completions to log (default 1).' },
      },
      required: ['name'],
    },
    execute: async (params) => {
      const count = typeof params['count'] === 'number' ? params['count'] : 1
      const result = logHabitCompletion(
        params['name'] as string,
        params['notes'] as string | undefined,
        count,
      )
      if (!result.ok) {
        const avail = result.available.length ? ` Known habits: ${result.available.join(', ')}.` : ' No habits defined yet.'
        return { content: `${result.error}${avail}`, isError: true }
      }
      return { content: `Logged "${result.habit.name}".` }
    },
  })

  ion.registerTool({
    name: 'get_habits',
    description:
      "Get all of Alex's tracked habits with completion stats (this-week count vs target, streak). " +
      'Call this at the start of a wellness check-in to ground it in real data.',
    parameters: {
      type: 'object',
      properties: {
        window_days: { type: 'number', description: 'Rolling window for the in-window completion count (default 7).' },
      },
      required: [],
    },
    execute: async (params) => {
      const windowDays = typeof params['window_days'] === 'number' ? params['window_days'] : 7
      const stats = getHabitsWithStats(windowDays)
      if (stats.length === 0) return { content: 'No habits are being tracked yet.' }
      return { content: stats.map(formatStatLine).join('\n') }
    },
  })

  ion.registerTool({
    name: 'habit_stats',
    description:
      'Get detailed stats for one specific habit (fuzzy-matched by name): this-week count, ' +
      'in-window count, day streak, and last-logged time.',
    parameters: {
      type: 'object',
      properties: {
        habit_name: { type: 'string', description: 'The habit to look up.' },
        window_days: { type: 'number', description: 'Rolling window in days (default 30).' },
      },
      required: ['habit_name'],
    },
    execute: async (params) => {
      const windowDays = typeof params['window_days'] === 'number' ? params['window_days'] : 30
      const stats = getHabitStats(params['habit_name'] as string, windowDays)
      if (!stats) return { content: `No habit matches "${params['habit_name'] as string}".`, isError: true }
      return { content: JSON.stringify(stats) }
    },
  })
}
