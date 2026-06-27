// Shared helpers for all scheduler routines.
// Types, config loading, delivery helpers, and concurrency guards live here
// so that routine files can import from a single place without creating cycles
// with index.ts.

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import jsYaml from 'js-yaml'

import { log } from 'ion-sdk'
import { HARNESS_DIR } from '../config'
import { logEvent } from '../memory/episodic'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RoutineConfig {
  enabled: boolean
  time: string | undefined
  day: string | undefined
  interval_minutes: number | undefined
  ephemeral: boolean | undefined
  writes_chain_context: boolean
  max_run_ms: number | undefined
  ignore_quiet_hours: boolean | undefined
}

export interface Contact {
  name: string
  relationship?: string
  last_seen?: string
  notes?: string
  preferences?: string[]
}

export interface BriefSection {
  title: string
  content: string
}

export interface BriefMessage {
  sections: BriefSection[]
  generatedAt: Date
  get text(): string
}

// ---------------------------------------------------------------------------
// YAML parsers
// ---------------------------------------------------------------------------

export function parseRoutinesYaml(content: string): Record<string, RoutineConfig> {
  const doc = jsYaml.load(content) as { routines?: Record<string, unknown> } | null
  const routineMap = doc?.routines ?? {}
  const result: Record<string, RoutineConfig> = {}
  for (const [name, raw] of Object.entries(routineMap)) {
    const r = (raw ?? {}) as Record<string, unknown>
    result[name] = {
      enabled: r['enabled'] === true,
      time: typeof r['time'] === 'string' ? r['time'] : undefined,
      day: typeof r['day'] === 'string' ? r['day'] : undefined,
      interval_minutes: typeof r['interval_minutes'] === 'number' ? r['interval_minutes'] : undefined,
      ephemeral: typeof r['ephemeral'] === 'boolean' ? r['ephemeral'] : undefined,
      writes_chain_context: r['writes_chain_context'] === true,
      max_run_ms: typeof r['max_run_ms'] === 'number' ? r['max_run_ms'] : undefined,
      ignore_quiet_hours: r['ignore_quiet_hours'] === true,
    }
  }
  return result
}

export function parseContactsYaml(content: string): Contact[] {
  const doc = jsYaml.load(content) as { contacts?: Contact[] } | null
  return doc?.contacts ?? []
}

export function isEphemeralMemoryEnabled(): boolean {
  return loadTopLevelYaml()['ephemeral_memory_enabled'] === true
}

export function isWorkingMemoryEnabled(): boolean {
  return loadTopLevelYaml()['working_memory_enabled'] === true
}

export function isEntityBatchingEnabled(): boolean {
  return loadTopLevelYaml()['entity_batching_enabled'] === true
}

// ---------------------------------------------------------------------------
// Routines config cache
// ---------------------------------------------------------------------------

// Cached at scheduler start() and reused across the 1-minute tick. Reading
// the YAML synchronously on every tick was sub-millisecond, but isEnabled()
// calls into here on every routine fire — caching is the idiomatic shape
// regardless of latency.
let _cachedRoutinesConfig: Record<string, RoutineConfig> | null = null
let _routinesMtime = 0

const ROUTINES_PATH = join(HARNESS_DIR, 'harness/config/routines.yaml')

export function loadRoutinesConfig(): Record<string, RoutineConfig> {
  try {
    const mtime = statSync(ROUTINES_PATH).mtimeMs
    if (_cachedRoutinesConfig && mtime === _routinesMtime) return _cachedRoutinesConfig
    _routinesMtime = mtime
    const content = readFileSync(ROUTINES_PATH, 'utf8')
    _cachedRoutinesConfig = parseRoutinesYaml(content)
  } catch {
    if (!_cachedRoutinesConfig) _cachedRoutinesConfig = {}
  }
  return _cachedRoutinesConfig
}

let _cachedTopLevel: Record<string, unknown> | null = null
let _topLevelMtime = 0

