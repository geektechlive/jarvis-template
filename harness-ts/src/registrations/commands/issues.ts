// /issue command -- create a GitHub issue on <your-org>/jarvis.
// Usage: /issue <title> [body...]
// Always targets <your-org>/jarvis, always labels user-filed.
// Confirmation is surfaced via logEvent (inbox_item).

import { log } from 'ion-sdk'
import { logEvent } from '../../memory/episodic'
import { runCommandAsync } from '../../util/ionPrompt'
import type { IonSDK } from 'ion-sdk'

const REPO = '<your-org>/jarvis'
const LABEL = 'user-filed'
const GH_TIMEOUT_MS = 20_000

interface GhIssueCreated {
  number: number
  url: string
  title: string
}

export function registerIssueCommands(ion: IonSDK): void {
  ion.registerCommand('issue', {
    description: 'Create a GitHub issue on <your-org>/jarvis. Usage: /issue <title> [body]',
    execute: async (args: string) => {
      const trimmed = args.trim()
      if (!trimmed) {
        logEvent('issue', 'inbox_item', {
          routine: 'issue',
          text: 'Usage: /issue <title> [body]. Title is required.',
        })
        return
      }

      // First line is the title, rest is the body.
      const newline = trimmed.indexOf('\n')
      const title = newline === -1 ? trimmed : trimmed.slice(0, newline).trim()
      const body = newline === -1 ? '' : trimmed.slice(newline + 1).trim()

      if (!title) {
        logEvent('issue', 'inbox_item', {
          routine: 'issue',
          text: 'Issue title cannot be empty.',
        })
        return
      }

      log.info('issue: creating', { repo: REPO, title })

      const ghArgs = [
        'issue', 'create',
        '--repo', REPO,
        '--title', title,
        '--label', LABEL,
        '--json', 'number,url,title',
      ]
      if (body) {
        ghArgs.push('--body', body)
      } else {
        ghArgs.push('--body', '')
      }

      const r = await runCommandAsync('gh', ghArgs, { timeoutMs: GH_TIMEOUT_MS })

      if (r.error || r.status !== 0) {
        const msg = r.stderr.trim() || r.error?.message || 'unknown error'
        log.warn('issue: gh failed', { msg })
        logEvent('issue', 'inbox_item', {
          routine: 'issue',
          text: `Failed to create issue: ${msg}`,
        })
        return
      }

      let created: GhIssueCreated
      try {
        created = JSON.parse(r.stdout.trim()) as GhIssueCreated
      } catch {
        logEvent('issue', 'inbox_item', {
          routine: 'issue',
          text: 'Issue created but could not parse response. Check GitHub.',
        })
        return
      }

      log.info('issue: created', { number: created.number, url: created.url })
      logEvent('issue', 'inbox_item', {
        routine: 'issue',
        text: `Issue #${created.number} filed: "${created.title}"\n${created.url}`,
      })
    },
  })
}
