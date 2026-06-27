// Background scheduler public API surface.
// The actual job registration now lives in scheduler/register.ts which uses
// ion.schedule.* (canonical engine scheduler). This file retains the exports
// consumed by commands, webhooks, and the self-improvement pending-trigger.

import { lastMessageTs, recentEvents } from '../memory/episodic'
import { isEnabled } from './helpers'
import { JOB_MANIFEST } from './register'

export type { BriefSection, BriefMessage } from './helpers'

import { runMorningBrief } from './routines/brief'
export { runUnifiWatch } from './routines/watch'
export { runInfraWatch } from './routines/watch'
export { pollResolverFeedback } from '../patrol/feedback'
export { runSecurityWatch, runSecurityAnalystAlert, runObservabilityAlert, runImessageIngest } from './routines/watch'

// ---------------------------------------------------------------------------
// Scheduler idle check — used by register.ts _pending_improve job
// ---------------------------------------------------------------------------

const PENDING_IMPROVE_IDLE_SECONDS = 900  // 15 min idle before triggering

export function schedulerIsIdle(): boolean {
  const ts = lastMessageTs()
  if (!ts) return true
  const lastMs = new Date(ts).getTime()
  if (isNaN(lastMs)) return true
  return (Date.now() - lastMs) / 1000 >= PENDING_IMPROVE_IDLE_SECONDS
}

// ---------------------------------------------------------------------------
// listJobs — returns the static manifest populated by registerScheduledJobs
// ---------------------------------------------------------------------------

export interface JobStatus {
  id: string
  type: 'daily' | 'weekly' | 'interval'
  schedule: string
  enabled: boolean
  /** ISO timestamp of the last routine_delivered event within the past 24 hours, or null if not yet run today. */
  lastRunDate: string | null
}

export function listJobs(): JobStatus[] {
  return JOB_MANIFEST.map(j => {
    const delivered = recentEvents(j.id, 'routine_delivered', 24)
    const lastRunDate = delivered.at(-1)?.ts ?? null
    return {
      id: j.id,
      type: j.type,
      schedule: j.schedule,
      enabled: isEnabled(j.id),
      lastRunDate,
    }
  })
}

// ---------------------------------------------------------------------------
// runBrief — used by /brief command
// ---------------------------------------------------------------------------

export async function runBrief(): Promise<void> {
  return runMorningBrief(true)
}

