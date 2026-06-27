// Shared guard for non-empty task/prompt strings at dispatchAgent call sites.
// Returns false (and logs) when the value is empty or whitespace-only.
// Each call site decides whether to throw or return after checking the result.

import { log } from 'ion-sdk'

/**
 * Validates that `prompt` is a non-empty, non-whitespace string.
 * Logs a warning with `context` prepended when validation fails.
 * Returns `true` when the prompt is valid, `false` otherwise.
 */
export function validateTaskPrompt(prompt: string | undefined, context: string): boolean {
  if (!prompt?.trim()) {
    log.warn(`${context}: skipping dispatch - empty task`)
    return false
  }
  return true
}
