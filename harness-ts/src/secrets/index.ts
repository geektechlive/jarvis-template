// macOS Keychain wrapper via the `security` CLI.
//
// Long-lived credentials (OAuth refresh tokens, IMAP app passwords, API keys)
// live here -- not in .env. The .env keeps short-lived bootstrap tokens only.
//
// Service name matches the Python harness: com.example.jarvis

import { spawnSync } from 'child_process'

const SERVICE = 'com.example.jarvis'

export function getSecret(key: string): string | null {
  const result = spawnSync('security', [
    'find-generic-password',
    '-s', SERVICE,
    '-a', key,
    '-w', // print password only
  ])
  if (result.status !== 0) return null
  return result.stdout.toString().trim() || null
}

export function setSecret(key: string, value: string): void {
  // Delete first (ignoring errors) then add, so the call is idempotent.
  spawnSync('security', ['delete-generic-password', '-s', SERVICE, '-a', key])
  const result = spawnSync('security', [
    'add-generic-password',
    '-s', SERVICE,
    '-a', key,
    '-w', value,
  ])
  if (result.status !== 0) {
    throw new Error(`setSecret failed for key=${key}: ${result.stderr.toString().trim()}`)
  }
}

export function deleteSecret(key: string): void {
  // No-op if absent (security exits 44 when not found).
  spawnSync('security', ['delete-generic-password', '-s', SERVICE, '-a', key])
}
