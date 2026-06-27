/**
 * Control Room -- agent state management for the ion-dev extension.
 *
 * Tracks all agent states (idle, running, done, error) and converts them
 * into AgentStateUpdate arrays for the Ion engine event stream. Leads and
 * staff are always visible; specialists/consultants appear only when dispatched.
 */

import type { AgentDef } from './types'

// ── Agent State ──

export interface AgentState {
  def: AgentDef
  status: 'idle' | 'running' | 'done' | 'error'
  task: string
  toolCount: number
  elapsed: number
  startTime: number  // Unix seconds (for live timer on clients)
  lastWork: string
  fullOutput: string
  runCount: number
  timer?: ReturnType<typeof setInterval>
  cost: number
  inputTokens: number
  outputTokens: number
  claudeSessionId: string | null
  contextPct: number
  messages: Array<{ role: 'assistant' | 'tool'; content: string; toolName?: string }>
}

// ── Agent Colors ──

const AGENT_NAME_COLORS: Record<string, string> = {
  'strategy-lead':      '#1e6b8c',
  'project-lead':       '#8c5a1e',
  'dev-lead':           '#1e8c3c',
  'graphics-lead':      '#8c1e6b',
  'docs-lead':          '#5a1e8c',
  'marketing-lead':     '#8c3c1e',
  'qa-lead':            '#3c648c',
  'comms-director':     '#6b5a1e',
  'chief-of-product':   '#1e3c8c',
  'chief-of-innovation':'#3c8c6b',
  'enterprise-strategist':'#505050',
}

const AGENT_TYPE_COLORS: Record<string, string> = {
  lead:       '#1e3278',
  specialist: '#144b55',
  staff:      '#411e64',
  consultant: '#5a410f',
}

function agentColor(state: AgentState): string {
  return AGENT_NAME_COLORS[state.def.name] || AGENT_TYPE_COLORS[state.def.type] || '#505050'
}

// ── Control Room ──

type CompletionListener = (state: AgentState) => void

export class ControlRoom {
  private agents = new Map<string, AgentState>()
  private allDefs: AgentDef[] = []
  private aliasMap = new Map<string, string>()
  private _activeTeam = ''
  private _onChange: (() => void) | null = null
  private _emitTimer: ReturnType<typeof setTimeout> | null = null
  private _emitPending = false
  private completionListeners = new Map<string, CompletionListener[]>()

  get activeTeam(): string { return this._activeTeam }
  get agentCount(): number { return this.agents.size }
  get allAgentDefs(): AgentDef[] { return this.allDefs }

  setDefs(defs: AgentDef[]): void {
    this.allDefs = defs
  }

  setOnChange(fn: () => void): void {
    this._onChange = fn
  }

  /** Throttled emit -- fires at most every 250ms, trailing edge guaranteed */
  private emit(): void {
    if (!this._onChange) return
    this._emitPending = true
    if (!this._emitTimer) {
      this._emitTimer = setTimeout(() => {
        this._emitTimer = null
        if (this._emitPending) {
          this._emitPending = false
          const running = Array.from(this.agents.values()).filter(a => a.status !== 'idle')
          process.stderr.write('[ControlRoom] emit: ' + JSON.stringify(running.map(a => `${a.def.name}:${a.status}:${a.lastWork?.substring(0,30)||'(empty)'}`)) + '\n')
          this._onChange?.()
        }
      }, 250)
    }
  }

  /** Immediate emit for critical state changes (markDone, markError, activateTeam) */
  private emitNow(): void {
    if (!this._onChange) return
    this._emitPending = false
    if (this._emitTimer) {
      clearTimeout(this._emitTimer)
      this._emitTimer = null
    }
    const running = Array.from(this.agents.values()).filter(a => a.status !== 'idle')
    process.stderr.write('[ControlRoom] emitNow: ' + JSON.stringify(running.map(a => `${a.def.name}:${a.status}:${a.lastWork?.substring(0,30)||'(empty)'}`)) + '\n')
    this._onChange()
  }

