import type { IonSDK } from 'ion-sdk'
import { logEvent } from '../../memory/episodic'
import { VEC_SERVER, VEC_TIMEOUT_MS } from '../../config/endpoints'

// Valid interest categories and their storage key prefixes.
const VALID_CATEGORIES = ['news', 'tech', 'finance', 'wellness', 'entertainment'] as const
type InterestCategory = (typeof VALID_CATEGORIES)[number]

function isValidCategory(s: string): s is InterestCategory {
  return (VALID_CATEGORIES as readonly string[]).includes(s)
}

function interestKey(category: InterestCategory): string {
  return `interests::${category}`
}

/**
 * Store or overwrite a category's interests in user_profile.
 * Text is stored as: "interests::<category>: <values>"
 */
async function setInterests(category: InterestCategory, values: string): Promise<{ id?: string; error?: string }> {
  const text = `${interestKey(category)}: ${values}`
  const res = await fetch(`${VEC_SERVER}/remember`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      collection: 'user_profile',
      source: 'manual',
      source_actor: 'user',
    }),
    signal: AbortSignal.timeout(VEC_TIMEOUT_MS),
  })
  return (await res.json()) as { id?: string; error?: string }
}

/**
 * Delete all entries for a category by recalling then forgetting each.
 * /recall returns up to n results; we clear up to 5 in one pass (interests
 * entries are typically one per category).
 */
async function clearInterests(category: InterestCategory): Promise<number> {
  const prefix = interestKey(category)
  const recallRes = await fetch(`${VEC_SERVER}/recall`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: prefix, collection: 'user_profile', n: 5 }),
    signal: AbortSignal.timeout(VEC_TIMEOUT_MS),
  })
  const recalled = (await recallRes.json()) as { results?: string[] }
  const matching = (recalled.results ?? []).filter((r) => r.includes(prefix))
  if (matching.length === 0) return 0

  let deleted = 0
  for (const text of matching) {
    const forgetRes = await fetch(`${VEC_SERVER}/forget`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, collection: 'user_profile' }),
      signal: AbortSignal.timeout(VEC_TIMEOUT_MS),
    })
    const result = (await forgetRes.json()) as { deleted?: boolean }
    if (result.deleted) deleted++
  }
  return deleted
}

/**
 * List all stored interests by fetching recent user_profile entries and
 * filtering to those that begin with "interests::".
 */
async function listAllInterests(): Promise<Record<string, string>> {
  const res = await fetch(
    `${VEC_SERVER}/list?collection=user_profile&limit=100`,
    { signal: AbortSignal.timeout(VEC_TIMEOUT_MS) },
  )
  const data = (await res.json()) as {
    entries?: Array<{ id: string; text: string; source: string; stored_at: string }>
    error?: string
  }
  const out: Record<string, string> = {}
  for (const entry of data.entries ?? []) {
    if (entry.text.startsWith('interests::')) {
      // Parse "interests::<category>: <values>"
      const colonIdx = entry.text.indexOf(': ')
      if (colonIdx !== -1) {
        const key = entry.text.slice(0, colonIdx)   // "interests::news"
        const vals = entry.text.slice(colonIdx + 2)  // "AI policy geopolitics crypto"
        out[key] = vals
      }
    }
  }
  return out
}

// /interests — show, set, or clear interest preferences.
export function registerInterestsCommands(ion: IonSDK): void {
  ion.registerCommand('interests', {
    description:
      'Manage topic interests for watch routines. ' +
      'Usage: interests | interests set <category> <values> | interests clear <category>. ' +
      'Categories: news, tech, finance, wellness, entertainment.',
    execute: async (args) => {
      const parts = args.trim().split(/\s+/).filter(Boolean)
      const [subcommand, category, ...rest] = parts

      // ── /interests (no args) ── list all ──────────────────────────────────
      if (!subcommand) {
        try {
          const all = await listAllInterests()
          const entries = Object.entries(all)
          if (entries.length === 0) {
            logEvent('interests', 'inbox_item', {
              routine: 'interests',
              text: 'No interests stored. Use: /interests set <category> <values>',
            })
            return
          }
          const lines = entries.map(([key, vals]) => {
            const cat = key.replace('interests::', '')
            return `  ${cat}: ${vals}`
          })
          logEvent('interests', 'inbox_item', {
            routine: 'interests',
            text: `Stored interests:\n${lines.join('\n')}`,
          })
        } catch (err: unknown) {
          logEvent('interests', 'inbox_item', {
            routine: 'interests',
            text: `Could not retrieve interests (vec server unavailable?): ${String(err)}`,
          })
        }
        return
      }

      // ── /interests set <category> <values> ────────────────────────────────
      if (subcommand === 'set') {
        if (!category || !isValidCategory(category)) {
          logEvent('interests', 'inbox_item', {
            routine: 'interests',
            text: `Invalid category "${category ?? ''}". Valid: ${VALID_CATEGORIES.join(', ')}`,
          })
          return
        }
        const values = rest.join(' ')
        if (!values) {
          logEvent('interests', 'inbox_item', {
            routine: 'interests',
            text: `Usage: /interests set ${category} <values>`,
          })
          return
        }
        try {
          // Clear any prior entry for this category first to avoid duplicates.
          await clearInterests(category)
          const result = await setInterests(category, values)
          const msg = result.id
            ? `Stored interests::${category}: ${values}`
            : `Storage failed: ${result.error ?? 'unknown error'}`
          logEvent('interests', 'inbox_item', { routine: 'interests', text: msg })
        } catch (err: unknown) {
          logEvent('interests', 'inbox_item', {
            routine: 'interests',
            text: `Set failed (vec server unavailable?): ${String(err)}`,
          })
        }
        return
      }

      // ── /interests clear <category> ───────────────────────────────────────
      if (subcommand === 'clear') {
        if (!category || !isValidCategory(category)) {
          logEvent('interests', 'inbox_item', {
            routine: 'interests',
            text: `Invalid category "${category ?? ''}". Valid: ${VALID_CATEGORIES.join(', ')}`,
          })
          return
        }
        try {
          const deleted = await clearInterests(category)
          const msg = deleted > 0
            ? `Cleared ${deleted} entry(s) for interests::${category}.`
            : `No interests found for category "${category}".`
          logEvent('interests', 'inbox_item', { routine: 'interests', text: msg })
        } catch (err: unknown) {
          logEvent('interests', 'inbox_item', {
            routine: 'interests',
            text: `Clear failed (vec server unavailable?): ${String(err)}`,
          })
        }
        return
      }

      // Unknown subcommand
      logEvent('interests', 'inbox_item', {
        routine: 'interests',
        text:
          `Unknown subcommand "${subcommand}". ` +
          `Usage: /interests | /interests set <category> <values> | /interests clear <category>`,
      })
    },
  })
}
