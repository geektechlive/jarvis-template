// Shared module-level state for ion lifecycle hooks.
// Centralized here so multiple hook modules can read/write the same maps
// without duplicating state. Importers: sessionLifecycle, turnLifecycle,
// toolPipeline (and indirectly the permission_classify wirer in toolPipeline).

import type { RecallItem } from '../memory/recall'

// ---------------------------------------------------------------------------
// Session tracking for turn_end persona audit.
// Phase 1 finding update: FireMessageUpdate now fires for CliBackend (ion
// commit 8eda00f, fireCliTurnHooks). lastReply IS populated per turn via the
// message_update hook, which fires just before turn_end with the accumulated
// assistant text. FireBeforeProviderRequest remains a stub.
// ---------------------------------------------------------------------------
export const lastReply = new Map<string, string>()

// Per-session recall cache: profile and procedural are stable across turns.
// Populated on turn 1 (before_prompt); cleared on session_end.
export const sessionRecallCache = new Map<string, { profile: RecallItem[]; procedural: RecallItem[] }>()

// Per-session turn counter for deferred extractAndStore cadence.
// Incremented on turn_end; cleared on session_end.
export const sessionTurnCounts = new Map<string, number>()

// User prompt captured in before_prompt; read in turn_end to build graph episode body.
export const lastUserMessage = new Map<string, string>()

// Turn counter per session. Updated in turn_start; read in before_prompt for
// turn-aware escalation (e.g. em dash reminder after turn 4).
export const sessionTurnNumber = new Map<string, number>()

// Wall-clock timestamp (Date.now()) captured in before_prompt (the true start
// of a turn on CliBackend); read in turn_end to compute prompt-to-response
// latency (phase 'llm'). Keyed by sessionKey.
export const sessionTurnStart = new Map<string, number>()

// ---------------------------------------------------------------------------
// Per-session last-touch timestamps. Used by evictStale() to drop entries
// from sessions that ended abnormally (process killed, connection dropped
// before session_end fired). Updated whenever any session-keyed write
// happens through touchSession(). Reads/deletes do not touch.
// ---------------------------------------------------------------------------
const sessionTouched = new Map<string, number>()

export function touchSession(sessionKey: string): void {
  sessionTouched.set(sessionKey, Date.now())
}

// Walk the touched map and drop entries whose last activity is older than
// maxAgeMs. Removes the session from lastReply and the touched map itself
// in one pass. Wired into the scheduler hourly tick
// (see scheduler/index.ts) with maxAgeMs=6h.
export function evictStale(maxAgeMs: number): { evicted: number; remaining: number } {
  const cutoff = Date.now() - maxAgeMs
  let evicted = 0
  for (const [key, ts] of sessionTouched) {
    if (ts < cutoff) {
      lastReply.delete(key)
      lastUserMessage.delete(key)
      sessionTurnNumber.delete(key)
      sessionTurnStart.delete(key)
      agentLoopState.delete(key)
      sessionRecallCache.delete(key)
      sessionTurnCounts.delete(key)
      sessionTouched.delete(key)
      evicted++
    }
  }
  return { evicted, remaining: sessionTouched.size }
}

// Clear bookkeeping when a session ends cleanly (called from sessionLifecycle).
export function clearSessionState(sessionKey: string): void {
  sessionTouched.delete(sessionKey)
  sessionTurnNumber.delete(sessionKey)
  sessionTurnStart.delete(sessionKey)
  agentLoopState.delete(sessionKey)
}

// ---------------------------------------------------------------------------
// Loop guard state. Tracks consecutive Agent tool calls to the same agent
// within a session. Used by wireToolPipeline to warn and eventually block
// runaway delegation loops (e.g. a mismatched model calling the same staff
// agent on every turn).
//
// Counter increments on each agent_tool_call where agentName matches lastName.
// Resets to 1 (new agent) when a different agent is called.
// Cleared on session_end and stale eviction.
// ---------------------------------------------------------------------------
export interface AgentLoopState {
  lastName: string
  count: number
}
export const agentLoopState = new Map<string, AgentLoopState>()

// Thresholds for the loop guard.
export const LOOP_WARN_THRESHOLD = 5  // emit engine_notify warning
export const LOOP_BLOCK_THRESHOLD = 10 // block the Agent tool call

export const TOOL_TIERS: Record<string, string> = {
  recall_memory: 'SAFE',
  remember_fact: 'LOW',
  ingest_item: 'LOW',
  ingest_document: 'LOW',
  surface_to_inbox: 'LOW',
  queue_for_brief: 'LOW',
  get_today_events: 'SAFE',
  get_week_events: 'SAFE',
  spotlight_search: 'SAFE',
  git_diff: 'HIGH',
  git_apply_patch: 'HIGH',
  calendar_create_event: 'LOW',
  mail_send: 'HIGH',
  // High-consequence, outward-facing tools that are now reachable by the LLM,
  // so they carry explicit tiers rather than falling through to the engine
  // default. (code review Warning 1)
  send_imessage: 'HIGH',
  bluesky_post: 'HIGH',
  bluesky_reply: 'HIGH',
  bluesky_repost: 'HIGH',
  bluesky_like: 'LOW',
  calendar_delete_event: 'HIGH',
  calendar_update_event: 'LOW',
  notes_create: 'LOW',
  reminder_create: 'LOW',
  create_reminder: 'LOW',
  // fetch_url: COVERED by ion built-in web_fetch (same http/https restriction;
  // web_fetch lacks HTML stripping + 4KB truncation but those are formatting
  // niceties, not security controls -- see Session B fetch_url analysis)
}
