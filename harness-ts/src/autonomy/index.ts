// Always-on autonomy worker (W4).
// Mirrors harness/autonomy.py. Polls every 60s; when idle and within daily cap,
// picks the first due goal and runs it via ion's CliBackend (Claude with tools).

import { log, type IonSDK } from 'ion-sdk'
import {
  GoalRow,
  eventsSince,
  goalRunsToday,
  goalsDueNow,
  lastMessageTs,
  logEvent,
  logExternalAudit,
  logGoalRun,
  markGoalFailed,
  markGoalSucceeded,
  MAX_GOAL_FAILURES,
  updateExternalAudit,
  updateGoalRun,
} from '../memory/episodic'
import { runIonPromptCapture } from '../util/ionPrompt'
import { EXECUTION_CONTEXT_PREAMBLE, GOAL_DIRECTIVE } from '../persona/executionContext'
import { getSchedulerCtx, setSchedulerCtx } from '../scheduler/ctx'
import { loadRoutinesConfig } from '../scheduler/helpers'
import { postProactive } from '../proactive/notify'
import { postLongEmbed } from '../discord/webhook'
import { loadModelForRole, loadDiscordConfig } from '../config'
import { verifyGoalOutput, verificationEvent } from './verify'
import { dispatchStaff } from '../staff/dispatch'


const DAILY_CAP = 20
const IDLE_SECONDS = 900
const DEFAULT_POLL_MS = 60_000

// ---------------------------------------------------------------------------
// Goal-type classifier — keyword heuristics, no LLM call
// ---------------------------------------------------------------------------

const EXTERNAL_KEYWORDS = [
  'send email', 'send slack', 'post to', 'push to git', 'push commit',
  'call api', 'http request', 'webhook', 'notify', 'message ', 'email ',
  'slack ', 'tweet', 'publish', 'deploy',
]
const READ_KEYWORDS = [
  'check', 'recall', 'search', 'find', 'look up', 'summarize', 'report',
  'list', 'show', 'read', 'fetch', 'retrieve', 'monitor', 'watch',
]

export function classifyGoalType(intent: string): 'read' | 'write' | 'external' {
  const lower = intent.toLowerCase()
  if (EXTERNAL_KEYWORDS.some((kw) => lower.includes(kw))) return 'external'
  if (READ_KEYWORDS.some((kw) => lower.includes(kw))) return 'read'
  return 'write'
}

let _enabled = false
let _maxRunMs = 180_000
let _activeGoalId: number | null = null
let _goalInFlight = false

// ---------------------------------------------------------------------------
// Failure types -- JSON shape matches Python GoalFailure.to_json() exactly
// ---------------------------------------------------------------------------

type FailureKind =
  | 'permission_blocked'
  | 'budget_timeout'
  | 'tool_error'
  | 'model_error'
  | 'unknown_tool'
  | 'uncaught'

interface GoalFailure {
  kind: FailureKind
  iteration: number
  last_tool_name: string | null
  last_tool_args: string
  last_model_output: string
  message: string
}

function failureJson(f: GoalFailure): string {
  return JSON.stringify(f)
}

// In-app signal (additive alongside Discord). Fires an engine_intercept banner
// to every other session so the user sees the goal update in-app. Failures here
// must never block Discord delivery — this is best-effort only.
async function interceptToOtherSessions(title: string, message: string): Promise<void> {
  const ctx = getSchedulerCtx()
  if (!ctx) return
  try {
    const sessions = await ctx.sessions.list()
    for (const s of sessions) {
      if (s.key === ctx.sessionKey) continue
      await ctx.intercept({
        level: 'banner',
        title,
        message,
        targetSessionKey: s.key,
      })
    }
  } catch { /* intercept failures must not block Discord delivery */ }
}

// ---------------------------------------------------------------------------
// Conclusion extraction — pull the tail of raw output, not chain-of-thought head
// ---------------------------------------------------------------------------

/** Extract the agent's actual conclusion from raw output. The conclusion lives at the
 *  TAIL of the output, not the head — the head is often chain-of-thought. Returns the
 *  last non-empty paragraph (or last 1-2 lines if that paragraph is short), newlines
 *  collapsed to spaces, capped at ~300 chars. */
export function extractConclusion(resultText: string): string {
  const text = resultText.trim()
  if (!text) return ''
  // Split into paragraphs on blank lines; take the last non-empty one.
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
  let tail = paras.length ? paras[paras.length - 1]! : text
  // If the final paragraph is very short, include the preceding line(s) for context.
  if (tail.length < 40 && paras.length >= 2) {
    tail = paras.slice(-2).join(' ')
  }
  return tail.replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300)
}

