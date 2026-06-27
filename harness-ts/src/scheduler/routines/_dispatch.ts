// Shared dispatchObserver helper for scheduler routines.
// Mirrors the local dispatchObserver in watch.ts without depending on that file.
// Use this in any new routine file rather than duplicating the pattern.

import { log } from 'ion-sdk'
import { logEvent } from '../../memory/episodic'
import { runClaudeAgent } from '../../util/claudeAgent'
import { getSchedulerCtx } from '../ctx'
import { dispatchStaff } from '../../staff/dispatch'
import { getRosterEntry } from '../../staff/roster'
import { validateTaskPrompt } from '../../util/validateTask'
import { EXECUTION_CONTEXT_PREAMBLE } from '../../persona/executionContext'

/**
 * Run an observer routine via ctx.dispatchAgent (Ion-native) when a root ctx is
 * available, or fall back to runClaudeAgent for cold-start (no user session yet).
 * Logs routine_delivered on completion. Never self-emits routine_started (scheduler
 * core owns that).
 */
export async function dispatchObserver(
  routineName: string,
  agentName: string,
  prompt: string,
  opts?: { model?: string; timeoutMs?: number },
): Promise<void> {
  if (!validateTaskPrompt(prompt, `scheduler: ${routineName}`)) return
  const ctx = getSchedulerCtx()
  if (ctx) {
    try {
      // dispatchStaff injects the observer's persona (roster systemPrompt) and
      // gives it the harness tools via the child extension.
      await dispatchStaff(ctx, agentName, prompt, {
        maxTurns: 10,
        ...(opts?.model ? { model: opts.model } : {}),
        onComplete: (r) => {
          if (r.cost > 0) logEvent(routineName, 'routine_cost', { cost: r.cost, tokens: r.outputTokens })
        },
        onError: (err) => {
          logEvent(routineName, 'routine_failed', { routine: routineName, error: err.message })
          log.warn(`scheduler: ${routineName}: dispatch failed`, { err: err.message })
        },
      })
      logEvent(routineName, 'routine_delivered', { routine: routineName, dispatched: true })
      return
    } catch (err) {
      if (String(err).includes('dispatch not available')) {
        log.info(`scheduler: ${routineName}: ion dispatch unavailable in async context, falling back to Claude CLI`)
      } else {
        log.warn(`scheduler: ${routineName}: dispatchAgent failed`, { err: String(err) })
        logEvent(routineName, 'routine_delivered', {
          routine: routineName,
          exit_code: -1,
          error: String(err),
        })
        return
      }
    }
  }
  // Cold-start or async-context fallback.
  // Prepend the roster system prompt so the CLI subprocess gets specialist context
  // rather than running as generic Claude. Not a perfect substitute for ctx.dispatchAgent
  // (system prompt goes in the user turn, not the system message), but far better than
  // dispatching with no persona. (#713)
  // The CLI subprocess bypasses ion's before_agent_start hook, so the execution
  // context preamble (injected there for ctx.dispatchAgent paths) is added here
  // explicitly -- otherwise the cold-start agent may try to SSH to the Mini.
  const entry = getRosterEntry(agentName)
  const coldStartPrompt = entry?.systemPrompt
    ? `${entry.systemPrompt}${EXECUTION_CONTEXT_PREAMBLE}\n\n${prompt}`
    : `${EXECUTION_CONTEXT_PREAMBLE}\n\n${prompt}`
  await runClaudeAgent(routineName, coldStartPrompt, opts)
  logEvent(routineName, 'routine_delivered', { routine: routineName, dispatched: false })
}
