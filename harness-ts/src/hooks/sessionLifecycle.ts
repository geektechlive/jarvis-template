import { log, type IonSDK } from 'ion-sdk'
import { logEvent, getRecentMessages, setPendingImprove, recentEvents, recordPerfMetric, recordError } from '../memory/episodic'
import { extractFromMeetings, extractAndStore } from '../learning'
import { writeSessionJournal } from '../sessions'
import { lastReply, touchSession, clearSessionState, sessionTurnCounts, sessionRecallCache } from './state'
import { incrementScriptUsage } from '../improve/curator'
import { extractProcedure } from '../memory/procedural'
import { getSchedulerCtx } from '../scheduler/ctx'
import { refreshRoster } from '../staff/roster'
import { initializeControlRoom } from '../staff/init'

// ---------------------------------------------------------------------------
// Provider error tracking — warn after THRESHOLD consecutive errors per session.
// ---------------------------------------------------------------------------

const PROVIDER_ERROR_WARN_THRESHOLD = 3

/** Tracks consecutive provider_error counts. Cleared on session_end. */
const providerErrorCounts = new Map<string, { count: number; warned: boolean }>()

// ---------------------------------------------------------------------------
// Memory consolidation triggered by session_compact.
// ---------------------------------------------------------------------------

const CONSOLIDATION_COOLDOWN_MS = 5 * 60 * 1000 // 5 minutes

// Ion's session_end hook has a ~30s budget. Keep extraction well inside it so
// the other session_end work (journal write, cache cleanup) always completes.
const SESSION_END_EXTRACTION_BUDGET_MS = 20_000

/** Timestamp of the last consolidation attempt (success or failure). */
let lastConsolidationFiredAt = 0

/** @internal Testing helper to reset consolidation cooldown state. */
export function __resetConsolidationState(): void {
  lastConsolidationFiredAt = 0
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Detect a run_shell tool call targeting scripts/ or ~/bin/ and increment
 * use_count for the matched script. Called from the tool_call hook.
 */
function detectAndRecordScriptInvocation(toolName: string, input: Record<string, unknown>): void {
  try {
    if (toolName !== 'run_shell') return
    const cmd = input['command'] ?? input['cmd']
    if (typeof cmd !== 'string') return

    // Only track calls to scripts/ or ~/bin/ paths.
    if (!cmd.includes('scripts/') && !cmd.includes('~/bin/')) return

    // Extract the basename of the script (no extension, no trailing args).
    const match = /\/([a-zA-Z0-9_-]+)(?:\s|$)/.exec(cmd)
    if (match?.[1]) {
      incrementScriptUsage(match[1])
    }
  } catch {
    // Never throw from a lifecycle hook.
  }
}

/**
 * Count tool calls in a session's messages. Counts assistant messages that
 * contain tool_use content blocks plus any messages with role 'tool'.
 */
export function countToolCalls(messages: Array<{ role?: string; content?: unknown }>): number {
  let count = 0
  for (const msg of messages) {
    if (msg.role === 'tool') {
      count++
      continue
    }
    if (msg.role === 'assistant') {
      const content = msg.content
      if (typeof content === 'string' && content.includes('"type":"tool_use"')) {
        count++
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block === 'object' && block !== null) {
            const b = block as Record<string, unknown>
            if (b['type'] === 'tool_use') {
              count++
            }
          }
        }
      }
    }
  }
  return count
}

/**
 * Return true if a routing_correction event for this session was logged in the
 * last 30 minutes. Returns false on any error.
 */
function hadRoutingCorrectionThisSession(sessionKey: string): boolean {
  try {
    const events = recentEvents(sessionKey, 'routing_correction', 0.5) // 0.5 hours = 30 min
    return events.length > 0
  } catch {
    return false
  }
}

/**
 * Trigger ChromaDB memory consolidation via VEC_SERVER, respecting a 5-minute cooldown.
 * Logs observability events on success or failure. Never throws.
 */
