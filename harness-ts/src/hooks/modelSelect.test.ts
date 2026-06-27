import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IonContext } from 'ion-sdk'

// Mock the log module
vi.mock('ion-sdk', () => ({
  log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

// Mock the episodic module
vi.mock('../memory/episodic', () => ({
  logEvent: vi.fn(() => Promise.resolve()),
}))

let tmpDir: string
let originalHarnessDir: string | undefined

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'model-select-'))
  originalHarnessDir = process.env['JARVIS_DIR']
  process.env['JARVIS_DIR'] = tmpDir
  vi.resetModules()
})

afterEach(() => {
  if (originalHarnessDir) {
    process.env['JARVIS_DIR'] = originalHarnessDir
  } else {
    delete process.env['JARVIS_DIR']
  }
  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    /* Windows may hold lock briefly */
  }
})

function createHarnessConfig(modelsYaml: string): void {
  const harness = join(tmpDir, 'harness', 'config')
  const fs = require('node:fs')
  fs.mkdirSync(harness, { recursive: true })
  fs.writeFileSync(join(harness, 'models.yaml'), modelsYaml, 'utf8')
}

function createMockContext(): IonContext {
  return {
    sessionKey: 'test-session',
    conversationId: '',
    cwd: tmpDir,
    model: { id: 'test-model', contextWindow: 8192 },
    config: {
      extensionDir: tmpDir,
      model: 'test-model',
      workingDirectory: tmpDir,
    },
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
    notify: vi.fn(),
    intercept: vi.fn(),
    sessions: { list: vi.fn(), send: vi.fn() },
    runOnce: vi.fn(),
    resources: { declare: vi.fn(), onQuery: vi.fn() },
  }
}