// ---------------------------------------------------------------------------
// Inbox-surfaced check — suppress redundant completion post when already delivered
// ---------------------------------------------------------------------------

/** True if the goal surfaced output to the inbox during this run (via surface_to_inbox →
 *  reason 'urgent', or queue_for_brief → reason 'staff observer'). Time-window heuristic:
 *  inbox_batch events log under a fixed 'inbox' session with no goal_id, so a concurrent
 *  routine surfacing in the same window could be misattributed. Low-risk (autonomy runs
 *  only after the idle gate) and benign (worst case: one suppressed redundant post). */
export function alreadySurfaced(startEventId: number): boolean {
  try {
    const events = eventsSince(startEventId, 'inbox', 'inbox_batch')
    return events.some((e) => {
      const detail = e.detail as { reason?: string } | undefined
      const reason = detail?.reason
      return reason === 'urgent' || reason === 'staff observer'
    })
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Public state accessors
// ---------------------------------------------------------------------------

export function isEnabled(): boolean { return _enabled }
export function enable(): void { _enabled = true; log.info('autonomy: enabled') }
export function disable(): void { _enabled = false; log.info('autonomy: disabled') }
export function activeGoalId(): number | null { return _activeGoalId }

// ---------------------------------------------------------------------------
// Idle check
// ---------------------------------------------------------------------------

function isIdle(): boolean {
  const ts = lastMessageTs()
  if (!ts) return true
  const lastMs = new Date(ts).getTime()
  if (isNaN(lastMs)) return true
  return (Date.now() - lastMs) / 1000 >= IDLE_SECONDS
}

// ---------------------------------------------------------------------------
// Next-run calculation
// ---------------------------------------------------------------------------

function nextRunAt(cadence: string): string | null {
  const now = Date.now()
  const deltas: Record<string, number> = {
    hourly: 3_600_000,
    daily: 86_400_000,
    weekly: 7 * 86_400_000,
  }
  const delta = deltas[cadence]
  if (delta == null) {
    log.warn('autonomy: unknown cadence, parking goal far future', { cadence })
  }
  // Unknown cadence: park far in the future rather than returning null, which
  // would cause goalsDueNow() to select this goal on every 60s tick.
  return new Date(now + (delta ?? 7 * 86_400_000 * 52)).toISOString()
}

// ---------------------------------------------------------------------------
// Delivery helper — verify + log + annotate + deliver (both success paths share this)
// ---------------------------------------------------------------------------

export async function deliverGoalResult(
  goalId: number,
  ownerId: string,
  intent: string,
  resultText: string,
  startEventId: number,
): Promise<void> {
  // summary: short one-liner for the in-app signal + completion log event.
  // fullText: the complete goal output delivered to Discord (never truncated).
  let summary = extractConclusion(resultText)
  let fullText = resultText

  // Verify, log telemetry, annotate on failure. Entire block is fail-safe.
  try {
    const verifierModel = loadModelForRole('verifier', 'claude-haiku-4-5-20251001')
    const v = await verifyGoalOutput(intent, resultText)
    // #837: skipped (non-verdict) results get verification_skipped, not a phantom
    // verification_pass that otherwise pins the Grafana pass-rate at 100%.
    const { event, detail } = verificationEvent(v, { goal_id: goalId, model: verifierModel })
    logEvent('goal_worker', event, detail)
    if (!v.ok && !v.skipped) {
      const annotation = `[unverified - ${v.issue}]\n`
      summary = annotation + summary
      fullText = annotation + fullText
      log.warn('autonomy: goal output failed verification', { goalId, issue: v.issue })
    }
  } catch (verifyErr: unknown) {
    log.warn('autonomy: verify block threw unexpectedly, continuing delivery', {
      goalId,
      err: String(verifyErr),
    })
  }

  // Delivery side effects are fail-safe: a telemetry or intercept throw here must
  // never escape into runGoal's outer catch, which would call markBlocked on a
  // goal already marked succeeded (double-mutation). Each is guarded; postProactive
  // below already has its own try/catch.
  try {
    logEvent('goal_worker', 'goal_completed', { goal_id: goalId, result_summary: summary })
  } catch (logErr: unknown) {
    log.warn('autonomy: goal_completed logEvent failed', { goalId, err: String(logErr) })
  }
  // In-app signal (additive alongside Discord) -- unconditional
  try {
    await interceptToOtherSessions(
      'Goal Complete',
      `Your ${ownerId.replace(/_/g, ' ')} concluded goal #${goalId}: ${summary.slice(0, 200)}`,
    )
  } catch (intErr: unknown) {
    log.warn('autonomy: interceptToOtherSessions failed', { goalId, err: String(intErr) })
  }
  if (!alreadySurfaced(startEventId)) {
    // Post the full report via postLongEmbed, which chunks at 4000 chars and
    // numbers parts (1/2, 2/2) -- so structured multi-section output is never
    // truncated mid-sentence (the bug behind goal #16). Mirrors brief.ts.
    const ownerLabel = ownerId.replace(/_/g, ' ')
    const discordConfig = loadDiscordConfig()
    if (discordConfig?.proactive_webhook_keychain_service) {
      await postLongEmbed(
        fullText,
        `Completed: ${ownerLabel} - goal #${goalId}`,
        0x57F287,
        discordConfig.proactive_webhook_keychain_service,
      ).catch((discordErr: unknown) => {
        log.warn('autonomy: discord notification failed', { goalId, err: String(discordErr) })
      })
    } else {
      log.warn('autonomy: no proactive webhook configured, skipping Discord goal post', { goalId })
    }
  } else {
    log.info('autonomy: completion post suppressed (already surfaced to inbox)', { goalId })
  }
}

// ---------------------------------------------------------------------------
// Per-goal execution
// ---------------------------------------------------------------------------

async function runGoal(goal: GoalRow): Promise<void> {
  const goalId = goal.id
  const intent = goal.intent
  const ownerId = goal.owner_staff_id
  const budgetMinutes = goal.budget_minutes
  const goalType = goal.goal_type ?? 'write'

  if (!intent?.trim()) {
    log.warn('autonomy: skipping goal run — empty intent', { goalId })
    return
  }

  const runId = logGoalRun(goalId)
  _activeGoalId = goalId

  const startEventId = logEvent('goal_worker', 'goal_started', {
    goal_id: goalId,
    intent: intent.slice(0, 60),
    owner: ownerId,
    goal_type: goalType,
  })
  log.info('autonomy: running goal', { goalId, intent: intent.slice(0, 60), owner: ownerId, goalType })

  // Route through ion's CliBackend (Claude with tools + memory recall injection).
  // The ctx-first path dispatches via dispatchStaff(ownerId) so the goal runs with
  // the owner's real system prompt, model, and the child-extension tools -- not as
  // a bare generic agent. The owner prefix is retained for the cold-start fallback
  // (runIonPromptCapture), which does not pass through the roster.
  // GOAL_DIRECTIVE tells the agent to report empty/missing data plainly instead
  // of pivoting to setup or meta questions. Appended to goalPrompt so BOTH the
  // ctx-first (dispatchStaff) and cold-start (coldStartGoalPrompt, built below
  // from goalPrompt) paths inherit it.
  const goalPrompt = `[Goal for ${ownerId}] ${intent}${GOAL_DIRECTIVE}`
  // Cold-start subprocess calls (runIonPromptCapture) bypass ion's
  // before_agent_start hook, so the execution-context preamble is added inline
  // here -- otherwise the goal agent may try to SSH to the Mini it runs on.
  const coldStartGoalPrompt = `${EXECUTION_CONTEXT_PREAMBLE}\n\n${goalPrompt}`
  const timeoutMs = Math.min(budgetMinutes * 60_000, _maxRunMs, 300_000)

  // For external goals, open an audit record before execution.
  let auditId: number | null = null
  if (goalType === 'external') {
    auditId = logExternalAudit(goalId, runId, intent, new Date().toISOString())
  }

  const dispatchCtx = getSchedulerCtx()
  try {
    let resultText = ''

    if (dispatchCtx) {
      // ctx-first: Ion-tracked child session; hooks fire, cost attributed.
      // dispatchStaff resolves the owner's persona+model from the roster and points
      // the child at the tools-only child extension; on a roster miss it degrades to
      // a bare {name, task} dispatch (prior behavior), so this never regresses.
      const r = await Promise.race([
        dispatchStaff(dispatchCtx, ownerId, goalPrompt, { maxTurns: 20 }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`goal-${goalId} timed out after ${timeoutMs}ms`)), timeoutMs),
        ),
      ])
      resultText = r.output.trim().slice(0, 8000)
    } else {
      // cold-start fallback: detached subprocess
      const r = await runIonPromptCapture(coldStartGoalPrompt, timeoutMs)
      if (r.error) {
        const isTimeout = r.error.message.includes('timed out')
        const failure: GoalFailure = {
          kind: isTimeout ? 'budget_timeout' : 'uncaught',
          iteration: 0,
          last_tool_name: null,
          last_tool_args: '',
          last_model_output: '',
          message: r.error.message,
        }
        updateGoalRun(runId, isTimeout ? 'timeout' : 'error', 0, undefined, failureJson(failure))
        if (auditId !== null) {
          updateExternalAudit(auditId, `error: ${r.error.message.slice(0, 500)}`, new Date().toISOString())
        }
        markBlocked(goalId, failure, goal.cadence)
        log.warn('autonomy: goal failed (cold-start path)', { goalId, kind: failure.kind, message: r.error.message })
        return
      }
      resultText = r.stdout.trim().slice(0, 8000)
    }

    updateGoalRun(runId, 'completed', 1, resultText)
    if (auditId !== null) {
      updateExternalAudit(auditId, resultText.slice(0, 1000), new Date().toISOString())
    }
    // Success re-activates the goal and clears any prior failure streak.
    markGoalSucceeded(goalId, nextRunAt(goal.cadence))

    await deliverGoalResult(goalId, ownerId, intent, resultText, startEventId)
    log.info('autonomy: goal completed', { goalId })

  } catch (err) {
    const message = String(err)

    // Ion dispatch is unavailable from async scheduler context (outside a live prompt turn).
    // Fall back to the cold-start subprocess path instead of blocking the goal permanently.
    if (message.includes('dispatch not available')) {
      log.info('autonomy: ion dispatch unavailable in async context, falling back to Claude CLI', { goalId })
      try {
        const r = await runIonPromptCapture(coldStartGoalPrompt, timeoutMs)
        if (r.error) {
          const isTimeout = r.error.message.includes('timed out')
          const failure: GoalFailure = {
            kind: isTimeout ? 'budget_timeout' : 'uncaught',
            iteration: 0,
            last_tool_name: null,
            last_tool_args: '',
            last_model_output: '',
            message: r.error.message,
          }
          updateGoalRun(runId, isTimeout ? 'timeout' : 'error', 0, undefined, failureJson(failure))
          if (auditId !== null) {
            updateExternalAudit(auditId, `error: ${r.error.message.slice(0, 500)}`, new Date().toISOString())
          }
          markBlocked(goalId, failure, goal.cadence)
          log.warn('autonomy: goal failed (CLI fallback path)', { goalId, kind: failure.kind, message: r.error.message })
        } else {
          const resultText = r.stdout.trim().slice(0, 8000)
          updateGoalRun(runId, 'completed', 1, resultText)
          if (auditId !== null) {
            updateExternalAudit(auditId, resultText.slice(0, 1000), new Date().toISOString())
          }
          // Success re-activates the goal and clears any prior failure streak.
          markGoalSucceeded(goalId, nextRunAt(goal.cadence))

          await deliverGoalResult(goalId, ownerId, intent, resultText, startEventId)
          log.info('autonomy: goal completed (CLI fallback)', { goalId })
        }
      } catch (fallbackErr: unknown) {
        const fallbackMsg = String(fallbackErr)
        const failure: GoalFailure = {
          kind: 'uncaught',
          iteration: 0,
          last_tool_name: null,
          last_tool_args: '',
          last_model_output: '',
          message: fallbackMsg,
        }
        updateGoalRun(runId, 'error', 0, undefined, failureJson(failure))
        if (auditId !== null) {
          updateExternalAudit(auditId, `error: ${fallbackMsg.slice(0, 500)}`, new Date().toISOString())
        }
        markBlocked(goalId, failure, goal.cadence)
        log.warn('autonomy: goal failed (CLI fallback error)', { goalId, message: fallbackMsg })
      }
      return
    }

    const isTimeout = message.includes('TimeoutError') || message.includes('AbortError') || message.includes('timed out')
    const failure: GoalFailure = {
      kind: isTimeout ? 'budget_timeout' : 'uncaught',
      iteration: 0,
      last_tool_name: null,
      last_tool_args: '',
      last_model_output: '',
      message,
    }
    updateGoalRun(runId, isTimeout ? 'timeout' : 'error', 0, undefined, failureJson(failure))
    if (auditId !== null) {
      updateExternalAudit(auditId, `error: ${message.slice(0, 500)}`, new Date().toISOString())
    }
    markBlocked(goalId, failure, goal.cadence)
    log.warn('autonomy: goal failed', { goalId, kind: failure.kind, message })
  } finally {
    _activeGoalId = null
  }
}

