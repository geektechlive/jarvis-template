// Engine event hooks — observability hooks for engine lifecycle signals.
// before_plan_mode_auto_exit: fires when the engine synthesizes an
// auto-exit from plan mode (model ended its turn without ExitPlanMode).

import { log, type IonSDK } from 'ion-sdk'
import { logEvent } from '../memory/episodic'

export interface BeforePlanModeAutoExitPayload {
  sessionId?: string
  runId?: string
  stopReason?: string
  planFilePath?: string
  assistantText?: string
  emittedTools?: string[]
}

export function wireEngineEvents(ion: IonSDK): void {
  // before_plan_mode_auto_exit fires when the model ends a plan-mode turn
  // without calling ExitPlanMode. Log it so sessions can surface the pattern.
  ion.on('before_plan_mode_auto_exit', (ctx, payload: BeforePlanModeAutoExitPayload) => {
    const info = payload ?? {}
    log.info('engine: plan_mode_auto_exit', {
      sessionKey: ctx.sessionKey,
      stopReason: info.stopReason ?? '',
      planFilePath: info.planFilePath ?? '',
      toolCount: info.emittedTools?.length ?? 0,
    })
    logEvent('engine', 'plan_auto_exit', {
      sessionKey: ctx.sessionKey,
      runId: info.runId ?? '',
      stopReason: info.stopReason ?? '',
      planFilePath: info.planFilePath ?? '',
      emittedTools: info.emittedTools ?? [],
    })
    // Return undefined = let engine proceed with synthesis.
  })
}
