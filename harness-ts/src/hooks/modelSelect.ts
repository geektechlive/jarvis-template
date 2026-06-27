// model_select hook: intelligent model routing based on intent and config rules.
// Fires on every prompt to allow upstream model override (e.g., via /cloud command).

import type { IonContext, ModelSelectInfo } from 'ion-sdk'
import { log } from 'ion-sdk'
import { HARNESS_DIR } from '../config'
import { logEvent } from '../memory/episodic'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Default model — matches claudeAgent.ts
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001'

// Fallback used by the model guard when a non-Claude model is rejected.
const SONNET_FALLBACK = 'claude-sonnet-4-6'

// Cached routing rules with TTL
interface ModelRoutingRules {
  defaultModel: string
  upgradeOnLengthChars?: number
  upgradeKeywords?: string[]
  upgradeTarget?: string
}

let _rulesCache: { ts: number; rules: ModelRoutingRules } | null = null
const RULES_CACHE_TTL_MS = 60_000

// #833: the persisted main-session conversation header re-seeds a stale non-Claude
// pin (e.g. "openai/gpt-4o-mini") on every cold start, so the guard fires once per
// restart. That first block is benign — we correct it to Sonnet and turn 1 persists
// Sonnet. Track which sessions have already had their (benign) first block so we can
// suppress the spurious user-facing notify for the cold-start re-seed while still
// logging + recording it. A SECOND block in the same session is a genuine new
// attempt and DOES surface to the user.
const _guardBlockedSessions = new Set<string>()

/**
 * Load the [routing] section from harness/config/models.yaml.
 * Returns cached copy within 60s TTL to avoid frequent disk reads.
 */
function loadModelRoutingRules(): ModelRoutingRules {
  const now = Date.now()
  if (_rulesCache && now - _rulesCache.ts < RULES_CACHE_TTL_MS) {
    return _rulesCache.rules
  }

  const rules: ModelRoutingRules = {
    defaultModel: DEFAULT_MODEL,
  }

  try {
    const content = readFileSync(join(HARNESS_DIR, 'harness/config/models.yaml'), 'utf8')
    let inRouting = false

    for (const line of content.split('\n')) {
      if (/^routing:\s*$/.test(line)) {
        inRouting = true
        continue
      }

      if (inRouting) {
        // Exit routing section when we hit a new top-level key (non-indented)
        if (/^\S/.test(line)) {
          break
        }

        // Parse routing keys (indented)
        const match = /^\s+(\w+):\s*(.+)/.exec(line)
        if (!match) continue

        const key = match[1]
        const val = match[2]?.trim() ?? ''

        switch (key) {
          case 'default_model':
            rules.defaultModel = val
            break
          case 'upgrade_on_length_chars':
            rules.upgradeOnLengthChars = parseInt(val, 10) || 2000
            break
          case 'upgrade_target':
            rules.upgradeTarget = val
            break
          case 'upgrade_keywords':
            // Skip the array key itself; actual keywords come on following lines
            break
        }
      }
    }

    // Parse upgrade_keywords array separately (multi-line list)
    const keywordMatches = content.match(/upgrade_keywords:\s*\n((?:\s+- .+\n)*)/m)
    if (keywordMatches?.[1]) {
      const keywords: string[] = []
      for (const line of keywordMatches[1].split('\n')) {
        const kw = /^\s+- (.+)/.exec(line)?.[1]?.trim()
        if (kw) keywords.push(kw.toLowerCase())
      }
      if (keywords.length > 0) {
        rules.upgradeKeywords = keywords
      }
    }
  } catch (err: unknown) {
    log.warn('modelSelect: failed to load routing rules', { err: String(err) })
  }

  _rulesCache = { ts: now, rules }
  return rules
}

/**
 * Handle the model_select hook. If requestedModel is the default (Haiku),
 * apply our routing rules. Otherwise pass through unchanged.
 *
 * Returns undefined to pass through, or a model string to override.
 */
