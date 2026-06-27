// contacts_pulse: weekly relationship surface routine.
// Dispatches the contacts-manager agent to scan harness/data/contacts.yaml
// for upcoming birthdays/anniversaries (next 14 days) and overdue contacts
// (last_contact > 60 days). Surfaces findings or goes silent.

import { log } from 'ion-sdk'
import { isEnabled } from '../helpers'
import { OBSERVER_DECISION_FRAMEWORK } from '../helpers'
import { dispatchObserver } from './_dispatch'

export async function runContactsPulse(): Promise<void> {
  if (!isEnabled('contacts_pulse')) return

  const prompt =
    'Standing weekly Contacts Pulse pass. Dispatch the Contacts Manager now. ' +
    'Read the contacts file at the absolute path /Users/<username>/Library/Mobile Documents/com~apple~CloudDocs/Jarvis/contacts/contacts.yaml (quote it in Bash; the path has a space). ' +
    'If the file does not exist or has no birthday, anniversary, or last_contact fields, ' +
    'surface a one-time setup hint via surface_to_inbox: ' +
    '"Your contacts.yaml has no birthday/anniversary/last_contact data yet — ' +
    'add it when you next reach out to someone." Then stop with no further output. ' +
    'If the file does exist with those fields: ' +
    'identify any contacts whose birthday or anniversary falls in the next 14 days, ' +
    'and any contacts with a last_contact date older than 60 days. ' +
    'Surface via surface_to_inbox if any such contacts exist. ' +
    OBSERVER_DECISION_FRAMEWORK

  try {
    await dispatchObserver('contacts_pulse', 'contacts-manager', prompt)
  } catch (err) {
    log.warn('scheduler: contacts_pulse failed', { err: String(err) })
  }
}
