// Procedural memory -- auto-extracts "how I solved this" summaries after
// tool-heavy sessions and stores them in the 'procedural' ChromaDB collection.
//
// extractProcedure() is called from session_end when toolHeavy=true.
// On the next session start, recallMeta(prompt, 'procedural', 3) surfaces
// matching procedures so Jarvis can recognise familiar task patterns.

import { log } from 'ion-sdk'
import type { IonContext } from 'ion-sdk'
import { OLLAMA_HOST, isAllowedHost, loadModelForRole } from '../config'
import { getRecentMessages } from './episodic'
import { remember } from './recall'
import { countToolCalls } from '../hooks/sessionLifecycle'

const PROCEDURAL_MODEL = loadModelForRole('procedural', 'qwen2.5-coder:14b')
const TIMEOUT_MS = 120_000
const MIN_TOOL_CALLS = 5

interface ExtractedProcedure {
  title: string
  trigger_conditions: string[]
  steps: string[]
  tools_used: string[]
}

function formatMessages(messages: Array<{ role: string; content: string }>): string {
  return messages
    .map((m) => `[${m.role}]: ${m.content.slice(0, 500)}`)
    .join('\n')
}

function formatProcedure(p: ExtractedProcedure): string {
  const steps = p.steps.map((s, i) => `${i + 1}. ${s}`).join(' ')
  return [
    `Title: ${p.title}`,
    `Trigger conditions: ${p.trigger_conditions.join(', ')}`,
    `Steps: ${steps}`,
    `Tools used: ${p.tools_used.join(', ')}`,
  ].join('\n')
}

function extractJson(text: string): Record<string, unknown> | null {
  const matched = /\{[\s\S]*\}/s.exec(text)?.[0]
  if (!matched) return null
  try {
    return JSON.parse(matched) as Record<string, unknown>
  } catch {
    return null
  }
}

export async function extractProcedure(sessionKey: string, ctx?: IonContext | null): Promise<void> {
  const messages = getRecentMessages(sessionKey, 30)
  const toolCallCount = countToolCalls(messages)

  if (toolCallCount < MIN_TOOL_CALLS) {
    log.debug('procedural: skipping extraction (tool calls below threshold)', {
      session: sessionKey,
      toolCallCount,
      threshold: MIN_TOOL_CALLS,
    })
    return
  }

  if (!isAllowedHost(OLLAMA_HOST)) {
    log.warn('procedural: OLLAMA_HOST not in allowed range; skipping extraction')
    return
  }

  const formattedMessages = formatMessages(messages)
  const userPrompt = `You are extracting a reusable procedure from a conversation session.

Session messages:
${formattedMessages}

Extract a JSON object describing the procedure used. Output ONLY valid JSON, no markdown fences:
{
  "title": "short imperative phrase (max 8 words)",
  "trigger_conditions": ["condition1", "condition2"],
  "steps": ["step1", "step2", "step3"],
  "tools_used": ["tool1", "tool2"]
}`

  if (!userPrompt?.trim()) {
    log.warn('procedural: skipping extraction — empty prompt', { session: sessionKey })
    return
  }

  let raw = ''
  if (ctx) {
    try {
      const r = await ctx.dispatchAgent({ name: 'procedural-extractor', task: userPrompt, model: PROCEDURAL_MODEL, maxTurns: 1 })
      raw = r.output.trim()
    } catch (err) {
      log.warn('procedural: dispatchAgent failed', { session: sessionKey, err: String(err) })
      return
    }
  } else {
    try {
      const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: PROCEDURAL_MODEL,
          messages: [
            { role: 'user', content: userPrompt },
          ],
          stream: false,
          options: { num_ctx: 8192, temperature: 0.2 },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!res.ok) throw new Error(`Ollama ${res.status}`)
      const data = (await res.json()) as { message?: { content?: string } }
      raw = data.message?.content ?? ''
    } catch (err) {
      log.warn('procedural: Ollama call failed', { session: sessionKey, err: String(err) })
      return
    }
  }

  let procedure: ExtractedProcedure
  try {
    const parsed = extractJson(raw)
    if (!parsed) throw new Error('no JSON found in output')
    procedure = parsed as unknown as ExtractedProcedure
    if (
      typeof procedure.title !== 'string' ||
      !Array.isArray(procedure.trigger_conditions) ||
      !Array.isArray(procedure.steps) ||
      !Array.isArray(procedure.tools_used)
    ) {
      throw new Error('unexpected shape')
    }
  } catch (err) {
    log.warn('procedural: JSON parse failed; skipping store', {
      session: sessionKey,
      err: String(err),
      raw: raw.slice(0, 200),
    })
    return
  }

  const formatted = formatProcedure(procedure)
  const result = await remember(formatted, 'procedural', 'session_extraction', 'jarvis_ts')
  if (!result.ok) {
    log.warn('procedural: remember failed', { session: sessionKey, reason: result.reason, detail: result.detail })
    return
  }
  log.info('procedural: stored procedure', { session: sessionKey, title: procedure.title })
}
