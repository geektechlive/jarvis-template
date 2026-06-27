// Lightweight per-operation timing. Records start/end and logs a structured
// perf_span event via logEvent so slow paths are auditable in agent_events.
// Fire-and-forget: the wrapper never swallows errors from the wrapped function.

import { log } from 'ion-sdk'
import { logEvent } from '../memory/episodic'

export async function span<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now()
  try {
    const result = await fn()
    const durationMs = Date.now() - t0
    log.debug('perf_span', { name, durationMs })
    // Fire-and-forget: logEvent is synchronous (SQLite), but wrap in try/catch
    // so a DB error never propagates out of the instrumentation layer.
    try {
      logEvent('perf', 'perf_span', { name, durationMs })
    } catch {
      // non-fatal
    }
    return result
  } catch (err) {
    const durationMs = Date.now() - t0
    log.debug('perf_span (error)', { name, durationMs })
    try {
      logEvent('perf', 'perf_span', { name, durationMs, error: true })
    } catch {
      // non-fatal
    }
    throw err
  }
}
