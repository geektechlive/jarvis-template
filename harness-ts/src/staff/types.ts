/**
 * Shared types for the ion-dev extension.
 *
 * Adapted from chief-of-staff types. Agent hierarchy uses lead/specialist
 * instead of chief/specialist, with staff for executive team and consultant
 * for read-only advisors.
 */

export interface AgentDef {
  name: string
  displayName: string
  description: string
  type: 'lead' | 'specialist' | 'staff' | 'consultant'
  visibility: 'always' | 'sticky' | 'ephemeral'
  tools: string[]
  section?: string
  specialists?: string[]
  chief?: boolean
  alias?: string
  tier?: string
  systemPrompt: string
  filePath: string
  parent?: string
  model?: string
  meta?: Record<string, string>
}

export interface TeamDef {
  [teamName: string]: string[]
}

export interface DispatchResult {
  output: string
  exitCode: number
  elapsed: number
  cost: number
  inputTokens: number
  outputTokens: number
  sessionId?: string
}

export interface DispatchRecord {
  agent: string
  task: string
  started: string
  completed: string
  exitCode: number
  elapsed: number
  cost: number
  inputTokens: number
  outputTokens: number
}

export interface TeamState {
  team: string
  lastSession: string
  dispatches: DispatchRecord[]
}
