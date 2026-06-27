/**
 * Agent Dispatch -- dispatches tasks to department agents via the Ion engine.
 *
 * Uses the SDK's background dispatch with structured lifecycle callbacks:
 * 1. Looks up the agent definition in the ControlRoom
 * 2. Builds the agent's system prompt
 * 3. Marks the agent as running and returns immediately
 * 4. Runs ctx.dispatchAgent({ background: true }) with lifecycle callbacks
 * 5. onComplete/onError/onRecall handle ControlRoom state + parent notification
 */

import { readFileSync, existsSync } from 'fs'
import type { AgentDef, DispatchResult } from './types'
import type { ControlRoom } from './control-room'
import type { IonContext } from 'ion-sdk'
import { recordDispatch } from './team-state'

interface DispatchOptions {
  agent: string
  task: string
  model: string
  workingDirectory: string
  universalStandards?: string
  skipSessionPersistence?: boolean
  contextWindow?: number
  /** Extension context for engine-native dispatch */
  ctx?: IonContext
  /** Parent agent name for hierarchy (set by ControlRoom) */
  parentAgent?: string
  /** All agent definitions -- used to build specialist catalogs for chiefs */
  allAgentDefs?: AgentDef[]
  /** dataHome and teamName for recording dispatch telemetry in team state */
  dataHome?: string
  teamName?: string
  /**
   * Hard timeout (ms) on the background dispatch. If the dispatch has not
   * completed in this window, ctx.recallAgent is called with reason 'timeout'.
   * The onRecall callback then marks the agent errored and notifies the parent.
   */
  timeoutMs?: number
  /**
   * Suppress the onComplete/onError/onRecall ctx.sendMessage parent-notification.
   * The ControlRoom panel is still updated (markDone/markError) so live state is
   * unaffected -- only the LLM re-prompt is skipped. Set by the synchronous
   * dispatchAgentAndWait path: there the caller already returns the result inline
   * as the tool result, so a sendMessage re-prompt would (a) double-deliver and
   * (b) land in a background-initiated turn that interactive clients (Ion Desktop,
   * iOS) never render. Inline tool-result delivery renders in every client.
   */
  suppressParentNotify?: boolean
}

/** Default ceiling on a single background dispatch before it is recalled.
 * Must be < ion toolDefaultMs (300_000ms / 5min) so the full dispatch cycle
 * (recall at Nms + waitForCompletion at N+5_000ms) completes before ion kills
 * the extension tool context. At 4min, the cycle finishes with ~55s to spare.
 */
const DEFAULT_DISPATCH_TIMEOUT_MS = 4 * 60_000

// ── Tool Name Formatting ──

function formatToolName(toolName: string): string {
  switch (toolName) {
    case 'Read': return 'Reading file'
    case 'Edit': return 'Editing file'
    case 'Write': return 'Writing file'
    case 'Grep': return 'Searching'
    case 'Glob': return 'Finding files'
    case 'Bash': return 'Running command'
    case 'Agent': return 'Dispatching agent'
    default: return `Using ${toolName}`
  }
}

// ── Dispatch Function ──

