// Parsing the LLM's XML-tagged change proposals, and applying an edit to a
// file on disk. Depends only on the path policy.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HARNESS_DIR } from '../config'
import { isImprovable } from './paths'

// ---------------------------------------------------------------------------
// Text normalization -- mirrors Python _QUOTE_MAP
// ---------------------------------------------------------------------------

function normalizeQuotes(s: string): string {
  return s
    .replace(/'/g, "'")
    .replace(/'/g, "'")
    .replace(/"/g, '"')
    .replace(/"/g, '"')
}

// ---------------------------------------------------------------------------
// apply_text_change -- mirrors harness/tools/__init__.py apply_text_change
// ---------------------------------------------------------------------------

export function applyTextChange(filepath: string, old: string, newText: string): string {
  if (!isImprovable(filepath)) {
    return `Error: ${filepath} is not in the IMPROVABLE_PATHS allowlist`
  }
  const abs = join(HARNESS_DIR, filepath)
  let content: string
  try {
    content = readFileSync(abs, 'utf8')
  } catch {
    return `Error: could not read ${filepath}`
  }
  const normalizedOld = normalizeQuotes(old)
  const normalizedContent = normalizeQuotes(content)
  if (!normalizedContent.includes(normalizedOld)) {
    return `Error: old text not found in ${filepath}`
  }
  const matchCount = content.split(old).length - 1
  if (matchCount === 0) {
    return `Error: old text not found in ${filepath}`
  }
  if (matchCount > 1) {
    return `Error: old text appears ${matchCount} times; must be unique`
  }
  const updated = content.replace(old, newText)
  try {
    writeFileSync(abs, updated, 'utf8')
  } catch {
    return `Error: could not write ${filepath}`
  }
  return 'ok'
}

// ---------------------------------------------------------------------------
// XML parsing
// ---------------------------------------------------------------------------

export interface Suggestion {
  action: 'edit'
  filepath: string
  old: string
  newText: string
  reason: string
}

export interface CreateSuggestion {
  action: 'create'
  filepath: string
  content: string
  reason: string
}

export type AnySuggestion = Suggestion | CreateSuggestion

export function parseSuggestion(text: string): AnySuggestion | null {
  const stripped = text.trim()
  if (stripped.toUpperCase() === 'DONE' || stripped.toUpperCase().startsWith('DONE')) {
    return null
  }

  const actionMatch = /<action>([\s\S]*?)<\/action>/.exec(text)?.[1]?.trim().toLowerCase()
  const fileMatch = /<file>([\s\S]*?)<\/file>/.exec(text)?.[1]?.trim()
  const reasonMatch = /<reason>([\s\S]*?)<\/reason>/.exec(text)?.[1]?.trim()

  if (!fileMatch || !reasonMatch) return null

  if (actionMatch === 'create') {
    const contentMatch = /<content>([\s\S]*?)<\/content>/.exec(text)?.[1]?.replace(/^\n/, '')
    if (!contentMatch) return null
    return { action: 'create', filepath: fileMatch, content: contentMatch, reason: reasonMatch }
  }

  // Default: edit (backwards-compatible -- <action> tag is optional for edits)
  const oldMatch = /<old>([\s\S]*?)<\/old>/.exec(text)?.[1]?.replace(/^\n|\n$/g, '')
  const newMatch = /<new>([\s\S]*?)<\/new>/.exec(text)?.[1]?.replace(/^\n|\n$/g, '')
  if (oldMatch == null || newMatch == null) return null
  return { action: 'edit', filepath: fileMatch, old: oldMatch, newText: newMatch, reason: reasonMatch }
}
