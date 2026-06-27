import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { IonSDK, IonContext } from 'ion-sdk'

const { mockLogEvent } = vi.hoisted(() => ({
  mockLogEvent: vi.fn(),
}))

vi.mock('ion-sdk', () => ({
  log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

vi.mock('../memory/episodic', () => ({
  logEvent: mockLogEvent,
}))

import { wireToolPipeline } from './toolPipeline'

function makeIon(): { ion: IonSDK; fire: (event: string, ctx: IonContext, info?: unknown) => unknown } {
  const handlers = new Map<string, Function>()
  const ion = {
    on(event: string, handler: Function) {
      handlers.set(event, handler)
    },
  } as unknown as IonSDK
  return {
    ion,
    fire: (event, ctx, info?) => handlers.get(event)?.(ctx, info),
  }
}

function makeCtx(sessionKey = 'test-session'): IonContext {
  return {
    sessionKey,
    emit: vi.fn(),
    sendMessage: vi.fn(),
    cwd: '/test',
    model: null,
    config: {} as any,
  } as unknown as IonContext
}

describe('wireToolPipeline: permission_request', () => {
  beforeEach(() => {
    mockLogEvent.mockClear()
  })

  it('logs the permission decision to episodic', () => {
    const { ion, fire } = makeIon()
    wireToolPipeline(ion)
    const ctx = makeCtx()
    fire('permission_request', ctx, {
      tool_name: 'run_shell',
      input: { command: 'ls' },
      decision: 'allow',
      tier: 'MEDIUM',
    })
    expect(mockLogEvent).toHaveBeenCalledWith(
      'test-session',
      'permission_request',
      expect.objectContaining({ tool_name: 'run_shell', decision: 'allow', tier: 'MEDIUM' }),
    )
  })

  it('logs null for missing optional tier and rule_name', () => {
    const { ion, fire } = makeIon()
    wireToolPipeline(ion)
    const ctx = makeCtx()
    fire('permission_request', ctx, { tool_name: 'read_file', input: {}, decision: 'allow' })
    expect(mockLogEvent).toHaveBeenCalledWith(
      'test-session',
      'permission_request',
      expect.objectContaining({ tier: null, rule_name: null }),
    )
  })

  it('is a no-op when info is null', () => {
    const { ion, fire } = makeIon()
    wireToolPipeline(ion)
    const ctx = makeCtx()
    expect(() => fire('permission_request', ctx, null)).not.toThrow()
    expect(mockLogEvent).not.toHaveBeenCalledWith(expect.anything(), 'permission_request', expect.anything())
  })
})

describe('wireToolPipeline: permission_denied', () => {
  beforeEach(() => {
    mockLogEvent.mockClear()
  })

  it('logs the denial to episodic', () => {
    const { ion, fire } = makeIon()
    wireToolPipeline(ion)
    const ctx = makeCtx()
    fire('permission_denied', ctx, { tool_name: 'run_shell', reason: 'CRITICAL tier' })
    expect(mockLogEvent).toHaveBeenCalledWith(
      'test-session',
      'permission_denied',
      expect.objectContaining({ tool_name: 'run_shell', reason: 'CRITICAL tier' }),
    )
  })

  it('sends a message to the user on denial', () => {
    const { ion, fire } = makeIon()
    wireToolPipeline(ion)
    const ctx = makeCtx()
    fire('permission_denied', ctx, { tool_name: 'run_shell', reason: 'CRITICAL tier' })
    expect(ctx.sendMessage).toHaveBeenCalledWith(expect.stringContaining('run_shell'))
    expect(ctx.sendMessage).toHaveBeenCalledWith(expect.stringContaining('CRITICAL tier'))
  })

  it('is a no-op when info is null', () => {
    const { ion, fire } = makeIon()
    wireToolPipeline(ion)
    const ctx = makeCtx()
    expect(() => fire('permission_denied', ctx, null)).not.toThrow()
    expect(ctx.sendMessage).not.toHaveBeenCalled()
  })
})
