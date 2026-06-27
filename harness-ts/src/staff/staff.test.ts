import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { IonContext, DiscoveredAgent, DispatchAgentOpts } from 'ion-sdk'
import { refreshRoster, getRosterEntry, rosterSize, rosterCatalog, normalizeAgentName } from './roster'
import { dispatchStaff } from './dispatch'

function agent(name: string, over: Partial<DiscoveredAgent> = {}): DiscoveredAgent {
  return {
    name,
    path: `/ext/agents/${name}.md`,
    source: 'extension',
    description: `${name} description`,
    systemPrompt: `You are ${name}.`,
    model: 'claude-haiku-4-5-20251001',
    ...over,
  }
}

// Minimal IonContext stub with the two methods the staff modules touch.
function makeCtx(
  discovered: DiscoveredAgent[],
  dispatch: (opts: DispatchAgentOpts) => Promise<{ output: string; cost: number; inputTokens: number; outputTokens: number; elapsed: number; exitCode: number }>,
): IonContext {
  return {
    sessionKey: 's1',
    config: { extensionDir: '/ext', model: 'm', workingDirectory: '/wd' },
    discoverAgents: vi.fn(async () => discovered),
    dispatchAgent: vi.fn(dispatch),
  } as unknown as IonContext
}

describe('roster', () => {
  beforeEach(async () => {
    // Reset the module-level roster to a known empty-then-populated state.
    const ctx = makeCtx([], async () => ({ output: '', cost: 0, inputTokens: 0, outputTokens: 0, elapsed: 0, exitCode: 0 }))
    await refreshRoster(ctx) // empty discovery leaves prior roster, so clear via a real set below
  })

  it('normalizes underscores and case to hyphens', () => {
    expect(normalizeAgentName('Personal_CFO')).toBe('personal-cfo')
    expect(normalizeAgentName('  Chief-Of-Strategy ')).toBe('chief-of-strategy')
  })

  it('populates the roster from discoverAgents and looks up by normalized name', async () => {
    const ctx = makeCtx([agent('admin'), agent('personal-cfo')], async () => ({ output: '', cost: 0, inputTokens: 0, outputTokens: 0, elapsed: 0, exitCode: 0 }))
    await refreshRoster(ctx)
    expect(rosterSize()).toBe(2)
    expect(getRosterEntry('admin')?.systemPrompt).toBe('You are admin.')
    // underscore form resolves to the hyphen-keyed entry
    expect(getRosterEntry('personal_cfo')?.name).toBe('personal-cfo')
    expect(ctx.discoverAgents).toHaveBeenCalledWith(expect.objectContaining({ sources: ['extension'] }))
  })

  it('rosterCatalog lists one sorted line per agent', async () => {
    const ctx = makeCtx([agent('writer', { description: 'drafts prose' }), agent('admin', { description: 'calendar + briefs' })], async () => ({ output: '', cost: 0, inputTokens: 0, outputTokens: 0, elapsed: 0, exitCode: 0 }))
    await refreshRoster(ctx)
    const cat = rosterCatalog()
    expect(cat).toBe('- admin — calendar + briefs\n- writer — drafts prose')
  })

  it('leaves the prior roster intact when discovery returns empty', async () => {
    const ctx1 = makeCtx([agent('admin')], async () => ({ output: '', cost: 0, inputTokens: 0, outputTokens: 0, elapsed: 0, exitCode: 0 }))
    await refreshRoster(ctx1)
    const before = rosterSize()
    const ctx2 = makeCtx([], async () => ({ output: '', cost: 0, inputTokens: 0, outputTokens: 0, elapsed: 0, exitCode: 0 }))
    await refreshRoster(ctx2)
    expect(rosterSize()).toBe(before)
  })
})

describe('dispatchStaff', () => {
  it('passes the roster systemPrompt, model, and child extensionDir to dispatchAgent', async () => {
    let captured: DispatchAgentOpts | undefined
    const ctx = makeCtx([agent('admin', { systemPrompt: 'You are admin.', model: 'claude-haiku-4-5-20251001' })], async (opts) => {
      captured = opts
      return { output: 'done', cost: 0.01, inputTokens: 5, outputTokens: 7, elapsed: 1.2, exitCode: 0 }
    })
    await refreshRoster(ctx)
    const r = await dispatchStaff(ctx, 'admin', 'check the calendar')
    expect(captured?.systemPrompt).toBe('You are admin.')
    expect(captured?.model).toBe('claude-haiku-4-5-20251001')
    expect(captured?.extensionDir).toBe('/ext/child-extension/index.js')
    expect(captured?.task).toBe('check the calendar')
    expect(r.output).toBe('done')
  })

  it('falls back to a bare dispatch (no systemPrompt) when the roster misses', async () => {
    let captured: DispatchAgentOpts | undefined
    const ctx = makeCtx([agent('admin')], async (opts) => {
      captured = opts
      return { output: 'x', cost: 0, inputTokens: 0, outputTokens: 0, elapsed: 0, exitCode: 0 }
    })
    await refreshRoster(ctx)
    await dispatchStaff(ctx, 'nonexistent-staff', 'do a thing')
    expect(captured?.systemPrompt).toBeUndefined()
    expect(captured?.extensionDir).toBe('/ext/child-extension/index.js')
  })
})