function markBlocked(goalId: number, failure: GoalFailure, cadence: string): void {
  // Increment the failure streak and block the goal. It auto-retries at its next
  // cadence until the streak reaches MAX_GOAL_FAILURES, after which goalsDueNow()
  // stops selecting it and it stays blocked until manually re-activated.
  const failCount = markGoalFailed(goalId, nextRunAt(cadence))
  const capped = failCount >= MAX_GOAL_FAILURES
  const retryNote = capped
    ? `Failed ${failCount} times in a row; parked until re-activated.`
    : `Failure ${failCount} of ${MAX_GOAL_FAILURES}; will retry next ${cadence} run.`
  logEvent('goal_worker', 'goal_blocked', {
    goal_id: goalId,
    failure_kind: failure.kind,
    reason: failure.message,
    consecutive_failures: failCount,
    capped,
  })
  // In-app signal (additive alongside Discord); fire-and-forget like the Discord call
  void interceptToOtherSessions(
    'Goal Failed',
    `Goal #${goalId} encountered a ${failure.kind}. ${retryNote} ${failure.message.slice(0, 150)}`,
  )
  // Fire Discord notification asynchronously; don't block on it
  postProactive(null, {
    embed: {
      color: 0xED4245,
      title: capped ? 'Blocked.' : 'Goal failed.',
      description: `Goal #${goalId} encountered a ${failure.kind} after ${failure.iteration} iteration${failure.iteration === 1 ? '' : 's'}. ${retryNote} ${failure.message.slice(0, 150)}`,
      footer: { text: `goal #${goalId}` },
    },
  }).catch((discordErr: unknown) => {
    log.warn('autonomy: discord notification failed', { goalId, err: String(discordErr) })
  })
}

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------

