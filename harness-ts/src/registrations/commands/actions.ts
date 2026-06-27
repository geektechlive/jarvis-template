import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { IonSDK } from 'ion-sdk'
import { logEvent, updateActionState, recentEventsBySession, getActionById, approveGoalProposalAtomic } from '../../memory/episodic'
import { triageAndAdd } from '../../triage'
import { getTodayEventsStr } from '../../tools/calendar'

// Action-approval and content slash commands: /approve, /deny, /ingest,
// /meetings, /reingest-mail.
export function registerActionCommands(ion: IonSDK): void {
  ion.registerCommand('approve', {
    description: 'Approve a pending action by ID. Usage: approve <id>',
    execute: async (args) => {
      const id = parseInt(args.trim(), 10)
      if (isNaN(id)) {
        logEvent('approve', 'inbox_item', { routine: 'approve', text: 'Usage: /approve <id>' })
        return
      }
      // Check if this is a goal_proposal before touching state, so we can use
      // the atomic approve+create path (issue #476, #477).
      const action = getActionById(id)
      if (action?.['action'] === 'goal_proposal' && typeof action['payload'] === 'string') {
        try {
          const p = JSON.parse(action['payload']) as {
            intent: string
            cadence: string
            owner_staff_id: string
            budget_tool_calls: number
            budget_minutes: number
          }
          const { changed, goalId } = approveGoalProposalAtomic(
            id,
            p.intent,
            p.cadence,
            p.owner_staff_id,
            p.budget_tool_calls,
            p.budget_minutes,
          )
          if (changed && goalId !== null) {
            logEvent('approve', 'action_approved', { action_id: id })
            logEvent('approve', 'inbox_item', { routine: 'approve', text: `Goal #${goalId} activated: ${p.intent}` })
            logEvent('approve', 'goal_activated', { action_id: id, goal_id: goalId, intent: p.intent })
          } else {
            logEvent('approve', 'inbox_item', {
              routine: 'approve',
              text: `Action ${id} not found or already resolved.`,
            })
          }
        } catch (err) {
          logEvent('approve', 'inbox_item', { routine: 'approve', text: `Action ${id} goal creation failed: ${String(err)}` })
        }
      } else {
        // Non-goal actions: plain state update.
        const changed = updateActionState(id, 'Approved')
        if (changed) {
          logEvent('approve', 'action_approved', { action_id: id })
          logEvent('approve', 'inbox_item', { routine: 'approve', text: `Action ${id} approved.` })
        } else {
          logEvent('approve', 'inbox_item', {
            routine: 'approve',
            text: `Action ${id} not found or already resolved.`,
          })
        }
      }
    },
  })

  ion.registerCommand('deny', {
    description: 'Deny a pending action by ID. Usage: deny <id>',
    execute: async (args) => {
      const id = parseInt(args.trim(), 10)
      if (isNaN(id)) {
        logEvent('deny', 'inbox_item', { routine: 'deny', text: 'Usage: /deny <id>' })
        return
      }
      const changed = updateActionState(id, 'Rejected')
      if (changed) {
        logEvent('deny', 'action_rejected', { action_id: id })
        logEvent('deny', 'inbox_item', { routine: 'deny', text: `Action ${id} denied.` })
      } else {
        logEvent('deny', 'inbox_item', {
          routine: 'deny',
          text: `Action ${id} not found or already resolved.`,
        })
      }
    },
  })

  // ---------------------------------------------------------------------------
  // Content commands
  // ---------------------------------------------------------------------------

  ion.registerCommand('ingest', {
    description: 'Triage a URL or text into the inbox. Usage: ingest <url or text>',
    execute: async (args) => {
      const input = args.trim()
      if (!input) {
        logEvent('ingest', 'inbox_item', { routine: 'ingest', text: 'Usage: /ingest <url or text>' })
        return
      }
      const isUrl = /^https?:\/\//i.test(input)
      if (isUrl) {
        let content: string
        try {
          const res = await fetch(input, { signal: AbortSignal.timeout(10_000) })
          content = await res.text()
          // Strip HTML tags for plain text content.
          content = content.replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').slice(0, 4000)
        } catch (err: unknown) {
          // Fetch failed; triage the URL itself as the content.
          content = `[URL fetch failed: ${String(err)}] ${input}`
        }
        await triageAndAdd({ source: 'manual', content }, '')
      } else {
        await triageAndAdd({ source: 'manual', content: input }, '')
      }
      logEvent('ingest', 'inbox_item', {
        routine: 'ingest',
        text: `Ingested ${isUrl ? 'URL' : 'text'}: ${input.slice(0, 80)}`,
      })
    },
  })

  ion.registerCommand('meetings', {
    description: "Show today's calendar events.",
    execute: async () => {
      const events = await getTodayEventsStr()
      logEvent('meetings', 'inbox_item', {
        routine: 'meetings',
        text: `Today's meetings:\n${events}`,
      })
    },
  })

  ion.registerCommand('reingest-mail', {
    description: 'Show mail ingest status. Forward-going ingestion happens at triage time; bulk historical backfill is not yet implemented.',
    execute: async () => {
      logEvent('reingest-mail', 'inbox_item', {
        routine: 'reingest-mail',
        text: 'Mail ingestion into semantic memory now happens automatically at triage time: the Chief of Communications calls POST http://127.0.0.1:9876/remember for each email containing a substantive fact, decision, event, or person mention. Bulk historical backfill is not yet implemented.',
      })
    },
  })

  ion.registerCommand('imessage-status', {
    description: 'Show iMessage watcher status: launchd job, cursor, and recent routing decisions.',
    execute: async () => {
      const lines: string[] = ['iMessage watcher status:']

      // Check launchd job
      try {
        const launchctl = execSync(
          "launchctl list | grep com.example.jarvis.imessage || echo '(not loaded)'",
          { encoding: 'utf8', timeout: 5_000 },
        ).trim()
        lines.push(`launchd: ${launchctl}`)
      } catch { lines.push('launchd: (check failed)') }

      // Cursor
      try {
        const cursorFile = join(homedir(), '.jarvis', 'imessage_cursor_rowid')
        const cursor = existsSync(cursorFile) ? readFileSync(cursorFile, 'utf8').trim() : '0'
        lines.push(`cursor ROWID: ${cursor}`)
      } catch { lines.push('cursor: (unreadable)') }

      // Recent routing decisions
      const events = recentEventsBySession('imessage', 10)
      lines.push(`\nLast ${events.length} events:`)
      for (const e of events) {
        const detailStr = e.detail != null ? JSON.stringify(e.detail).slice(0, 80) : ''
        lines.push(`  ${e.ts} ${e.event} ${detailStr}`)
      }

      const text = lines.join('\n')
      logEvent('imessage-status', 'inbox_item', { routine: 'imessage-status', text })
    },
  })
}
