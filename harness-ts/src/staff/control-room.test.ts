import { describe, it, expect, afterEach } from 'vitest'
import { ControlRoom } from './control-room'
import type { AgentDef } from './types'

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

// ── Test Suite ──

describe('ControlRoom', () => {
  let office: ControlRoom

  afterEach(() => {
    office?.cleanup()
  })

  // ── State Transitions ──

  describe('markRunning', () => {
    it('transitions idle agent to running', () => {
      office = makeOffice([def('eng-lead')])
      const state = office.markRunning('eng-lead', 'build the feature')
      expect(state?.status).toBe('running')
    })

    it('sets task and resets toolCount', () => {
      office = makeOffice([def('eng-lead')])
      const state = office.markRunning('eng-lead', 'my task')
      expect(state?.task).toBe('my task')
      expect(state?.toolCount).toBe(0)
    })

    it('truncates lastWork to 80 chars', () => {
      office = makeOffice([def('eng-lead')])
      const longTask = 'a'.repeat(200)
      const state = office.markRunning('eng-lead', longTask)
      expect(state?.lastWork.length).toBeLessThanOrEqual(80)
    })

    it('increments runCount on each invocation', () => {
      office = makeOffice([def('eng-lead')])
      office.markRunning('eng-lead', 'first')
      office.markDone('eng-lead', 'done', 0)
      office.markRunning('eng-lead', 'second')
      const state = office.getState('eng-lead')
      expect(state?.runCount).toBe(2)
    })

    it('returns undefined for unknown agent', () => {
      office = makeOffice([def('eng-lead')])
      const state = office.markRunning('nonexistent', 'task')
      expect(state).toBeUndefined()
    })
  })

  describe('markDone', () => {
    it('transitions to done on exitCode 0', () => {
      office = makeOffice([def('eng-lead')])
      office.markRunning('eng-lead', 'task')
      office.markDone('eng-lead', 'all done', 0)
      expect(office.getState('eng-lead')?.status).toBe('done')
    })

    it('transitions to error on nonzero exitCode', () => {
      office = makeOffice([def('eng-lead')])
      office.markRunning('eng-lead', 'task')
      office.markDone('eng-lead', 'it failed', 1)
      expect(office.getState('eng-lead')?.status).toBe('error')
    })

    it('stores fullOutput', () => {
      office = makeOffice([def('eng-lead')])
      office.markRunning('eng-lead', 'task')
      office.markDone('eng-lead', 'the result', 0)
      expect(office.getState('eng-lead')?.fullOutput).toBe('the result')
    })

    it('sets lastWork to last non-empty output line', () => {
      office = makeOffice([def('eng-lead')])
      office.markRunning('eng-lead', 'task')
      office.markDone('eng-lead', 'line one\nline two\n\nline three', 0)
      expect(office.getState('eng-lead')?.lastWork).toBe('line three')
    })

    it('falls back to task when output is empty', () => {
      office = makeOffice([def('eng-lead')])
      office.markRunning('eng-lead', 'my-task')
      office.markDone('eng-lead', '', 0)
      expect(office.getState('eng-lead')?.lastWork).toBe('my-task')
    })

    it('is a no-op for unknown agent', () => {
      office = makeOffice([def('eng-lead')])
      // Must not throw
      expect(() => office.markDone('unknown', 'output', 0)).not.toThrow()
    })
  })

  describe('markError', () => {
    it('transitions to error status', () => {
      office = makeOffice([def('eng-lead')])
      office.markRunning('eng-lead', 'task')
      office.markError('eng-lead', 'something broke')
      expect(office.getState('eng-lead')?.status).toBe('error')
    })

    it('stores message as lastWork', () => {
      office = makeOffice([def('eng-lead')])
      office.markRunning('eng-lead', 'task')
      office.markError('eng-lead', 'timeout exceeded')
      expect(office.getState('eng-lead')?.lastWork).toBe('timeout exceeded')
    })

    it('is a no-op for unknown agent', () => {
      office = makeOffice([def('eng-lead')])
      expect(() => office.markError('unknown', 'err')).not.toThrow()
    })
  })

  // ── State Queries ──

  describe('getAllStates', () => {
    it('returns all activated agents', () => {
      office = makeOffice([def('eng-lead'), def('project-lead')])
      expect(office.getAllStates()).toHaveLength(2)
    })

    it('returns empty array when no team is active', () => {
      office = new ControlRoom()
      expect(office.getAllStates()).toHaveLength(0)
    })
  })

  describe('getState', () => {
    it('returns state for a known agent', () => {
      office = makeOffice([def('eng-lead')])
      expect(office.getState('eng-lead')).toBeDefined()
    })

    it('returns undefined for unknown agent', () => {
      office = makeOffice([def('eng-lead')])
      expect(office.getState('nonexistent')).toBeUndefined()
    })

    it('is case-insensitive', () => {
      office = makeOffice([def('eng-lead')])
      expect(office.getState('ENG-LEAD')).toBeDefined()
    })
  })

  // ── Alias Resolution ──

  describe('resolveAgent', () => {
    it('resolves by canonical name', () => {
      office = makeOffice([def('eng-lead')])
      expect(office.resolveAgent('eng-lead')?.def.name).toBe('eng-lead')
    })

    it('resolves via alias', () => {
      office = makeOffice([def('eng-lead', 'lead', { alias: 'engineering' })])
      expect(office.resolveAgent('engineering')?.def.name).toBe('eng-lead')
    })

    it('is case-insensitive for alias', () => {
      office = makeOffice([def('eng-lead', 'lead', { alias: 'engineering' })])
      expect(office.resolveAgent('ENGINEERING')?.def.name).toBe('eng-lead')
    })

    it('returns undefined for unknown name/alias', () => {
      office = makeOffice([def('eng-lead')])
      expect(office.resolveAgent('unknown')).toBeUndefined()
    })
  })

  // ── Global Lookup ──

  describe('agentExistsGlobally', () => {
    it('finds agent in allDefs even when not in active team', () => {
      const allDefs = [def('eng-lead'), def('specialist-a', 'specialist')]
      office = new ControlRoom()
      office.setDefs(allDefs)
      // Activate team without specialist-a
      office.activateTeam('test-team', { 'test-team': ['eng-lead'] })
      expect(office.agentExistsGlobally('specialist-a')).toBeDefined()
      expect(office.agentExistsGlobally('specialist-a')?.name).toBe('specialist-a')
    })

    it('returns undefined when agent not in allDefs at all', () => {
      office = makeOffice([def('eng-lead')])
      expect(office.agentExistsGlobally('nobody')).toBeUndefined()
    })

    it('is case-insensitive', () => {
      office = makeOffice([def('eng-lead')])
      expect(office.agentExistsGlobally('ENG-LEAD')).toBeDefined()
    })
  })

  // ── Instrumentation ──

  describe('incrementTools', () => {
    it('increments toolCount', () => {
      office = makeOffice([def('eng-lead')])
      office.markRunning('eng-lead', 'task')
      office.incrementTools('eng-lead')
      office.incrementTools('eng-lead')
      expect(office.getState('eng-lead')?.toolCount).toBe(2)
    })

    it('updates lastWork when toolDesc provided', () => {
      office = makeOffice([def('eng-lead')])
      office.markRunning('eng-lead', 'task')
      office.incrementTools('eng-lead', 'Reading file')
      expect(office.getState('eng-lead')?.lastWork).toBe('Reading file')
    })

    it('does not update lastWork when toolDesc omitted', () => {
      office = makeOffice([def('eng-lead')])
      office.markRunning('eng-lead', 'initial-task')
      const beforeLastWork = office.getState('eng-lead')?.lastWork
      office.incrementTools('eng-lead')
      expect(office.getState('eng-lead')?.lastWork).toBe(beforeLastWork)
    })

    it('is a no-op for unknown agent', () => {
      office = makeOffice([def('eng-lead')])
      expect(() => office.incrementTools('unknown', 'desc')).not.toThrow()
    })
  })

  describe('pushMessage', () => {
    it('appends message to state.messages', () => {
      office = makeOffice([def('eng-lead')])
      office.markRunning('eng-lead', 'task')
      office.pushMessage('eng-lead', { role: 'assistant', content: 'thinking...' })
      office.pushMessage('eng-lead', { role: 'tool', content: 'Reading file', toolName: 'Read' })
      const msgs = office.getState('eng-lead')?.messages
      expect(msgs).toHaveLength(2)
      expect(msgs?.[0]?.role).toBe('assistant')
      expect(msgs?.[1]?.toolName).toBe('Read')
    })

    it('is a no-op for unknown agent', () => {
      office = makeOffice([def('eng-lead')])
      expect(() => office.pushMessage('unknown', { role: 'assistant', content: 'x' })).not.toThrow()
    })
  })

  // ── buildAgentStateUpdates visibility rules ──

  describe('buildAgentStateUpdates', () => {
    it('includes lead agents even when idle', () => {
      office = makeOffice([def('eng-lead', 'lead')])
      const updates = office.buildAgentStateUpdates()
      expect(updates.some(u => u.name === 'eng-lead')).toBe(true)
    })

    it('includes staff agents even when idle', () => {
      office = makeOffice([def('staff-agent', 'staff')])
      const updates = office.buildAgentStateUpdates()
      expect(updates.some(u => u.name === 'staff-agent')).toBe(true)
    })

    it('excludes idle specialists', () => {
      office = makeOffice([def('spec-a', 'specialist')])
      const updates = office.buildAgentStateUpdates()
      expect(updates.some(u => u.name === 'spec-a')).toBe(false)
    })

    it('excludes idle consultants', () => {
      office = makeOffice([def('consult-a', 'consultant')])
      const updates = office.buildAgentStateUpdates()
      expect(updates.some(u => u.name === 'consult-a')).toBe(false)
    })

    it('includes running specialist in updates', () => {
      office = makeOffice([def('spec-a', 'specialist')])
      office.markRunning('spec-a', 'task')
      const updates = office.buildAgentStateUpdates()
      expect(updates.some(u => u.name === 'spec-a')).toBe(true)
    })

    it('includes error-state consultant in updates', () => {
      office = makeOffice([def('consult-a', 'consultant')])
      office.markRunning('consult-a', 'task')
      office.markError('consult-a', 'failed')
      const updates = office.buildAgentStateUpdates()
      expect(updates.some(u => u.name === 'consult-a')).toBe(true)
    })

    it('includes metadata.displayName', () => {
      office = makeOffice([def('eng-lead', 'lead')])
      const updates = office.buildAgentStateUpdates()
      const entry = updates.find(u => u.name === 'eng-lead')
      expect(entry?.metadata?.displayName).toBeDefined()
    })

    it('includes depth=1 for specialists', () => {
      office = makeOffice([def('spec-a', 'specialist')])
      office.markRunning('spec-a', 'task')
      const updates = office.buildAgentStateUpdates()
      const entry = updates.find(u => u.name === 'spec-a')
      expect(entry?.metadata?.depth).toBe(1)
    })

    it('does not include depth for lead agents', () => {
      office = makeOffice([def('eng-lead', 'lead')])
      const updates = office.buildAgentStateUpdates()
      const entry = updates.find(u => u.name === 'eng-lead')
      expect(entry?.metadata?.depth).toBeUndefined()
    })
  })

  // ── findParent ──

  describe('findParent', () => {
    it('returns the lead name when agent is a specialist of that lead', () => {
      const leadDef = def('eng-lead', 'lead', { specialists: ['spec-a'] })
      const specDef = def('spec-a', 'specialist')
      office = makeOffice([leadDef, specDef])
      expect(office.findParent('spec-a')).toBe('eng-lead')
    })

    it('returns undefined when agent has no lead parent', () => {
      office = makeOffice([def('eng-lead', 'lead'), def('spec-a', 'specialist')])
      expect(office.findParent('spec-a')).toBeUndefined()
    })
  })

  // ── activateTeam ──

  describe('activateTeam', () => {
    it('clears previous team members and sets new ones', () => {
      const defs = [def('eng-lead'), def('project-lead')]
      office = new ControlRoom()
      office.setDefs(defs)
      office.activateTeam('team-a', { 'team-a': ['eng-lead'] })
      expect(office.getAllStates()).toHaveLength(1)
      office.activateTeam('team-b', { 'team-b': ['project-lead'] })
      expect(office.getAllStates()).toHaveLength(1)
      expect(office.getState('project-lead')).toBeDefined()
      expect(office.getState('eng-lead')).toBeUndefined()
    })

    it('ignores member names with no matching def', () => {
      office = new ControlRoom()
      office.setDefs([def('eng-lead')])
      office.activateTeam('team-a', { 'team-a': ['eng-lead', 'ghost-agent'] })
      expect(office.getAllStates()).toHaveLength(1)
    })

    it('sets activeTeam name', () => {
      office = new ControlRoom()
      office.setDefs([def('eng-lead')])
      office.activateTeam('my-team', { 'my-team': ['eng-lead'] })
      expect(office.activeTeam).toBe('my-team')
    })
  })

  // ── Cumulative usage tracking ──

  describe('setCumulativeUsage / setCumulativeCost', () => {
    it('replaces (does not add) token counts', () => {
      office = makeOffice([def('eng-lead')])
      office.markRunning('eng-lead', 'task')
      office.setCumulativeUsage('eng-lead', 100, 50)
      office.setCumulativeUsage('eng-lead', 200, 80)
      const state = office.getState('eng-lead')
      expect(state?.inputTokens).toBe(200)
      expect(state?.outputTokens).toBe(80)
    })

    it('replaces (does not add) cost', () => {
      office = makeOffice([def('eng-lead')])
      office.markRunning('eng-lead', 'task')
      office.setCumulativeCost('eng-lead', 0.5)
      office.setCumulativeCost('eng-lead', 1.2)
      expect(office.getState('eng-lead')?.cost).toBe(1.2)
    })
  })

  // ── Session ID ──

  describe('setSessionId / getSessionId', () => {
    it('stores and retrieves a session ID', () => {
      office = makeOffice([def('eng-lead')])
      office.setSessionId('eng-lead', 'sess-abc')
      expect(office.getSessionId('eng-lead')).toBe('sess-abc')
    })

    it('returns null when no session ID set', () => {
      office = makeOffice([def('eng-lead')])
      expect(office.getSessionId('eng-lead')).toBeNull()
    })
  })

  // ── waitForCompletion ──

  describe('waitForCompletion', () => {
    it('resolves immediately when agent is already done', async () => {
      office = makeOffice([def('eng-lead')])
      office.markRunning('eng-lead', 'task')
      office.markDone('eng-lead', 'output', 0)
      const state = await office.waitForCompletion('eng-lead', 1000)
      expect(state.status).toBe('done')
    })

    it('resolves immediately when agent is already in error state', async () => {
      office = makeOffice([def('eng-lead')])
      office.markRunning('eng-lead', 'task')
      office.markError('eng-lead', 'failed')
      const state = await office.waitForCompletion('eng-lead', 1000)
      expect(state.status).toBe('error')
    })

    it('rejects for unknown agent', async () => {
      office = makeOffice([def('eng-lead')])
      await expect(office.waitForCompletion('nobody', 100)).rejects.toThrow('unknown agent')
    })

    it('resolves when markDone is called after waitForCompletion', async () => {
      office = makeOffice([def('eng-lead')])
      office.markRunning('eng-lead', 'task')
      const promise = office.waitForCompletion('eng-lead', 2000)
      office.markDone('eng-lead', 'done now', 0)
      const state = await promise
      expect(state.status).toBe('done')
    })

    it('rejects with timeout error when agent never completes', async () => {
      office = makeOffice([def('eng-lead')])
      office.markRunning('eng-lead', 'task')
      await expect(office.waitForCompletion('eng-lead', 50)).rejects.toThrow('timed out')
    })
  })
})
