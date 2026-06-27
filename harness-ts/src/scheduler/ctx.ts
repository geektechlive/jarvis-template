// Scheduler ctx store -- holds the most recently seen IonContext from a scheduled
// job handler. Set by the `scheduled()` wrapper in register.ts on every job fire.
//
// Why a stored reference rather than threading ctx through every routine signature:
// - Scheduler routines are registered as handler callbacks and fire from the engine
//   scheduler -- there is no ambient callsite ctx to thread through.
// - Each scheduled job gets a fresh ctx per fire; we always overwrite with the
//   latest so dispatchObserver sees an up-to-date ctx.
// - Cold-start gap: if no job has fired yet, _ctx stays null and routines fall back
//   to runClaudeAgent.

import { log } from 'ion-sdk'
import type { IonContext } from 'ion-sdk'

let _ctx: IonContext | null = null

// Called by the scheduled() wrapper in register.ts at the start of every job handler.
// Always overwrites so the stored ctx stays fresh.
export function setSchedulerCtx(ctx: IonContext): void {
  _ctx = ctx
}

export function clearSchedulerCtx(): void {
  _ctx = null
  log.info('schedulerCtx: cleared')
}

export function getSchedulerCtx(): IonContext | null {
  if (!_ctx) log.debug('schedulerCtx: returning null -- no job has fired yet (cold-start gap)')
  return _ctx
}
