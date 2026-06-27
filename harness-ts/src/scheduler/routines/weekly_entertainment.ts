// weekly_entertainment: Friday entertainment brief routine.
// Dispatches the entertainment-advisor agent to surface new releases and
// recommendations matching Alex's taste profile.

import { log } from 'ion-sdk'
import { isEnabled } from '../helpers'
import { OBSERVER_DECISION_FRAMEWORK } from '../helpers'
import { dispatchObserver } from './_dispatch'

export async function runWeeklyEntertainment(): Promise<void> {
  if (!isEnabled('weekly_entertainment')) return

  const prompt =
    'Standing weekly Entertainment Advisor pass. Dispatch the Entertainment Advisor now. ' +
    'Pull Alex\'s taste profile from recall (query: "entertainment taste profile preferences"). ' +
    'Surface new releases this week in TV, film, comics, books, music, and podcasts that match ' +
    'the taste profile. Pay particular attention to limited-run premieres or comic drops ' +
    'that would justify pre-empting his current queue. ' +
    'Use surface_to_inbox for strong matches or time-sensitive releases; ' +
    'use queue_for_brief for notable-but-not-urgent picks. ' +
    OBSERVER_DECISION_FRAMEWORK

  try {
    await dispatchObserver('weekly_entertainment', 'entertainment-advisor', prompt)
  } catch (err) {
    log.warn('scheduler: weekly_entertainment failed', { err: String(err) })
  }
}
