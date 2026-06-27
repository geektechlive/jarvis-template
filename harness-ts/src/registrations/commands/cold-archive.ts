import type { IonSDK } from 'ion-sdk'
import { logEvent } from '../../memory/episodic'
import { VEC_SERVER, VEC_TIMEOUT_MS } from '../../config/endpoints'

interface ColdResult {
  chroma_id: string
  text: string
  source: string
  stored_at: string
  confidence: number
}

export function registerColdArchiveCommands(ion: IonSDK): void {
  ion.registerCommand('recall-cold', {
    description: 'Search the cold Parquet archive on the NAS for retired memories.',
    execute: async (args) => {
      const query = args.trim()
      if (!query) {
        logEvent('recall-cold', 'inbox_item', { text: 'Usage: /recall-cold <search terms>' })
        return
      }

      let data: { results: ColdResult[]; note?: string }
      try {
        const res = await fetch(`${VEC_SERVER}/cold-archive/recall`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, limit: 10 }),
          signal: AbortSignal.timeout(VEC_TIMEOUT_MS),
        })
        data = (await res.json()) as typeof data
      } catch (err) {
        logEvent('recall-cold', 'inbox_item', {
          text: `Cold archive recall failed: ${String(err)}`,
        })
        return
      }

      if (data.note) {
        logEvent('recall-cold', 'inbox_item', { text: `Cold archive: ${data.note}` })
        return
      }

      const results = data.results ?? []
      if (results.length === 0) {
        logEvent('recall-cold', 'inbox_item', {
          text: `No cold archive matches for "${query}".`,
        })
        return
      }

      const lines = results.map((r, i) => {
        const date = r.stored_at ? r.stored_at.slice(0, 10) : 'unknown'
        return `${i + 1}. [${date}] ${r.text}`
      })
      const summary = `Cold archive -- ${results.length} match${results.length === 1 ? '' : 'es'} for "${query}":\n${lines.join('\n')}`
      logEvent('recall-cold', 'inbox_item', { text: summary })
    },
  })
}
