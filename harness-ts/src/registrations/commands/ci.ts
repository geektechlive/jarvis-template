import { log } from 'ion-sdk'
import { logEvent } from '../../memory/episodic'
import { runCommandAsync } from '../../util/ionPrompt'
import type { IonSDK } from 'ion-sdk'

const REPO = '<your-org>/jarvis'
const GH_TIMEOUT_MS = 15_000

interface GhRun {
  name: string
  status: string
  conclusion: string | null
  updatedAt: string
  url: string
}

function statusIcon(run: GhRun): string {
  if (run.status !== 'completed') return '⏳'
  switch (run.conclusion) {
    case 'success': return '✅'
    case 'failure': return '❌'
    case 'cancelled': return '🚫'
    case 'skipped': return '⏭'
    default: return '❓'
  }
}

function formatAge(updatedAt: string): string {
  const diffMs = Date.now() - new Date(updatedAt).getTime()
  const mins = Math.round(diffMs / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

export function registerCiCommands(ion: IonSDK): void {
  ion.registerCommand('ci-check', {
    description: 'Show the last 5 CI runs for the Jarvis repo.',
    execute: async (_args) => {
      log.info('ci-check: fetching runs')
      const r = await runCommandAsync('gh', [
        'run', 'list',
        '--repo', REPO,
        '--limit', '5',
        '--json', 'name,status,conclusion,updatedAt,url',
      ], { timeoutMs: GH_TIMEOUT_MS })

      if (r.error || r.status !== 0) {
        const msg = r.stderr.trim() || r.error?.message || 'unknown error'
        log.warn('ci-check: gh failed', { msg })
        logEvent('ci-check', 'inbox_item', { routine: 'ci-check', text: `CI check failed: ${msg}` })
        return
      }

      let runs: GhRun[]
      try {
        runs = JSON.parse(r.stdout.trim()) as GhRun[]
      } catch {
        logEvent('ci-check', 'inbox_item', { routine: 'ci-check', text: 'CI check failed: could not parse gh output.' })
        return
      }

      if (!runs.length) {
        logEvent('ci-check', 'inbox_item', { routine: 'ci-check', text: 'No CI runs found.' })
        return
      }

      const lines = runs.map(run => {
        const icon = statusIcon(run)
        const state = run.status !== 'completed' ? run.status : (run.conclusion ?? 'unknown')
        return `${icon} ${run.name} — ${state} (${formatAge(run.updatedAt)})`
      })

      const failures = runs.filter(r => r.conclusion === 'failure')
      const footer = failures.length
        ? `\n${failures.length} failing. Check: ${failures[0]!.url}`
        : ''

      logEvent('ci-check', 'inbox_item', {
        routine: 'ci-check',
        text: `CI status (last ${runs.length} runs):\n${lines.join('\n')}${footer}`,
      })
    },
  })
}
