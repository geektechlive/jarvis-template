// commit_activity_summary: Friday weekly commit activity summary routine.
// Dispatches the Chief of Strategy to review recent commits across all Source projects
// and surface a synthesis of what moved, what stalled, and what has not been touched.

import * as os from 'node:os'
import { log } from 'ion-sdk'
import { logEvent } from '../../memory/episodic'
import { isEnabled } from '../helpers'
import { OBSERVER_DECISION_FRAMEWORK } from '../helpers'
import { runCommandAsync } from '../../util/ionPrompt'
import { dispatchObserver } from './_dispatch'

const JARVIS_REPO = `${os.homedir()}/Jarvis`

export async function runCommitActivitySummary(): Promise<void> {
  if (!isEnabled('commit_activity_summary')) return

  // Gather the last 7 days of commits from the Jarvis repo as a concrete anchor.
  // The Chief of Strategy will supplement this with cross-repo context from Repo Steward.
  let commitLog = ''
  try {
    const r = await runCommandAsync('git', [
      '-C', JARVIS_REPO,
      'log', '--since=7.days', '--oneline', '--all',
    ], { timeoutMs: 15_000 })
    commitLog = r.stdout.trim()
  } catch (err) {
    log.warn('scheduler: commit_activity_summary: git log failed', { err: String(err) })
  }

  if (!commitLog) {
    log.info('scheduler: commit_activity_summary: no commits this week, surfacing notice')
    logEvent('commit_activity_summary', 'routine_delivered', {
      routine: 'commit_activity_summary',
      skipped: true,
    })
    await dispatchObserver(
      'commit_activity_summary',
      'chief-of-strategy',
      'Standing weekly commit activity summary pass. ' +
      'The Jarvis repository shows no commits in the last 7 days. ' +
      'Convene the Repo Steward to confirm whether the other Source projects ' +
      '(ion, <your-org>-www, example-app, ExampleApp, ExampleApp, ExampleApp) are similarly quiet. ' +
      'Surface a one-line inbox item: "No commits this week across tracked repositories." ' +
      'Use surface_to_inbox. ' +
      OBSERVER_DECISION_FRAMEWORK,
    )
    return
  }

  const prompt =
    'Standing weekly commit activity summary pass. Dispatch the Chief of Strategy now. ' +
    'She should convene the Repo Steward to review recent commit activity across all Source projects ' +
    '(Jarvis, ion, <your-org>-www, example-app, ExampleApp, ExampleApp, ExampleApp, and any other active repos). ' +
    'For each project: what moved in the last week, what was the theme of the work, what stalled, ' +
    'and what has not been touched in two weeks or longer. ' +
    `The Jarvis repo commits from the last 7 days are:\n\n${commitLog}\n\n` +
    'Produce a crisp weekly synthesis. ' +
    'Notable momentum or concerning stalls: use surface_to_inbox. ' +
    'Informational summary (routine week): use queue_for_brief. ' +
    OBSERVER_DECISION_FRAMEWORK

  try {
    await dispatchObserver('commit_activity_summary', 'chief-of-strategy', prompt)
  } catch (err) {
    log.warn('scheduler: commit_activity_summary failed', { err: String(err) })
    logEvent('commit_activity_summary', 'routine_delivered', {
      routine: 'commit_activity_summary',
      exit_code: -1,
      error: String(err),
    })
  }
}
