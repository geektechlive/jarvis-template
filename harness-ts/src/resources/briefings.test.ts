import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ResourceHandle, ResourceItem, IonContext } from 'ion-sdk'

vi.mock('ion-sdk', () => ({
  log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

// Scheduler ctx must be mocked before importing briefings so getSchedulerCtx
// can be controlled per-test.
vi.mock('../scheduler/ctx', () => ({
  getSchedulerCtx: vi.fn(() => null),
}))

describe('resources/briefings', () => {
  let briefingsModule: typeof import('./briefings')
  let mockHandle: ResourceHandle
  let mockCtx: IonContext

  beforeEach(async () => {
    vi.resetModules()
    briefingsModule = await import('./briefings')

    mockHandle = {
      publish: vi.fn().mockResolvedValue(undefined),
    }

    mockCtx = {
      sessionKey: 'test',
      conversationId: '',
      cwd: '/tmp',
      model: null,
      config: { extensionDir: '/tmp', model: 'test', workingDirectory: '/tmp' },
      emit: vi.fn(),
      sendMessage: vi.fn(),
      registerProcess: vi.fn(),
      deregisterProcess: vi.fn(),
      listProcesses: vi.fn(),
      terminateProcess: vi.fn(),
      cleanStaleProcesses: vi.fn(),
      suppressTool: vi.fn(),
      callTool: vi.fn(),
      sendPrompt: vi.fn(),
      dispatchAgent: vi.fn(),
      discoverAgents: vi.fn(),
      sandboxWrap: vi.fn(),
      registerAgentSpec: vi.fn(),
      deregisterAgentSpec: vi.fn(),
      elicit: vi.fn(),
      setSessionMemory: vi.fn(),
      getSessionMemory: vi.fn(),
      recallAgent: vi.fn(),
      getContextUsage: vi.fn(),
      searchHistory: vi.fn(),
      llmCall: vi.fn(),
      notify: vi.fn().mockResolvedValue(undefined),
      intercept: vi.fn().mockResolvedValue(undefined),
      sessions: { list: vi.fn(), send: vi.fn() },
      runOnce: vi.fn(),
      resources: { declare: vi.fn(), onQuery: vi.fn() },
    }
  })

  describe('publishBriefing — handle not initialized', () => {
    it('returns without throwing when handle is null', async () => {
      await expect(briefingsModule.publishBriefing('content', 'Title')).resolves.toBeUndefined()
    })

    it('does not call notify when handle is null', async () => {
      await briefingsModule.publishBriefing('content', 'Title', mockCtx)
      expect(mockCtx.notify).not.toHaveBeenCalled()
    })
  })

  describe('publishBriefing — handle initialized', () => {
    beforeEach(() => {
      briefingsModule.initBriefingsHandle(mockHandle)
    })

    it('calls handle.publish with op=create and correct item shape', async () => {
      await briefingsModule.publishBriefing('Some brief content', 'Morning Brief', mockCtx)

      expect(mockHandle.publish).toHaveBeenCalledOnce()
      const [op, item] = (mockHandle.publish as ReturnType<typeof vi.fn>).mock.calls[0] as [string, ResourceItem]
      expect(op).toBe('create')
      expect(item.kind).toBe('briefing')
      expect(item.title).toBe('Morning Brief')
      expect(item.content).toBe('Some brief content')
      expect(item.id).toMatch(/^brief-/)
      expect(typeof item.createdAt).toBe('string')
    })

    it('calls ctx.notify with correct kind and resourceId', async () => {
      await briefingsModule.publishBriefing('content', 'Midday Check-in', mockCtx)

      expect(mockCtx.notify).toHaveBeenCalledOnce()
      const notifyOpts = ((mockCtx.notify as ReturnType<typeof vi.fn>).mock.calls[0] ?? [])[0] as { kind: string; resourceId: string; title: string }
      expect(notifyOpts.kind).toBe('briefing')
      expect(notifyOpts.title).toBe('Midday Check-in')
      expect(typeof notifyOpts.resourceId).toBe('string')
    })

    it('truncates title to 120 characters', async () => {
      const longTitle = 'T'.repeat(200)
      await briefingsModule.publishBriefing('content', longTitle, mockCtx)

      const callArgs = ((mockHandle.publish as ReturnType<typeof vi.fn>).mock.calls[0] ?? []) as [string, ResourceItem]
      const item = callArgs[1]
      expect(item.title!.length).toBeLessThanOrEqual(120)
    })

    it('uses getSchedulerCtx() as ctx fallback when ctx not passed', async () => {
      const { getSchedulerCtx } = await import('../scheduler/ctx')
      vi.mocked(getSchedulerCtx).mockReturnValue(mockCtx)

      await briefingsModule.publishBriefing('content', 'Title')

      expect(mockCtx.notify).toHaveBeenCalledOnce()
    })

    it('skips notify when ctx is unavailable and getSchedulerCtx returns null', async () => {
      const { getSchedulerCtx } = await import('../scheduler/ctx')
      vi.mocked(getSchedulerCtx).mockReturnValue(null)

      await briefingsModule.publishBriefing('content', 'Title')

      // publish should still succeed
      expect(mockHandle.publish).toHaveBeenCalledOnce()
      // notify not called without ctx
      expect(mockCtx.notify).not.toHaveBeenCalled()
    })
  })
})
