import { spawnSync } from 'node:child_process'
import * as os from 'node:os'
import * as path from 'node:path'

const SCRIPTS_DIR = path.join(os.homedir(), 'Jarvis', 'scripts')

export function imessageSend(to: string, body: string, service: 'iMessage' | 'SMS' = 'iMessage'): string {
  const script = path.join(SCRIPTS_DIR, 'imessage-send.sh')
  const result = spawnSync('/bin/bash', [script, to, body, service], {
    encoding: 'utf8',
    timeout: 15_000,
  })
  if (result.status !== 0) {
    const err = (result.stderr || '').trim() || `exit ${result.status}`
    return `Failed to send iMessage: ${err}`
  }
  return `Sent to ${to}.`
}

export function contactsLookup(query: string, mode: 'name' | 'phone' = 'name'): string {
  const script = path.join(SCRIPTS_DIR, 'contacts-lookup.sh')
  const flag = mode === 'phone' ? '--phone' : '--name'
  const result = spawnSync('/bin/bash', [script, flag, query], {
    encoding: 'utf8',
    timeout: 10_000,
  })
  if (result.status !== 0) {
    return JSON.stringify({ error: (result.stderr || '').trim() || `exit ${result.status}` })
  }
  return result.stdout.trim() || '[]'
}