export function dispatchAgent(
  office: ControlRoom,
  opts: DispatchOptions,
): Promise<DispatchResult> {
  const agentName = opts.agent

  // Pre-flight: check if agent exists and is available
  const existing = office.resolveAgent(agentName)
  if (!existing) {
    const globalDef = office.agentExistsGlobally(agentName)
    const hint = globalDef
      ? ` Agent "${agentName}" exists but is not in the active team "${office.activeTeam}". Switch teams with /agents-team.`
      : ''
    const available = office.getAllStates().map(s => s.def.name).join(', ')
    return Promise.resolve({
      output: `Agent "${agentName}" not found in team "${office.activeTeam}".${hint} Available: ${available}`,
      exitCode: 1,
      elapsed: 0,
      cost: 0,
      inputTokens: 0,
      outputTokens: 0,
    })
  }

  if (existing.status === 'running') {
    return Promise.resolve({
      output: `Agent "${existing.def.displayName}" is already running. Wait for it to finish or use recall_agent to terminate it.`,
      exitCode: 1,
      elapsed: 0,
      cost: 0,
      inputTokens: 0,
      outputTokens: 0,
    })
  }

  if (!opts.ctx) {
    return Promise.resolve({
      output: 'Error: engine context not available for dispatch',
      exitCode: 1,
      elapsed: 0,
      cost: 0,
      inputTokens: 0,
      outputTokens: 0,
    })
  }

  // Mark as running (resets state, starts timer)
  office.markRunning(agentName, opts.task)

  // Build agent system prompt
  let agentPrompt = existing.def.systemPrompt
  if (opts.universalStandards && existsSync(opts.universalStandards)) {
    try {
      const standards = readFileSync(opts.universalStandards, 'utf-8')
      if (standards.trim()) {
        agentPrompt = standards + '\n\n' + agentPrompt
      }
    } catch {
      // Standards unreadable
    }
  }

  // For chiefs: inject specialist catalog
  if (existing.def.type === 'lead' && existing.def.specialists?.length) {
    const allDefs = opts.allAgentDefs || []
    const specDefs = allDefs.filter(d =>
      d.type === 'specialist' && existing.def.specialists?.includes(d.name)
    )
    if (specDefs.length > 0) {
      agentPrompt += '\n\n## Your Specialists\n'
      agentPrompt += 'You have the following specialists available via the dispatch_specialist tool:\n'
      for (const spec of specDefs) {
        agentPrompt += `- **${spec.name}**: ${spec.description}\n`
      }
      agentPrompt += '\nTo delegate to a specialist, use the dispatch_specialist tool with the specialist name and a clear task description. Your dispatch request will be routed through the department hierarchy.\n'
    }
  }

  // Resolve session ID for resume (if available)
  const priorSession = !opts.skipSessionPersistence ? office.getSessionId(agentName) : null

  // Capture ctx for background closure
  const ctx = opts.ctx
  const displayName = existing.def.displayName
  const startTime = new Date()

  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_DISPATCH_TIMEOUT_MS

  // Local accumulated text for flush-on-tool-start. The onTextDelta callback
  // gives us info.accumulated for updateWork, but we track a local
  // since-last-flush buffer because we clear it each time a tool starts
  // (converting pre-tool text into a pushMessage).
  let accumulatedText = ''
  let completed = false

  // Timeout: recall the agent if the dispatch hasn't completed
  const timeoutHandle = setTimeout(() => {
    if (!completed) {
      ctx.recallAgent(agentName, { reason: 'timeout' }).catch((err) => {
        process.stderr.write(`[agent-dispatch] recallAgent timeout failed for ${agentName}: ${err}\n`)
      })
    }
  }, timeoutMs)

  // Background dispatch with structured lifecycle callbacks
  ctx.dispatchAgent({
    name: agentName,
    task: opts.task,
    model: opts.model,
    systemPrompt: agentPrompt,
    projectPath: opts.workingDirectory,
    ...(priorSession ? { sessionId: priorSession } : {}),
    background: true,

    // ── Text streaming ──
    onTextDelta: (info) => {
      accumulatedText += info.delta
      office.updateWork(agentName, info.accumulated)
    },

    // ── Tool lifecycle ──
    onToolStart: (info) => {
      // Flush accumulated text before the tool call
      if (accumulatedText.trim()) {
        office.pushMessage(agentName, { role: 'assistant', content: accumulatedText.trim() })
        accumulatedText = ''
      }
      const desc = formatToolName(info.toolName)
      office.incrementTools(agentName, desc)
      office.pushMessage(agentName, { role: 'tool', content: desc, toolName: info.toolName })
    },

    onToolEnd: () => {
      // No-op: tool completion doesn't drive ControlRoom state currently
    },

    onToolError: (info) => {
      process.stderr.write(`[agent-dispatch] tool error in ${agentName}: ${info.toolName} - ${info.content}\n`)
    },

    // ── Usage tracking (cumulative) ──
    onUsage: (info) => {
      office.setCumulativeUsage(agentName, info.cumulativeInputTokens, info.cumulativeOutputTokens)
      if (info.cumulativeCost > 0) office.setCumulativeCost(agentName, info.cumulativeCost)
      if (opts.contextWindow && opts.contextWindow > 0 && info.cumulativeInputTokens > 0) {
        office.updateContextPct(agentName, Math.round((info.cumulativeInputTokens / opts.contextWindow) * 100))
      }
    },

    // ── Completion (happy path) ──
    onComplete: (result) => {
      completed = true
      clearTimeout(timeoutHandle)

      // Flush remaining assistant text
      if (accumulatedText.trim()) {
        office.pushMessage(agentName, { role: 'assistant', content: accumulatedText.trim() })
      }

      // Store session ID for future resume
      if (result.sessionId && !opts.skipSessionPersistence) {
        office.setSessionId(agentName, result.sessionId)
      }

      const exitCode = result.exitCode
      const outputTrimmed = (result.output || '').trim()
      const toolCount = office.getState(agentName)?.toolCount ?? 0
      const elapsed = Math.round(result.elapsed)

      let finalOutput = result.output
      let emptyReason: string | undefined

      if (exitCode === 0 && outputTrimmed === '' && toolCount === 0) {
        emptyReason = `Empty completion: no output and no tool calls (toolCount=${toolCount}, textChars=${accumulatedText.length}, elapsed=${elapsed}s). Model produced no response or hit immediate stop.`
        office.markError(agentName, emptyReason)
      } else if (exitCode === 0 && outputTrimmed === '' && toolCount > 0) {
        finalOutput = `[silent: ${toolCount} tools, no narration]`
        office.markDone(agentName, finalOutput, exitCode)
      } else {
        office.markDone(agentName, result.output, exitCode)
      }

      // Notify parent LLM that the agent completed (skipped for synchronous
      // dispatch, which returns the result inline as the tool result instead).
      if (!opts.suppressParentNotify) {
        if (emptyReason) {
          ctx.sendMessage(`[Agent ${displayName} produced no output in ${elapsed}s] ${emptyReason} Retry with a more concrete task or call check_agent_status for state. See engine.log for details.`)
        } else {
          const status = exitCode === 0 ? 'completed' : 'failed'
          ctx.sendMessage(`[Agent ${displayName} ${status} in ${elapsed}s]\n\n${finalOutput}`)
        }
      }

      // Record dispatch telemetry with real values
      if (opts.dataHome && opts.teamName) {
        recordDispatch(opts.dataHome, opts.teamName, {
          agent: agentName,
          task: opts.task,
          started: startTime.toISOString(),
          completed: new Date().toISOString(),
          exitCode: result.exitCode,
          elapsed: result.elapsed,
          cost: result.cost ?? 0,
          inputTokens: result.inputTokens ?? 0,
          outputTokens: result.outputTokens ?? 0,
        })
      }
    },

    // ── Error ──
    onError: (err) => {
      completed = true
      clearTimeout(timeoutHandle)

      const stack = err.message
      office.markError(agentName, `Error: ${stack}`)
      if (!opts.suppressParentNotify) ctx.sendMessage(`[Agent ${displayName} failed]: ${stack}`)
    },

    // ── Recall (engine-level cancellation) ──
    onRecall: (info) => {
      completed = true
      clearTimeout(timeoutHandle)

      const reason = info.reason || 'recalled'
      const elapsed = info.elapsed
      office.markError(agentName, `Recalled: ${reason}`)
      if (!opts.suppressParentNotify) ctx.sendMessage(`[Agent ${displayName} recalled after ${Math.round(elapsed)}s] ${reason}`)
    },
  }).catch((err: unknown) => {
    // dispatchAgent itself rejected (pre-flight error in engine)
    completed = true
    clearTimeout(timeoutHandle)
    const message = err instanceof Error ? err.message : String(err)
    office.markError(agentName, `Error: ${message}`)
    if (!opts.suppressParentNotify) ctx.sendMessage(`[Agent ${displayName} failed]: ${message}`)
  })

  // Return immediately -- agent runs in background
  return Promise.resolve({
    output: `Agent "${displayName}" dispatched. Working in background. You will receive a message with the full result when the agent finishes. Do NOT poll check_agent_status - just wait for the completion message or move on to other work.`,
    exitCode: 0,
    elapsed: 0,
    cost: 0,
    inputTokens: 0,
    outputTokens: 0,
  })
}