describe('modelSelect', () => {
  describe('model guard: non-Claude models blocked', () => {
    // The interactive model guard forces ANY non-Claude model to Sonnet/CLI,
    // including provider-namespaced OpenRouter IDs. model_select is interactive-
    // only; dispatched staff/utility roles never pass through it, so this does
    // not affect their OpenRouter models. (Fix for the main-session gpt-4o-mini
    // pin: a persisted conversation model re-seeds every turn and must not stick.)
    it('blocks bare gemini-2.5-pro and overrides to claude-sonnet-4-6', async () => {
      const { handleModelSelect } = await import('./modelSelect')
      const ctx = createMockContext()
      const info = { requestedModel: 'gemini-2.5-pro' }

      const result = handleModelSelect(ctx, info)

      expect(result).toBe('claude-sonnet-4-6')
      // #833: the first block of a session is treated as the benign cold-start
      // re-seed, so the user-facing notify is suppressed (see dedicated test below).
      expect(ctx.emit).not.toHaveBeenCalled()
    })

    it('blocks bare llama-4-maverick', async () => {
      const { handleModelSelect } = await import('./modelSelect')
      const ctx = createMockContext()
      const info = { requestedModel: 'llama-4-maverick' }

      const result = handleModelSelect(ctx, info)

      expect(result).toBe('claude-sonnet-4-6')
    })

    it('blocks bare gpt-4o', async () => {
      const { handleModelSelect } = await import('./modelSelect')
      const ctx = createMockContext()
      const info = { requestedModel: 'gpt-4o' }

      const result = handleModelSelect(ctx, info)

      expect(result).toBe('claude-sonnet-4-6')
    })

    it('logs model_guard_block event for blocked models', async () => {
      const { logEvent } = await import('../memory/episodic')
      const { handleModelSelect } = await import('./modelSelect')
      const ctx = createMockContext()

      handleModelSelect(ctx, { requestedModel: 'gemini-2.5-flash' })

      expect(logEvent).toHaveBeenCalledWith(
        'test-session',
        'model_guard_block',
        expect.objectContaining({ blocked: 'gemini-2.5-flash', override: 'claude-sonnet-4-6' }),
      )
    })

    it('overrides provider-namespaced OpenRouter IDs to Claude (interactive guard)', async () => {
      const { handleModelSelect } = await import('./modelSelect')
      const ctx = createMockContext()

      expect(handleModelSelect(ctx, { requestedModel: 'google/gemini-2.5-flash-lite' })).toBe('claude-sonnet-4-6')
      expect(handleModelSelect(ctx, { requestedModel: 'openai/gpt-4o' })).toBe('claude-sonnet-4-6')
      expect(handleModelSelect(ctx, { requestedModel: 'meta-llama/llama-4-maverick' })).toBe('claude-sonnet-4-6')
    })

    it('overrides the persisted openai/gpt-4o-mini pin to Sonnet (regression: main-session pin)', async () => {
      const { handleModelSelect } = await import('./modelSelect')
      const ctx = createMockContext()

      expect(handleModelSelect(ctx, { requestedModel: 'openai/gpt-4o-mini' })).toBe('claude-sonnet-4-6')
      // #833: this IS the cold-start re-seed pin — the spurious user notify is suppressed.
      expect(ctx.emit).not.toHaveBeenCalled()
    })

    it('suppresses the guard notify on the cold-start re-seed but surfaces a repeat in-session block (#833)', async () => {
      const { handleModelSelect } = await import('./modelSelect')
      const ctx = createMockContext()

      // First block = benign cold-start re-seed: no user-facing notify.
      handleModelSelect(ctx, { requestedModel: 'openai/gpt-4o-mini' })
      expect(ctx.emit).not.toHaveBeenCalled()

      // Second block in the same session = genuine new attempt: surfaces to the user.
      handleModelSelect(ctx, { requestedModel: 'gemini-2.5-pro' })
      expect(ctx.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'engine_notify', level: 'warn' }))
    })

    it('does NOT block the default Claude model (claude-haiku) — guard keys on the claude- prefix', async () => {
      const { handleModelSelect } = await import('./modelSelect')
      const ctx = createMockContext()

      // Must not return SONNET_FALLBACK; a typo'd DEFAULT_MODEL constant would
      // otherwise be silently force-upgraded to Sonnet on every turn.
      expect(handleModelSelect(ctx, { requestedModel: 'claude-haiku-4-5-20251001' })).toBeUndefined()
    })
  })

  describe('explicit non-default model passthrough', () => {
    it('passes through when claude-sonnet-4-6 is explicitly requested', async () => {
      const { handleModelSelect } = await import('./modelSelect')
      const ctx = createMockContext()
      const info = { requestedModel: 'claude-sonnet-4-6' }

      const result = handleModelSelect(ctx, info)

      expect(result).toBeUndefined()
    })

    it('passes through for any non-default Claude model', async () => {
      const { handleModelSelect } = await import('./modelSelect')
      const ctx = createMockContext()
      const info = { requestedModel: 'claude-opus-4-100k-20250514' }

      const result = handleModelSelect(ctx, info)

      expect(result).toBeUndefined()
    })
  })

  describe('default model routing', () => {
    it('passes through when default model has no routing config', async () => {
      createHarnessConfig(`
default:
  backend: ollama
  model: gemma3:27b
`)
      const { handleModelSelect } = await import('./modelSelect')
      const ctx = createMockContext()
      const info = { requestedModel: 'claude-haiku-4-5-20251001' }

      const result = handleModelSelect(ctx, info)

      expect(result).toBeUndefined()
    })

    it('passes through when routing config is incomplete', async () => {
      createHarnessConfig(`
routing:
  default_model: claude-haiku-4-5-20251001

default:
  backend: ollama
  model: gemma3:27b
`)
      const { handleModelSelect } = await import('./modelSelect')
      const ctx = createMockContext()
      const info = { requestedModel: 'claude-haiku-4-5-20251001' }

      const result = handleModelSelect(ctx, info)

      expect(result).toBeUndefined()
    })
  })

  describe('rule caching', () => {
    it('caches rules within 60s TTL', async () => {
      createHarnessConfig(`
routing:
  default_model: claude-haiku-4-5-20251001
  upgrade_on_length_chars: 3000
  upgrade_target: claude-sonnet-4-6
`)
      const { handleModelSelect, loadModelRoutingRules } = await import('./modelSelect')

      const ctx = createMockContext()
      const info = { requestedModel: 'claude-haiku-4-5-20251001' }

      // First call loads from disk
      loadModelRoutingRules()
      // This should use cache
      const result = handleModelSelect(ctx, info)

      expect(result).toBeUndefined()
    })
  })

  describe('missing models.yaml', () => {
    it('gracefully falls back to defaults when file missing', async () => {
      // tmpDir has no harness/config directory
      const { handleModelSelect } = await import('./modelSelect')
      const ctx = createMockContext()
      const info = { requestedModel: 'claude-haiku-4-5-20251001' }

      const result = handleModelSelect(ctx, info)

      // Should passthrough gracefully (rules incomplete, no upgrade_target)
      expect(result).toBeUndefined()
    })
  })

  describe('yaml parsing', () => {
    it('parses routing rules with upgrade_keywords array', async () => {
      createHarnessConfig(`
routing:
  default_model: claude-haiku-4-5-20251001
  upgrade_on_length_chars: 2000
  upgrade_keywords:
    - review
    - analyze
    - design
  upgrade_target: claude-sonnet-4-6

default:
  backend: ollama
  model: gemma3:27b
`)
      const { loadModelRoutingRules } = await import('./modelSelect')
      const rules = loadModelRoutingRules()

      expect(rules.defaultModel).toBe('claude-haiku-4-5-20251001')
      expect(rules.upgradeOnLengthChars).toBe(2000)
      expect(rules.upgradeTarget).toBe('claude-sonnet-4-6')
      expect(rules.upgradeKeywords).toEqual(['review', 'analyze', 'design'])
    })

    it('handles routing section at end of file', async () => {
      createHarnessConfig(`
default:
  backend: ollama
  model: gemma3:27b

router:
  backend: ollama
  model: qwen2.5:14b

routing:
  default_model: claude-haiku-4-5-20251001
  upgrade_on_length_chars: 1500
  upgrade_target: claude-sonnet-4-6
`)
      const { loadModelRoutingRules } = await import('./modelSelect')
      const rules = loadModelRoutingRules()

      expect(rules.upgradeOnLengthChars).toBe(1500)
    })

    it('extracts multiple upgrade_keywords correctly', async () => {
      createHarnessConfig(`
routing:
  default_model: claude-haiku-4-5-20251001
  upgrade_target: claude-sonnet-4-6
  upgrade_keywords:
    - review
    - analyze
    - design
    - panel
    - architecture
    - tradeoff
`)
      const { loadModelRoutingRules } = await import('./modelSelect')
      const rules = loadModelRoutingRules()

      expect(rules.upgradeKeywords).toHaveLength(6)
      expect(rules.upgradeKeywords).toContain('review')
      expect(rules.upgradeKeywords).toContain('tradeoff')
    })
  })

  describe('event logging', () => {
    it('does not emit model_select_decision on passthrough (#733)', async () => {
      const { logEvent } = await import('../memory/episodic')
      createHarnessConfig(`
routing:
  default_model: claude-haiku-4-5-20251001
  upgrade_target: claude-sonnet-4-6
`)
      const { handleModelSelect } = await import('./modelSelect')
      const ctx = createMockContext()
      const info = { requestedModel: 'claude-haiku-4-5-20251001' }

      const result = handleModelSelect(ctx, info)

      expect(result).toBeUndefined()
      expect(logEvent).not.toHaveBeenCalledWith(
        'test-session',
        'model_select_decision',
        expect.anything(),
      )
    })
  })
})
