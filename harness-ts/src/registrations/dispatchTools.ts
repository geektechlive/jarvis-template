/**
 * Dispatch tools — the ControlRoom-backed agent dispatch surface.
 *
 * Registers six ion tools that replace the engine's generic Agent tool:
 *   dispatch_agent      — any staff/lead agent (blocking, awaited)
 *   dispatch_specialist — specialist agents only
 *   request_consultant  — consultant agents (fresh context each time)
 *   recall_agent        — cancel a running agent
 *   check_agent_status  — query ControlRoom for current agent states
 *   convene_meeting     — structured multi-agent meeting
 *
 * Modeled on ion-dev's tool registrations (ion-extension.ts lines 1131-1463),
 * adapted for Jarvis's strict TypeScript config (no `any` params, no OPS_HOME,
 * exact-optional-types-safe option building).
 *
 * All handlers read state.office at call time (not at registration) so they
 * always see the post-session_start ControlRoom, not a null snapshot.
 */

import { join } from 'node:path'
import { homedir } from 'node:os'
import type { IonSDK, IonContext } from 'ion-sdk'
import { log } from 'ion-sdk'
import { HARNESS_DIR } from '../config'
import { dispatchAgent, dispatchAgentAndWait, recallAgent } from '../staff/agent-dispatch'
import { conveneMeeting } from '../staff/meetings'
import { state } from '../staff/shared-state'

/** Working directory for dispatched agents: prefer engine config, fall back. */
function workingDir(ctx: IonContext): string {
  return ctx.config.workingDirectory || ctx.cwd || join(homedir(), 'Jarvis') || HARNESS_DIR
}

/** Model for a dispatch: per-agent frontmatter → config → session model → fallback. */
function resolveModel(ctx: IonContext, agentModel?: string): string {
  return agentModel ?? ctx.config.model ?? ctx.model?.id ?? 'claude-sonnet-4-6'
}

