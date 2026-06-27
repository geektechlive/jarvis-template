import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock child_process before importing the module under test.
vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}))

import { spawnSync } from 'node:child_process'
import { postToChannel } from './webhook'

const mockSpawnSync = vi.mocked(spawnSync)

function makeSpawnResult(stdout: string, status = 0): ReturnType<typeof spawnSync> {
  return {
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(''),
    status,
    pid: 0,
    output: [],
    signal: null,
  }
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
  mockSpawnSync.mockReturnValue(makeSpawnResult('https://discord.com/api/webhooks/123/abc'))
})

describe('postToChannel', () => {
  it('posts content and returns message id', async () => {
    const mockFetch = vi.mocked(fetch)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'msg-789' }),
      text: async () => '',
    } as Response)

    const result = await postToChannel('Hello from Jarvis')

    expect(mockFetch).toHaveBeenCalledOnce()
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('?wait=true')
    const body = JSON.parse(init.body as string) as { content: string }
    expect(body.content).toBe('Hello from Jarvis')
    expect(result.messageId).toBe('msg-789')
  })

  it('truncates content exceeding 2000 chars', async () => {
    const mockFetch = vi.mocked(fetch)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'msg-trunc' }),
      text: async () => '',
    } as Response)

    const longContent = 'A'.repeat(2100)
    await postToChannel(longContent)

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string) as { content: string }
    expect(body.content.length).toBeLessThanOrEqual(2000)
    expect(body.content.endsWith('... (truncated)')).toBe(true)
  })

  it('includes embed when provided', async () => {
    const mockFetch = vi.mocked(fetch)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'msg-embed' }),
      text: async () => '',
    } as Response)

    await postToChannel('content', { embed: { title: 'Test', color: 0x00ff00 } })

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string) as { embeds: unknown[] }
    expect(Array.isArray(body.embeds)).toBe(true)
    expect(body.embeds).toHaveLength(1)
  })

  it('throws when Discord returns non-ok status', async () => {
    const mockFetch = vi.mocked(fetch)
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => 'Bad Request',
    } as Response)

    await expect(postToChannel('fail')).rejects.toThrow('HTTP 400')
  })

  it('throws when Keychain lookup fails', async () => {
    mockSpawnSync.mockReturnValueOnce(makeSpawnResult('', 44))

    await expect(postToChannel('test')).rejects.toThrow('not found in Keychain')
  })
})
