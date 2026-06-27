// Spotlight tool -- file search via mdfind.
// Ports harness/subagents/skills/spotlight.py.
// Config read from harness/config/integrations.yaml (spotlight section).

import { execFile } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import jsYaml from 'js-yaml'

import { HARNESS_DIR } from '../config'
import { log } from 'ion-sdk'

const execFileAsync = promisify(execFile)

interface SpotlightConfig {
  roots: string[]
  nas_roots: string[]
  timeout_seconds: number
  max_results: number
}

const DEFAULTS: SpotlightConfig = {
  roots: [join(homedir(), 'Documents')],
  nas_roots: [],
  timeout_seconds: 10,
  max_results: 20,
}

function loadSpotlightConfig(): SpotlightConfig {
  try {
    const content = readFileSync(
      join(HARNESS_DIR, 'harness/config/integrations.yaml'),
      'utf8',
    )
    const doc = jsYaml.load(content) as { spotlight?: Partial<SpotlightConfig> } | null
    const sp = doc?.spotlight ?? {}
    const roots = Array.isArray(sp.roots) && sp.roots.length ? sp.roots : DEFAULTS.roots
    return {
      roots,
      nas_roots: Array.isArray(sp.nas_roots) ? sp.nas_roots : [],
      timeout_seconds: typeof sp.timeout_seconds === 'number' ? sp.timeout_seconds : DEFAULTS.timeout_seconds,
      max_results: typeof sp.max_results === 'number' ? sp.max_results : DEFAULTS.max_results,
    }
  } catch {
    return DEFAULTS
  }
}

function expandPath(p: string): string {
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

function isTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const e = err as NodeJS.ErrnoException & { killed?: boolean }
  return (
    e.code === 'ETIMEDOUT' ||
    e.killed === true ||
    e.message.includes('ETIMEDOUT') ||
    e.message.includes('timed out')
  )
}

export async function spotlightSearch(query: string): Promise<string> {
  // mdfind treats leading-dash arguments as flags (-onlyin, -name, -count, ...).
  // A query like "-onlyin /tmp" would silently rescope the search; "-count"
  // would change the output mode. Reject these to keep the tool semantics
  // user-controlled rather than mdfind-flag-controlled.
  const trimmed = query.trim()
  if (!trimmed) return 'Empty spotlight query.'
  if (trimmed.startsWith('-')) {
    return `Invalid spotlight query: cannot start with '-' (mdfind would interpret it as a flag): ${JSON.stringify(query)}`
  }

  const cfg = loadSpotlightConfig()
  const timeoutMs = cfg.timeout_seconds * 1_000

  // "name:<filename>" → mdfind -name search across the full home directory.
  // This bypasses the configured roots so filenames are found regardless of
  // where they live (Documents, Downloads, Desktop, iCloud Drive, etc.).
  if (trimmed.startsWith('name:')) {
    const filename = trimmed.slice(5).trim()
    if (!filename) return 'Empty filename in name: query.'
    try {
      const { stdout } = await execFileAsync('mdfind', ['-name', filename], {
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
      })
      const allPaths = stdout
        .split('\n')
        .map((p) => p.trim())
        .filter(Boolean)
      if (!allPaths.length) return `No files found with name: ${JSON.stringify(filename)}`
      const paths = allPaths.slice(0, cfg.max_results)
      let result = paths.map((p) => `- ${p}`).join('\n')
      if (allPaths.length > cfg.max_results) {
        result += `\n\n(Showing ${cfg.max_results} of ${allPaths.length} results. Use a more specific query to narrow results.)`
      }
      return result
    } catch (err: unknown) {
      if (isTimeoutError(err)) {
        return `Spotlight query timed out after ${cfg.timeout_seconds}s: ${JSON.stringify(filename)}`
      }
      log.warn('spotlight: search error', { err: String(err) })
      return `Spotlight search error: ${String(err)}`
    }
  }

  const allRoots = [...cfg.roots, ...cfg.nas_roots].map(expandPath)
  const validRoots = allRoots.filter(r => existsSync(r))
  const skippedCount = allRoots.length - validRoots.length

  if (validRoots.length === 0 && allRoots.length > 0) {
    return `spotlight: all ${allRoots.length} configured root(s) are missing or unmounted; nothing to search`
  }

  const args: string[] = []
  for (const root of validRoots) args.push('-onlyin', root)
  args.push(trimmed)

  try {
    const { stdout } = await execFileAsync('mdfind', args, {
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    })
    const allPaths = stdout
      .split('\n')
      .map((p) => p.trim())
      .filter(Boolean)
    if (!allPaths.length) return `No files found matching: ${JSON.stringify(query)}`
    const paths = allPaths.slice(0, cfg.max_results)
    let result = paths.map((p) => `- ${p}`).join('\n')
    if (allPaths.length > cfg.max_results) {
      result += `\n\n(Showing ${cfg.max_results} of ${allPaths.length} results. Use a more specific query to narrow results.)`
    }
    if (skippedCount > 0) {
      result += `\n(Note: ${skippedCount} configured root(s) were skipped -- not mounted or missing)`
    }
    return result
  } catch (err: unknown) {
    if (isTimeoutError(err)) {
      return `Spotlight query timed out after ${cfg.timeout_seconds}s: ${JSON.stringify(query)}`
    }
    log.warn('spotlight: search error', { err: String(err) })
    return `Spotlight search error: ${String(err)}`
  }
}
