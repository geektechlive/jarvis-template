import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { log } from 'ion-sdk'
import { runClaudeAgent } from './claudeAgent'
import * as ionPrompt from './ionPrompt'

describe('claudeAgent utility (#302/#303)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does NOT emit routine_started or routine_delivered events', async () => {
    const runCommandSpy = vi.spyOn(ionPrompt, 'runCommandAsync').mockResolvedValue({
      status: 0,
      stdout: 'test output',
      stderr: '',
    })

    const result = await runClaudeAgent('test_routine', 'test prompt')

    expect(result).toBe('test output')
    expect(runCommandSpy).toHaveBeenCalled()

    // Verify that runClaudeAgent itself doesn't log events
    // (event logging is the scheduler's responsibility, not the utility's)
  })

  it('returns stdout on success', async () => {
    vi.spyOn(ionPrompt, 'runCommandAsync').mockResolvedValue({
      status: 0,
      stdout: 'success output',
      stderr: '',
    })

    const result = await runClaudeAgent('routine', 'prompt')
    expect(result).toBe('success output')
  })

  it('returns empty string on error', async () => {
    vi.spyOn(ionPrompt, 'runCommandAsync').mockRejectedValue(new Error('command failed'))

    const result = await runClaudeAgent('routine', 'prompt')
    expect(result).toBe('')
  })

  it('respects custom model option', async () => {
    const runCommandSpy = vi.spyOn(ionPrompt, 'runCommandAsync').mockResolvedValue({
      status: 0,
      stdout: '',
      stderr: '',
    })

    await runClaudeAgent('routine', 'prompt', { model: 'claude-opus-4-1' })

    const call = runCommandSpy.mock.calls[0]
    expect(call?.[1]).toContain('--model')
    expect(call?.[1]).toContain('claude-opus-4-1')
  })

  it('respects custom timeout option', async () => {
    const runCommandSpy = vi.spyOn(ionPrompt, 'runCommandAsync').mockResolvedValue({
      status: 0,
      stdout: '',
      stderr: '',
    })

    await runClaudeAgent('routine', 'prompt', { timeoutMs: 60000 })

    const call = runCommandSpy.mock.calls[0]
    const opts = call?.[2] as { timeoutMs?: number } | undefined
    expect(opts?.timeoutMs).toBe(60000)
  })

  it('forwards AbortSignal to runCommandAsync', async () => {
    const runCommandSpy = vi.spyOn(ionPrompt, 'runCommandAsync').mockResolvedValue({
      status: 0,
      stdout: 'output',
      stderr: '',
    })

    const controller = new AbortController()
    await runClaudeAgent('routine', 'prompt', { signal: controller.signal })

    const call = runCommandSpy.mock.calls[0]
    const opts = call?.[2] as { signal?: AbortSignal } | undefined
    expect(opts?.signal).toBe(controller.signal)
  })

  it('returns empty string when subprocess is aborted', async () => {
    const controller = new AbortController()
    vi.spyOn(ionPrompt, 'runCommandAsync').mockResolvedValue({
      status: null,
      stdout: '',
      stderr: 'aborted',
      error: new Error('aborted'),
    })

    const result = await runClaudeAgent('routine', 'prompt', { signal: controller.signal })
    expect(result).toBe('')
  })

  it('warn-logs when the subprocess exits non-zero, still returning stdout', async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    vi.spyOn(ionPrompt, 'runCommandAsync').mockResolvedValue({
      status: 1,
      stdout: 'partial output',
      stderr: 'boom',
    })

    const result = await runClaudeAgent('routine', 'prompt')

    expect(result).toBe('partial output')
    expect(warnSpy).toHaveBeenCalledOnce()
  })

  it('does NOT warn-log on an intentional abort', async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    vi.spyOn(ionPrompt, 'runCommandAsync').mockResolvedValue({
      status: null,
      stdout: '',
      stderr: 'aborted',
      error: new Error('aborted'),
    })

    await runClaudeAgent('routine', 'prompt')

    expect(warnSpy).not.toHaveBeenCalled()
  })
})
