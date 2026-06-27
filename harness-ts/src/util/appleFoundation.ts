// Client for the on-device Apple Foundation Models service (tools-py/apple-foundation,
// issue #775). Free + offline inference. Both calls throw on unavailability so
// callers can fall back to their configured backup backend.

import { AFM_SERVER } from '../config/endpoints'

export interface AfmProperty {
  name: string
  type: 'string' | 'string[]' | 'number' | 'boolean'
  description?: string
  enum?: string[]
}

export interface AfmSchema {
  properties: AfmProperty[]
}

async function afmPost(path: string, body: Record<string, unknown>, timeoutMs: number): Promise<string> {
  const res = await fetch(`${AFM_SERVER}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`afm ${res.status}`)
  const data = (await res.json()) as { ok?: boolean; content?: string; error?: string }
  if (!data.ok) throw new Error(`afm unavailable: ${data.error ?? 'unknown'}`)
  return data.content ?? ''
}

// Plain text generation.
export async function afmGenerate(prompt: string, instructions = '', timeoutMs = 30_000): Promise<string> {
  return afmPost('/generate', { prompt, instructions }, timeoutMs)
}

// Guided/typed generation. Returns the structured result as a JSON STRING the
// caller parses (the afm service constructs a runtime DynamicGenerationSchema).
export async function afmGenerateTyped(
  prompt: string,
  schema: AfmSchema,
  instructions = '',
  timeoutMs = 30_000,
): Promise<string> {
  return afmPost('/generate_typed', { prompt, schema, instructions }, timeoutMs)
}
