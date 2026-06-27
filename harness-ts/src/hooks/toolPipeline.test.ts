import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { IonSDK, IonContext } from 'ion-sdk'

vi.mock('ion-sdk', () => ({
  log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))
vi.mock('../memory/episodic', () => ({ logEvent: vi.fn() }))

import { wireToolPipeline } from './toolPipeline'
import { agentLoopState } from './state'

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

// The agent-dispatch sidebar watchdog was removed; the engine's built-in Agent
// tool owns engine_agent_state. Only the permission pipeline remains here.
describe('wireToolPipeline: permission_classify', () => {
  const cases: Array<[string, string | null]> = [
    ['recall_memory', 'SAFE'],
    ['get_today_events', 'SAFE'],
    ['spotlight_search', 'SAFE'],
    ['remember_fact', 'LOW'],
    ['ingest_item', 'LOW'],
    ['calendar_create_event', 'LOW'],
    ['git_diff', 'HIGH'],
    ['git_apply_patch', 'HIGH'],
    ['mail_send', 'HIGH'],
    // High-consequence tools now reachable by the LLM carry explicit tiers.
    ['send_imessage', 'HIGH'],
    ['bluesky_post', 'HIGH'],
    ['calendar_delete_event', 'HIGH'],
    // Unknown tools defer to ion.
    ['web_fetch', null],
  ]

  for (const [tool, tier] of cases) {
    it(`classifies ${tool} as ${tier ?? 'null (defer)'}`, () => {
      const { ion, fire } = makeIon()
      wireToolPipeline(ion)
      const ctx = makeCtx()
      expect(fire('permission_classify', ctx, { tool_name: tool, input: {} })).toBe(tier)
    })
  }
})

describe('wireToolPipeline: permission_denied', () => {
  it('messages the user with the denial reason', () => {
    const { ion, fire } = makeIon()
    wireToolPipeline(ion)
    const ctx = makeCtx()
    fire('permission_denied', ctx, { tool_name: 'mail_send', reason: 'not allowed' })
    expect(ctx.sendMessage).toHaveBeenCalledWith(expect.stringContaining('mail_send'))
  })
})

// Loop guard tests: the generic Agent tool is suppressed, so delegation goes
// through the typed dispatch tools (dispatch_agent / dispatch_specialist /
// request_consultant). The target agent is the `agent` argument, NOT part of
// the tool name, so the guard keys on info.input.agent (#710).
describe('wireToolPipeline: loop guard (tool_call / dispatch tools)', () => {
  beforeEach(() => {
    agentLoopState.clear()
  })

  it('allows first agent call with no warning', () => {
    const { ion, fire } = makeIon()
    wireToolPipeline(ion)
    const ctx = makeCtx()

    const result = fire('tool_call', ctx, {
      toolName: 'dispatch_agent',
      input: { agent: 'chief-of-communications' },
    })

    expect(result).toBeUndefined()
    expect(ctx.emit).not.toHaveBeenCalled()
  })

  it('resets counter when a different agent is dispatched via the same tool', () => {
    const { ion, fire } = makeIon()
    wireToolPipeline(ion)
    const ctx = makeCtx()

    for (let i = 0; i < 4; i++) {
      fire('tool_call', ctx, { toolName: 'dispatch_agent', input: { agent: 'chief-of-communications' } })
    }
    // Switch agent — counter resets even though the tool name is identical.
    fire('tool_call', ctx, { toolName: 'dispatch_agent', input: { agent: 'personal-cfo' } })

    expect(agentLoopState.get('test-session')).toEqual({ lastName: 'personal-cfo', count: 1 })
  })

  it('does NOT false-trip when many different agents are dispatched in a row', () => {
    const { ion, fire } = makeIon()
    wireToolPipeline(ion)
    const ctx = makeCtx()

    const agents = ['admin', 'personal-cfo', 'researcher', 'writer', 'eng-lead', 'doc-steward']
    let result: unknown
    for (const agent of agents) {
      result = fire('tool_call', ctx, { toolName: 'dispatch_agent', input: { agent } })
    }

    expect(result).toBeUndefined()
    expect(ctx.emit).not.toHaveBeenCalled()
    expect(agentLoopState.get('test-session')).toEqual({ lastName: 'doc-steward', count: 1 })
  })

  it('tracks request_consultant calls too', () => {
    const { ion, fire } = makeIon()
    wireToolPipeline(ion)
    const ctx = makeCtx()

    for (let i = 0; i < 3; i++) {
      fire('tool_call', ctx, { toolName: 'request_consultant', input: { agent: 'devils-advocate' } })
    }

    expect(agentLoopState.get('test-session')).toEqual({ lastName: 'devils-advocate', count: 3 })
  })

  it('emits engine_notify warning at LOOP_WARN_THRESHOLD (5)', () => {
    const { ion, fire } = makeIon()
    wireToolPipeline(ion)
    const ctx = makeCtx()

    for (let i = 0; i < 5; i++) {
      fire('tool_call', ctx, { toolName: 'dispatch_agent', input: { agent: 'chief-of-communications' } })
    }

    expect(ctx.emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'engine_notify',
      level: 'warn',
    }))
  })

  it('blocks and returns { block: true } at LOOP_BLOCK_THRESHOLD (10)', () => {
    const { ion, fire } = makeIon()
    wireToolPipeline(ion)
    const ctx = makeCtx()

    let result: unknown
    for (let i = 0; i < 10; i++) {
      result = fire('tool_call', ctx, { toolName: 'dispatch_agent', input: { agent: 'chief-of-communications' } })
    }

    expect(result).toMatchObject({ block: true })
    expect(ctx.sendMessage).toHaveBeenCalledWith(expect.stringContaining('Loop guard'))
  })

  it('ignores tool_call events that are not dispatch tools', () => {
    const { ion, fire } = makeIon()
    wireToolPipeline(ion)
    const ctx = makeCtx()

    // Non-dispatch tool calls should not update loop state.
    fire('tool_call', ctx, { toolName: 'recall_memory', input: {} })

    expect(agentLoopState.get('test-session')).toBeUndefined()
  })
})
