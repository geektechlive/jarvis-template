import type { IonSDK } from 'ion-sdk'
import { createReminder, cancelReminder, listReminders, logEvent } from '../../memory/episodic'
import { parseReminderInput, formatReminderConfirmation } from '../../reminders/parse'

export function registerReminderCommands(ion: IonSDK): void {
  ion.registerCommand('remind', {
    description: 'Manage reminders. Usage: /remind <natural language> | list [all] | cancel <id>',
    execute: async (args: string) => {
      const trimmed = args.trim()

      // /remind list [all]
      if (/^list(\s+all)?$/i.test(trimmed)) {
        const showAll = /all/i.test(trimmed)
        const rows = listReminders(showAll ? undefined : 'pending')
        if (rows.length === 0) {
          logEvent('remind', 'inbox_item', {
            routine: 'remind',
            text: showAll ? 'No reminders found.' : 'No pending reminders.',
          })
          return
        }
        const lines = rows.map(r => {
          const dt = new Date(r.fire_at).toLocaleString('en-US', {
            timeZone: 'America/Chicago',
            weekday: 'short', month: 'short', day: 'numeric',
            hour: 'numeric', minute: '2-digit', hour12: true,
          })
          return `#${r.id} [${r.status}] ${dt} CT — ${r.message}`
        })
        logEvent('remind', 'inbox_item', { routine: 'remind', text: lines.join('\n') })
        return
      }

      // /remind cancel <id>
      const cancelMatch = /^cancel\s+(\d+)$/i.exec(trimmed)
      if (cancelMatch) {
        const id = parseInt(cancelMatch[1] ?? '0', 10)
        const ok = cancelReminder(id)
        logEvent('remind', 'inbox_item', {
          routine: 'remind',
          text: ok
            ? `Reminder #${id} cancelled.`
            : `Reminder #${id} not found or already completed.`,
        })
        return
      }

      // /remind <natural language>
      if (!trimmed) {
        logEvent('remind', 'inbox_item', {
          routine: 'remind',
          text: 'Usage: /remind <natural language time + message> | list [all] | cancel <id>',
        })
        return
      }
      const parsed = parseReminderInput(trimmed)
      if (!parsed) {
        logEvent('remind', 'inbox_item', {
          routine: 'remind',
          text: "Couldn't parse a future time from that. Try: /remind in 2 hours to call the dentist",
        })
        return
      }
      const id = createReminder(trimmed, parsed.fire_at, parsed.message)
      logEvent('remind', 'inbox_item', {
        routine: 'remind',
        text: formatReminderConfirmation(id, parsed.fire_at, parsed.message),
      })
    },
  })
}