  activateTeam(teamName: string, teams: Record<string, string[]>): void {
    this._activeTeam = teamName
    const members = teams[teamName] || []
    const defsByName = new Map(this.allDefs.map(d => [d.name.toLowerCase(), d]))

    this.agents.clear()
    this.aliasMap.clear()

    for (const member of members) {
      const def = defsByName.get(member.toLowerCase())
      if (!def) continue

      this.agents.set(def.name.toLowerCase(), {
        def,
        status: 'idle',
        task: '',
        toolCount: 0,
        elapsed: 0,
        startTime: 0,
        lastWork: '',
        fullOutput: '',
        runCount: 0,
        cost: 0,
        inputTokens: 0,
        outputTokens: 0,
        claudeSessionId: null,
        contextPct: 0,
        messages: [],
      })

      // Populate alias map
      if (def.alias) {
        this.aliasMap.set(def.alias.toLowerCase(), def.name.toLowerCase())
      }
    }

    this.emitNow()
  }

  getState(agentName: string): AgentState | undefined {
    const key = agentName.toLowerCase()
    return this.agents.get(key) || this.agents.get(this.aliasMap.get(key) || '')
  }

  getAllStates(): AgentState[] {
    return Array.from(this.agents.values())
  }

  resolveAgent(name: string): AgentState | undefined {
    const key = name.toLowerCase()
    return this.agents.get(key) || this.agents.get(this.aliasMap.get(key) || '')
  }

  agentExistsGlobally(name: string): AgentDef | undefined {
    const key = name.toLowerCase()
    return this.allDefs.find(d => d.name.toLowerCase() === key)
  }

  /** Find the lead that lists this agent as a specialist. Returns lead name or undefined. */
  findParent(agentName: string): string | undefined {
    const key = agentName.toLowerCase()
    for (const def of this.allDefs) {
      if (def.type === 'lead' && def.specialists) {
        if (def.specialists.some(s => s.toLowerCase() === key)) return def.name
      }
    }
    return undefined
  }

  /** Depth by type: lead=0, specialist=1, staff=0, consultant=0 */
  agentDepth(agentName: string): number {
    const state = this.resolveAgent(agentName)
    if (!state) return 0
    return state.def.type === 'specialist' ? 1 : 0
  }

  markRunning(name: string, task: string): AgentState | undefined {
    const state = this.resolveAgent(name)
    if (!state) return undefined

    state.status = 'running'
    state.task = task
    state.toolCount = 0
    state.elapsed = 0
    state.lastWork = task ? task.substring(0, 80) : ''
    state.fullOutput = ''
    state.runCount++
    state.cost = 0
    state.inputTokens = 0
    state.outputTokens = 0
    state.contextPct = 0
    state.messages = []

    const startTime = Date.now()
    state.startTime = Math.floor(startTime / 1000) // Unix seconds for iOS/desktop live timer
    state.timer = setInterval(() => {
      state.elapsed = Math.round((Date.now() - startTime) / 1000) // seconds
      this.emit()
    }, 1000)

    this.emitNow()
    return state
  }

  markDone(name: string, output: string, exitCode: number): void {
    const state = this.resolveAgent(name)
    if (!state) return

    if (state.timer) clearInterval(state.timer)
    state.status = exitCode === 0 ? 'done' : 'error'
    state.fullOutput = output
    state.lastWork = output.split('\n').filter(l => l.trim()).pop() || state.task || 'completed'
    this.emitNow()
    this.notifyCompletion(state)
  }

  markError(name: string, message: string): void {
    const state = this.resolveAgent(name)
    if (!state) return

    if (state.timer) clearInterval(state.timer)
    state.status = 'error'
    state.lastWork = message
    this.emitNow()
    this.notifyCompletion(state)
  }