export function handleModelSelect(ctx: IonContext, info: ModelSelectInfo): string | undefined {
  const requested = info.requestedModel

  // Model guard: the interactive Jarvis session MUST run a Claude model (CLI
  // backend). Jarvis's routing, persona, and staff delegation are all tuned for
  // Claude's instruction-following behavior; non-Claude models (Gemini, GPT,
  // Llama, etc.) have diverged dramatically in practice — the Gemini loop
  // incident (57 runaway Agent calls at ~1.3s/turn) is the canonical example.
  //
  // ANY non-Claude model is overridden to Sonnet/CLI, including provider-
  // namespaced OpenRouter IDs (e.g. "openai/gpt-4o-mini"). This neutralizes the
  // main-session pin: the engine re-seeds the persisted conversation model on
  // every cold start (prompt_dispatch.go:178-180) and overrides the Sonnet
  // default with it BEFORE this guard fires (at :224). The guard then corrects
  // it to Sonnet, and turn 1 persists s.lastModel=Sonnet (:263) so turns 2+ in
  // the same session skip the re-seed. NOTE: this does NOT rewrite the stale
  // .llm.jsonl conversation header (CliBackend does not mutate conv.Model), so
  // the guard re-fires once per cold start (one model_guard_block per restart)
  // until the conversation rolls over or its header is reset.
  // model_select fires ONLY for interactive sessions (verified: 0 dispatched-
  // child firings; the engine calls fireModelSelect only on the main SendPrompt
  // path, prompt_dispatch.go:224). Dispatched staff get their model from the
  // spawner/roster and never pass through here, so this does NOT affect staff
  // or OpenRouter-backed utility roles (code/improve/procedural/graphiti).
  if (requested && !requested.startsWith('claude-')) {
    log.warn('modelSelect: non-Claude model blocked by guard', { requested, override: SONNET_FALLBACK })
    // First block of the session is the benign cold-start re-seed (#833): suppress
    // the user-facing notify but still record it. Surface only on a repeat attempt.
    const coldStartReseed = !_guardBlockedSessions.has(ctx.sessionKey)
    _guardBlockedSessions.add(ctx.sessionKey)
    try {
      if (!coldStartReseed) {
        ctx.emit({
          type: 'engine_notify',
          message: `Model guard: "${requested}" is not allowed. Jarvis requires a Claude model. Using ${SONNET_FALLBACK}.`,
          level: 'warn',
        })
      }
      logEvent(ctx.sessionKey, 'model_guard_block', { blocked: requested, override: SONNET_FALLBACK, cold_start_reseed: coldStartReseed })
    } catch (err: unknown) {
      log.warn('modelSelect: failed to emit model guard event', { err: String(err) })
    }
    return SONNET_FALLBACK
  }

  // If an explicit Claude model was requested (not the Haiku default), respect it.
  // Explicit dispatch calls with model: 'claude-sonnet-4-6' should not be overridden.
  if (requested && requested !== DEFAULT_MODEL) {
    log.debug('modelSelect: explicit Claude override requested', {
      from: DEFAULT_MODEL,
      to: requested,
    })
    return undefined // return undefined = no change
  }

  const rules = loadModelRoutingRules()

  // Fallback for misconfigured models.yaml (if routing section is missing or broken)
  if (!rules.defaultModel || !rules.upgradeTarget) {
    log.debug('modelSelect: routing rules incomplete, passthrough', {
      rules,
    })
    return undefined
  }

  // NOTE: v1 limitation — ModelSelectInfo does not expose the current user prompt.
  // We cannot implement keyword-based routing without adding context to the hook payload.
  // Implement length-based and length-threshold passthrough only.

  // No routing signal available — pass through. No audit event emitted;
  // absence of model_select_decision is the signal. (#733)
  log.debug('modelSelect: passthrough (no prompt access in v1)', {
    requested,
    availableModels: info.availableModels,
  })

  return undefined
}

// Export the rules loader for testing
export { loadModelRoutingRules }
