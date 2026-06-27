// home_maintenance_check: weekly property sweep routine.
// Dispatches the home-property agent to scan harness/data/property.yaml
// for overdue maintenance items and surface via inbox.

import { log } from 'ion-sdk'
import { isEnabled } from '../helpers'
import { OBSERVER_DECISION_FRAMEWORK } from '../helpers'
import { dispatchObserver } from './_dispatch'

export async function runHomeMaintenanceCheck(): Promise<void> {
  if (!isEnabled('home_maintenance_check')) return

  const prompt =
    'Standing weekly Home/Property maintenance sweep. Dispatch the Home Property Manager now. ' +
    'Read the property file at the absolute path /Users/<username>/Library/Mobile Documents/com~apple~CloudDocs/Jarvis/property/property.yaml (quote it in Bash; the path has a space). ' +
    'If the file does not exist or contains no maintenance schedule data, ' +
    'surface a one-time setup hint via surface_to_inbox: ' +
    '"property.yaml has no maintenance schedule data yet — add HVAC, appliance, and service ' +
    'intervals when you get a chance." Then stop. ' +
    'If the file exists with maintenance data: ' +
    'identify any overdue maintenance items based on their last-serviced date and recommended interval ' +
    '(e.g. HVAC filter, appliance service, seasonal tasks). ' +
    'Surface overdue items via surface_to_inbox. ' +
    OBSERVER_DECISION_FRAMEWORK

  try {
    await dispatchObserver('home_maintenance_check', 'home-property', prompt)
  } catch (err) {
    log.warn('scheduler: home_maintenance_check failed', { err: String(err) })
  }
}
