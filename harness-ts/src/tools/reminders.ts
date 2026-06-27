// Reminders tool -- iCloud Reminders via CalDAV (reminders-caldav.py).
// Delegates all credential handling and CalDAV logic to the Python script.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { join } from 'node:path'

const execFileAsync = promisify(execFile)
const SCRIPTS_DIR = join(homedir(), 'Jarvis', 'scripts')
const PYTHON = '/usr/bin/env'

async function runCaldavScript(subcommand: string, args: string[]): Promise<string> {
  const script = join(SCRIPTS_DIR, 'reminders-caldav.py')
  try {
    const { stdout } = await execFileAsync(PYTHON, ['python3', script, subcommand, ...args], {
      encoding: 'utf8',
      timeout: 30_000,
    })
    return stdout.trim() || '[]'
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return JSON.stringify({ error: msg })
  }
}

export async function reminderList(list?: string, includeCompleted?: boolean): Promise<string> {
  const args: string[] = []
  if (list) args.push('--list', list)
  if (includeCompleted) args.push('--all')
  return runCaldavScript('list', args)
}

export async function reminderCreate(title: string, list?: string, dueDate?: string): Promise<string> {
  const args = ['--title', title]
  if (list) args.push('--list', list)
  if (dueDate) args.push('--due-date', dueDate)
  return runCaldavScript('create', args)
}

export async function reminderComplete(query: string, list?: string): Promise<string> {
  const args = ['--query', query]
  if (list) args.push('--list', list)
  return runCaldavScript('complete', args)
}
