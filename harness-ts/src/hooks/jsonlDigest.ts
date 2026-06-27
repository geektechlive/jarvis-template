import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const CLAUDE_PROJECT_DIR = join(
  homedir(),
  '.claude/projects/-Users-<username>-Jarvis',
)

const MAX_CHARS = 2000
const MAX_USER_MESSAGES = 10
const MAX_MESSAGE_LEN = 150

interface JsonlEntry {
  type?: string
  message?: {
    role?: string
    content?: Array<{ type: string; text?: string }>
  }
}

function relativeTime(mtimeMs: number): string {
  const diffMs = Date.now() - mtimeMs
  const diffMin = Math.floor(diffMs / 60_000)
  if (diffMin < 2) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.floor(diffHr / 24)
  return `${diffDay}d ago`
}

function extractUserMessages(filePath: string): string[] {
  const raw = readFileSync(filePath, 'utf8')
  const lines = raw.split('\n').filter(l => l.trim().length > 0)
  const messages: string[] = []

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as JsonlEntry
      if (entry.type !== 'user') continue
      if (!Array.isArray(entry.message?.content)) continue

      const text = entry.message.content
        .filter(block => block.type === 'text' && typeof block.text === 'string')
        .map(block => block.text ?? '')
        .join(' ')
        .trim()

      if (text.length > 0) {
        messages.push(text)
      }
    } catch {
      // skip unparseable lines
    }
  }

  return messages.slice(-MAX_USER_MESSAGES)
}

/**
 * Reads recent Claude Code session JSONL files for this project and returns
 * a formatted digest of what was discussed. Used in before_prompt to give
 * Jarvis cross-session awareness without being told explicitly.
 *
 * Never throws -- returns empty string on any error.
 */
export function readOtherSessionDigests(hoursBack = 24, maxSessions = 5): string {
  try {
    const cutoffMs = Date.now() - hoursBack * 3_600_000

    let entries: Array<{ file: string; mtimeMs: number; size: number }>
    try {
      entries = readdirSync(CLAUDE_PROJECT_DIR)
        .filter(name => name.endsWith('.jsonl'))
        .map(name => {
          const file = join(CLAUDE_PROJECT_DIR, name)
          try {
            const stat = statSync(file)
            return { file, mtimeMs: stat.mtimeMs, size: stat.size }
          } catch {
            return null
          }
        })
        .filter((e): e is { file: string; mtimeMs: number; size: number } => e !== null)
    } catch {
      return ''
    }

    const recent = entries
      .filter(e => e.mtimeMs > cutoffMs && e.size > 5000)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, maxSessions)

    if (recent.length === 0) return ''

    const sessionBlocks: string[] = []

    for (const { file, mtimeMs } of recent) {
      try {
        const messages = extractUserMessages(file)
        if (messages.length === 0) continue

        const header = `[Session active ${relativeTime(mtimeMs)}]`
        const lines = messages
          .map(m => `- "${m.length > MAX_MESSAGE_LEN ? m.slice(0, MAX_MESSAGE_LEN) + '...' : m}"`)
          .join('\n')
        sessionBlocks.push(`${header}\n${lines}`)
      } catch {
        // skip files that fail to read or parse
      }
    }

    if (sessionBlocks.length === 0) return ''

    const intro =
      '---\nOther open Jarvis sessions (last 24h — pick up context from these before answering):'
    const body = sessionBlocks.join('\n\n')
    const full = `${intro}\n${body}`

    if (full.length > MAX_CHARS) {
      return full.slice(0, MAX_CHARS) + '\n... (truncated)'
    }

    return full
  } catch {
    return ''
  }
}
