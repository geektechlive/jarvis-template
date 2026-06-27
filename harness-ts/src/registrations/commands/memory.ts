import type { IonSDK } from 'ion-sdk'
import { logEvent, getLatestSummary } from '../../memory/episodic'
import { VEC_SERVER, VEC_TIMEOUT_MS } from '../../config/endpoints'

// Memory slash commands: /recall, /learn, /forget, /list-memories,
// /consolidate, /recall-stats. All call the local vec server.
export function registerMemoryCommands(ion: IonSDK): void {
  ion.registerCommand('recall', {
    description: 'Search long-term memory. Usage: recall <query>',
    execute: async (args) => {
      const query = args.trim()
      if (!query) {
        logEvent('recall', 'inbox_item', { routine: 'recall', text: 'Usage: /recall <query>' })
        return
      }
      try {
        const [profileRes, knowledgeRes] = await Promise.all([
          fetch(`${VEC_SERVER}/recall`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, collection: 'user_profile', n: 10 }),
            signal: AbortSignal.timeout(VEC_TIMEOUT_MS),
          }),
          fetch(`${VEC_SERVER}/recall`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, collection: 'knowledge', n: 5 }),
            signal: AbortSignal.timeout(VEC_TIMEOUT_MS),
          }),
        ])
        const profile = (await profileRes.json()) as { results: string[] }
        const knowledge = (await knowledgeRes.json()) as { results: string[] }
        const all = [
          ...profile.results.map((r) => `[profile] ${r}`),
          ...knowledge.results.map((r) => `[knowledge] ${r}`),
        ]
        const text = all.length > 0
          ? `Recall results for "${query}":\n${all.join('\n')}`
          : `No memories found for "${query}".`
        logEvent('recall', 'inbox_item', { routine: 'recall', text })
      } catch (err: unknown) {
        logEvent('recall', 'inbox_item', {
          routine: 'recall',
          text: `Recall unavailable (vec server not running?): ${String(err)}`,
        })
      }
    },
  })

  ion.registerCommand('learn', {
    description: 'Store a fact in the knowledge collection. Usage: learn <text>',
    execute: async (args) => {
      const text = args.trim()
      if (!text) {
        logEvent('learn', 'inbox_item', { routine: 'learn', text: 'Usage: /learn <text>' })
        return
      }
      try {
        const res = await fetch(`${VEC_SERVER}/remember`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, collection: 'knowledge', source: 'manual', source_actor: 'user' }),
          signal: AbortSignal.timeout(VEC_TIMEOUT_MS),
        })
        const data = (await res.json()) as { id?: string; error?: string }
        const msg = data.id
          ? `Stored in knowledge (id: ${data.id}): ${text.slice(0, 80)}`
          : `Storage failed: ${data.error ?? 'unknown error'}`
        logEvent('learn', 'inbox_item', { routine: 'learn', text: msg })
      } catch (err: unknown) {
        logEvent('learn', 'inbox_item', {
          routine: 'learn',
          text: `Learn unavailable (vec server not running?): ${String(err)}`,
        })
      }
    },
  })

  ion.registerCommand('forget', {
    description: 'Remove a memory by content match. Usage: forget <text>',
    execute: async (args) => {
      const text = args.trim()
      if (!text) {
        logEvent('forget', 'inbox_item', { routine: 'forget', text: 'Usage: /forget <text>' })
        return
      }
      try {
        const res = await fetch(`${VEC_SERVER}/forget`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, collection: 'knowledge' }),
          signal: AbortSignal.timeout(VEC_TIMEOUT_MS),
        })
        const data = (await res.json()) as { deleted?: boolean; id?: string; reason?: string; error?: string }
        let msg: string
        if (data.error) {
          msg = `Forget failed: ${data.error}`
        } else if (data.deleted) {
          msg = `Removed memory (id: ${data.id}): ${text.slice(0, 80)}`
        } else {
          msg = `No matching memory found for: ${text.slice(0, 80)}`
        }
        logEvent('forget', 'inbox_item', { routine: 'forget', text: msg })
      } catch (err: unknown) {
        logEvent('forget', 'inbox_item', {
          routine: 'forget',
          text: `Forget unavailable (vec server not running?): ${String(err)}`,
        })
      }
    },
  })

  ion.registerCommand('list-memories', {
    description: 'List recent stored memories. Usage: list-memories [collection]',
    execute: async (args) => {
      const collection = args.trim() || 'knowledge'
      const validCollections = ['user_profile', 'knowledge', 'agent_memories']
      if (!validCollections.includes(collection)) {
        logEvent('list-memories', 'inbox_item', {
          routine: 'list-memories',
          text: `Invalid collection. Choose: ${validCollections.join(', ')}`,
        })
        return
      }
      try {
        const res = await fetch(
          `${VEC_SERVER}/list?collection=${encodeURIComponent(collection)}&limit=20`,
          { signal: AbortSignal.timeout(VEC_TIMEOUT_MS) },
        )
        const data = (await res.json()) as {
          entries?: Array<{ id: string; text: string; source: string; stored_at: string }>
          error?: string
        }
        if (data.error) {
          logEvent('list-memories', 'inbox_item', {
            routine: 'list-memories',
            text: `List failed: ${data.error}`,
          })
          return
        }
        const entries = data.entries ?? []
        if (!entries.length) {
          logEvent('list-memories', 'inbox_item', {
            routine: 'list-memories',
            text: `No entries in ${collection}.`,
          })
          return
        }
        const lines = entries.map(
          (e) => `[${e.stored_at.slice(0, 10)}] (${e.source}) ${e.text}`,
        )
        logEvent('list-memories', 'inbox_item', {
          routine: 'list-memories',
          text: `${collection} (${entries.length} entries):\n${lines.join('\n')}`,
        })
      } catch (err: unknown) {
        logEvent('list-memories', 'inbox_item', {
          routine: 'list-memories',
          text: `List unavailable (vec server not running?): ${String(err)}`,
        })
      }
    },
  })

  ion.registerCommand('consolidate', {
    description: 'Deduplicate and consolidate memories (runs all four consolidation jobs).',
    execute: async () => {
      logEvent('consolidate', 'inbox_item', { routine: 'consolidate', text: 'Consolidation started...' })
      try {
        const res = await fetch(`${VEC_SERVER}/consolidate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
          signal: AbortSignal.timeout(120_000),
        })
        const data = (await res.json()) as {
          sessions_summarized?: number
          cross_session_facts?: number
          preferences_merged?: number
          entries_archived?: number
          errors?: string[]
          error?: string
        }
        if (data.error) {
          logEvent('consolidate', 'inbox_item', {
            routine: 'consolidate',
            text: `Consolidation failed: ${data.error}`,
          })
          return
        }
        const errCount = data.errors?.length ?? 0
        const text =
          `Consolidation complete: ` +
          `${data.sessions_summarized ?? 0} sessions summarized, ` +
          `${data.cross_session_facts ?? 0} cross-session facts, ` +
          `${data.preferences_merged ?? 0} preferences merged, ` +
          `${data.entries_archived ?? 0} entries archived` +
          (errCount > 0 ? ` (${errCount} error(s))` : '.')
        logEvent('consolidate', 'inbox_item', { routine: 'consolidate', text })
      } catch (err: unknown) {
        logEvent('consolidate', 'inbox_item', {
          routine: 'consolidate',
          text: `Consolidation unavailable (vec server not running?): ${String(err)}`,
        })
      }
    },
  })

  ion.registerCommand('summary', {
    description: 'Show the latest conversation summary. Usage: summary [daily|weekly|monthly]',
    execute: async (args) => {
      const granularity = args.trim().toLowerCase() || 'daily'
      const valid = ['daily', 'weekly', 'monthly']
      if (!valid.includes(granularity)) {
        logEvent('summary', 'inbox_item', {
          routine: 'summary',
          text: `Invalid granularity "${granularity}". Choose: daily, weekly, monthly`,
        })
        return
      }
      const row = getLatestSummary(granularity)
      if (!row) {
        logEvent('summary', 'inbox_item', {
          routine: 'summary',
          text: `No ${granularity} summary yet.`,
        })
        return
      }
      const start = new Date(row.period_start).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Chicago' })
      const end = new Date(row.period_end).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Chicago' })
      logEvent('summary', 'inbox_item', {
        routine: 'summary',
        text: `${granularity.charAt(0).toUpperCase() + granularity.slice(1)} summary (${start} - ${end}):\n\n${row.summary}`,
      })
    },
  })

  ion.registerCommand('recap', {
    description: 'Show the latest daily conversation summary (alias for /summary daily).',
    execute: async () => {
      const row = getLatestSummary('daily')
      if (!row) {
        logEvent('recap', 'inbox_item', { routine: 'recap', text: 'No daily summary yet.' })
        return
      }
      const start = new Date(row.period_start).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Chicago' })
      const end = new Date(row.period_end).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Chicago' })
      logEvent('recap', 'inbox_item', {
        routine: 'recap',
        text: `Daily summary (${start} - ${end}):\n\n${row.summary}`,
      })
    },
  })

  ion.registerCommand('recall-stats', {
    description: 'Show recall hit counts and top recalled memories.',
    execute: async () => {
      try {
        const res = await fetch(`${VEC_SERVER}/stats`, {
          signal: AbortSignal.timeout(VEC_TIMEOUT_MS),
        })
        const data = (await res.json()) as {
          hits?: Array<{ id: string; count: number }>
          error?: string
        }
        if (data.error) {
          logEvent('recall-stats', 'inbox_item', {
            routine: 'recall-stats',
            text: `Stats failed: ${data.error}`,
          })
          return
        }
        const hits = data.hits ?? []
        if (!hits.length) {
          logEvent('recall-stats', 'inbox_item', {
            routine: 'recall-stats',
            text: 'No recall hits recorded yet.',
          })
          return
        }
        const lines = hits.slice(0, 20).map((h) => `[${h.count}x] ${h.id}`)
        logEvent('recall-stats', 'inbox_item', {
          routine: 'recall-stats',
          text: `Top recalled memories (${hits.length} total):\n${lines.join('\n')}`,
        })
      } catch (err: unknown) {
        logEvent('recall-stats', 'inbox_item', {
          routine: 'recall-stats',
          text: `Stats unavailable (vec server not running?): ${String(err)}`,
        })
      }
    },
  })
}
