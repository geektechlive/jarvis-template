// Prompt assembly + the LLM call for the self-improvement loop: the system
// prompt, reading the current source files, the approved/rejected history
// block, and dispatching the model (scheduler ctx agent, else direct Ollama).

import { log } from 'ion-sdk'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { HARNESS_DIR, OLLAMA_HOST, isAllowedHost, loadModelForRole } from '../config'
import { recentImprovementEvents } from '../memory/episodic'
import { getSchedulerCtx } from '../scheduler/ctx'
import { IMPROVABLE_PATHS } from './paths'

// ---------------------------------------------------------------------------
// Improvement history -- surfaces past approvals/rejections to the LLM so it
// does not re-propose rejected work and can build on approved changes.
// ---------------------------------------------------------------------------

export function loadImprovementHistory(): string {
  try {
    const { merged, rejected } = recentImprovementEvents(90)
    if (merged.length === 0 && rejected.length === 0) return ''
    const lines: string[] = []
    if (merged.length > 0) {
      lines.push('Past improvements approved (last 90 days):')
      for (const m of merged) {
        const fileList = m.files.length > 0 ? ` [${m.files.join(', ')}]` : ''
        lines.push(`  - ${m.branch}${fileList}`)
      }
    }
    if (rejected.length > 0) {
      lines.push('Past improvements rejected (last 90 days):')
      for (const r of rejected) {
        lines.push(`  - ${r.branch}`)
      }
    }
    lines.push('Do not re-propose previously rejected changes unless context has materially changed.')
    lines.push('Build on what was previously approved rather than repeating it.')
    return lines.join('\n')
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// System prompt (mirrors Python _SYSTEM verbatim)
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPT = `You are improving an AI agent's config and identity files. Your job: find ONE concrete improvement
per iteration and output it as an XML change.

Files you may edit:
- harness/identity/*.md -- persona, behavior rules, mission, goals, active projects
- harness/config/models.yaml -- model role assignments
- harness/config/staff.yaml -- staff roster config
- harness/config/routines.yaml -- enable/disable/retune scheduled routines
- harness/agents/*.md -- staff agent specs (tool access, routing rules, system prompts)

GOOD improvements (do these):
1. Add a concrete example to a vague rule in an identity or agent spec file.
2. Add a missing negative constraint to prevent a known failure mode.
3. Replace corporate/AI-sounding text with plain language.
4. Tighten an agent spec: clearer tool descriptions, sharper routing rules, remove redundant DO NOT instructions that cause tool paralysis.
5. Enable a disabled routine if the description matches a clear user need.
6. Add a missing rule for a failure pattern visible in the conversation history.
7. Make implicit rules explicit with a concrete do/don't.

BAD "improvements" (never propose these):
- Rewording without changing behavior
- Renaming section headers
- Making text more formal or "professional"
- Adding corporate buzzwords: leverage (verb), synergy, circle back, move the needle
- Adding AI filler: "provide insightful responses", "It's worth noting", "I want to emphasize"
- Removing safety constraints or persona rules
- Adding banned tokens: certainly, of course, great question, happy to help, let's dive in, as an AI, absolutely

CRITICAL -- anti-hallucination:
- The <old> text MUST be copy-pasted verbatim from the === CURRENT SOURCE FILES === section.
- NEVER quote conversation history in <old> tags.
- Preserve exact whitespace and punctuation when copying.

You may also CREATE a new script in scripts/ when you observe a capability gap that a script would fill:
- Output <action>create</action> instead of the default edit action
- <file>scripts/name.sh</file> or <file>scripts/name.py</file> -- flat filenames only, no subdirs
- <content>...</content> instead of <old>/<new>
- First two lines of every agent-created script MUST be:
  # created_by: agent
  # created_at: YYYY-MM-DD

Script format for <action>create</action>:
<action>create</action>
<file>scripts/name.sh</file>
<content>
#!/bin/bash
# created_by: agent
# created_at: 2026-05-16
...
</content>
<reason>one sentence explaining what capability this adds</reason>

Only create a script if:
1. The capability is clearly missing (no existing script does this)
2. The script is useful to a staff agent via run_shell
3. You can write the full, correct implementation
Do not create incomplete stubs.

Constraints:
- Never touch: harness/identity/SOUL.md, harness-ts/, tests/, infrastructure
- Never EDIT a script without # created_by: agent in its header
- One change per iteration

Output format for edits (default, <action> tag is optional):
<file>relative/path/to/file</file>
<old>exact text copied from source files</old>
<new>replacement text</new>
<reason>one sentence explaining what behavior this changes</reason>

Propose a change on every iteration. Only output DONE if you have genuinely exhausted
all improvement opportunities across every file shown.`

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

function extractSystemPrompts(content: string): string {
  const matches = [...content.matchAll(/_\w*SYSTEM\w*\s*=\s*"""([\s\S]*?)"""/g)]
  if (!matches.length) return content
  return matches.map((m) => `_SYSTEM = """\n${m[1]}\n"""`).join('\n\n')
}

export function readFiles(): string {
  const paths: string[] = [...IMPROVABLE_PATHS]

  // Add all agent specs dynamically
  const agentsDir = join(HARNESS_DIR, 'harness/agents')
  if (existsSync(agentsDir)) {
    try {
      const specs = readdirSync(agentsDir)
        .filter((f) => f.endsWith('.md'))
        .map((f) => `harness/agents/${f}`)
      paths.push(...specs)
    } catch { /* skip if unreadable */ }
  }

  const parts: string[] = []
  for (const relPath of paths.sort()) {
    const abs = join(HARNESS_DIR, relPath)
    if (!existsSync(abs)) continue
    let content: string
    try {
      content = readFileSync(abs, 'utf8')
    } catch {
      continue
    }
    const isYamlOrMd = relPath.endsWith('.yaml') || relPath.endsWith('.md')
    if (isYamlOrMd || content.length <= 3000) {
      parts.push(`=== ${relPath} ===\n${content}`)
    } else {
      const extracted = extractSystemPrompts(content)
      parts.push(`=== ${relPath} (system prompts only) ===\n${extracted}`)
    }
  }
  return parts.join('\n\n')
}

// ---------------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------------

export async function callLLM(systemPrompt: string, userPrompt: string): Promise<string> {
  const model = loadModelForRole('improve', 'qwen2.5-coder:14b')
  const ctx = getSchedulerCtx()
  if (ctx) {
    try {
      const task = `${systemPrompt}\n\n${userPrompt}`
      const r = await ctx.dispatchAgent({ name: 'improve-worker', task, model, maxTurns: 1 })
      return r.output.trim()
    } catch (err) {
      log.warn('improve: callLLM dispatchAgent failed, falling back to Ollama', { err: String(err) })
      // fall through to direct Ollama
    }
  }
  if (!isAllowedHost(OLLAMA_HOST)) {
    throw new Error('OLLAMA_HOST not in allowed range (loopback/RFC1918/.local)')
  }
  const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      stream: false,
      options: { num_ctx: 8192, temperature: 0.2 },
    }),
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok) throw new Error(`Ollama ${res.status}`)
  const data = (await res.json()) as { message?: { content?: string } }
  return data.message?.content ?? ''
}
