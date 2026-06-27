// Proactive trigger engine -- runs every 5 minutes via scheduler.
// Each trigger is idempotent and tracks its own cooldown via agent_events.

import { log } from 'ion-sdk'
import { logEvent, recentEvents } from '../memory/episodic'
import { isEnabled } from '../scheduler/helpers'
import { postProactive } from './notify'
import { meetingCountdown } from './meetingCountdown'
import { safariClustering } from './safariClustering'
import { unreadThreadSweep } from './unreadThreadSweep'
import { preRoutineGapProbe } from './preRoutineGapProbe'

export { postProactive }

const ROUTINE_ID = 'proactive_check'

// Returns true if trigger fired (so cooldown event is logged), false if skipped.
type TriggerFn = () => Promise<boolean>

interface Trigger {
  id: string           // unique key for cooldown tracking
  cooldownHours: number
  run: TriggerFn
}

const TRIGGERS: Trigger[] = [
  { id: 'meeting_countdown',     cooldownHours: 0,  run: meetingCountdown },
  { id: 'safari_clustering',     cooldownHours: 0,  run: safariClustering },
  { id: 'unread_thread_sweep',   cooldownHours: 22, run: unreadThreadSweep },
  { id: 'pre_routine_gap_probe', cooldownHours: 0,  run: preRoutineGapProbe },
]

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export async function runProactiveCheck(): Promise<void> {
  if (!isEnabled(ROUTINE_ID)) {
    log.debug('proactive: disabled -- skipping')
    return
  }

  log.info('proactive: check starting', { triggers: TRIGGERS.map(t => t.id) })

  for (const trigger of TRIGGERS) {
    try {
      const recent = recentEvents(trigger.id, 'proactive_fired', trigger.cooldownHours)
      if (recent.length > 0) {
        log.debug('proactive: trigger on cooldown', { id: trigger.id, cooldownHours: trigger.cooldownHours })
        continue
      }

      const fired = await trigger.run()
      if (fired) {
        logEvent(trigger.id, 'proactive_fired', { trigger: trigger.id })
        log.info('proactive: trigger fired', { id: trigger.id })
      }
    } catch (err) {
      log.warn('proactive: trigger error', { id: trigger.id, err: String(err) })
    }
  }
}
