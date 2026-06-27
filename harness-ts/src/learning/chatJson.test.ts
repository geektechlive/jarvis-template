import { describe, it, expect, vi, beforeEach } from 'vitest'

// #855: the memory-correction classifier must honor NORMALIZE_BACKEND=cli (its
// production setting) and route through the Claude CLI subprocess rather than a
// direct Ollama fetch. shared.ts resolves the backend at import time from
// loadBackendForRole, so we mock config to return 'cli' before importing.

const { mockRunClaudeAgent } = vi.hoisted(() => ({
  mockRunClaudeAgent: vi.fn(),
}))

vi.mock('ion-sdk', () => ({
  log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

vi.mock('../config', () => ({
  OLLAMA_HOST: 'http://127.0.0.1:11434',
  loadModelForRole: vi.fn().mockReturnValue('claude-haiku-4-5-20251001'),
  loadBackendForRole: vi.fn().mockReturnValue('cli'),
  loadStaff: vi.fn().mockReturnValue([]),
}))

vi.mock('../util/claudeAgent', () => ({
  runClaudeAgent: mockRunClaudeAgent,
}))

import { normalizeChatJson } from './shared'

describe('normalizeChatJson cli routing (#855)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('routes through runClaudeAgent (not Ollama) when the normalize backend is cli', async () => {
    mockRunClaudeAgent.mockResolvedValue('{"is_correction": false, "contradicted": null, "corrected": null}')

    const result = await normalizeChatJson('SYSTEM', 'USER MESSAGE', 0)

    expect(mockRunClaudeAgent).toHaveBeenCalledOnce()
    const [label, prompt, opts] = mockRunClaudeAgent.mock.calls[0]!
    expect(label).toBe('normalizeChatJson')
    expect(prompt).toContain('SYSTEM')
    expect(prompt).toContain('USER MESSAGE')
    expect((opts as { model?: string }).model).toBe('claude-haiku-4-5-20251001')
    expect(result).toEqual({ is_correction: false, contradicted: null, corrected: null })
  })

  it('strips a prose prefix from the cli JSON response before parsing', async () => {
    // The CLI path has no format:json enforcement, so a model may prepend prose.
    mockRunClaudeAgent.mockResolvedValue('Here is the result: {"is_correction": true, "contradicted": "x", "corrected": "y"}')

    const result = await normalizeChatJson('SYSTEM', 'USER', 0)

    expect(result).toEqual({ is_correction: true, contradicted: 'x', corrected: 'y' })
  })

  it('throws a typed error when the cli response is not valid JSON', async () => {
    mockRunClaudeAgent.mockResolvedValue('not json at all')
    await expect(normalizeChatJson('SYSTEM', 'USER', 0)).rejects.toThrow(/invalid JSON/)
  })
})
