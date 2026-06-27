import { log, type IonSDK } from 'ion-sdk'
import { auditReply } from '../persona/audit'
import { logEvent, logMessage, recordPerfMetric, recordError } from '../memory/episodic'
import { sessionLogMessage } from '../sessions'
import { extractAndStore, detectMemoryCorrection, extractConcreteValues } from '../learning'
import { graphIngest } from '../memory/recall'
import { lastReply, lastUserMessage, sessionTurnNumber, sessionTurnCounts, sessionTurnStart } from './state'
import { VOICE_SERVER } from '../config/endpoints'
import { commitDataFiles } from '../util/autoCommit'
import { span } from '../util/span'

export function wireTurnLifecycle(ion: IonSDK): void {
  ion.on('turn_end', (ctx, info) => {
    const turnNum = info?.turnNumber ?? -1
    const session = ctx.sessionKey
    log.info('jarvis: turn_end', { turn: turnNum })

    // Phase 'llm': wall-clock duration of the full turn (model + in-turn tool
    // execution). CliBackend exposes no separate provider-call duration, so
    // turn_start → turn_end is the finest bracket available.
    const turnStartMs = sessionTurnStart.get(session)
    if (turnStartMs !== undefined) {
      const llmMs = Date.now() - turnStartMs
      try { recordPerfMetric('llm', llmMs, session) } catch { /* non-fatal */ }
      sessionTurnStart.delete(session)
    }

    const reply = lastReply.get(session) ?? ''

    // Log assistant reply to episodic SQLite and session journal buffer
    if (reply) {
      logMessage(session, 'assistant', reply, session)
      sessionLogMessage(session, 'assistant', reply)
      const { passed, violations } = auditReply(reply)
      if (!passed) {
        log.warn('jarvis: PERSONA VIOLATIONS', { turn: turnNum, violations })
        logEvent(session, 'persona_violation', { turn: turnNum, violations })
      } else {
        log.info('jarvis: persona audit passed', { turn: turnNum })
      }

      // Voice: fire-and-forget -- never block the turn
      fetch(`${VOICE_SERVER}/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: reply }),
        signal: AbortSignal.timeout(5000),
      }).catch((err: unknown) => {
        log.debug('jarvis: voice unavailable', { err: String(err) })
        recordError('voice', err, { rateKey: 'voice' })
      })
    } else {
      log.info('jarvis: turn_end (reply not captured -- using system-prompt enforcement)', {
        turn: turnNum,
      })
    }

    logEvent(session, 'turn_end', { turn: turnNum })

    // Graph ingest: fire-and-forget -- never block turn processing.
    // Gate on userMsg; reply is also available (message_update fires before
    // turn_end in ion commit 8eda00f) and is passed through to enrich episodes.
    const userMsg = lastUserMessage.get(session) ?? ''
    if (userMsg) {
      const episodeName = `${session.slice(0, 8)}-t${turnNum}`
      // #767: pass the turn-start time (when the user's message landed) so
      // graphiti dates extracted facts to the turn, not the ingest moment.
      const referenceTime =
        turnStartMs !== undefined ? new Date(turnStartMs).toISOString() : undefined
      void graphIngest(userMsg, reply, episodeName, referenceTime).catch((err: unknown) => {
        log.warn('jarvis: graph ingest failed', { err: String(err) })
        recordError('graph_ingest', err, { rateKey: 'graph_ingest' })
      })
    }

    // Increment per-session turn counter (independent of ion's turnNumber which
    // may reset on compact). Used to schedule mid-session extractions.
    const turnCount = (sessionTurnCounts.get(session) ?? 0) + 1
    sessionTurnCounts.set(session, turnCount)

    // Memory correction runs every turn (fast, non-LLM).
    // Extraction is deferred: run at turn 4, then every 3 turns (4, 7, 10, 13...).
    // Correction is chained before extraction on those turns to preserve the
    // invariant that contradicted facts are removed before the new version is stored.
    if (turnCount >= 4 && (turnCount - 4) % 3 === 0) {
      void detectMemoryCorrection(session)
        .catch((err: unknown) => {
          log.warn('jarvis: turn_end memory correction error', { err: String(err) })
          recordError('turn_end_extraction', err, { rateKey: 'turn_end_extraction' })
        })
        .then(() => {
          const t0 = Date.now()
          return span('extractAndStore', () => extractAndStore(session)).then(() => {
            try { recordPerfMetric('extract', Date.now() - t0, session) } catch { /* non-fatal */ }
          })
        })
        .catch((err: unknown) => {
          log.warn('jarvis: turn_end extraction error', { err: String(err) })
          recordError('turn_end_extraction', err, { rateKey: 'turn_end_extraction' })
        })
        .then(() => extractConcreteValues(session))
        .catch((err: unknown) => {
          log.warn('jarvis: turn_end detail-pass error', { err: String(err) })
          recordError('turn_end_extraction', err, { rateKey: 'turn_end_extraction' })
        })
    } else {
      void detectMemoryCorrection(session).catch((err: unknown) => {
        log.warn('jarvis: turn_end memory correction error', { err: String(err) })
        recordError('turn_end_extraction', err, { rateKey: 'turn_end_extraction' })
      })
    }

    void commitDataFiles().catch((err: unknown) => {
      log.warn('jarvis: turn_end auto-commit error', { err: String(err) })
      recordError('auto_commit', err, { rateKey: 'auto_commit' })
    })
  })

  // Record the turn number so before_prompt can read it for escalating
  // reminders. Agent-dispatch state is no longer flipped here — the engine's
  // built-in Agent tool emits its own engine_agent_state.
  //
  // The 'llm' wall-clock start stamp is set in before_prompt (promptPipeline.ts),
  // NOT here: on CliBackend ion does not run the agent loop, so turn_start fires
  // at turn *completion* alongside turn_end (~3ms apart) — useless as a start
  // marker. before_prompt fires at the true start of the turn.
  ion.on('turn_start', (ctx, info) => {
    sessionTurnNumber.set(ctx.sessionKey, info?.turnNumber ?? 0)
  })

  // NOTE: no phase='tool' instrumentation. On CliBackend the tool_result hook
  // never fires (Claude Code executes tools inside the subprocess; verified:
  // tool_start fires, tool_result fires 0 times), so a start/result bracket
  // could never record and would leak the start map. Per-tool latency would
  // require an engine-side tool_result emission on the CLI path.
}
