import { log, type IonSDK } from 'ion-sdk'
import { run as improveRun, mergeBranch, rejectBranch } from '../../improve'
import { findByRunId, decide } from '../../approvals/index'
import { runBrief } from '../../scheduler'
import { drain as inboxDrain, countPending } from '../../inbox'
import { enable as autonomyEnable, disable as autonomyDisable, isEnabled as autonomyIsEnabled, classifyGoalType } from '../../autonomy'
import { logEvent, pendingActions, listGoals, updateGoal, reactivateGoal, recentExternalAudit } from '../../memory/episodic'
import { markThreadClosed, loadOpenThreads } from '../../openThreads'

const VALID_BRANCH_RE = /^auto\/improve-[\w-]+$/

// Workflow + autonomy slash commands: /improve, /brief, /whats-new,
// /autonomy, /pending, /goals.
export function registerWorkflowCommands(ion: IonSDK): void {
  ion.registerCommand('improve', {
    description: 'Self-improvement loop. Usage: run [minutes] [focus] | approve <branch> | reject <branch>',
    execute: async (args) => {
      const parts = args.trim().split(/\s+/)
      const sub = parts[0] ?? 'run'

      if (sub === 'approve') {
        const branch = parts[1]
        if (!branch || !VALID_BRANCH_RE.test(branch)) {
          log.warn('improve approve: invalid or missing branch name')
          logEvent('improve', 'inbox_item', { routine: 'improve_approve', text: 'Invalid or missing branch name.' })
          return
        }
        const { ok, diff } = await mergeBranch(branch)
        log.info('improve approve', { branch, ok })
        // Mark the matching approval row as decided so the queue stays accurate.
        // No-op if no approval row exists (e.g. older branches predating this feature).
        if (ok) {
          const approval = findByRunId(branch)
          if (approval) {
            try { decide(approval.id, 'approved', 'slash-command') } catch { /* already decided */ }
          }
        }
        logEvent('improve', 'inbox_item', {
          routine: 'improve_approve',
          text: ok ? `Branch ${branch} merged.\n\n${diff}` : `Merge failed for ${branch}.\n\n${diff}`,
        })
        return
      }

      if (sub === 'reject') {
        const branch = parts[1]
        if (!branch || !VALID_BRANCH_RE.test(branch)) {
          log.warn('improve reject: invalid or missing branch name')
          logEvent('improve', 'inbox_item', { routine: 'improve_reject', text: 'Invalid or missing branch name.' })
          return
        }
        await rejectBranch(branch)
        log.info('improve reject', { branch })
        logEvent('improve', 'inbox_item', { routine: 'improve_reject', text: `Branch ${branch} rejected and deleted.` })
        return
      }

      // run [minutes] [focus...]
      const minutes = sub === 'run'
        ? (parseInt(parts[1] ?? '15', 10) || 15)
        : (parseInt(sub, 10) || 15)
      const focusStart = sub === 'run' ? 2 : 1
      const focus = parts.slice(focusStart).join(' ')
      log.info('improve run', { minutes, focus: focus || '(general)' })
      const result = await improveRun(minutes, focus)
      log.info('improve run complete', { result: result.slice(0, 200) })
    },
  })

  ion.registerCommand('brief', {
    description: 'On-demand morning brief: inbox digest, calendar, overnight commits.',
    execute: async () => {
      log.info('jarvis: /brief triggered')
      await runBrief()
    },
  })

  ion.registerCommand('whats-new', {
    description: 'Drain the batch inbox and surface pending items.',
    execute: async () => {
      const items = inboxDrain(50)
      if (!items.length) {
        logEvent('inbox', 'inbox_item', { routine: 'whats_new', text: 'No new items in the batch digest.' })
        return
      }
      const lines = items.map((i) => `[${i.source}] ${i.content.slice(0, 120)} (score: ${i.score.toFixed(2)})`)
      logEvent('inbox', 'inbox_item', {
        routine: 'whats_new',
        text: `Batch digest (${items.length} item${items.length === 1 ? '' : 's'}):\n${lines.join('\n')}`,
      })
      log.info('jarvis: /whats-new drained', { count: items.length })
    },
  })

  ion.registerCommand('autonomy', {
    description: 'Toggle always-on goal worker. Usage: on | off | status',
    execute: async (args) => {
      const sub = args.trim().toLowerCase()
      if (sub === 'on') {
        autonomyEnable()
        logEvent('autonomy', 'inbox_item', { routine: 'autonomy', text: 'Autonomy worker enabled.' })
      } else if (sub === 'off') {
        autonomyDisable()
        logEvent('autonomy', 'inbox_item', { routine: 'autonomy', text: 'Autonomy worker disabled.' })
      } else {
        const state = autonomyIsEnabled() ? 'enabled' : 'disabled'
        const pending = countPending()
        logEvent('autonomy', 'inbox_item', {
          routine: 'autonomy',
          text: `Autonomy is ${state}. Batch inbox has ${pending} pending item(s).`,
        })
      }
    },
  })

  ion.registerCommand('pending', {
    description: 'Show unresolved triage actions or recent external goal runs. Usage: pending | pending external',
    execute: async (args) => {
      const sub = args.trim().toLowerCase()

      if (sub === 'external') {
        const rows = recentExternalAudit(10)
        if (!rows.length) {
          logEvent('pending', 'inbox_item', { routine: 'pending', text: 'No external goal runs recorded.' })
          return
        }
        const lines = rows.map((r) => {
          const started = r.started_at.slice(0, 16)
          const completed = r.completed_at ? r.completed_at.slice(0, 16) : 'running'
          const snippet = (r.result_text ?? '').slice(0, 80).replace(/\n/g, ' ')
          return `[goal ${r.goal_id}] ${started} → ${completed}: ${r.intent.slice(0, 60)}${snippet ? ` | ${snippet}` : ''}`
        })
        logEvent('pending', 'inbox_item', {
          routine: 'pending',
          text: `External goal runs (last ${rows.length}):\n${lines.join('\n')}`,
        })
        return
      }

      const all = pendingActions()
      const unresolved = all.filter(
        (a) => a['action'] === 'triage_question' || a['action'] === 'triage_review',
      )
      if (!unresolved.length) {
        logEvent('pending', 'inbox_item', { routine: 'pending', text: 'No pending actions.' })
        return
      }
      const lines = unresolved.map((a) => {
        const action = String(a['action'] ?? '')
        const snippet = String(a['payload'] ?? '').slice(0, 80)
        return `[${a['id']}] ${action}${snippet ? ` -- ${snippet}` : ''}`
      })
      logEvent('pending', 'inbox_item', {
        routine: 'pending',
        text: `Pending actions (${unresolved.length}):\n${lines.join('\n')}`,
      })
    },
  })

  ion.registerCommand('close', {
    description: 'Retire an open thread from prior-session continuity. Usage: close <topic> | list',
    execute: async (args) => {
      const arg = args.trim()
      if (!arg || arg.toLowerCase() === 'list') {
        const threads = loadOpenThreads()
        if (!threads.length) {
          logEvent('close', 'inbox_item', { routine: 'close', text: 'No open threads.' })
          return
        }
        const lines = threads.map((t) => `- ${t.topic} (${t.dispatchCount} dispatch${t.dispatchCount === 1 ? '' : 'es'})`)
        logEvent('close', 'inbox_item', {
          routine: 'close',
          text: `Open threads:\n${lines.join('\n')}\n\nUse /close <topic> to retire one.`,
        })
        return
      }
      markThreadClosed(arg)
      logEvent('close', 'inbox_item', { routine: 'close', text: `Closed thread: ${arg}` })
    },
  })

  ion.registerCommand('goals', {
    description: 'List goals. Usage: goals [active|proposed|blocked|all]',
    execute: async (args) => {
      const filter = args.trim().toLowerCase() || 'active'
      const goals = filter === 'all' ? listGoals() : listGoals(filter)
      if (!goals.length) {
        logEvent('goals', 'inbox_item', { routine: 'goals', text: `No ${filter} goals.` })
        return
      }
      const lines = goals.map((g) =>
        `[${g.id}] ${g.status.toUpperCase()} ${g.cadence} [${g.goal_type}] -- ${g.intent.slice(0, 80)} (owner: ${g.owner_staff_id})`,
      )
      logEvent('goals', 'inbox_item', {
        routine: 'goals',
        text: `Goals (${goals.length}):\n${lines.join('\n')}`,
      })
    },
  })

  ion.registerCommand('goal', {
    description: 'Goal lifecycle commands. Usage: goal confirm <id> | goal reactivate <id>',
    execute: async (args) => {
      const parts = args.trim().split(/\s+/)
      const sub = parts[0] ?? ''

      if (sub === 'reactivate') {
        const id = parseInt(parts[1] ?? '', 10)
        if (isNaN(id)) {
          logEvent('goal', 'inbox_item', { routine: 'goal', text: 'Usage: /goal reactivate <id>' })
          return
        }
        // Un-park a goal that hit the failure cap. There is no other recovery
        // path short of manual SQL: a capped goal is excluded by goalsDueNow()
        // and only a successful run resets it, which can never happen once it is
        // unscheduled. reactivateGoal resets status='active' + consecutive_failures=0.
        const ok = reactivateGoal(id)
        if (!ok) {
          logEvent('goal', 'inbox_item', { routine: 'goal', text: `Goal ${id} not found.` })
          return
        }
        log.info('goal reactivated', { id })
        logEvent('goal', 'inbox_item', {
          routine: 'goal',
          text: `Goal ${id} reactivated (status=active, failure streak reset). It will be picked up on the next autonomy tick.`,
        })
        return
      }

      if (sub === 'confirm') {
        const id = parseInt(parts[1] ?? '', 10)
        if (isNaN(id)) {
          logEvent('goal', 'inbox_item', { routine: 'goal', text: 'Usage: /goal confirm <id>' })
          return
        }
        const goals = listGoals('proposed')
        const goal = goals.find((g) => g.id === id)
        if (!goal) {
          logEvent('goal', 'inbox_item', {
            routine: 'goal',
            text: `Goal ${id} not found or not in proposed state.`,
          })
          return
        }
        const goalType = classifyGoalType(goal.intent)
        updateGoal(id, { status: 'active', goal_type: goalType })
        log.info('goal confirmed', { id, goalType })
        logEvent('goal', 'inbox_item', {
          routine: 'goal',
          text: `Goal ${id} confirmed as active (type: ${goalType}). Intent: ${goal.intent.slice(0, 80)}`,
        })
        return
      }

      logEvent('goal', 'inbox_item', {
        routine: 'goal',
        text: 'Unknown subcommand. Usage: /goal confirm <id> | /goal reactivate <id>',
      })
    },
  })
}