/**
 * Dispatch an agent and resolve only once it completes (done or error).
 * Reads the final response from ControlRoom instead of from the fire-and-
 * forget stub returned by dispatchAgent. Use this when the caller needs
 * the actual agent output, e.g. building a meeting transcript.
 *
 * Returns the same DispatchResult shape as dispatchAgent, populated from
 * the resolved AgentState. If the stub itself reports a pre-flight error
 * (unknown agent, already running, missing ctx) that stub is returned
 * unchanged and no wait is performed.
 *
 * suppressParentNotify is forced on: this path returns the result to the caller
 * inline, so the background onComplete must NOT also fire a sendMessage re-prompt
 * (that would double-deliver and the re-prompt's output never reaches an
 * interactive client anyway).
 */
export async function dispatchAgentAndWait(
  office: ControlRoom,
  opts: DispatchOptions,
): Promise<DispatchResult> {
  const stub = await dispatchAgent(office, { ...opts, suppressParentNotify: true })
  if (stub.exitCode !== 0) {
    return stub
  }
  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_DISPATCH_TIMEOUT_MS
  try {
    const state = await office.waitForCompletion(opts.agent, timeoutMs + 5_000)
    return {
      output: state.fullOutput || state.lastWork || '',
      exitCode: state.status === 'done' ? 0 : 1,
      elapsed: state.elapsed,
      cost: state.cost,
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
    }
  } catch (err: unknown) {
    return {
      output: `Agent "${opts.agent}" did not complete: ${err instanceof Error ? err.message : String(err)}`,
      exitCode: 1,
      elapsed: 0,
      cost: 0,
      inputTokens: 0,
      outputTokens: 0,
    }
  }
}

// ── Recall Helper ──

/**
 * Recall a running agent via the engine's background dispatch registry.
 * Returns true if the engine found and cancelled the dispatch; false if
 * no background dispatch was found (caller should fall back to manual
 * ControlRoom state cleanup).
 */
export async function recallAgent(
  office: ControlRoom,
  agentName: string,
  ctx: IonContext,
  reason?: string,
): Promise<boolean> {
  const recalled = await ctx.recallAgent(agentName, reason !== undefined ? { reason } : {})
  if (!recalled) {
    // No background dispatch found -- fall back to ControlRoom-only cleanup
    office.markError(agentName, reason ? `Recalled: ${reason}` : 'Recalled by ion-dev')
  }
  // If recalled is true, the onRecall callback in dispatchAgent handles
  // ControlRoom state transition and parent notification.
  return recalled
}
