import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the webhook module before importing notify
vi.mock('./webhook', () => ({
  postToChannel: vi.fn(),
}))

// Mock the issueMeta module
vi.mock('./issueMeta', () => ({
  fetchIssueMetadata: vi.fn().mockResolvedValue(null),
  metadataBadges: vi.fn().mockReturnValue([]),
  firstParagraph: (s: string) => s.split('\n\n')[0] ?? '',
}))

import { postToChannel } from './webhook'
import {
  notifyPatrolOpened,
  notifyPatrolClosed,
  notifyPatrolCycle,
  notifyResolverShipped,
  notifyResolverAwaiting,
  notifyDeploySucceeded,
  notifyDeployFailed,
  notifyDeploySkipped,
} from './notify'

const mockPostToChannel = vi.mocked(postToChannel)

beforeEach(() => {
  vi.clearAllMocks()
  mockPostToChannel.mockResolvedValue({ messageId: 'test-msg-id' })
})

describe('Discord notifications', () => {
  describe('notifyPatrolOpened', () => {
    it('posts safe-tier patrol open with blue color', async () => {
      await notifyPatrolOpened({
        routine: 'log_patrol',
        issueNumber: 123,
        issueUrl: 'https://github.com/<your-org>/jarvis/issues/123',
        issueTitle: 'Test error in log',
        riskTier: 'safe',
      })

      expect(mockPostToChannel).toHaveBeenCalledOnce()
      const [content, opts] = mockPostToChannel.mock.calls[0] as [string | null, { embed: unknown }]
      expect(content).toBeNull()
      expect(opts.embed).toBeDefined()
      const embed = opts.embed as Record<string, unknown>
      expect(String(embed.title)).toContain('Patrol cycle')
      expect(String(embed.title)).toContain('log_patrol')
      expect(embed.color).toBe(0x2196F3) // blue
    })

    it('posts risky-tier patrol open with amber color', async () => {
      await notifyPatrolOpened({
        routine: 'commit_patrol',
        issueNumber: 456,
        issueUrl: 'https://github.com/<your-org>/jarvis/issues/456',
        issueTitle: 'Quality issue found',
        riskTier: 'risky',
      })

      expect(mockPostToChannel).toHaveBeenCalledOnce()
      const [, opts] = mockPostToChannel.mock.calls[0] as [string | null, { embed: unknown }]
      const embed = opts.embed as Record<string, unknown>
      expect(embed.color).toBe(0xFFC107) // amber
    })

    it('includes issue in description', async () => {
      await notifyPatrolOpened({
        routine: 'improve_patrol',
        issueNumber: 789,
        issueUrl: 'https://github.com/<your-org>/jarvis/issues/789',
        issueTitle: 'Improvement detected',
        riskTier: 'safe',
      })

      const [, opts] = mockPostToChannel.mock.calls[0] as [string | null, { embed: unknown }]
      const embed = opts.embed as Record<string, unknown>
      expect(String(embed.description)).toContain('#789')
      expect(String(embed.description)).toContain('Improvement detected')
    })
  })

  describe('notifyPatrolClosed', () => {
    it('posts closed patrol with blue color (safe when no risky opened)', async () => {
      await notifyPatrolClosed({
        routine: 'issue_patrol',
        issueNumber: 999,
        issueUrl: 'https://github.com/<your-org>/jarvis/issues/999',
        reason: 'resolved',
      })

      expect(mockPostToChannel).toHaveBeenCalledOnce()
      const [, opts] = mockPostToChannel.mock.calls[0] as [string | null, { embed: unknown }]
      const embed = opts.embed as Record<string, unknown>
      expect(String(embed.title)).toContain('Patrol cycle')
      expect(String(embed.description)).toContain('#999')
      // When there are no opened issues, color is safe (blue)
      expect(embed.color).toBe(0x2196F3) // blue
    })
  })

  describe('notifyResolverShipped', () => {
    it('posts success with green color', async () => {
      await notifyResolverShipped({
        commitSha: 'abc1234567890',
        commitShort: 'abc1234',
        filesChanged: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'],
        issueNumber: 100,
        issueUrl: 'https://github.com/<your-org>/jarvis/issues/100',
      })

      expect(mockPostToChannel).toHaveBeenCalledOnce()
      const [, opts] = mockPostToChannel.mock.calls[0] as [string | null, { embed: unknown }]
      const embed = opts.embed as Record<string, unknown>
      expect(String(embed.title)).toContain('Resolver shipped fix')
      expect(String(embed.title)).toContain('#100')
      expect(embed.color).toBe(0x4CAF50) // green
    })

    it('truncates file list preview with italic +N more', async () => {
      await notifyResolverShipped({
        commitSha: 'x'.repeat(13),
        commitShort: 'x'.repeat(7),
        filesChanged: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts', 'h.ts', 'i.ts'],
        issueNumber: 100,
        issueUrl: 'https://github.com/<your-org>/jarvis/issues/100',
      })

      const [, opts] = mockPostToChannel.mock.calls[0] as [string | null, { embed: unknown }]
      const embed = opts.embed as Record<string, unknown>
      expect(String(embed.description)).toContain('_+3 more_')
    })
  })

  describe('notifyResolverAwaiting', () => {
    it('posts risky approval with amber color', async () => {
      await notifyResolverAwaiting({
        approvalId: 42,
        summary: 'fix: resolve #100 test fix',
        filesChanged: ['src/test.ts'],
        issueNumber: 100,
        issueUrl: 'https://github.com/<your-org>/jarvis/issues/100',
      })

      expect(mockPostToChannel).toHaveBeenCalledOnce()
      const [, opts] = mockPostToChannel.mock.calls[0] as [string | null, { embed: unknown }]
      const embed = opts.embed as Record<string, unknown>
      expect(String(embed.title)).toContain('Resolver awaiting approval')
      expect(String(embed.title)).toContain('#100')
      expect(embed.color).toBe(0xFFC107) // amber
    })
  })

  describe('notifyDeploySucceeded', () => {
    it('posts success with green color and component name', async () => {
      await notifyDeploySucceeded({
        sha: 'abc1234567890',
        component: 'ts-extension',
        durationSec: 45,
      })

      expect(mockPostToChannel).toHaveBeenCalledOnce()
      const [, opts] = mockPostToChannel.mock.calls[0] as [string | null, { embed: unknown }]
      const embed = opts.embed as Record<string, unknown>
      expect(String(embed.title)).toContain('Deploy succeeded')
      expect(String(embed.title)).toContain('ts-extension')
      expect(String(embed.description)).toContain('Live in 45s')
      expect(embed.color).toBe(0x4CAF50) // green
    })

    it('omits duration when not provided', async () => {
      await notifyDeploySucceeded({
        sha: 'abc1234567890',
        component: 'ion-engine',
      })

      const [, opts] = mockPostToChannel.mock.calls[0] as [string | null, { embed: unknown }]
      const embed = opts.embed as Record<string, unknown>
      expect(String(embed.description)).toContain('Live in unknown')
      expect(String(embed.description)).not.toContain('undefined')
    })
  })

  describe('notifyDeployFailed', () => {
    it('posts failure with red color and error summary', async () => {
      await notifyDeployFailed({
        sha: 'abc1234567890',
        component: 'vec-server',
        errorSummary: 'Python dependency resolution failed',
      })

      expect(mockPostToChannel).toHaveBeenCalledOnce()
      const [, opts] = mockPostToChannel.mock.calls[0] as [string | null, { embed: unknown }]
      const embed = opts.embed as Record<string, unknown>
      expect(String(embed.title)).toContain('Deploy failed')
      expect(String(embed.title)).toContain('vec-server')
      expect(String(embed.description)).toContain('Python dependency resolution failed')
      expect(embed.color).toBe(0xF44336) // red
    })
  })

  describe('notifyDeploySkipped', () => {
    it('posts skip with gray color and reason', async () => {
      await notifyDeploySkipped({
        sha: 'abc1234567890',
        reason: 'active conversation in last 30 min',
      })

      expect(mockPostToChannel).toHaveBeenCalledOnce()
      const [, opts] = mockPostToChannel.mock.calls[0] as [string | null, { embed: unknown }]
      const embed = opts.embed as Record<string, unknown>
      expect(String(embed.title)).toContain('Deploy deferred')
      expect(String(embed.description)).toContain('active conversation in last 30 min')
      expect(embed.color).toBe(0x9E9E9E) // gray
    })
  })

  describe('notifyPatrolCycle', () => {
    it('includes openBacklog in embed description when provided', async () => {
      await notifyPatrolCycle({
        routine: 'log_patrol',
        opened: [{
          number: 456,
          title: 'New error',
          url: 'https://github.com/<your-org>/jarvis/issues/456',
          riskTier: 'safe',
        }],
        closed: [],
        openBacklog: 15,
      })

      expect(mockPostToChannel).toHaveBeenCalledOnce()
      const [, opts] = mockPostToChannel.mock.calls[0] as [string | null, { embed: unknown }]
      const embed = opts.embed as Record<string, unknown>
      expect(String(embed.description)).toContain('Open backlog: 15')
    })

    it('omits openBacklog line when not provided', async () => {
      await notifyPatrolCycle({
        routine: 'log_patrol',
        opened: [{
          number: 456,
          title: 'New error',
          url: 'https://github.com/<your-org>/jarvis/issues/456',
          riskTier: 'safe',
        }],
        closed: [],
      })

      expect(mockPostToChannel).toHaveBeenCalledOnce()
      const [, opts] = mockPostToChannel.mock.calls[0] as [string | null, { embed: unknown }]
      const embed = opts.embed as Record<string, unknown>
      expect(String(embed.description)).not.toContain('Open backlog:')
    })
  })

  describe('graceful degradation', () => {
    it('logs warning but does not throw when postToChannel fails', async () => {
      mockPostToChannel.mockRejectedValueOnce(new Error('Network error'))

      // Should not throw; resolves to undefined despite rejection
      await expect(
        notifyPatrolOpened({
          routine: 'log_patrol',
          issueNumber: 123,
          issueUrl: 'https://github.com/<your-org>/jarvis/issues/123',
          issueTitle: 'Test',
          riskTier: 'safe',
        }),
      ).resolves.toBeUndefined()
    })
  })
})
