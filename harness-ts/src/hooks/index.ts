import type { IonSDK } from 'ion-sdk'
import { wireSessionLifecycle } from './sessionLifecycle'
import { wirePromptPipeline } from './promptPipeline'
import { wireTurnLifecycle } from './turnLifecycle'
import { wireToolPipeline } from './toolPipeline'
import { handleModelSelect } from './modelSelect'
import { wireEngineEvents } from './engineEvents'
import { injectChildAgentPersona } from './childAgentPersona'
import { logEvent } from '../memory/episodic'
import { normalizeAgentName } from '../staff/normalize'
import { clearRecallDegradation, consumeRecallDegradation } from '../memory/recall'

export interface DispatchReceipt {
  name: string
  task?: string | undefined
  durationMs: number
}

// Formats dispatch receipts into a visible receipt block emitted as an
// engine_notify at turn_end. Pure function -- no side effects, unit-testable.
export function formatDispatchReceipts(receipts: DispatchReceipt[]): string {
  const lines: string[] = ['Delegated this turn.']
  for (const r of receipts) {
    const dur = r.durationMs >= 1000 ? `${(r.durationMs / 1000).toFixed(1)}s` : `${r.durationMs}ms`
    const parts: string[] = [normalizeAgentName(r.name)]
    if (r.task) parts.push(r.task)
    parts.push(dur)
    lines.push(`→ ${parts.join(' · ')}`)
  }
  return lines.join('\n')
}

// Formats a one-line degradation note surfaced at turn_end when memory recall
// ran degraded or failed. Pure function -- no side effects, fully unit-testable.
export function formatDegradationNote(reason: 'degraded' | 'failed'): string {
  if (reason === 'failed') {
    return 'Note: memory recall failed this turn, so I may be missing relevant context.'
  }
  return 'Note: memory recall ran degraded this turn, so context may be thinner than usual.'
}

