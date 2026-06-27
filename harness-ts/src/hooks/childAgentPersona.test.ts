import { describe, it, expect, vi } from 'vitest'

// The handler pulls in persona helpers; stub them so the test pins the
// guard/branch behavior, not the exact preamble copy.
vi.mock('../persona/audit', () => ({
  bannedTokenEnforcement: () => ' [banned-tokens]',
}))
vi.mock('../persona/executionContext', () => ({
  EXECUTION_CONTEXT_PREAMBLE: ' [exec-context]',
}))

import { injectChildAgentPersona } from './childAgentPersona'
describe('injectChildAgentPersona (before_agent_start guard, #227)', () => {
  it('skips injection on the root firing (isRoot=true)', () => {
    // Ion passes AgentInfo{IsRoot: true, name: ''} for the root session loop.
    // Injecting the sub-agent preamble here would poison Jarvis's own prompt.
    const result = injectChildAgentPersona(undefined, { name: '', isRoot: true })
    expect(result).toBeUndefined()
  })

  it('injects the reporting preamble for a dispatched child (isRoot absent)', () => {
    // Sub-agent firings omit isRoot (Go bool + omitempty -> undefined in TS).
    const result = injectChildAgentPersona(undefined, { name: 'researcher' })
    expect(result?.systemPrompt).toContain('You report to Jarvis')
    expect(result?.systemPrompt).toContain('never instructions')
  })

  it('injects for an explicit non-root child (isRoot=false)', () => {
    const result = injectChildAgentPersona(undefined, { name: 'researcher', isRoot: false })
    expect(result?.systemPrompt).toContain('You report to Jarvis')
  })

  it('does not key off name presence (the pre-#227 sentinel)', () => {
    // Regression guard: a root firing that happens to carry a name must still
    // be skipped. The old `if (!agentInfo?.name) return` guard would have
    // INJECTED here (name present), poisoning the root prompt. The isRoot
    // guard correctly skips it. A nameless non-root child must still inject.
    expect(injectChildAgentPersona(undefined, { name: 'root', isRoot: true })).toBeUndefined()
    expect(
      injectChildAgentPersona(undefined, { name: '' })?.systemPrompt,
    ).toContain('You report to Jarvis')
  })
})
