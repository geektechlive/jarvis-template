import { describe, it, expect, vi, afterEach } from 'vitest'
import { ollamaOneShot } from './ollamaChat'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ollamaOneShot', () => {
  it('sends a correctly shaped request body', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message: { content: 'result text' } }),
    })
    vi.stubGlobal('fetch', mockFetch)

    await ollamaOneShot('llama3.1:8b', 'You are helpful.', 'What is 2+2?')

    expect(mockFetch).toHaveBeenCalledOnce()
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/chat')

    const body = JSON.parse(init.body as string) as {
      model: string
      messages: Array<{ role: string; content: string }>
      stream: boolean
    }
    expect(body.model).toBe('llama3.1:8b')
    expect(body.stream).toBe(false)
    expect(body.messages).toHaveLength(2)
    expect(body.messages[0]).toMatchObject({ role: 'system', content: 'You are helpful.' })
    expect(body.messages[1]).toMatchObject({ role: 'user', content: 'What is 2+2?' })
  })

  it('returns trimmed content from the response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message: { content: '  four  ' } }),
    }))

    const result = await ollamaOneShot('llama3.1:8b', 'sys', 'usr')
    expect(result).toBe('four')
  })

  it('throws on non-OK HTTP status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    }))

    await expect(ollamaOneShot('llama3.1:8b', 'sys', 'usr')).rejects.toThrow('Ollama 503')
  })

  it('returns empty string when response has no content', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message: {} }),
    }))

    const result = await ollamaOneShot('llama3.1:8b', 'sys', 'usr')
    expect(result).toBe('')
  })
})
