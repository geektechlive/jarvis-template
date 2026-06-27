/**
 * Backend-aware single-shot inference dispatcher.
 *
 * Reads `backend` and `model` for a named role from harness/config/models.yaml
 * and routes to the appropriate provider:
 *
 *   backend: cli    → Claude CLI subprocess (runClaudeAgent)
 *   backend: apple  → on-device Apple Foundation Models (afmGenerate)
 *   backend: ollama → local Ollama REST API (ollamaOneShot)
 *
 * OpenRouter-backed roles now route through the engine via ctx.dispatchAgent /
 * ctx.llmCall, not a harness REST helper. A role configured with
 * backend: openrouter falls through to the cli default here.
 *
 * Use this for **pure inference** calls (no tool access needed).
 * Do NOT use it for agentic dispatches that rely on Claude CLI tools
 * (run_shell, read_file, memory MCP, etc.) — those go through runClaudeAgent
 * or dispatchAgent directly.
 */

import { log } from 'ion-sdk'
import { loadModelForRole, loadBackendForRole, loadFallbackForRole } from '../config'
import { runClaudeAgent } from './claudeAgent'
import { ollamaOneShot } from './ollamaChat'
import { afmGenerate } from './appleFoundation'

const DEFAULT_TIMEOUT_MS = 60_000

export interface ModelDispatchOpts {
  /** System prompt. For cli backend, prepended to the user prompt. */
  system?: string
  /** Per-call timeout in ms. Default 60 s. */
  timeoutMs?: number
  /** Optional abort signal — combined with internal timeout. */
  signal?: AbortSignal
  /** Sampling temperature. Default 0.2. Ignored by cli backend. */
  temperature?: number
}

interface ModelDispatchConfig {
  backend: string
  model: string
  timeoutMs: number
  temperature: number
  system: string
  signal: AbortSignal
}

/**
 * Resolve backend, model, timeout, temperature, and signal for a role + opts.
 * `defaultTemperature` differs between text (0.2) and JSON (0.1) dispatch, so
 * callers pass it explicitly to preserve existing behavior exactly.
 */
function loadModelDispatchConfig(
  role: string,
  opts: ModelDispatchOpts,
  defaultTemperature: number,
): ModelDispatchConfig {
  const backend = loadBackendForRole(role, 'cli')
  const model = loadModelForRole(role)
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const temperature = opts.temperature ?? defaultTemperature
  const system = opts.system ?? ''
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs)
  return { backend, model, timeoutMs, temperature, system, signal }
}

/**
 * Dispatch a text-generation call to one concrete backend (no fallback).
 * Extracted so both the primary backend and the apple-fallback path reuse it.
 */
async function dispatchText(
  backend: string,
  model: string,
  role: string,
  label: string,
  userPrompt: string,
  cfg: { timeoutMs: number; temperature: number; system: string; signal: AbortSignal; rawSignal?: AbortSignal },
): Promise<string> {
  if (backend === 'apple') {
    // afm takes a single prompt; prepend the system text like the cli path does.
    const prompt = cfg.system ? `${cfg.system}\n\n${userPrompt}` : userPrompt
    return afmGenerate(prompt, '', cfg.timeoutMs)
  }
  if (backend === 'ollama') {
    return ollamaOneShot(model, cfg.system, userPrompt, cfg.timeoutMs)
  }
  // Default: cli — Claude CLI subprocess via runClaudeAgent.
  const fullPrompt = cfg.system ? `${cfg.system}\n\n${userPrompt}` : userPrompt
  return runClaudeAgent(label, fullPrompt, { model, timeoutMs: cfg.timeoutMs, ...(cfg.rawSignal ? { signal: cfg.rawSignal } : {}) })
}

/**
 * Run a single inference call routed via the role's configured backend.
 * Returns the model's text response, or empty string on error.
 *
 * When the primary backend is the on-device `apple` backend and it is
 * unavailable, falls back to the role's fallback_backend (e.g. cli/haiku) so the
 * result is preserved rather than lost.
 */
export async function runModelForRole(
  role: string,
  label: string,
  userPrompt: string,
  opts: ModelDispatchOpts = {},
): Promise<string> {
  const { backend, model, timeoutMs, temperature, system, signal } = loadModelDispatchConfig(role, opts, 0.2)
  const cfg = { timeoutMs, temperature, system, signal, ...(opts.signal ? { rawSignal: opts.signal } : {}) }
  try {
    return await dispatchText(backend, model, role, label, userPrompt, cfg)
  } catch (err) {
    const fb = loadFallbackForRole(role)
    if (backend === 'apple' && fb.backend) {
      log.warn('modelDispatch: apple backend failed, falling back', { role, fallback: fb.backend, err: String(err) })
      return dispatchText(fb.backend, fb.model || model, role, label, userPrompt, cfg)
    }
    throw err
  }
}

/**
 * Like runModelForRole but parses the response as JSON.
 * For cli/ollama/apple, gets raw text and parses. Throws on parse failure.
 */
export async function runModelForRoleJson(
  role: string,
  label: string,
  userPrompt: string,
  opts: ModelDispatchOpts = {},
): Promise<unknown> {
  const { backend, model, timeoutMs, temperature, system, signal } = loadModelDispatchConfig(role, opts, 0.1)

  // For apple/cli/ollama, get raw text and parse. apple falls back to the role's
  // fallback backend on unavailability (reusing the text dispatcher).
  let raw: string
  const cfg = { timeoutMs, temperature, system, signal, ...(opts.signal ? { rawSignal: opts.signal } : {}) }
  if (backend === 'apple') {
    try {
      raw = await dispatchText(backend, model, role, label, userPrompt, cfg)
    } catch (err) {
      const fb = loadFallbackForRole(role)
      if (!fb.backend) throw err
      log.warn('modelDispatch(json): apple backend failed, falling back', { role, fallback: fb.backend, err: String(err) })
      raw = await dispatchText(fb.backend, fb.model || model, role, label, userPrompt, cfg)
    }
  } else if (backend === 'ollama') {
    raw = await ollamaOneShot(model, system, userPrompt, timeoutMs)
  } else {
    const fullPrompt = system ? `${system}\n\n${userPrompt}` : userPrompt
    raw = await runClaudeAgent(label, fullPrompt, { model, timeoutMs, ...(opts.signal ? { signal: opts.signal } : {}) })
  }

  // Strip markdown fences before parsing
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  // Try direct parse first; fall back to regex extraction
  try {
    return JSON.parse(cleaned)
  } catch {
    const match = /\{.*\}/s.exec(cleaned)?.[0]
    if (match) {
      try { return JSON.parse(match) } catch { /* fall through */ }
    }
    throw new Error(`${label}: could not parse JSON from ${backend} response: ${raw.slice(0, 200)}`)
  }
}