export async function triggerMemoryConsolidation(): Promise<void> {
  const now = Date.now()
  const timeSinceLastAttempt = now - lastConsolidationFiredAt

  if (timeSinceLastAttempt < CONSOLIDATION_COOLDOWN_MS) {
    const remainingMs = CONSOLIDATION_COOLDOWN_MS - timeSinceLastAttempt
    log.info('jarvis: session_compact consolidation cooldown active', {
      remainingMs,
      nextAttemptIn: `${Math.ceil(remainingMs / 1000)}s`,
    })
    return
  }

  // Set the timestamp synchronously before any await so concurrent callers
  // see the updated value and don't bypass the cooldown. (TOCTOU fix: #705)
  lastConsolidationFiredAt = now

  log.info('jarvis: session_compact memory consolidation started', { source: 'session_compact' })
  logEvent('memory_consolidation', 'memory_consolidation_started', { source: 'session_compact' })

  const VEC_SERVER = process.env['VEC_SERVER'] ?? 'http://127.0.0.1:9876'
  const startTime = Date.now()

  try {
    const res = await fetch(`${VEC_SERVER}/consolidate`, {
      method: 'POST',
      signal: AbortSignal.timeout(180_000),
    })

    const durationMs = Date.now() - startTime

    if (!res.ok) {
      log.warn('jarvis: session_compact memory consolidation http error', {
        status: res.status,
        statusText: res.statusText,
      })
      logEvent('memory_consolidation', 'memory_consolidation_failed', {
        source: 'session_compact',
        http_status: res.status,
        duration_ms: durationMs,
      })
      return
    }

    log.info('jarvis: session_compact memory consolidation complete', { duration_ms: durationMs })
    logEvent('memory_consolidation', 'memory_consolidation_complete', {
      source: 'session_compact',
      duration_ms: durationMs,
    })
  } catch (err) {
    const durationMs = Date.now() - startTime
    log.warn('jarvis: session_compact memory consolidation unavailable', { err: String(err), duration_ms: durationMs })
    logEvent('memory_consolidation', 'memory_consolidation_failed', {
      source: 'session_compact',
      err: String(err),
      duration_ms: durationMs,
    })
  }
}

// ---------------------------------------------------------------------------
// Hook wiring
// ---------------------------------------------------------------------------

