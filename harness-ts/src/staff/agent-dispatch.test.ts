/**
 * agent-dispatch.test.ts
 *
 * Covers the deterministic pre-flight validation in dispatchAgent and
 * the dispatchAgentAndWait wrapper. All cases are exercised without a
 * live IonContext — only the paths that resolve before ctx.dispatchAgent
 * is ever called are tested here.
 *
 * Deliberately SKIPPED (too coupled to a live IonContext):
 *   - onTextDelta / onToolStart / onToolEnd / onToolError streaming callbacks
 *   - onComplete / onError / onRecall lifecycle callbacks
 *   - The actual background dispatch loop
 *   - recallAgent helper (requires ctx.recallAgent)
 *   - dispatchAgentAndWait happy-path wait (requires ctx.dispatchAgent to call back)
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { ControlRoom } from './control-room'
import { dispatchAgent, dispatchAgentAndWait } from './agent-dispatch'
import type { AgentDef } from './types'

// ── team-state has file I/O; mock it to avoid needing a real dataHome ──
vi.mock('./team-state', () => ({
  recordDispatch: vi.fn(),
}))

// ── Helpers ──

function def(
  name: string,
  type: AgentDef['type'] = 'lead',
  over: Partial<AgentDef> = {},
): AgentDef {
  return {
    name,
    displayName: name.charAt(0).toUpperCase() + name.slice(1),
    description: `${name} agent`,
    type,
    visibility: 'always',
    tools: [],
    systemPrompt: `You are ${name}.`,
    filePath: `/agents/${name}.md`,
    ...over,
  }
}

function makeOffice(defs: AgentDef[], teamMembers?: string[]): ControlRoom {
  const office = new ControlRoom()
  office.setDefs(defs)
  const members = teamMembers ?? defs.map(d => d.name)
  office.activateTeam('test-team', { 'test-team': members })
  return office
}

// ── Tests ──

describe('dispatchAgent pre-flight validation', () => {
  let office: ControlRoom

  afterEach(() => {
    office?.cleanup()
  })

  it('returns exitCode 1 when agent is not in active team', async () => {
    office = makeOffice([def('eng-lead')])
    const result = await dispatchAgent(office, {
      agent: 'nobody',
      task: 'do something',
      model: 'claude-haiku',
      workingDirectory: '/wd',
    })
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('not found in team')
  })

  it('includes available agents in not-found error', async () => {
    office = makeOffice([def('eng-lead'), def('project-lead')])
    const result = await dispatchAgent(office, {
      agent: 'nobody',
      task: 'do something',
      model: 'claude-haiku',
      workingDirectory: '/wd',
    })
    expect(result.output).toContain('eng-lead')
    expect(result.output).toContain('project-lead')
  })

  it('includes /agents-team hint when agent exists globally but not in active team', async () => {
    const allDefs = [def('eng-lead'), def('specialist-a', 'specialist')]
    office = new ControlRoom()
    office.setDefs(allDefs)
    // Activate team that excludes specialist-a
    office.activateTeam('team-a', { 'team-a': ['eng-lead'] })

    const result = await dispatchAgent(office, {
      agent: 'specialist-a',
      task: 'do something',
      model: 'claude-haiku',
      workingDirectory: '/wd',
    })
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('/agents-team')
    expect(result.output).toContain('specialist-a')
  })

  it('does NOT include /agents-team hint when agent does not exist globally', async () => {
    office = makeOffice([def('eng-lead')])
    const result = await dispatchAgent(office, {
      agent: 'totally-unknown',
      task: 'do something',
      model: 'claude-haiku',
      workingDirectory: '/wd',
    })
    expect(result.exitCode).toBe(1)
    expect(result.output).not.toContain('/agents-team')
  })

  it('returns exitCode 1 when agent is already running', async () => {
    office = makeOffice([def('eng-lead')])
    // Put the agent in running state manually (no ctx needed — state is internal)
    office.markRunning('eng-lead', 'previous task')

    const result = await dispatchAgent(office, {
      agent: 'eng-lead',
      task: 'new task',
      model: 'claude-haiku',
      workingDirectory: '/wd',
    })
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('already running')
  })

  it('returns exitCode 1 and error message when ctx is undefined', async () => {
    office = makeOffice([def('eng-lead')])
    // Omit ctx entirely — exactOptionalPropertyTypes forbids explicit undefined
    const result = await dispatchAgent(office, {
      agent: 'eng-lead',
      task: 'some task',
      model: 'claude-haiku',
      workingDirectory: '/wd',
    })
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('engine context not available')
  })

  it('returns exitCode 0 stub response when ctx is provided (dispatch proceeds to background)', async () => {
    office = makeOffice([def('eng-lead')])

    // Minimal ctx stub — dispatchAgent calls ctx.dispatchAgent() but we don't
    // care about the result here; we just need it not to throw.
    const ctxStub = {
      dispatchAgent: vi.fn().mockReturnValue(Promise.resolve()),
      sendMessage: vi.fn(),
      recallAgent: vi.fn().mockResolvedValue(true),
    }

    const result = await dispatchAgent(office, {
      agent: 'eng-lead',
      task: 'build the feature',
      model: 'claude-haiku',
      workingDirectory: '/wd',
      ctx: ctxStub as never,
    })

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('dispatched')
  })

  it('agent is marked running when dispatch proceeds', async () => {
    office = makeOffice([def('eng-lead')])

    const ctxStub = {
      dispatchAgent: vi.fn().mockReturnValue(Promise.resolve()),
      sendMessage: vi.fn(),
      recallAgent: vi.fn().mockResolvedValue(true),
    }

    await dispatchAgent(office, {
      agent: 'eng-lead',
      task: 'some work',
      model: 'claude-haiku',
      workingDirectory: '/wd',
      ctx: ctxStub as never,
    })

    expect(office.getState('eng-lead')?.status).toBe('running')
  })
})

describe('dispatchAgentAndWait pre-flight', () => {
  let office: ControlRoom

  afterEach(() => {
    office?.cleanup()
  })

  it('propagates pre-flight error stub directly without waiting', async () => {
    office = makeOffice([def('eng-lead')])
    // No ctx → pre-flight returns exitCode 1 stub. Omit ctx entirely —
    // exactOptionalPropertyTypes forbids explicit undefined.
    const result = await dispatchAgentAndWait(office, {
      agent: 'eng-lead',
      task: 'some task',
      model: 'claude-haiku',
      workingDirectory: '/wd',
    })
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('engine context not available')
  })

  it('propagates unknown-agent error stub directly', async () => {
    office = makeOffice([def('eng-lead')])
    const result = await dispatchAgentAndWait(office, {
      agent: 'nobody',
      task: 'task',
      model: 'claude-haiku',
      workingDirectory: '/wd',
    })
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('not found in team')
  })

  it('waits and returns result when agent completes', async () => {
    office = makeOffice([def('eng-lead')])

    const ctxStub = {
      dispatchAgent: vi.fn().mockImplementation(() => {
        // Simulate the agent completing immediately after dispatch
        return Promise.resolve()
      }),
      sendMessage: vi.fn(),
      recallAgent: vi.fn().mockResolvedValue(true),
    }

    // Dispatch starts running; we need to complete the agent after dispatch returns
    const waitPromise = dispatchAgentAndWait(office, {
      agent: 'eng-lead',
      task: 'the task',
      model: 'claude-haiku',
      workingDirectory: '/wd',
      ctx: ctxStub as never,
      timeoutMs: 2000,
    })

    // Give the dispatch a tick to mark the agent running, then complete it
    await Promise.resolve()
    office.markDone('eng-lead', 'final result', 0)

    const result = await waitPromise
    expect(result.exitCode).toBe(0)
    expect(result.output).toBe('final result')
  })

  it('returns error result when agent errors', async () => {
    office = makeOffice([def('eng-lead')])

    const ctxStub = {
      dispatchAgent: vi.fn().mockReturnValue(Promise.resolve()),
      sendMessage: vi.fn(),
      recallAgent: vi.fn().mockResolvedValue(true),
    }

    const waitPromise = dispatchAgentAndWait(office, {
      agent: 'eng-lead',
      task: 'the task',
      model: 'claude-haiku',
      workingDirectory: '/wd',
      ctx: ctxStub as never,
      timeoutMs: 2000,
    })

    await Promise.resolve()
    office.markError('eng-lead', 'something exploded')

    const result = await waitPromise
    expect(result.exitCode).toBe(1)
  })

  it('returns timeout error when agent never completes', async () => {
    office = makeOffice([def('eng-lead')])

    const ctxStub = {
      dispatchAgent: vi.fn().mockReturnValue(new Promise(() => { /* never resolves */ })),
      sendMessage: vi.fn(),
      recallAgent: vi.fn().mockResolvedValue(true),
    }

    // dispatchAgentAndWait passes (timeoutMs + 5000) to waitForCompletion, so
    // with timeoutMs=50 the wait ceiling is 5050ms. Give vitest 8s to be safe.
    const result = await dispatchAgentAndWait(office, {
      agent: 'eng-lead',
      task: 'stuck',
      model: 'claude-haiku',
      workingDirectory: '/wd',
      ctx: ctxStub as never,
      timeoutMs: 50,
    })

    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('did not complete')
  }, 8_000)
})
