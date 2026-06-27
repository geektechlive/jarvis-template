// Jarvis session journal — Tier 1 episodic memory.
//
// At session_end: writes a markdown entry to ~/.jarvis/sessions/YYYY-MM-DD.md
// and stores a summary in ChromaDB for semantic recall.
//
// At before_prompt: getRecentJournalContext() returns the last ~60 lines from
// today's (or yesterday's) journal for injection into the system prompt.
// This gives Jarvis genuine cross-session continuity without an LLM call.

import { join } from 'node:path'
import { homedir } from 'node:os'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { log } from 'ion-sdk'
import { remember } from './memory/recall'

const DATA_DIR = process.env['AGENT_DATA_DIR']
  ? process.env['AGENT_DATA_DIR'].replace('~', homedir())
  : join(homedir(), '.jarvis')

const SESSIONS_DIR = join(DATA_DIR, 'sessions')

// Per-session in-memory buffer: sessionKey -> exchanges
const sessionBuffer = new Map<string, Array<{ role: 'user' | 'assistant'; content: string }>>()

export function sessionLogMessage(sessionKey: string, role: 'user' | 'assistant', content: string): void {
  if (!sessionBuffer.has(sessionKey)) {
    if (sessionBuffer.size >= 100) {
      const oldest = sessionBuffer.keys().next().value
      if (oldest !== undefined) sessionBuffer.delete(oldest)
    }
    sessionBuffer.set(sessionKey, [])
  }
  const buf = sessionBuffer.get(sessionKey)!
  const last = buf.at(-1)
  if (last !== undefined && last.role === role && last.content === content) return
  buf.push({ role, content })
}

export async function writeSessionJournal(sessionKey: string): Promise<void> {
  const buf = sessionBuffer.get(sessionKey)
  sessionBuffer.delete(sessionKey)

  if (!buf || buf.length === 0) return

  const userMessages = buf.filter(m => m.role === 'user')
  if (userMessages.length === 0) return

  try {
    mkdirSync(SESSIONS_DIR, { recursive: true })

    const now = new Date()
    const dateStr = now.toISOString().split('T')[0]!
    const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })

    // Build the journal entry — concise but complete
    let entry = `\n---\n### ${timeStr}\n\n`

    for (const msg of buf) {
      const preview = msg.content.replace(/\n+/g, ' ').trim()
      if (msg.role === 'user') {
        entry += `**You:** ${preview.substring(0, 320)}${preview.length > 320 ? '…' : ''}\n\n`
      } else {
        entry += `**Jarvis:** ${preview.substring(0, 240)}${preview.length > 240 ? '…' : ''}\n\n`
      }
    }

    // Append to daily file
    const filePath = join(SESSIONS_DIR, `${dateStr}.md`)
    const header = existsSync(filePath) ? '' : `# Jarvis Session Journal — ${dateStr}\n`
    appendFileSync(filePath, header + entry, 'utf8')

    // Store a summary in ChromaDB so semantic recall can surface past sessions
    const summary = `Session ${dateStr} ${timeStr}: ` +
      userMessages.map(m => m.content.substring(0, 160)).join(' | ')
    const result = await remember(summary, 'knowledge', 'session_journal', 'jarvis_inference', { date: dateStr })
    if (!result.ok) {
      log.warn('session journal: remember failed', { reason: result.reason, detail: result.detail })
    }

    log.info('session journal written', { date: dateStr, time: timeStr, turns: userMessages.length })
  } catch (err: unknown) {
    log.warn('writeSessionJournal error', { err: String(err) })
  }
}

export function getRecentJournalContext(): string {
  try {
    const now = new Date()
    const today = now.toISOString().split('T')[0]!
    const yesterday = new Date(now)
    yesterday.setDate(yesterday.getDate() - 1)
    const yday = yesterday.toISOString().split('T')[0]!

    const segments: string[] = []

    // Today's file: take the first 120 lines (chronological start) so overnight
    // sessions written at the top of the file are captured, not crowded out by
    // later sessions when slicing from the end.
    const todayPath = join(SESSIONS_DIR, `${today}.md`)
    if (existsSync(todayPath)) {
      const text = readFileSync(todayPath, 'utf8').trim()
      if (text) segments.push(text.split('\n').slice(0, 120).join('\n'))
    }

    // Yesterday's file: take the last 80 lines to capture late-evening sessions.
    const ydayPath = join(SESSIONS_DIR, `${yday}.md`)
    if (existsSync(ydayPath)) {
      const text = readFileSync(ydayPath, 'utf8').trim()
      if (text) segments.push(text.split('\n').slice(-80).join('\n'))
    }

    return segments.join('\n\n---\n\n')
  } catch {
    return ''
  }
}
