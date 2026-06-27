import type { IonSDK } from 'ion-sdk'
import { registerWorkflowCommands } from './workflow'
import { registerMemoryCommands } from './memory'
import { registerActionCommands } from './actions'
import { registerStaffCommands } from './staff'
import { registerReminderCommands } from './reminders'
import { registerSchedulerCommands } from './scheduler'
import { registerMattersCommands } from './matters'
import { registerColdArchiveCommands } from './cold-archive'
import { registerCiCommands } from './ci'
import { registerInterestsCommands } from './interests'
import { registerFeedbackCommands } from './feedback'
import { registerIssueCommands } from './issues'
import { registerHabitsCommands } from './habits'

// Register all slash commands. Order matches the original
// monolithic extension.ts: workflow -> memory -> actions -> staff.
export function registerCommands(ion: IonSDK): void {
  registerWorkflowCommands(ion)
  registerMemoryCommands(ion)
  registerFeedbackCommands(ion)
  registerActionCommands(ion)
  registerStaffCommands(ion)
  registerReminderCommands(ion)
  registerSchedulerCommands(ion)
  registerMattersCommands(ion)
  registerColdArchiveCommands(ion)
  registerCiCommands(ion)
  registerInterestsCommands(ion)
  registerIssueCommands(ion)
  registerHabitsCommands(ion)
}