async function tick(): Promise<void> {
  if (!_enabled) return
  if (!isIdle()) return
  if (goalRunsToday() >= DAILY_CAP) {
    log.info('autonomy: daily cap reached, skipping tick', { cap: DAILY_CAP })
    return
  }

  // Guard must be checked and set before querying due goals so that concurrent
  // ticks (setInterval does not await the async handler) cannot both see
  // _goalInFlight === false and both proceed to dispatch.
  if (_goalInFlight) return
  _goalInFlight = true

  let goal: GoalRow | undefined
  try {
    const due = goalsDueNow()
    if (!due.length) {
      _goalInFlight = false
      return
    }
    goal = due[0]!
  } catch (err) {
    _goalInFlight = false
    throw err
  }

  try {
    await runGoal(goal)
  } finally {
    _goalInFlight = false
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function registerAutonomyJob(ion: IonSDK): void {
  try {
    const cfg = loadRoutinesConfig()
    const autonomyCfg = cfg['autonomy']
    if (autonomyCfg?.enabled) _enabled = true
    if (autonomyCfg?.max_run_ms) _maxRunMs = autonomyCfg.max_run_ms
  } catch { /* default: disabled */ }

  const pollMs = (loadRoutinesConfig()['autonomy']?.interval_minutes ?? 1) * 60_000 || DEFAULT_POLL_MS

  void ion.schedule.interval({
    id: '_autonomy_tick',
    intervalMs: pollMs,
    concurrency: 'single',
    // A goal run legitimately takes up to the budget cap (max 300s), but the tick
    // handler awaits it, so ion's default 60s fire_async ack window expires and
    // logs a spurious timeout while the work keeps running. Raise the per-fire
    // ack timeout above the cap. concurrency:'single' + the _goalInFlight guard
    // already prevent overlapping runs, so a longer window adds no risk.
    timeoutMs: 360_000,
    handler: async (ctx) => {
      setSchedulerCtx(ctx)
      await tick()
    },
  }).catch((err: unknown) => {
    log.warn('autonomy: failed to register interval job', { err: String(err) })
  })

  log.info('autonomy: interval job registered', { enabled: _enabled, pollMs })
}

export function start(): void {
  log.info('autonomy: start() is a no-op (lifecycle owned by ion engine via registerAutonomyJob)')
}

export function stop(): void {
  log.info('autonomy: stop() is a no-op (lifecycle owned by ion engine)')
}
