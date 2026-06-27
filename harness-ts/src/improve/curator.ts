// Script usage curator.
// Tracks provenance of scripts in scripts/ and archives stale agent-created scripts.
// Archival prefers last_activity_at for staleness; falls back to file mtime.

import { readFileSync, writeFileSync, mkdirSync, renameSync, statSync, existsSync } from 'node:fs'
import { join, basename, extname } from 'node:path'
import { HARNESS_DIR } from '../config'
import { log } from 'ion-sdk'

const SCRIPTS_DIR = join(HARNESS_DIR, 'scripts')
const USAGE_PATH = join(SCRIPTS_DIR, '.usage.json')
const ARCHIVE_DIR = join(SCRIPTS_DIR, '.archive')
const STALE_DAYS = 30

export interface ScriptMeta {
  created_by: 'human' | 'agent'
  state: 'active' | 'candidate' | 'stale' | 'archived'
  created_at: string | null
  use_count: number
  last_activity_at: string | null
}

export type UsageJson = Record<string, ScriptMeta>

export function loadUsage(): UsageJson {
  try {
    return JSON.parse(readFileSync(USAGE_PATH, 'utf8')) as UsageJson
  } catch {
    return {}
  }
}

export function saveUsage(data: UsageJson): void {
  writeFileSync(USAGE_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8')
}

export function registerAgentScript(name: string): void {
  const data = loadUsage()
  data[name] = {
    created_by: 'agent',
    state: 'candidate',
    created_at: new Date().toISOString(),
    use_count: 0,
    last_activity_at: null,
  }
  saveUsage(data)
}

export function incrementScriptUsage(name: string): void {
  if (!existsSync(USAGE_PATH)) return

  const data = loadUsage()
  const ext = extname(name)
  const key = ext.length > 0 ? basename(name, ext) : basename(name)

  const entry = data[key]
  if (entry === undefined) {
    data[key] = {
      created_by: 'agent',
      state: 'active',
      created_at: null,
      use_count: 1,
      last_activity_at: new Date().toISOString(),
    }
  } else {
    data[key] = {
      ...entry,
      use_count: entry.use_count + 1,
      last_activity_at: new Date().toISOString(),
    }
  }

  saveUsage(data)
}

export function runCurator(): string {
  const data = loadUsage()
  const archived: string[] = []
  const now = Date.now()
  const staleMs = STALE_DAYS * 86_400_000

  for (const [name, meta] of Object.entries(data)) {
    if (meta.created_by !== 'agent' || meta.state === 'archived') continue
    const scriptPath = join(SCRIPTS_DIR, name)
    if (!existsSync(scriptPath)) continue
    const refTime = meta.last_activity_at !== null
      ? new Date(meta.last_activity_at).getTime()
      : statSync(scriptPath).mtimeMs
    if (now - refTime > staleMs) {
      try {
        mkdirSync(ARCHIVE_DIR, { recursive: true })
        renameSync(scriptPath, join(ARCHIVE_DIR, name))
        data[name] = { ...meta, state: 'archived' }
        archived.push(name)
        log.info('curator: archived stale script', { name })
      } catch (err) {
        log.warn('curator: failed to archive script', { name, err: String(err) })
      }
    }
  }

  if (archived.length > 0) {
    saveUsage(data)
  }

  return archived.length > 0
    ? `Archived ${archived.length} stale agent-created script(s): ${archived.join(', ')}`
    : 'No stale agent-created scripts found.'
}

