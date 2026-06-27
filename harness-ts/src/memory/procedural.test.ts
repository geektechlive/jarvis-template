import { describe, it, expect, vi, beforeEach } from 'vitest'

const {
  mockRemember,
  mockGetRecentMessages,
  mockCountToolCalls,
  mockIsAllowedHost,
} = vi.hoisted(() => ({
  mockRemember: vi.fn().mockResolvedValue('proc-doc-id'),
  mockGetRecentMessages: vi.fn().mockReturnValue([]),
  mockCountToolCalls: vi.fn().mockReturnValue(0),
  mockIsAllowedHost: vi.fn().mockReturnValue(true),
}))

vi.mock('ion-sdk', () => ({
  log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

vi.mock('../config', () => ({
  OLLAMA_HOST: 'http://127.0.0.1:11434',
  isAllowedHost: mockIsAllowedHost,
  loadModelForRole: vi.fn().mockReturnValue('qwen2.5-coder:14b'),
}))

vi.mock('./episodic', () => ({
  getRecentMessages: mockGetRecentMessages,
}))

vi.mock('./recall', () => ({
  remember: mockRemember,
}))

vi.mock('../hooks/sessionLifecycle', () => ({
  countToolCalls: mockCountToolCalls,
}))

import { extractProcedure } from './procedural'

const SESSION = 'test-session'

const VALID_PROCEDURE = JSON.stringify({
  title: 'Deploy TypeScript extension to Mini',
  trigger_conditions: ['harness-ts changes', 'extension update needed'],
  steps: ['run npm run build', 'scp to mini', 'restart launchd'],
  tools_used: ['run_shell', 'read_file'],
})

function makeOllamaResponse(content: string): Response {
  return new Response(
    JSON.stringify({ message: { content } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

describe('extractProcedure', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsAllowedHost.mockReturnValue(true)
    mockRemember.mockResolvedValue('proc-doc-id')
    globalThis.fetch = vi.fn().mockResolvedValue(makeOllamaResponse(VALID_PROCEDURE))
  })

  it('returns without calling Ollama when tool call count < 5', async () => {
    mockCountToolCalls.mockReturnValue(4)
    await extractProcedure(SESSION)
    expect(globalThis.fetch).not.toHaveBeenCalled()
    expect(mockRemember).not.toHaveBeenCalled()
  })

  it('returns without calling Ollama when tool call count is exactly 0', async () => {
    mockCountToolCalls.mockReturnValue(0)
    await extractProcedure(SESSION)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('calls Ollama when tool call count >= 5', async () => {
    mockCountToolCalls.mockReturnValue(5)
    await extractProcedure(SESSION)
    expect(globalThis.fetch).toHaveBeenCalledOnce()
    const [url, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:11434/api/chat')
    const body = JSON.parse(opts.body as string) as { model: string; options: { temperature: number } }
    expect(body.model).toBe('qwen2.5-coder:14b')
    expect(body.options.temperature).toBe(0.2)
  })

  it('calls Ollama when tool call count > 5', async () => {
    mockCountToolCalls.mockReturnValue(10)
    await extractProcedure(SESSION)
    expect(globalThis.fetch).toHaveBeenCalledOnce()
  })

  it('calls remember with procedural collection on valid JSON response', async () => {
    mockCountToolCalls.mockReturnValue(6)
    await extractProcedure(SESSION)
    expect(mockRemember).toHaveBeenCalledOnce()
    const [text, collection, source, sourceActor] = mockRemember.mock.calls[0] as [string, string, string, string]
    expect(collection).toBe('procedural')
    expect(source).toBe('session_extraction')
    expect(sourceActor).toBe('jarvis_ts')
    expect(text).toContain('Title: Deploy TypeScript extension to Mini')
    expect(text).toContain('Steps:')
    expect(text).toContain('Tools used:')
  })

  it('does NOT call remember on invalid JSON response', async () => {
    mockCountToolCalls.mockReturnValue(5)
    globalThis.fetch = vi.fn().mockResolvedValue(makeOllamaResponse('not valid json at all'))
    await extractProcedure(SESSION)
    expect(mockRemember).not.toHaveBeenCalled()
  })

  it('does not throw on invalid JSON response', async () => {
    mockCountToolCalls.mockReturnValue(5)
    globalThis.fetch = vi.fn().mockResolvedValue(makeOllamaResponse('{bad json'))
    await expect(extractProcedure(SESSION)).resolves.toBeUndefined()
  })

  it('does not throw on JSON with wrong shape', async () => {
    mockCountToolCalls.mockReturnValue(5)
    globalThis.fetch = vi.fn().mockResolvedValue(makeOllamaResponse('{"title": 42}'))
    await expect(extractProcedure(SESSION)).resolves.toBeUndefined()
    expect(mockRemember).not.toHaveBeenCalled()
  })

  it('does not throw when Ollama returns a non-ok status', async () => {
    mockCountToolCalls.mockReturnValue(5)
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 500 }))
    await expect(extractProcedure(SESSION)).resolves.toBeUndefined()
    expect(mockRemember).not.toHaveBeenCalled()
  })

  it('does not throw when fetch rejects', async () => {
    mockCountToolCalls.mockReturnValue(5)
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network error'))
    await expect(extractProcedure(SESSION)).resolves.toBeUndefined()
    expect(mockRemember).not.toHaveBeenCalled()
  })
})
