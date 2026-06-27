import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { IonSDK, IonContext } from 'ion-sdk'

vi.mock('ion-sdk', () => ({
  log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

vi.mock('../memory/episodic', () => ({
  logEvent: vi.fn(),
}))

describe('wireEngineEvents', () => {
  let wireEngineEvents: typeof import('./engineEvents').wireEngineEvents
  let mockIon: IonSDK
  let registeredHandlers: Map<string, (ctx: IonContext, payload: unknown) => unknown>
  let mockCtx: IonContext

  beforeEach(async () => {
    vi.resetModules()
    registeredHandlers = new Map()

    mockIon = {
      on: vi.fn((hook: string, handler: (ctx: IonContext, payload: unknown) => unknown) => {
        registeredHandlers.set(hook, handler)
      }),
    } as unknown as IonSDK

    mockCtx = {
      sessionKey: 'test-session',
      conversationId: '',
      cwd: '/tmp',
      model: null,
      config: { extensionDir: '/tmp', model: 'test', workingDirectory: '/tmp' },
      emit: vi.fn(),
      sendMessage: vi.fn(),
    } as unknown as IonContext

    const mod = await import('./engineEvents')
    wireEngineEvents = mod.wireEngineEvents
  })

  it('registers the before_plan_mode_auto_exit hook', () => {
    wireEngineEvents(mockIon)
    expect(mockIon.on).toHaveBeenCalledWith('before_plan_mode_auto_exit', expect.any(Function))
    expect(registeredHandlers.has('before_plan_mode_auto_exit')).toBe(true)
  })

  it('does not register engine_run_stalled or engine_model_fallback', () => {
    wireEngineEvents(mockIon)
    const hookNames = (mockIon.on as ReturnType<typeof vi.fn>).mock.calls.map(
      (call: unknown[]) => call[0] as string
    )
    expect(hookNames).not.toContain('engine_run_stalled')
    expect(hookNames).not.toContain('engine_model_fallback')
  })

  it('before_plan_mode_auto_exit handler logs to episodic', async () => {
    wireEngineEvents(mockIon)
    const handler = registeredHandlers.get('before_plan_mode_auto_exit')!
    const { logEvent } = await import('../memory/episodic')

    handler(mockCtx, {
      sessionId: 'sess-1',
      runId: 'run-1',
      stopReason: 'end_turn',
      planFilePath: '/tmp/plan.md',
      assistantText: 'Here is my plan.',
      emittedTools: ['Bash'],
    })

    expect(logEvent).toHaveBeenCalledWith(
      'engine',
      'plan_auto_exit',
      expect.objectContaining({
        sessionKey: 'test-session',
        runId: 'run-1',
        stopReason: 'end_turn',
        planFilePath: '/tmp/plan.md',
      }),
    )
  })

  it('before_plan_mode_auto_exit handler returns undefined (no suppression by default)', () => {
    wireEngineEvents(mockIon)
    const handler = registeredHandlers.get('before_plan_mode_auto_exit')!
    const result = handler(mockCtx, { stopReason: 'end_turn', planFilePath: '/tmp/plan.md' })
    expect(result).toBeUndefined()
  })

  it('before_plan_mode_auto_exit handler handles empty payload gracefully', () => {
    wireEngineEvents(mockIon)
    const handler = registeredHandlers.get('before_plan_mode_auto_exit')!
    expect(() => handler(mockCtx, {})).not.toThrow()
    expect(() => handler(mockCtx, null)).not.toThrow()
  })
})