export function wireSessionLifecycle(ion: IonSDK): void {
  ion.on('session_start', async (ctx) => {
    log.info('jarvis: session_start', { session: ctx.sessionKey })
    logEvent(ctx.sessionKey, 'session_start', { ion_session: ctx.sessionKey })
    const isRoot = getSchedulerCtx() === null
    if (isRoot) {
      void ctx.cleanStaleProcesses().catch((err: unknown) => {
        log.warn('jarvis: session_start cleanStaleProcesses failed', { err: String(err) })
      })
    }
    // Refresh the in-memory staff roster (staffRoster Map) from the extension's
    // bundled agents/ dir. The roster supplies each specialist's system prompt
    // for programmatic dispatch (scheduler/autonomy via dispatchStaff) and the
    // before_prompt delegation catalog (rosterCatalog). Deduped with runOnce:
    // when multiple Ion Desktop tabs open simultaneously, one winner does the
    // filesystem walk; others skip. Falls back to direct refresh on runOnce
    // unavailability (old engine builds).
    //
    // NOTE: refreshRoster MUST remain separate from initializeControlRoom.
    // It populates the staffRoster Map (getRosterEntry) used by dispatchStaff
    // → scheduler routines + autonomy. initializeControlRoom populates the
    // ControlRoom (state.office) for LLM-initiated dispatch tools. They serve
    // different consumers and cannot be collapsed.
    try {
      const result = await ctx.runOnce('roster-refresh', { debounceMs: 300_000 }, async () => {
        await refreshRoster(ctx)
      })
      if (!result.executed) {
        // Another instance did the refresh within the debounce window. The
        // in-process staffRoster map is already populated (shared module state).
        // If for some reason it is empty (e.g. this is the very first session
        // after a cold restart), fall back to a direct refresh so we never
        // start with an empty roster.
        if (result.reason === 'in_progress') {
          // Another instance is currently refreshing; do our own refresh to
          // ensure the roster is ready before any early dispatch.
          await refreshRoster(ctx)
        }
        log.info('jarvis: roster-refresh deduped by runOnce', { reason: result.reason })
      }
    } catch (err) {
      // runOnce unavailable or threw; fall back to direct refresh so the
      // session never starts without a roster.
      log.warn('jarvis: runOnce roster-refresh unavailable, falling back', { err: String(err) })
      recordError('roster_refresh', err, { rateKey: 'roster_refresh' })
      await refreshRoster(ctx)
    }
    // Initialize the ControlRoom: discover agents, build the panel, suppress the
    // engine's generic Agent tool, and emit initial engine_status + engine_agent_state.
    // registerRosterSpecs is removed — agent specs are no longer needed because the
    // engine's Agent tool is suppressed and all LLM-initiated dispatch routes through
    // the typed dispatch_agent/dispatch_specialist/request_consultant tools.
    await initializeControlRoom(ctx)
  })

  ion.on('session_end', async (ctx) => {
    const sessionKey = ctx.sessionKey
    lastReply.delete(sessionKey)
    providerErrorCounts.delete(sessionKey)
    clearSessionState(sessionKey)
    log.info('jarvis: session_end', { session: sessionKey })
    logEvent(sessionKey, 'session_end', { ion_session: sessionKey })
    // Reflection lives behind the run_reflection tool now (Jarvis decides when
    // via the overnight wake-up routine). Meeting extraction is a fast
    // in-process call that fits in Ion's 30s session_end budget.
    void extractFromMeetings(sessionKey).catch((err: unknown) => {
      log.warn('jarvis: session_end meeting extraction error', { session: sessionKey, err: String(err) })
    })
    writeSessionJournal(sessionKey).catch((err: unknown) => {
      log.warn('jarvis: session_end journal error', { session: sessionKey, err: String(err) })
    })
    // Queue a self-improvement check on any of: long session, tool-heavy session,
    // or a routing correction this session.
    const sessionMessages = getRecentMessages(sessionKey, 20)
    const longSession = sessionMessages.length > 8
    const toolHeavy = countToolCalls(sessionMessages) >= 5
    const hadCorrection = hadRoutingCorrectionThisSession(sessionKey)
    if (longSession || toolHeavy || hadCorrection) {
      try {
        setPendingImprove()
        log.info('session lifecycle: queuing pending improve', { longSession, toolHeavy, hadCorrection })
      } catch (err) {
        log.warn('jarvis: setPendingImprove failed', { err: String(err) })
      }
    }
    if (toolHeavy) {
      void extractProcedure(sessionKey, ctx).catch((e: unknown) =>
        console.error('[sessionLifecycle] extractProcedure error', e),
      )
    }

    // Run final extraction for anything captured since the last mid-session extract.
    const finalTurnCount = sessionTurnCounts.get(sessionKey) ?? 0
    if (finalTurnCount > 0) {
      const t0 = Date.now()
      try {
        await extractAndStore(sessionKey, { budgetMs: SESSION_END_EXTRACTION_BUDGET_MS })
        try { recordPerfMetric('extract', Date.now() - t0, sessionKey) } catch { /* non-fatal */ }
      } catch (err: unknown) {
        log.warn('jarvis: session_end extraction error', { session: sessionKey, err: String(err) })
      }
    }

    // Clean up session-scoped caches.
    sessionTurnCounts.delete(sessionKey)
    sessionRecallCache.delete(sessionKey)
  })

  ion.on('tool_call', (_ctx, info) => {
    if (info) {
      detectAndRecordScriptInvocation(info.toolName, info.input)
    }
  })

  ion.on('message_update', (ctx, info) => {
    if (info?.role === 'assistant') {
      lastReply.set(ctx.sessionKey, info.content ?? '')
      touchSession(ctx.sessionKey)
    }
  })

  // G6: No persistent subprocesses are spawned by the extension today -- the webhook
  // server (webhooks/unifi.ts) runs in-process and auto-restarts on respawn. When a
  // persistent subprocess is added (file-system watcher, wake-word daemon, or an
  // extracted webhook server), register it in session_start:
  //   await ctx.registerProcess('process-name', pid, 'task description')
  // and deregister in session_end or on natural exit.

  ion.on('extension_respawned', async (ctx, info) => {
    const sessionKey = ctx.sessionKey
    log.info('jarvis: extension_respawned', {
      session: sessionKey,
      attempt: info?.attemptNumber,
      prevExitCode: info?.prevExitCode ?? null,
      prevSignal: info?.prevSignal ?? null,
    })
    logEvent(sessionKey, 'extension_respawned', {
      ion_session: sessionKey,
      attempt_number: info?.attemptNumber ?? 0,
      prev_exit_code: info?.prevExitCode ?? null,
      prev_signal: info?.prevSignal ?? null,
    })
    void ctx.cleanStaleProcesses().catch((err: unknown) => {
      log.warn('jarvis: extension_respawned cleanStaleProcesses failed', { err: String(err) })
    })
    // Refresh the staffRoster Map so programmatic dispatch (scheduler/autonomy) keeps
    // working after a respawn with current agent specs.
    void refreshRoster(ctx)
    // Re-initialize the ControlRoom fully on respawn: re-discovers agents, rebuilds
    // the panel, re-suppresses Agent, and re-emits engine_status + engine_agent_state.
    // This is the core fix: a respawn previously left the ControlRoom stale because
    // only refreshRoster was called. Now the UI panel always reflects reality.
    await initializeControlRoom(ctx)
  })

  ion.on('turn_aborted', (ctx, info) => {
    const sessionKey = ctx.sessionKey
    log.info('jarvis: turn_aborted', { session: sessionKey, reason: info?.reason })
    logEvent(sessionKey, 'turn_aborted', {
      ion_session: sessionKey,
      reason: info?.reason ?? 'extension_died',
    })
    // Reset per-session counters (sessionTurnNumber, sessionTouched) so a
    // restarted session starts from a clean slate rather than inheriting a
    // stale turn count from the aborted turn.
    clearSessionState(sessionKey)
  })

  ion.on('task_created', (ctx, info) => {
    if (!info) return
    logEvent(ctx.sessionKey, 'task_created', {
      task_id: info.task_id,
      name: info.name ?? null,
    })
    touchSession(ctx.sessionKey)
    log.debug('jarvis: task_created', { session: ctx.sessionKey, taskId: info.task_id, name: info.name })
  })

  ion.on('task_completed', (ctx, info) => {
    if (!info) return
    logEvent(ctx.sessionKey, 'task_completed', {
      task_id: info.task_id,
      name: info.name ?? null,
      status: info.status ?? null,
    })
    log.debug('jarvis: task_completed', { session: ctx.sessionKey, taskId: info.task_id, status: info.status })
  })

  ion.on('on_error', (ctx, info) => {
    if (!info) return
    const session = ctx.sessionKey
    logEvent(session, 'on_error', {
      message: info.message,
      error_code: info.errorCode ?? null,
      category: info.category ?? null,
      retryable: info.retryable ?? null,
      http_status: info.httpStatus ?? null,
    })
    log.warn('jarvis: on_error', { session, category: info.category, message: info.message })

    if (info.category === 'provider_error') {
      const rec = providerErrorCounts.get(session) ?? { count: 0, warned: false }
      rec.count++
      providerErrorCounts.set(session, rec)
      if (rec.count >= PROVIDER_ERROR_WARN_THRESHOLD && !rec.warned) {
        rec.warned = true
        ctx.sendMessage(
          `[System] ${rec.count} consecutive provider errors this session. ` +
          `The AI provider may be unavailable -- check Ollama or network connectivity.`,
        )
      }
    }
  })

  ion.on('session_before_compact', (ctx, info) => {
    if (!info) return
    const session = ctx.sessionKey
    logEvent(session, 'session_before_compact', {
      strategy: info.strategy,
      messages_before: info.messagesBefore,
    })
    log.info('jarvis: session_before_compact', { session, strategy: info.strategy, messagesBefore: info.messagesBefore })
  })

  ion.on('session_compact', async (ctx, info) => {
    if (!info) return
    const session = ctx.sessionKey
    logEvent(session, 'session_compact', {
      strategy: info.strategy,
      messages_before: info.messagesBefore,
      messages_after: info.messagesAfter,
    })
    log.info('jarvis: session_compact', {
      session,
      strategy: info.strategy,
      messagesBefore: info.messagesBefore,
      messagesAfter: info.messagesAfter,
    })

    // Trigger memory consolidation with cooldown check.
    void triggerMemoryConsolidation().catch((err: unknown) => {
      log.warn('jarvis: session_compact consolidation error', { err: String(err) })
    })
  })
}
