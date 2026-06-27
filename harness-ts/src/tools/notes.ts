// Notes tool -- Notes.app read via SQLite, create via AppleScript.
// Read uses notes-read.py (SQLite, no GUI session needed).
// Create uses notes-create.py (AppleScript, requires ion LaunchAgent GUI context).

import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SCRIPTS_DIR = join(homedir(), 'Jarvis', 'scripts')
const PYTHON = '/usr/bin/env'

export function notesRead(query?: string, recent?: number, folder?: string): string {
  const script = join(SCRIPTS_DIR, 'notes-read.py')
  const args: string[] = []
  if (query) args.push(query)
  if (recent !== undefined) args.push('--recent', String(recent))
  if (folder) args.push('--folder', folder)

  const result = spawnSync(PYTHON, ['python3', script, ...args], {
    encoding: 'utf8',
    timeout: 10_000,
  })
  if (result.status !== 0) {
    const err = (result.stderr || '').trim() || `exit ${result.status}`
    return JSON.stringify({ error: err })
  }
  return result.stdout.trim() || '[]'
}

export function notesCreate(title: string, body: string, folder?: string): string {
  const script = join(SCRIPTS_DIR, 'notes-create.py')
  const args = ['--title', title, '--body', body]
  if (folder) args.push('--folder', folder)

  const result = spawnSync(PYTHON, ['python3', script, ...args], {
    encoding: 'utf8',
    timeout: 20_000,
  })
  if (result.status !== 0) {
    const err = (result.stderr || '').trim() || `exit ${result.status}`
    return JSON.stringify({ error: err })
  }
  return result.stdout.trim() || JSON.stringify({ error: 'no output from notes-create.py' })
}