export function registerDispatchTools(ion: IonSDK): void {

  // ── dispatch_agent ──────────────────────────────────────────────────────────

  ion.registerTool({
    name: 'dispatch_agent',
    description: 'Dispatch a task to a staff or lead agent. The agent executes and returns its result. Use check_agent_status to see available agents.',
    planModeSafe: true,
    parameters: {
      type: 'object',
      properties: {
        agent: {
          type: 'string',
          description: "Agent name (case-insensitive, e.g. 'admin', 'personal-cfo')",
        },
        task: {
          type: 'string',
          description: 'Clear task description for the agent to execute',
        },
        reasoning: {
          type: 'boolean',
          description: 'Use a reasoning model for this dispatch. Default: false.',
        },
      },
      required: ['agent', 'task'],
    },

    execute: async (params, ctx) => {
      const office = state.office
      if (!office) {
        return { content: 'ControlRoom not initialized — try again in a moment.', isError: true }
      }

      const agent = params['agent'] as string
      const task  = params['task'] as string
      const reasoning = params['reasoning'] as boolean | undefined

      const def = state.allAgentDefs.find(d => d.name.toLowerCase() === agent.toLowerCase())
      const model = reasoning
        ? 'claude-opus-4-6'
        : resolveModel(ctx, def?.model)

      try {
        ctx.emit({ type: 'engine_working_message', message: `dispatching ${agent}...` })

        const dispatchOpts = {
          agent,
          task,
          model,
          workingDirectory: workingDir(ctx),
          ctx,
        } as Parameters<typeof dispatchAgent>[1]

        const parentAgent = office.findParent(agent)
        if (parentAgent !== undefined) dispatchOpts.parentAgent = parentAgent

        if (state.allAgentDefs.length > 0) dispatchOpts.allAgentDefs = state.allAgentDefs

        const result = await dispatchAgentAndWait(office, dispatchOpts)

        const status  = result.exitCode === 0 ? 'done' : 'error'
        const elapsed = Math.round(result.elapsed)

        ctx.emit({ type: 'engine_working_message', message: '' })
        return { content: `[${agent}] ${status} in ${elapsed}s\n\n${result.output}` }
      } catch (err: unknown) {
        ctx.emit({ type: 'engine_working_message', message: '' })
        const msg = err instanceof Error ? err.message : String(err)
        log.warn('jarvis: dispatch_agent error', { agent, err: msg })
        return { content: `Error dispatching to ${agent}: ${msg}`, isError: true }
      }
    },
  })

  // ── dispatch_specialist ─────────────────────────────────────────────────────

  ion.registerTool({
    name: 'dispatch_specialist',
    description: 'Dispatch a task to a specialist agent only. Use dispatch_agent for staff or lead agents.',
    planModeSafe: true,
    parameters: {
      type: 'object',
      properties: {
        agent: {
          type: 'string',
          description: "Specialist name",
        },
        task: {
          type: 'string',
          description: 'Clear task description for the specialist',
        },
      },
      required: ['agent', 'task'],
    },

    execute: async (params, ctx) => {
      const office = state.office
      if (!office) {
        return { content: 'ControlRoom not initialized — try again in a moment.', isError: true }
      }

      const agent = params['agent'] as string
      const task  = params['task'] as string

      const def = state.allAgentDefs.find(d => d.name.toLowerCase() === agent.toLowerCase())
      if (!def) {
        return { content: `Specialist "${agent}" not found.`, isError: true }
      }
      if (def.type !== 'specialist') {
        return {
          content: `"${agent}" is a ${def.type}, not a specialist. Use dispatch_agent for non-specialists.`,
          isError: true,
        }
      }

      const model = resolveModel(ctx, def.model)

      try {
        ctx.emit({ type: 'engine_working_message', message: `dispatching specialist ${agent}...` })

        const dispatchOpts = {
          agent,
          task,
          model,
          workingDirectory: workingDir(ctx),
          ctx,
        } as Parameters<typeof dispatchAgent>[1]

        const parentAgent = office.findParent(agent)
        if (parentAgent !== undefined) dispatchOpts.parentAgent = parentAgent

        if (state.allAgentDefs.length > 0) dispatchOpts.allAgentDefs = state.allAgentDefs

        const result = await dispatchAgentAndWait(office, dispatchOpts)

        const truncated = result.output.length > 8000
          ? result.output.slice(0, 8000) + '\n\n... [truncated]'
          : result.output
        const status  = result.exitCode === 0 ? 'done' : 'error'
        const elapsed = Math.round(result.elapsed)

        ctx.emit({ type: 'engine_working_message', message: '' })
        return { content: `[specialist:${agent}] ${status} in ${elapsed}s\n\n${truncated}` }
      } catch (err: unknown) {
        ctx.emit({ type: 'engine_working_message', message: '' })
        const msg = err instanceof Error ? err.message : String(err)
        return { content: `Error dispatching specialist ${agent}: ${msg}`, isError: true }
      }
    },
  })

  // ── request_consultant ──────────────────────────────────────────────────────

  ion.registerTool({
    name: 'request_consultant',
    description: 'Request advisory from a consultant agent. Consultants provide read-only analysis; each request gets fresh context (no session persistence).',
    planModeSafe: true,
    parameters: {
      type: 'object',
      properties: {
        agent: {
          type: 'string',
          description: "Consultant name",
        },
        task: {
          type: 'string',
          description: 'Question or analysis request for the consultant',
        },
      },
      required: ['agent', 'task'],
    },

    execute: async (params, ctx) => {
      const office = state.office
      if (!office) {
        return { content: 'ControlRoom not initialized — try again in a moment.', isError: true }
      }

      const agent = params['agent'] as string
      const task  = params['task'] as string

      const def = state.allAgentDefs.find(d => d.name.toLowerCase() === agent.toLowerCase())
      if (!def) {
        return { content: `Consultant "${agent}" not found.`, isError: true }
      }
      if (def.type !== 'consultant') {
        return {
          content: `"${agent}" is a ${def.type}, not a consultant. Use dispatch_agent for non-consultants.`,
          isError: true,
        }
      }

      const model = resolveModel(ctx, def.model)

      try {
        ctx.emit({ type: 'engine_working_message', message: `consulting ${agent}...` })

        // Consultants always get fresh context: skipSessionPersistence: true.
        const dispatchOpts = {
          agent,
          task,
          model,
          workingDirectory: workingDir(ctx),
          skipSessionPersistence: true,
          ctx,
        } as Parameters<typeof dispatchAgent>[1]

        const result = await dispatchAgentAndWait(office, dispatchOpts)

        const truncated = result.output.length > 8000
          ? result.output.slice(0, 8000) + '\n\n... [truncated]'
          : result.output
        const status  = result.exitCode === 0 ? 'done' : 'error'
        const elapsed = Math.round(result.elapsed)

        ctx.emit({ type: 'engine_working_message', message: '' })
        return { content: `[consultant:${agent}] ${status} in ${elapsed}s\n\n${truncated}` }
      } catch (err: unknown) {
        ctx.emit({ type: 'engine_working_message', message: '' })
        const msg = err instanceof Error ? err.message : String(err)
        return { content: `Error consulting ${agent}: ${msg}`, isError: true }
      }
    },
  })

  // ── recall_agent ────────────────────────────────────────────────────────────

  ion.registerTool({
    name: 'recall_agent',
    description: 'Terminate a running agent via engine-level cancellation.',
    planModeSafe: true,
    parameters: {
      type: 'object',
      properties: {
        agent: {
          type: 'string',
          description: 'Agent name to recall (case-insensitive)',
        },
        reason: {
          type: 'string',
          description: 'Why this agent is being recalled',
        },
      },
      required: ['agent'],
    },

    execute: async (params, ctx) => {
      const office = state.office
      if (!office) {
        return { content: 'ControlRoom not initialized — try again in a moment.', isError: true }
      }

      const agent  = params['agent'] as string
      const reason = params['reason'] as string | undefined

      const agentState = office.resolveAgent(agent)
      if (!agentState) {
        return { content: `Agent "${agent}" not found.`, isError: true }
      }
      if (agentState.status !== 'running') {
        return {
          content: `Agent "${agentState.def.displayName}" is not running (status: ${agentState.status}).`,
          isError: true,
        }
      }

      const recalled = await recallAgent(office, agent, ctx, reason)
      const displayName = agentState.def.displayName
      const suffix = reason ? ` Reason: ${reason}` : ''
      if (recalled) {
        return { content: `Agent "${displayName}" has been recalled via engine cancellation.${suffix}` }
      }
      return {
        content: `Agent "${displayName}" has been recalled.${suffix} (no active engine dispatch found, state cleaned up locally)`,
      }
    },
  })

  // ── check_agent_status ──────────────────────────────────────────────────────

  ion.registerTool({
    name: 'check_agent_status',
    description: 'Check the current status of dispatched agents (running/done/error). Omit agent to see all non-idle agents.',
    planModeSafe: true,
    parameters: {
      type: 'object',
      properties: {
        agent: {
          type: 'string',
          description: 'Agent name to check (omit to see all non-idle agents)',
        },
      },
    },

    execute: async (params, _ctx) => {
      const office = state.office
      if (!office) {
        return { content: 'ControlRoom not initialized — try again in a moment.', isError: true }
      }

      const agent = params['agent'] as string | undefined

      const formatState = (s: ReturnType<typeof office.resolveAgent>): unknown => {
        if (!s) return null
        const elapsedSec = s.elapsed > 0 ? Math.round(s.elapsed) : 0
        const synthExit  = s.status === 'error' ? 1 : s.status === 'done' ? 0 : null
        const truncatedOutput = s.fullOutput && s.fullOutput.length > 2000
          ? s.fullOutput.slice(0, 2000) + '\n... [truncated]'
          : s.fullOutput || ''
        return {
          name:          s.def.name,
          displayName:   s.def.displayName,
          status:        s.status,
          task:          s.task || '',
          toolCount:     s.toolCount,
          elapsedSeconds: elapsedSec,
          lastWork:      s.lastWork || '',
          output:        truncatedOutput,
          exitCode:      synthExit,
        }
      }

      if (agent) {
        const agentState = office.resolveAgent(agent)
        if (!agentState) {
          return {
            content: `Agent "${agent}" not found in active team "${office.activeTeam}".`,
            isError: true,
          }
        }
        return { content: JSON.stringify(formatState(agentState), null, 2) }
      }

      const all = office.getAllStates().filter(s => s.status !== 'idle')
      if (all.length === 0) {
        return { content: 'No agents are running, done, or in error state. All idle.' }
      }
      return { content: JSON.stringify(all.map(formatState), null, 2) }
    },
  })

  // ── convene_meeting ─────────────────────────────────────────────────────────

  ion.registerTool({
    name: 'convene_meeting',
    description: 'Convene a structured meeting with multiple agents. Each participant responds to the brief and to each other across multiple rounds. Returns a consolidated transcript.',
    planModeSafe: true,
    parameters: {
      type: 'object',
      properties: {
        brief: {
          type: 'string',
          description: 'The topic, question, or brief for the meeting',
        },
        participants: {
          type: 'array',
          items: { type: 'string' },
          description: "Agent names to participate (e.g. ['admin', 'personal-cfo'])",
        },
        rounds: {
          type: 'number',
          description: 'Number of discussion rounds (default 2)',
        },
      },
      required: ['brief', 'participants'],
    },

    execute: async (params, ctx) => {
      const office = state.office
      if (!office) {
        return { content: 'ControlRoom not initialized — try again in a moment.', isError: true }
      }

      const brief        = params['brief'] as string
      const participants = params['participants'] as string[]
      const rounds       = (params['rounds'] as number | undefined) ?? 2

      const model = resolveModel(ctx)

      try {
        ctx.emit({
          type: 'engine_working_message',
          message: `convening meeting (${participants.length} participants, ${rounds} rounds)...`,
        })

        const result = await conveneMeeting(office, {
          brief,
          participants,
          rounds,
          model,
          workingDirectory: workingDir(ctx),
          ctx,
        })

        ctx.emit({ type: 'engine_working_message', message: '' })
        return { content: result.transcript }
      } catch (err: unknown) {
        ctx.emit({ type: 'engine_working_message', message: '' })
        const msg = err instanceof Error ? err.message : String(err)
        return { content: `Error convening meeting: ${msg}`, isError: true }
      }
    },
  })
}
