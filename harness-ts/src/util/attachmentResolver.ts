/**
 * attachmentResolver.ts
 *
 * Rewrites [Attached (file|image|plan): ~/...] markers in a prompt so that
 * the CliBackend agent receives absolute, materialized paths rather than
 * iCloud-relative tilde paths that may not have been downloaded yet.
 *
 * Fast path: if the prompt contains no '[Attached ' substring, returns
 * the original string immediately with zero fs or subprocess work.
 */

import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { log } from 'ion-sdk'
import { runCommandAsync } from './ionPrompt'

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing without real fs/subprocess)
// ---------------------------------------------------------------------------

/** Expand a leading `~` to the user's home directory. */
export function expandTilde(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return homedir() + p.slice(1)
  }
  return p
}

/**
 * Replace the path portion of one marker in the prompt string.
 *
 * @param prompt    - original prompt
 * @param original  - exact marker string to replace, e.g. `[Attached file: ~/foo.pdf]`
 * @param absPath   - absolute path to substitute in
 * @returns new prompt string
 */
export function rewriteMarker(prompt: string, original: string, absPath: string): string {
  // Reconstruct the replacement marker from the original, swapping only the path.
  // We need to find the path inside the marker to build the replacement.
  const pathStart = original.indexOf(': ') + 2
  const pathEnd = original.length - 1 // before the closing `]`
  const kind = original.slice(1, pathStart - 2) // e.g. "Attached file"
  const replaced = `[${kind}: ${absPath}]`
  // pathStart/pathEnd sanity check — if parsing is off, fall back to plain replace
  const oldPath = original.slice(pathStart, pathEnd)
  if (!oldPath) return prompt
  return prompt.replace(original, replaced)
}

// ---------------------------------------------------------------------------
// Injection interface (makes the poller unit-testable without real i/o)
// ---------------------------------------------------------------------------

export interface AttachmentResolverDeps {
  /** Returns true when the file exists and has a non-zero size. */
  isFileReady: (abs: string) => boolean
  /** Trigger an iCloud download; best-effort — errors are swallowed. */
  download: (abs: string) => Promise<void>
  /** Async sleep (injectable so tests can skip delays). */
  sleep: (ms: number) => Promise<void>
  /** Total poll attempts (default: 30). */
  maxAttempts: number
  /** Milliseconds between polls (default: 500). */
  intervalMs: number
}

const DEFAULT_DEPS: AttachmentResolverDeps = {
  isFileReady(abs: string): boolean {
    try {
      return existsSync(abs) && statSync(abs).size > 0
    } catch {
      return false
    }
  },
  async download(abs: string): Promise<void> {
    try {
      await runCommandAsync('brctl', ['download', abs], { timeoutMs: 5_000 })
    } catch {
      // brctl may be absent in test environments or on non-Mac; ignore
    }
  },
  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  },
  maxAttempts: 30,
  intervalMs: 500,
}

// Regex: matches [Attached file: ...], [Attached image: ...], [Attached plan: ...]
const MARKER_RE = /\[Attached (?:file|image|plan): ([^\]]+)\]/g

/**
 * Resolve iCloud-relative attachment markers in a prompt string.
 *
 * For each `[Attached (file|image|plan): ~/path]` marker:
 *   1. Expand `~` to the absolute home path.
 *   2. Trigger `brctl download` to force iCloud materialization.
 *   3. Poll up to ~15s for the file to appear on disk.
 *   4. If materialized: rewrite the marker to use the absolute path.
 *   5. If timeout: leave the marker unchanged (agent will report the issue).
 *
 * @param prompt - raw incoming prompt
 * @param deps   - injectable dependencies for unit testing
 */
export async function resolveAttachmentMarkers(
  prompt: string,
  deps: Partial<AttachmentResolverDeps> = {},
): Promise<string> {
  // Fast path: no attachment markers → zero work
  if (!prompt.includes('[Attached ')) {
    return prompt
  }

  const {
    isFileReady,
    download,
    sleep,
    maxAttempts,
    intervalMs,
  }: AttachmentResolverDeps = { ...DEFAULT_DEPS, ...deps }

  let result = prompt

  // Collect all matches first (avoids async-in-replace-callback problem)
  const matches = [...prompt.matchAll(MARKER_RE)]

  for (const match of matches) {
    const fullMarker = match[0]
    const rawPath = match[1]

    if (rawPath === undefined || rawPath === '') continue

    const absPath = expandTilde(rawPath)

    // Trigger iCloud download (best-effort, run once up front)
    await download(absPath)

    // Poll until the file materializes or we time out
    let materialized = isFileReady(absPath)
    for (let i = 1; i < maxAttempts && !materialized; i++) {
      await sleep(intervalMs)
      // Re-trigger download periodically (every ~5s at 500ms interval = every 10 polls)
      if (i % 10 === 0) {
        await download(absPath)
      }
      materialized = isFileReady(absPath)
    }

    if (materialized) {
      result = rewriteMarker(result, fullMarker, absPath)
      log.info('attachmentResolver: materialized', { rawPath, absPath })
    } else {
      log.warn('attachmentResolver: timeout waiting for file', { rawPath, absPath })
      // Leave marker unchanged; the agent will report it honestly
    }
  }

  return result
}
