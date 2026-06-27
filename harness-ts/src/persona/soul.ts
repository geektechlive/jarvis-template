import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { log } from 'ion-sdk'

// Mirrors harness/identity/loader.py: concatenate the identity files in order,
// reload when any mtime changes. SOUL is voice; ENVIRONMENT is runtime context +
// tool inventory; BEHAVIOR is decision rules; MISSION is context.
// GOALS.md (autonomy/system goals) and PROJECTS.md (stale weekly snapshot) are
// intentionally NOT injected per turn — they are operational reference, not
// interactive personality, and added ~5.8KB to every system prompt. The files
// remain on disk for the autonomy/improve routines and the Repo Steward.
const IDENTITY_DIR = join(__dirname, '../../harness/identity')
const FILES = ['SOUL.md', 'ENVIRONMENT.md', 'BEHAVIOR.md', 'MISSION.md']

let cachedPrefix = ''
let cachedMtimes: number[] = []

export function loadSoul(): string {
  try {
    const paths = FILES.map((f) => join(IDENTITY_DIR, f))
    const mtimes: number[] = []
    for (const p of paths) {
      try {
        mtimes.push(statSync(p).mtimeMs)
      } catch {
        mtimes.push(0)
      }
    }
    const same =
      cachedPrefix &&
      mtimes.length === cachedMtimes.length &&
      mtimes.every((m, i) => m === cachedMtimes[i])
    if (same) return cachedPrefix

    const parts: string[] = []
    for (const p of paths) {
      try {
        parts.push(readFileSync(p, 'utf8').trim())
      } catch { /* skip missing */ }
    }
    cachedPrefix = parts.filter(Boolean).join('\n\n')
    cachedMtimes = mtimes
    return cachedPrefix
  } catch (err) {
    log.warn('jarvis: identity load failed, using minimal fallback', { err: String(err) })
    return 'You are Jarvis, a British chief of staff. Be concise and formal. No exclamation marks.'
  }
}
