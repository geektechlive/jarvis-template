/**
 * initializeControlRoom — wires the ControlRoom for a session.
 *
 * Modeled on ion-dev's initializeControlRoom (lines 427-633 of ion-extension.ts),
 * adapted to Jarvis's simpler agent layout:
 *  - No departments/specialists hierarchy — all agents are flat staff or workers.
 *  - No teams.yaml — a synthetic "all" team is activated containing every agent.
 *  - No ops-git-sync, buildSystemPrompt, bootstrap, damage-control, or clearReadMemos.
 *  - Emits engine_status (label: 'jarvis') + engine_agent_state after building the panel.
 *
 * Called at session_start and extension_respawned so the ControlRoom is always
 * populated and the UI panel reflects current agent definitions.
 */

import { join } from 'node:path'
import { log } from 'ion-sdk'
import type { IonContext } from 'ion-sdk'
import { HARNESS_DIR } from '../config'
import { ControlRoom } from './control-room'
import type { AgentDef } from './types'
import { state } from './shared-state'
import { recordError } from '../memory/episodic'

// ── Visibility defaults by agent type (mirrors ion-dev) ──

const DEFAULT_VISIBILITY: Record<string, AgentDef['visibility']> = {
  lead:       'always',
  specialist: 'ephemeral',
  staff:      'sticky',
  consultant: 'sticky',
}

// ── formatDisplayName: title-case a hyphenated agent name ──