  /**
   * Resolve when the agent reaches done or error status. Rejects with a
   * timeout error if the agent does not complete within timeoutMs. The
   * listener is registered against the resolved agent name (canonical, not
   * alias) so duplicate listeners across aliases do not double-fire.
   */
  waitForCompletion(name: string, timeoutMs: number): Promise<AgentState> {
    const state = this.resolveAgent(name)
    if (!state) {
      return Promise.reject(new Error(`unknown agent: ${name}`))
    }
    if (state.status === 'done' || state.status === 'error') {
      return Promise.resolve(state)
    }
    const key = state.def.name.toLowerCase()
    return new Promise<AgentState>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeListener(key, listener)
        reject(new Error(`waitForCompletion timed out after ${timeoutMs}ms for agent ${name}`))
      }, timeoutMs)
      const listener: CompletionListener = (finalState) => {
        clearTimeout(timer)
        resolve(finalState)
      }
      const arr = this.completionListeners.get(key) || []
      arr.push(listener)
      this.completionListeners.set(key, arr)
    })
  }

  private notifyCompletion(state: AgentState): void {
    const key = state.def.name.toLowerCase()
    const listeners = this.completionListeners.get(key)
    if (!listeners || listeners.length === 0) return
    this.completionListeners.delete(key)
    for (const fn of listeners) {
      try { fn(state) } catch (err) {
        process.stderr.write('[ControlRoom] completion listener threw: ' + String(err) + '\n')
      }
    }
  }

  private removeListener(key: string, listener: CompletionListener): void {
    const arr = this.completionListeners.get(key)
    if (!arr) return
    const idx = arr.indexOf(listener)
    if (idx >= 0) arr.splice(idx, 1)
    if (arr.length === 0) this.completionListeners.delete(key)
  }

  updateWork(name: string, text: string): void {
    const state = this.resolveAgent(name)
    if (!state) return

    state.fullOutput = text
    const sentences = text.split(/(?:\n|(?<=[.!?])\s+)/).filter(s => s.trim())
    state.lastWork = sentences.length > 0 ? sentences[sentences.length - 1]! : ''
    this.emit()
  }

  updateUsage(name: string, input: number, output: number): void {
    const state = this.resolveAgent(name)
    if (!state) return

    state.inputTokens += input
    state.outputTokens += output
    this.emit()
  }

  updateCost(name: string, cost: number): void {
    const state = this.resolveAgent(name)
    if (!state) return

    state.cost += cost
    this.emit()
  }

  /** Set absolute cumulative usage (replaces additive updateUsage for SDK callbacks). */
  setCumulativeUsage(name: string, input: number, output: number): void {
    const state = this.resolveAgent(name)
    if (!state) return

    state.inputTokens = input
    state.outputTokens = output
    this.emit()
  }

  /** Set absolute cumulative cost (replaces additive updateCost for SDK callbacks). */
  setCumulativeCost(name: string, cost: number): void {
    const state = this.resolveAgent(name)
    if (!state) return

    state.cost = cost
    this.emit()
  }

  setSessionId(name: string, sessionId: string): void {
    const state = this.resolveAgent(name)
    if (!state) return
    state.claudeSessionId = sessionId
  }

  getSessionId(name: string): string | null {
    const state = this.resolveAgent(name)
    return state?.claudeSessionId || null
  }

  updateContextPct(name: string, pct: number): void {
    const state = this.resolveAgent(name)
    if (!state) return
    state.contextPct = pct
    this.emit()
  }

  incrementTools(name: string, toolDesc?: string): void {
    const state = this.resolveAgent(name)
    if (!state) return

    state.toolCount++
    if (toolDesc) state.lastWork = toolDesc
    this.emit()
  }

  pushMessage(name: string, msg: { role: 'assistant' | 'tool'; content: string; toolName?: string }): void {
    const state = this.resolveAgent(name)
    if (!state) return
    state.messages.push(msg)
    // Don't emit here -- high frequency during streaming. updateWork handles that.
  }

  /**
   * Build the AgentStateUpdate array for the engine event stream.
   * Leads and staff are always visible. Others only when not idle.
   */
  buildAgentStateUpdates(): Array<{
    name: string
    status: 'idle' | 'running' | 'done' | 'error'
    metadata?: Record<string, unknown>
  }> {
    const updates: Array<{
      name: string
      status: 'idle' | 'running' | 'done' | 'error'
      metadata?: Record<string, unknown>
    }> = []

    for (const state of this.agents.values()) {
      // Skip idle agents unless they are lead or staff (always visible)
      if (state.status === 'idle' && state.def.type !== 'lead' && state.def.type !== 'staff') continue

      const parentAgent = this.findParent(state.def.name)
      const depth = state.def.type === 'specialist' ? 1 : 0

      const md: Record<string, unknown> = {
        displayName: state.def.displayName,
        type: state.def.type,
        visibility: state.def.visibility,
        invited: true,
        color: agentColor(state),
      }
      if (state.task) md.task = state.task
      if (state.lastWork) md.lastWork = state.lastWork
      if (state.elapsed) md.elapsed = state.elapsed
      if (state.startTime) md.startTime = state.startTime
      if (state.cost > 0) md.cost = state.cost
      if (parentAgent) md.parentAgent = parentAgent
      if (depth > 0) md.depth = depth

      updates.push({
        name: state.def.name,
        status: state.status,
        metadata: md,
      })
    }

    return updates
  }

  cleanup(): void {
    if (this._emitTimer) clearTimeout(this._emitTimer)
    for (const state of this.agents.values()) {
      if (state.timer) clearInterval(state.timer)
    }
    this.agents.clear()
    this.completionListeners.clear()
  }
}
