// Entity extraction and batching for the findings dispatcher.
// Shadow mode (entity_batching_enabled: false): detect groupings, log them, deliver nothing.
// Live mode (entity_batching_enabled: true): synthesize and return a synthesized FindingRow.

import type { FindingRow } from '../../findings'

// Simple named entity extraction: company tickers (all-caps 1-5 chars), known company names,
// and proper names. Returns lowercase canonical form.
export function extractEntities(text: string): string[] {
  const entities: Set<string> = new Set()

  // Ticker pattern: standalone 2-5 uppercase letters
  const tickerMatches = text.matchAll(/\b([A-Z]{2,5})\b/g)
  for (const m of tickerMatches) {
    const word = m[1]!
    // Filter out common English words that are all-caps (acronyms)
    if (!['THE', 'FOR', 'AND', 'NOT', 'BUT', 'ARE', 'HAS', 'HAD', 'WAS', 'ITS'].includes(word)) {
      entities.add(word.toLowerCase())
    }
  }

  // Company names (title case, 2+ words ending in Corp/Inc/LLC/Ltd or well-known singles)
  const companyMatches = text.matchAll(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*(?:\s+(?:Corp|Inc|LLC|Ltd|Group|Capital|Fund|Technologies?))?)/g)
  for (const m of companyMatches) {
    if (m[1]!.length > 4) entities.add(m[1]!.toLowerCase())
  }

  return [...entities].slice(0, 10)  // cap at 10 per finding
}

export interface EntityGroup {
  entity: string
  findings: FindingRow[]
}

// Group findings by shared entity, within a 30-minute window.
export function groupByEntity(findings: FindingRow[]): EntityGroup[] {
  const windowMs = 30 * 60_000
  const entityMap = new Map<string, FindingRow[]>()

  for (const finding of findings) {
    const entities = extractEntities(`${finding.source} ${finding.content}`)
    for (const entity of entities) {
      if (!entityMap.has(entity)) entityMap.set(entity, [])
      entityMap.get(entity)!.push(finding)
    }
  }

  // Only return groups with 2+ findings, and only where all findings are within 30 min of each other
  const groups: EntityGroup[] = []
  for (const [entity, group] of entityMap) {
    if (group.length < 2) continue
    const times = group.map(f => new Date(f.created_at).getTime())
    const span = Math.max(...times) - Math.min(...times)
    if (span <= windowMs) {
      groups.push({ entity, findings: group })
    }
  }

  return groups
}
