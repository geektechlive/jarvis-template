import type { IonSDK } from 'ion-sdk'
import { logEvent, getHabitsWithStats, type HabitStats } from '../../memory/episodic'

function formatLine(s: HabitStats): string {
  const cat = s.category ? ` [${s.category}]` : ''
  const streak = s.streak_days > 0 ? `, 🔥 ${s.streak_days}d` : ''
  const onTrack = s.completions_this_week >= s.target_per_week ? ' ✓' : ''
  return `• ${s.name}${cat}: ${s.completions_this_week}/${s.target_per_week} this week${streak}${onTrack}`
}

// /habits — show today's habit status inline in chat (#546).
export function registerHabitsCommands(ion: IonSDK): void {
  ion.registerCommand('habits', {
    description: 'Show tracked habits with this-week completion counts vs target and current streaks.',
    execute: async (_args) => {
      const stats = getHabitsWithStats(7)
      const text = stats.length === 0
        ? 'No habits are being tracked yet. Ask me to start tracking one (e.g. "track my workouts, target 5 a week").'
        : `Habits this week:\n${stats.map(formatLine).join('\n')}`
      logEvent('habits', 'inbox_item', { routine: 'habits', text })
    },
  })
}
