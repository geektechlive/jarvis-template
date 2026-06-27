// Banned-token audit. Checks a reply string for persona violations.
// Phase 0 finding #3: message_update does not fire in current ion, so
// reply content is not available in turn_end. This module is called from
// before_provider_request if it carries reply history, otherwise it is used
// to enforce constraints via the system prompt only (Option B).
// Decision: Option B (system-prompt-only enforcement) is the baseline until
// before_provider_request is confirmed to carry the last assistant turn.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { load } from 'js-yaml'

let BANNED_TOKENS = ['!', '—']
let BANNED_PHRASES = [
  'certainly',
  'of course',
  'great question',
  'happy to help',
  "let's dive in",
  "let's get started",
  'as an AI',
  'I think maybe',
  'perhaps maybe',
  'absolutely',
  'sure thing',
]

try {
  const yamlPath = resolve(__dirname, '../../../harness/config/persona.yaml')
  const parsed = load(readFileSync(yamlPath, 'utf8')) as {
    banned_tokens?: string[]
    banned_phrases?: string[]
  }
  if (parsed.banned_tokens && parsed.banned_tokens.length > 0) {
    BANNED_TOKENS = parsed.banned_tokens
  }
  if (parsed.banned_phrases && parsed.banned_phrases.length > 0) {
    BANNED_PHRASES = parsed.banned_phrases
  }
} catch {
  // fall back to hardcoded defaults
}

export interface AuditResult {
  passed: boolean
  violations: string[]
}

export function auditReply(reply: string): AuditResult {
  const violations: string[] = []
  const lower = reply.toLowerCase()

  for (const token of BANNED_TOKENS) {
    if (reply.includes(token)) violations.push(`banned token: "${token}"`)
  }
  for (const phrase of BANNED_PHRASES) {
    if (lower.includes(phrase.toLowerCase())) violations.push(`banned phrase: "${phrase}"`)
  }

  return { passed: violations.length === 0, violations }
}

// Returns a system-prompt addendum that instructs the model to self-enforce
// banned tokens. Used as Option B when reply content is unavailable.
export function bannedTokenEnforcement(): string {
  // Replace the literal em dash with a Unicode code point reference to avoid
  // embedding the banned character in the system prompt (which can reinforce it).
  const tokenList = BANNED_TOKENS.map((t) => t === '—' ? 'em dash (U+2014)' : `"${t}"`).join(', ')
  const phraseList = BANNED_PHRASES.map((p) => `"${p}"`).join(', ')
  return `\n\n## Hard constraints\n\nNever use these tokens: ${tokenList}\nNever use these phrases: ${phraseList}\n`
}
