import { log, type IonSDK } from 'ion-sdk'
import { logEvent } from '../memory/episodic'
import { TOOL_TIERS, agentLoopState, LOOP_WARN_THRESHOLD, LOOP_BLOCK_THRESHOLD } from './state'

// Permission pipeline + dispatch loop guard.
//
// Agent-dispatch ControlRoom state is not tracked here. Interactive staff
// dispatch goes through the typed dispatch tools (dispatch_agent /
// dispatch_specialist / request_consultant); the ControlRoom feeds
// engine_agent_state via its onChange wire (see staff/init.ts). The generic
// Agent tool is suppressed at session_start.
export function wireToolPipeline(ion: IonSDK): void {
  ion.on('permission_classify', (_ctx, info) => {
    const tool = info?.tool_name ?? ''
    const tier = TOOL_TIERS[tool]
    log.debug('jarvis: permission_classify', { tool, tier: tier ?? 'null (deferred to ion)' })
    return tier ?? null
  })

  ion.on('permission_request', (ctx, info) => {
    if (!info) return
    logEvent(ctx.sessionKey, 'permission_request', {
      tool_name: info.tool_name,
      decision: info.decision,
      tier: info.tier ?? null,
      rule_name: info.rule_name ?? null,
    })
    log.debug('jarvis: permission_request', { tool: info.tool_name, decision: info.decision, tier: info.tier })
  })

  // Loop guard: track consecutive dispatch calls to the same agent.
  // The generic Agent tool is suppressed (session_start:ctx.suppressTool) so all
  // interactive delegation goes through the typed dispatch tools
  // (dispatch_agent / dispatch_specialist / request_consultant), which fire as
  // 'tool_call' not 'agent_tool_call'. These tools take the target agent as the
  // `agent` argument (the tool name itself is generic), so the loop state must
  // key on info.input.agent, not the tool name, or dispatching different staff
  // in a row would false-trip the guard. convene_meeting is multi-agent and is
  // intentionally excluded. (#710)
  const DISPATCH_TOOLS = new Set(['dispatch_agent', 'dispatch_specialist', 'request_consultant'])
  ion.on('tool_call', (ctx, info) => {
    if (!info || !DISPATCH_TOOLS.has(info.toolName)) return

    // The dispatched agent is the `agent` argument; fall back to the tool name
    // only if it is somehow absent.
    const rawAgent = info.input?.['agent']
    const agentName = typeof rawAgent === 'string' && rawAgent.length > 0 ? rawAgent : info.toolName

    const prev = agentLoopState.get(ctx.sessionKey)
    const count = prev && prev.lastName === agentName ? prev.count + 1 : 1
    agentLoopState.set(ctx.sessionKey, { lastName: agentName, count })

    if (count >= LOOP_BLOCK_THRESHOLD) {
      log.warn('jarvis: loop guard — blocking agent call', {
        session: ctx.sessionKey,
        count,
        agent: agentName,
      })
      void logEvent(ctx.sessionKey, 'loop_guard_block', { count, agentName })
      ctx.emit({
        type: 'engine_notify',
        message: `Loop guard: blocked dispatch #${count} to "${agentName}". Session intervention needed.`,
        level: 'warn',
      })
      ctx.sendMessage(
        `[Loop guard] Blocked. "${agentName}" has been delegated to ${count} consecutive times — ` +
          `this indicates a routing loop. Please start a new session or change the model.`,
      )
      return { block: true, reason: `Loop guard: ${count} consecutive dispatches to "${agentName}" detected.` }
    }

    if (count >= LOOP_WARN_THRESHOLD) {
      log.warn('jarvis: loop guard — repeated agent calls', {
        session: ctx.sessionKey,
        count,
        agent: agentName,
      })
      void logEvent(ctx.sessionKey, 'loop_guard_warn', { count, agentName })
      ctx.emit({
        type: 'engine_notify',
        message: `Loop guard: "${agentName}" called ${count} consecutive times. Watching.`,
        level: 'warn',
      })
    }
  })

  ion.on('permission_denied', (ctx, info) => {
    if (!info) return
    logEvent(ctx.sessionKey, 'permission_denied', {
      tool_name: info.tool_name,
      reason: info.reason,
    })
    log.warn('jarvis: permission_denied', { session: ctx.sessionKey, tool: info.tool_name, reason: info.reason })
    ctx.sendMessage(`[System] Tool \`${info.tool_name}\` was denied. Reason: ${info.reason}`)
  })
}
