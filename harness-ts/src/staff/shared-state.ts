/**
 * Shared runtime state for cross-module access.
 *
 * extension.ts populates these fields during session_start.
 * plan-management.ts (and future modules) read from them in tool
 * execute handlers. This avoids circular imports between extension.ts
 * and modules that register tools against the same ion instance.
 */

import type { ControlRoom } from './control-room'
import type { AgentDef } from './types'

export const state = {
  office: null as ControlRoom | null,
  allAgentDefs: [] as AgentDef[],
  dataHome: '',
  workflowsDir: '',
  extensionAgentsRoot: '',
  universalStandardsPath: undefined as string | undefined,
}