function loadTopLevelYaml(): Record<string, unknown> {
  try {
    const mtime = statSync(ROUTINES_PATH).mtimeMs
    if (_cachedTopLevel && mtime === _topLevelMtime) return _cachedTopLevel
    _topLevelMtime = mtime
    _cachedTopLevel = (jsYaml.load(readFileSync(ROUTINES_PATH, 'utf8')) as Record<string, unknown>) ?? {}
  } catch {
    if (!_cachedTopLevel) _cachedTopLevel = {}
  }
  return _cachedTopLevel
}

export function isEnabled(routine: string): boolean {
  return loadRoutinesConfig()[routine]?.enabled === true
}

// ---------------------------------------------------------------------------
// Delivery helpers
// ---------------------------------------------------------------------------

export function writeInbox(routine: string, text: string): void {
  try {
    logEvent(routine, 'inbox_item', { routine, text })
  } catch (err) {
    log.error('scheduler: writeInbox failed', { routine, err: String(err) })
  }
}

// Mini is a headless server. osascript notifications fire on Mini's screen,
// which no one watches. Notification delivery goes through ion Desktop via the
// TCP event stream instead (see engine-bridge.ts). This stub is kept for future
// use if a local-machine context is ever needed.
export function notify(_title: string, _message: string): void { /* no-op on Mini */ }

// ---------------------------------------------------------------------------
// Observer decision framework (shared by all observer-pattern routines)
// ---------------------------------------------------------------------------

export const OBSERVER_DECISION_FRAMEWORK =
  'After the staff member reports back, you decide the disposition: ' +
  'if the signal is urgent enough to interrupt Alex now, call surface_to_inbox. ' +
  'If it is notable but not urgent, call queue_for_brief so it appears in tomorrow morning brief. ' +
  'If it should be remembered for later context, call remember_fact to agent_memories. ' +
  'If nothing material crossed the bar: respond with exactly the single word "Clear" and nothing else. ' +
  'No description of the scan. No "standing down". No list of what was checked. Just "Clear".'

// ---------------------------------------------------------------------------
// Quiet-hours guard -- suppresses interval routines 11pm-6am CT
// ---------------------------------------------------------------------------

export function isWeekend(): boolean {
  // Use Intl.DateTimeFormat to get the weekday in Chicago time.
  // Avoids the brittle new Date(toLocaleString()) pattern which is locale-dependent.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'short',
  }).formatToParts(new Date())
  const wd = parts.find(p => p.type === 'weekday')?.value
  return wd === 'Sat' || wd === 'Sun'
}

export function isQuietHours(): boolean {
  const topLevel = loadTopLevelYaml()
  const quietStart = typeof topLevel['quiet_hours_start'] === 'number' ? topLevel['quiet_hours_start'] : 23
  const quietEnd = typeof topLevel['quiet_hours_end'] === 'number' ? topLevel['quiet_hours_end'] : 6

  const hour = parseInt(
    new Date().toLocaleString('en-US', {
      timeZone: 'America/Chicago',
      hour: 'numeric',
      hour12: false,
    }),
    10,
  )

  if (quietStart > quietEnd) {
    // Midnight wrap: quiet from 23:00 to 06:00
    return hour >= quietStart || hour < quietEnd
  } else {
    // Same day: quiet from quietStart to quietEnd
    return hour >= quietStart && hour < quietEnd
  }
}

// ---------------------------------------------------------------------------
// Prompt-rate guard -- prevents ion prompt pile-up across interval routines
// ---------------------------------------------------------------------------

// Track last ion prompt dispatch time per routine so we can skip if Jarvis
// is already mid-run on another routine (avoids voice pile-up).
export const lastPromptFiredAt: Record<string, number> = {}
export const MIN_PROMPT_INTERVAL_MS = 4 * 60 * 1000  // 4-minute minimum gap between any two ion prompts

export function shouldRunPrompt(routine: string): boolean {
  const now = Date.now()
  const lastAny = Math.max(0, ...Object.values(lastPromptFiredAt))
  if (now - lastAny < MIN_PROMPT_INTERVAL_MS) {
    log.info(`scheduler: ${routine} skipped — another routine ran recently`, {
      lastAnyMs: now - lastAny,
    })
    return false
  }
  lastPromptFiredAt[routine] = now
  return true
}
