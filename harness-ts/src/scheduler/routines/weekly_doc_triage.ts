// weekly_doc_triage: Saturday document sweep routine.
// Dispatches the doc-steward agent to check Downloads aging, large files,
// and recent iCloud Drive activity.

import { log } from 'ion-sdk'
import { isEnabled } from '../helpers'
import { OBSERVER_DECISION_FRAMEWORK } from '../helpers'
import { dispatchObserver } from './_dispatch'

export async function runWeeklyDocTriage(): Promise<void> {
  if (!isEnabled('weekly_doc_triage')) return

  const prompt =
    'Standing weekly Document Steward triage. Dispatch the Document Steward now. ' +
    'Run the following checks using available shell tools: ' +
    '1. Check ~/Downloads/ for any items older than 7 days and list them. ' +
    '2. Find unusually large files (> 500 MB) in ~/Downloads/, ~/Documents/, and ~/Desktop/. ' +
    '3. Check for recent iCloud Drive activity via mdfind: ' +
    '   mdfind -onlyin ~/Library/Mobile\\ Documents/ "kMDItemFSContentChangeDate > $time.now(-7d)" ' +
    'Surface findings via surface_to_inbox if any items need attention. ' +
    OBSERVER_DECISION_FRAMEWORK

  try {
    await dispatchObserver('weekly_doc_triage', 'doc-steward', prompt)
  } catch (err) {
    log.warn('scheduler: weekly_doc_triage failed', { err: String(err) })
  }
}