function formatDisplayName(name: string): string {
  return name.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

// ── ControlRoom singleton (shared across sessions in the same extension process) ──

const office = new ControlRoom()

/**
 * Wire the ControlRoom into the extension context for this session.
 *
 * Safe to call multiple times (session_start + extension_respawned): resets
 * allAgentDefs, re-discovers agents, and rebuilds the panel from scratch.
 * Never throws — errors are logged and the existing state is preserved so
 * the extension stays live.
 */
export async function initializeControlRoom(ctx: IonContext): Promise<void> {
  try {
    // Reset the agent definitions list before (re)populating so double-append
    // cannot happen on respawn when this function fires a second time.
    const allAgentDefs: AgentDef[] = []

    // Discover agents: extension source (bundled agents/) + harness/agents/ extraDir.
    // This matches roster.ts's working discovery args exactly.
    let discovered: Awaited<ReturnType<typeof ctx.discoverAgents>> = []
    try {
      discovered = await ctx.discoverAgents({
        sources: ['extension'],
        extraDirs: [join(HARNESS_DIR, 'harness', 'agents')],
      })
      log.info('jarvis: initializeControlRoom discovered agents', { count: discovered.length })
    } catch (discoverErr) {
      log.warn('jarvis: initializeControlRoom discoverAgents failed', { err: String(discoverErr) })
      recordError('control_room_init', discoverErr, { rateKey: 'cr_discover' })
    }

    // Convert each DiscoveredAgent into an AgentDef.
    for (const agent of discovered) {
      // Type resolution: prefer explicit `tier` frontmatter over path heuristics.
      let agentType: AgentDef['type'] = 'staff'
      const tier = agent.meta?.['tier']

      if (agent.path.includes('/specialists/')) {
        // A specialist file carries tier: departments (same as its lead), so the
        // /specialists/ path MUST win over the tier check or specialists are
        // mis-typed as leads.
        agentType = 'specialist'
      } else if (tier === 'chiefs' || tier === 'departments') {
        agentType = 'lead'
      } else if (tier === 'staff') {
        agentType = 'staff'
      } else if (tier === 'consultants') {
        agentType = 'consultant'
      } else if (tier === 'specialist') {
        agentType = 'specialist'
      } else if (agent.path.includes('/departments/')) {
        agentType = 'lead'
      } else if (agent.path.includes('/consultants/')) {
        agentType = 'consultant'
      } else if (agent.path.includes('/orchestrator/')) {
        // Orchestrators define the conversation itself — not roster agents.
        continue
      }
      // Default for all Jarvis harness/agents/ flat files: 'staff'

      // Visibility: explicit frontmatter overrides type default.
      const explicitViz = agent.meta?.['visibility']
      const visibility = (
        explicitViz && ['always', 'sticky', 'ephemeral'].includes(explicitViz)
          ? explicitViz
          : DEFAULT_VISIBILITY[agentType] ?? 'ephemeral'
      ) as AgentDef['visibility']

      // Specialists list: meta values from discoverAgents are strings; parse
      // either JSON array ("[...]") or comma-separated list safely.
      let specialists: string[] | undefined
      const specMeta = agent.meta?.['specialists']
      if (specMeta) {
        try {
          const parsed = JSON.parse(specMeta)
          if (Array.isArray(parsed)) {
            specialists = parsed.map(String).filter(Boolean)
          }
        } catch {
          specialists = specMeta.split(',').map(s => s.trim()).filter(Boolean)
        }
        if (specialists?.length === 0) specialists = undefined
      }

      const agentEntry: AgentDef = {
        name:        agent.name,
        displayName: formatDisplayName(agent.name),
        description: agent.description ?? '',
        type:        agentType,
        visibility,
        tools:       agent.tools ?? [],
        systemPrompt: agent.systemPrompt ?? '',
        filePath:    agent.path,
      }
      if (agent.parent !== undefined) agentEntry.parent = agent.parent
      if (agent.model !== undefined) agentEntry.model = agent.model
      if (agent.meta !== undefined) agentEntry.meta = agent.meta
      if (specialists !== undefined) agentEntry.specialists = specialists
      allAgentDefs.push(agentEntry)
    }

    // Populate the ControlRoom with the discovered definitions.
    office.setDefs(allAgentDefs)

    // Activate a synthetic "all" team (Jarvis has no teams.yaml).
    const syntheticTeams: Record<string, string[]> = {
      all: allAgentDefs.map(d => d.name),
    }
    office.activateTeam('all', syntheticTeams)

    // Populate shared state so tool handlers can access the office + defs.
    state.office = office
    state.allAgentDefs = allAgentDefs

    // Suppress the engine's built-in Agent tool; all dispatch goes through the
    // typed dispatch_agent/dispatch_specialist/request_consultant tools.
    ctx.suppressTool('Agent').catch(() => {})

    // NOTE: we deliberately do NOT setOnChange or emit here. At headless boot the
    // session is created by the transient `ion start` bootstrap connection
    // (ion-serve.sh). Any engine_agent_state emit during/just-after session_start
    // makes the engine broadcast to that bootstrap connection, evicting it before
    // its start_session result -> `ion start` fails -> ion-serve.sh `set -e` exits
    // -> launchd SIGTERMs the engine -> 30s crash-loop. (Empirically bisected: with
    // the emit on, the engine dies in ~640ms; with it off, it stays up.) ion-dev
    // never hits this because its session_start is driven by the persistent Desktop
    // client. Fix: wire onChange + the initial emit on the FIRST real turn (see
    // wireControlRoomEmits, called from before_prompt) when the bootstrap is gone.

    log.info('jarvis: initializeControlRoom complete', {
      agents: allAgentDefs.length,
      team:   office.activeTeam,
    })
  } catch (err) {
    log.warn('jarvis: initializeControlRoom failed', { err: String(err) })
    recordError('control_room_init', err, { rateKey: 'cr_init' })
    // Do not rethrow — the extension must stay live even if the panel is empty.
  }
}

// Wire the ControlRoom → UI emit path (onChange + initial snapshot). Called from
// before_prompt on the FIRST real turn, NOT at session_start, so the engine never
// broadcasts agent-state to the transient `ion start` bootstrap connection during
// start_session (which would evict it and crash-loop the engine — see the NOTE in
// initializeControlRoom). By the first turn the bootstrap connection is long gone
// and a real client is active. Idempotent: wires once per extension process.
let _emitsWired = false
export function wireControlRoomEmits(ctx: IonContext): void {
  if (_emitsWired) return
  const room = state.office
  if (!room) return
  _emitsWired = true

  // onChange reads the CURRENT state.office so it survives extension respawns.
  room.setOnChange(() => {
    try {
      const r = state.office
      if (r) ctx.emit({ type: 'engine_agent_state', agents: r.buildAgentStateUpdates() })
    } catch (err) {
      log.warn('jarvis: controlroom onChange emit failed', { err: String(err) })
    }
  })

  try {
    ctx.emit({
      type: 'engine_status',
      fields: {
        label:          'jarvis',
        state:          'online',
        team:           room.activeTeam,
        model:          ctx.model?.id ?? 'unknown',
        contextPercent: 0,
        contextWindow:  ctx.model?.contextWindow ?? 0,
      },
    })
    ctx.emit({ type: 'engine_agent_state', agents: room.buildAgentStateUpdates() })
    log.info('jarvis: ControlRoom emits wired on first turn', { agents: room.buildAgentStateUpdates().length })
  } catch (err) {
    log.warn('jarvis: controlroom initial emit failed', { err: String(err) })
  }
}
