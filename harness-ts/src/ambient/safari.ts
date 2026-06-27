// Ambient Safari signal aggregation for the morning brief.
//
// Reads `ambient_safari` and `ambient_safari_tabs` rows that the vec-server
// writes when each host's safari-watcher.py POSTs to /ambient/safari. Returns
// a terse domain-aggregated summary so Jarvis can flag "you've been reading X"
// without dumping the URL list itself into the brief.

import { log } from 'ion-sdk'
import { recentEvents } from '../memory/episodic'

interface HistoryDetail {
  url?: string
  title?: string
  visit_ts?: string
  host?: string
  kind?: string
}

interface TabsDetail {
  host?: string
  tabs?: Array<{ url?: string; title?: string }>
  captured_at?: string
}

function hostFromUrl(url: string): string {
  try {
    const u = new URL(url)
    return u.hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return ''
  }
}

interface DomainAgg {
  domain: string
  count: number
  sampleTitle: string
}

export interface SafariSummary {
  totalVisits: number
  domainsAggregated: DomainAgg[]
  openTabsByHost: Array<{ host: string; titles: string[]; capturedAt: string }>
  staleHours: number | null
}

export function summariseSafari(windowHours = 24): SafariSummary {
  const history = recentEvents('ambient', 'ambient_safari', windowHours)
  const tabsRows = recentEvents('ambient', 'ambient_safari_tabs', windowHours)

  const byDomain = new Map<string, DomainAgg>()
  let mostRecentTs: number | null = null
  for (const row of history) {
    const detail = (row.detail as HistoryDetail | null) ?? {}
    const url = String(detail.url ?? '')
    if (!url) continue
    const domain = hostFromUrl(url)
    if (!domain) continue
    const ts = Date.parse(row.ts || '')
    if (!Number.isNaN(ts)) {
      mostRecentTs = mostRecentTs == null ? ts : Math.max(mostRecentTs, ts)
    }
    const existing = byDomain.get(domain)
    if (!existing) {
      byDomain.set(domain, {
        domain,
        count: 1,
        sampleTitle: String(detail.title ?? '').slice(0, 80),
      })
    } else {
      existing.count += 1
      if (!existing.sampleTitle && detail.title) {
        existing.sampleTitle = String(detail.title).slice(0, 80)
      }
    }
  }

  const domains = [...byDomain.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 8)

  const latestTabsByHost = new Map<string, { titles: string[]; capturedAt: string }>()
  for (const row of tabsRows) {
    const detail = (row.detail as TabsDetail | null) ?? {}
    const host = String(detail.host ?? 'unknown')
    const titles = (detail.tabs ?? [])
      .map((t) => String(t.title ?? '').trim())
      .filter(Boolean)
      .slice(0, 6)
    const capturedAt = String(detail.captured_at ?? row.ts ?? '')
    const existing = latestTabsByHost.get(host)
    if (!existing || existing.capturedAt < capturedAt) {
      latestTabsByHost.set(host, { titles, capturedAt })
    }
  }

  const staleHours =
    mostRecentTs == null ? null : Math.floor((Date.now() - mostRecentTs) / 3_600_000)

  return {
    totalVisits: history.length,
    domainsAggregated: domains,
    openTabsByHost: [...latestTabsByHost.entries()].map(([host, v]) => ({
      host,
      titles: v.titles,
      capturedAt: v.capturedAt,
    })),
    staleHours,
  }
}

export function buildAmbientSafariSection(windowHours = 24): string {
  try {
    const summary = summariseSafari(windowHours)
    if (!summary.totalVisits && !summary.openTabsByHost.length) {
      // No data at all — likely the watcher daemons are not running or all
      // hosts are asleep. Flag it so silence doesn't masquerade as nothing
      // happening.
      return 'No browser activity captured in the last 24h. Watcher daemons may be paused.'
    }

    const lines: string[] = []
    if (summary.domainsAggregated.length) {
      const top = summary.domainsAggregated
        .map((d) => {
          const tail = d.sampleTitle ? ` — "${d.sampleTitle}"` : ''
          return `• ${d.domain} (${d.count} visit${d.count === 1 ? '' : 's'})${tail}`
        })
        .join('\n')
      lines.push(`Browsing activity (last ${windowHours}h, ${summary.totalVisits} visits):\n${top}`)
    }
    if (summary.openTabsByHost.length) {
      const tabLines = summary.openTabsByHost.map((h) => {
        const titles = h.titles.length
          ? h.titles.map((t) => `    – ${t}`).join('\n')
          : '    – (no titles captured)'
        return `Open tabs on ${h.host}:\n${titles}`
      })
      lines.push(tabLines.join('\n'))
    }
    if (summary.staleHours != null && summary.staleHours >= 6) {
      lines.push(`(Most recent history entry is ${summary.staleHours}h old.)`)
    }
    return lines.join('\n\n')
  } catch (err) {
    log.warn('ambient/safari: buildAmbientSafariSection failed', { err: String(err) })
    return ''
  }
}