// Wire all ion lifecycle hooks. Registration order matches the original
// monolithic extension.ts:
//   session_start, session_end, message_update (sessionLifecycle)
//   before_prompt (promptPipeline)
//   turn_end, turn_start (turnLifecycle -- turn_end registered first)
//   tool_start, tool_call, permission_classify (toolPipeline)
//   model_select (model routing before LLM dispatch)
//   before_agent_start (persona injection into all child agents)
export function wireHooks(ion: IonSDK): void {
  wireSessionLifecycle(ion)
  wirePromptPipeline(ion)
  wireTurnLifecycle(ion)
  wireToolPipeline(ion)
  wireEngineEvents(ion)

  // Reject ion's auto-discovered project context files (CLAUDE.md / ION.md).
  // ion walks the working directory (~/Jarvis) up to root and injects every
  // CLAUDE.md / .claude/CLAUDE.md it finds into the system prompt -- including
  // the Claude-Code coding-conventions files. That content made Jarvis believe
  // he was a Claude Code session. Jarvis's authoritative identity and context
  // come from before_prompt (SOUL.md, memory, etc.), so ion must not inject
  // these files at all. Returning true rejects the file (context_discover is a
  // boolean canceller hook -- see ion hook_forwarders.go registerBoolForwarder).
  ion.on('context_discover', (_ctx, info) => {
    const path = typeof info?.path === 'string' ? info.path : ''
    const lower = path.toLowerCase()
    const reject = lower.endsWith('/claude.md') || lower.endsWith('/ion.md')
    return reject || undefined
  })

  // Model selection hook — route model based on intent and config.
  ion.on('model_select', handleModelSelect)

  // Inject persona constraints into dispatched child agents. The handler skips
  // the root firing via the explicit isRoot flag (#227) -- see childAgentPersona.
  ion.on('before_agent_start', injectChildAgentPersona)

  // Canonical, name-normalized staff-dispatch telemetry. ion's observe-only
  // agent_start fires from the session layer for both LLM Agent-tool dispatches
  // and ctx.dispatchAgent (prompt_agent_spawner.go / extcontext/dispatch_agent.go),
  // so it captures every sub-agent ion observes — under CliBackend too. We log a
  // normalized `subagent_dispatch` row here so usage analytics stop splitting one
  // staffer across `-`/`_` variants (the raw `agent_dispatch` events ion writes
  // are unnormalized). The logEvent is a synchronous local SQLite write — safe
  // from a hook handler (the host_rpc async caveat applies only to ctx.* RPCs).
  ion.on('agent_start', (ctx, agentInfo) => {
    if (!agentInfo?.name) return
    const name = normalizeAgentName(agentInfo.name)
    try {
      logEvent(ctx?.sessionKey || 'jarvis', 'subagent_dispatch', {
        name,
        task: typeof agentInfo.task === 'string' ? agentInfo.task.slice(0, 80) : undefined,
        source: 'ion',
      })
    } catch {
      // Observe-only: never let telemetry failure affect the dispatch.
    }
    // Stamp the dispatch start so agent_end can record its wall-clock duration.
    // Interactive (LLM Agent-tool) dispatches run in-turn, so this is the slice
    // of a slow reply spent inside a sub-agent (e.g. the mail-triage staffer).
    // Keyed by name as a stack to tolerate same-name/nested dispatches.
    const stack = _dispatchStart.get(name) ?? []
    stack.push(Date.now())
    _dispatchStart.set(name, stack)
  })

  // agent_end is an observe-only engine hook (ion/docs/hooks/reference.md). Pair
  // it with the agent_start stamp to emit a dispatch:<name> perf_span so staff
  // dispatch latency is visible (dashboard: jarvis-turn-latency).
  // Also accumulates a DispatchReceipt for the turn receipt block emitted at turn_end.
  ion.on('agent_end', (ctx, agentInfo) => {
    if (!agentInfo?.name) return
    const name = normalizeAgentName(agentInfo.name)
    const t0 = _dispatchStart.get(name)?.pop()
    if (t0 === undefined) return
    const durationMs = Date.now() - t0
    try {
      logEvent('perf', 'perf_span', { name: `dispatch:${name}`, durationMs })
    } catch {
      // Observe-only: never let telemetry failure affect the dispatch.
    }
    try {
      const key = ctx?.sessionKey || 'jarvis'
      const receipts = _turnReceipts.get(key) ?? []
      receipts.push({
        name,
        task: typeof agentInfo.task === 'string' ? agentInfo.task.slice(0, 60) : undefined,
        durationMs,
      })
      _turnReceipts.set(key, receipts)
    } catch {
      // Observe-only: never let receipt accumulation affect the dispatch.
    }
  })

  // Clear stale receipts and the per-turn recall degradation signal at the start
  // of each turn so carryover from prior turns never pollutes the next blocks.
  ion.on('turn_start', (ctx) => {
    _turnReceipts.delete(ctx?.sessionKey || 'jarvis')
    clearRecallDegradation()
  })

  // Emit the receipt block and/or degradation note after the turn completes.
  // consumeRecallDegradation() is called unconditionally so the signal is always
  // drained, even when there are no receipts to send.
  ion.on('turn_end', (ctx) => {
    const key = ctx?.sessionKey || 'jarvis'
    const receipts = _turnReceipts.get(key)
    _turnReceipts.delete(key)
    const deg = consumeRecallDegradation()
    const parts: string[] = []
    if (receipts && receipts.length > 0) {
      parts.push(formatDispatchReceipts(receipts))
    }
    if (deg !== null) {
      parts.push(formatDegradationNote(deg))
    }
    if (parts.length === 0) return
    try {
      // Deliver via engine_notify (display-only, rendered by desktop/iOS
      // clients), NOT ctx.sendMessage -- sendMessage re-prompts the LLM
      // (host wires it to m.SendPrompt: prompt_extensions.go:57), which on
      // this every-turn hot path would cause an infinite re-prompt / dispatch
      // cascade and pollute conversation context. emit is one-way to clients.
      ctx.emit({
        type: 'engine_notify',
        message: parts.join('\n\n'),
        level: deg !== null ? 'warn' : 'info',
      })
    } catch {
      // Observe-only: never let receipt delivery affect the turn.
    }
  })
}

// Per-name stack of dispatch start timestamps, drained by agent_end. Module-scoped
// so the start/end handlers share it across the single wireHooks registration.
const _dispatchStart = new Map<string, number[]>()

// Per-session receipt accumulator, keyed by sessionKey. Populated by agent_end,
// consumed and cleared by turn_end, reset at turn_start.
const _turnReceipts = new Map<string, DispatchReceipt[]>()
