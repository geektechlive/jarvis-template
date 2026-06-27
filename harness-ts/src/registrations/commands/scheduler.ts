import { logEvent } from '../../memory/episodic'
import { listJobs } from '../../scheduler'
import type { IonSDK } from 'ion-sdk'

export function registerSchedulerCommands(ion: IonSDK): void {
  ion.registerCommand('schedule-status', {
    description: 'List all scheduled routines and when they last ran today.',
    execute: async (_args) => {
      const jobs = listJobs()
      if (!jobs.length) {
        logEvent('schedule-status', 'inbox_item', {
          routine: 'schedule-status',
          text: 'Scheduler not running on this process (lock held by another process).',
        })
        return
      }
      const lines = jobs.map(job => {
        const lastRan = job.lastRunDate
          ? new Date(job.lastRunDate).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
          : 'not yet today'
        const flag = !job.enabled ? ' [DISABLED]' : ''
        return `${job.id}${flag}: ${job.schedule} — last ran: ${lastRan}`
      })
      logEvent('schedule-status', 'inbox_item', {
        routine: 'schedule-status',
        text: `Ion scheduler (${jobs.length} jobs):\n${lines.join('\n')}`,
      })
    },
  })
}
