// Enriches a GitHub issue number with labels / milestone / body via `gh issue view`.
// Cached in-process (5 minute TTL) so a patrol cycle that opens multiple
// issues doesn't fan out N gh calls.

import { runCommandAsync } from '../util/ionPrompt'

export interface IssueMetadata {
  number: number
  title: string
  body: string
  labels: string[]
  milestone: string | null
  severity: string | null         // "severity: critical" → "critical"
  area: string | null             // first "area:*" label → "security"
}

const REPO = '<your-org>/jarvis'
const TTL_MS = 5 * 60_000

interface CacheEntry {
  value: IssueMetadata
  expiresAt: number
}

const _cache = new Map<number, CacheEntry>()

export function _resetCache(): void {
  _cache.clear()
}

function deriveSeverity(labels: string[]): string | null {
  const sev = labels.find(l => l.startsWith('severity:'))
  if (!sev) return null
  return sev.slice('severity:'.length).trim()
}

function deriveArea(labels: string[]): string | null {
  const area = labels.find(l => l.startsWith('area:'))
  if (!area) return null
  return area.slice('area:'.length).trim()
}

interface GhJson {
  title: string
  body: string
  labels: { name: string }[]
  milestone: { title: string } | null
}

export async function fetchIssueMetadata(
  issueNumber: number,
  opts?: { now?: () => number; ghBin?: string },
): Promise<IssueMetadata | null> {
  const now = opts?.now ?? Date.now
  const cached = _cache.get(issueNumber)
  if (cached && cached.expiresAt > now()) {
    return cached.value
  }

  const ghBin = opts?.ghBin ?? process.env['GH_BIN'] ?? 'gh'
  let json: GhJson
  try {
    const r = await runCommandAsync(ghBin, [
      'issue', 'view', String(issueNumber),
      '--repo', REPO,
      '--json', 'title,body,labels,milestone',
    ], { timeoutMs: 15_000 })
    if (r.error || r.status !== 0) return null
    json = JSON.parse(r.stdout.trim()) as GhJson
  } catch {
    return null
  }

  const labels = (json.labels ?? []).map(l => l.name)
  const meta: IssueMetadata = {
    number: issueNumber,
    title: json.title ?? '',
    body: json.body ?? '',
    labels,
    milestone: json.milestone?.title ?? null,
    severity: deriveSeverity(labels),
    area: deriveArea(labels),
  }

  _cache.set(issueNumber, { value: meta, expiresAt: now() + TTL_MS })
  return meta
}

// Helper for callers building badges arrays.
export function metadataBadges(meta: IssueMetadata | null): string[] {
  if (!meta) return []
  const out: string[] = []
  if (meta.milestone) out.push(meta.milestone)
  if (meta.severity) out.push(`severity: ${meta.severity}`)
  if (meta.area) out.push(`area: ${meta.area}`)
  return out
}

// Helper: extract the first non-empty paragraph from an issue body (or any
// markdown text). Used as narrative fallback when commit body isn't rich.
export function firstParagraph(text: string, maxChars = 500): string {
  if (!text) return ''
  const paragraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)
  const first = paragraphs[0] ?? ''
  return first.length > maxChars ? first.slice(0, maxChars - 1) + '…' : first
}
