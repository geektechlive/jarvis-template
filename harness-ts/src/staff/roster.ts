// Staff roster — in-memory map of dispatchable staff agents, loaded from the
// extension's bundled `agents/` directory via ctx.discoverAgents().
//
// Why this exists: the ion engine does NOT resolve a persona by name when an
// extension calls ctx.dispatchAgent({ name }). The Go spawner only honors an
// explicit `systemPrompt` (dispatch_agent.go) and the name is metadata. So the
// harness must supply each specialist's system prompt at dispatch time. We get
// it by bundling the agent .md files with the extension and capturing the
// discoverAgents() result here — discoverAgents() returns the full markdown
// body as `systemPrompt` (agentdiscovery/frontmatter.go: def.SystemPrompt = body).
//
// Consumers: staff/dispatch.ts (system prompt + model per dispatch) and the
// before_prompt delegation catalog (rosterCatalog).

import { join } from 'node:path'
import type { DiscoveredAgent, IonContext, AgentSpec } from 'ion-sdk'
import { log } from 'ion-sdk'
import { loadStaff, HARNESS_DIR } from '../config'
import { normalizeAgentName } from './normalize'

// Re-exported for back-compat: callers historically imported normalizeAgentName
// from roster.ts. The implementation now lives in ./normalize (dependency-free).
export { normalizeAgentName }

// Keyed by normalized agent name (hyphens, lowercase).
const staffRoster = new Map<string, DiscoveredAgent>()

// Display titles from staff.yaml (e.g. "Personal CFO"), keyed by normalized id.
// Lazily built on first use so merely importing this module does not read
// staff.yaml (keeps it mock-friendly for transitive importers in tests).
let staffTitlesCache: Map<string, string> | null = null
function staffTitles(): Map<string, string> {
  if (!staffTitlesCache) {
    staffTitlesCache = new Map(loadStaff().map((e) => [normalizeAgentName(e.id), e.title]))
  }
  return staffTitlesCache
}

/**
 * Repopulate the roster from the extension's bundled `agents/` directory
 * (the `extension` discovery source = {extDir}/agents/). Called at
 * session_start and extension_respawned. Never throws — on failure it logs and
 * leaves any prior roster intact.
 */
export async function refreshRoster(ctx: IonContext): Promise<void> {
  try {
    // Read the bundled agents/ via the extension source, plus an explicit
    // extraDirs pointing at the source-of-truth harness/agents (always present).
    // The extension source can come back empty when the engine has not resolved
    // the extension dir for the discovery RPC, so extraDirs is the reliable path.
    const agents = await ctx.discoverAgents({
      sources: ['extension'],
      extraDirs: [join(HARNESS_DIR, 'harness', 'agents')],
    })
    if (agents.length === 0) {
      log.warn('jarvis: refreshRoster found no agents (extension source + harness/agents both empty)')
      return
    }
    staffRoster.clear()
    for (const a of agents) {
      staffRoster.set(normalizeAgentName(a.name), a)
    }
    log.info('jarvis: roster refreshed', { count: staffRoster.size })
  } catch (err) {
    log.warn('jarvis: refreshRoster failed', { err: String(err) })
  }
}

/** Look up a staff member's discovered spec (systemPrompt, model, description). */
export function getRosterEntry(name: string): DiscoveredAgent | undefined {
  return staffRoster.get(normalizeAgentName(name))
}

/**
 * Register every roster member as an agent spec so the engine's built-in Agent
 * tool resolves them by name with their full persona. This is the ion-native
 * way for the interactive LLM to dispatch staff (ion dev guidance): the engine
 * dispatches through its own agent loop, avoiding the CliBackend ToolServer
 * "dispatch not available" race (dsswift/ion#183). Never throws.
 */
export async function registerRosterSpecs(ctx: IonContext): Promise<void> {
  let registered = 0
  for (const a of staffRoster.values()) {
    const spec: AgentSpec = { name: a.name }
    if (a.description !== undefined) spec.description = a.description
    if (a.model !== undefined) spec.model = a.model
    if (a.tools !== undefined) spec.tools = a.tools
    if (a.systemPrompt !== undefined) spec.systemPrompt = a.systemPrompt
    try {
      await ctx.registerAgentSpec(spec)
      registered++
    } catch (err) {
      log.warn('jarvis: registerAgentSpec failed', { name: a.name, err: String(err) })
    }
  }
  log.info('jarvis: registered agent specs', { registered })
}

/** Current number of staff in the roster. */
export function rosterSize(): number {
  return staffRoster.size
}

/**
 * Human-friendly sidebar label for a staff member. Prefers the staff.yaml
 * title; falls back to title-casing the hyphenated name.
 */
export function staffDisplayName(name: string): string {
  const key = normalizeAgentName(name)
  const title = staffTitles().get(key)
  if (title) return title
  return key
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

/**
 * One line per staff member for the delegation catalog injected at
 * before_prompt: "- <name> — <description>". Sorted for stable output.
 * Empty string when the roster is empty (caller skips injection).
 */
export function rosterCatalog(): string {
  if (staffRoster.size === 0) return ''
  const lines: string[] = []
  for (const a of staffRoster.values()) {
    const desc = (a.description ?? '').trim()
    lines.push(`- ${a.name}${desc ? ` — ${desc}` : ''}`)
  }
  return lines.sort().join('\n')
}
