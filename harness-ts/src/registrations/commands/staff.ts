import type { IonSDK } from 'ion-sdk'
import { logEvent, recentAgentEvents } from '../../memory/episodic'
import { loadStaff } from '../../config'
import { runReflection } from '../../reflection'

// Staff slash commands: /list-staff, /staff-log, /reflect.
export function registerStaffCommands(ion: IonSDK): void {
  ion.registerCommand('list-staff', {
    description: 'List active staff members.',
    execute: async () => {
      const staff = loadStaff().filter((s) => s.status === 'active')
      if (!staff.length) {
        logEvent('list-staff', 'inbox_item', { routine: 'list-staff', text: 'No active staff found.' })
        return
      }
      const lines = staff.map(
        (s) => `[${s.id}] ${s.title} -- ${s.specialties.slice(0, 3).join(', ')}`,
      )
      logEvent('list-staff', 'inbox_item', {
        routine: 'list-staff',
        text: `Active staff (${staff.length}):\n${lines.join('\n')}`,
      })
    },
  })

  ion.registerCommand('staff-log', {
    description: 'Show recent staff activity events. Usage: staff-log [n]',
    execute: async (args) => {
      const n = parseInt(args.trim(), 10) || 10
      const events = recentAgentEvents(n * 3).filter((e) => {
        const evt = e.event
        return (
          evt === 'staff_proposal' ||
          evt === 'goal_started' ||
          evt === 'goal_completed' ||
          evt === 'goal_blocked' ||
          evt === 'panel_run' ||
          evt === 'clarification_resolved' ||
          evt === 'reflection_complete' ||
          evt === 'meeting_prepped' ||
          evt === 'routine_delivered'
        )
      }).slice(0, n)
      if (!events.length) {
        logEvent('staff-log', 'inbox_item', { routine: 'staff-log', text: 'No recent staff activity.' })
        return
      }
      const lines = events.map((e) => {
        const detail = e.detail ? ` -- ${JSON.stringify(e.detail).slice(0, 60)}` : ''
        return `[${e.ts.slice(0, 16)}] ${e.event}${detail}`
      })
      logEvent('staff-log', 'inbox_item', {
        routine: 'staff-log',
        text: `Recent staff activity (${events.length}):\n${lines.join('\n')}`,
      })
    },
  })

  // ---------------------------------------------------------------------------
  // Reflect command
  // ---------------------------------------------------------------------------

  ion.registerCommand('reflect', {
    description: 'Manual reflection escape hatch -- runs the panel via ctx.dispatchAgent. Background execution; result lands in agent_events when done.',
    execute: async (_args, ctx) => {
      logEvent('reflect', 'inbox_item', {
        routine: 'reflect',
        text: 'Reflection panel running (manual trigger)...',
      })
      // Background promise -- panel cannot complete in Ion's 30s command budget.
      void runReflection(ctx, 'default')
        .then((stored) => {
          const msg = stored.length > 0
            ? `Reflection complete. ${stored.length} fact(s) stored in user_profile.`
            : 'Reflection complete. No new facts to store (all near-duplicates or no messages).'
          logEvent('reflect', 'inbox_item', { routine: 'reflect', text: msg })
        })
        .catch((err: unknown) => {
          logEvent('reflect', 'inbox_item', {
            routine: 'reflect',
            text: `Reflection failed: ${String(err)}`,
          })
        })
    },
  })
}
