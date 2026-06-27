// Monthly Netflix viewing history sync routine.
// Invoked by the scheduler every 43200 minutes (30 days).
// Fetches fresh history via ~/bin/netflix-history, reads items from the past
// 35 days, groups them by series/film, and dispatches the Entertainment Advisor
// to update the taste profile in iCloud Drive.

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { IonContext } from 'ion-sdk'
import { log } from 'ion-sdk'
import { logEvent } from '../../memory/episodic'
import { isEnabled, writeInbox } from '../helpers'
import { runCommandAsync } from '../../util/ionPrompt'
import { runClaudeAgent } from '../../util/claudeAgent'
import { getSchedulerCtx } from '../ctx'

// Resolve spec path relative to compiled file location (CommonJS __dirname).
// harness-ts/src/scheduler/routines/netflix.ts -> repo root is 4 levels up.
const ADVISOR_SPEC_PATH = join(__dirname, '..', '..', '..', '..', 'harness', 'agents', 'entertainment-advisor.md')

function loadAdvisorSpec(): string {
  if (!existsSync(ADVISOR_SPEC_PATH)) {
    throw new Error(`Entertainment Advisor spec not found at ${ADVISOR_SPEC_PATH}`)
  }
  const raw = readFileSync(ADVISOR_SPEC_PATH, 'utf8')
  // Strip YAML frontmatter delimited by leading --- ... ---
  const fmMatch = raw.match(/^---\r?\n[\s\S]*?\n---\r?\n/)
  return fmMatch ? raw.slice(fmMatch[0].length).trim() : raw.trim()
}

const ROUTINE = 'netflix_history_sync'
const LOOKBACK_DAYS = 35
const HISTORY_PATH = join(
  homedir(),
  'Library',
  'Mobile Documents',
  'com~apple~CloudDocs',
  'Jarvis',
  'entertainment',
  'netflix-history.jsonl',
)

interface HistoryEntry {
  videoId: number
  title: string
  seriesTitle: string
  episodeTitle: string
  date: string
  durationSecs: number
  percentWatched: number
  fetchedAt: string
}

interface SyncSummary {
  count: number
  outputPath: string
  fetchedAt: string
}

function readRecentEntries(cutoffDate: Date): HistoryEntry[] {
  if (!existsSync(HISTORY_PATH)) return []
  const cutoff = cutoffDate.toISOString().slice(0, 10)
  return readFileSync(HISTORY_PATH, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l) as HistoryEntry
      } catch {
        return null
      }
    })
    .filter((e): e is HistoryEntry => e !== null && e.date >= cutoff)
}

function buildAdvisorPrompt(entries: HistoryEntry[]): string {
  const series: Record<string, HistoryEntry[]> = {}
  const films: HistoryEntry[] = []

  for (const e of entries) {
    if (e.seriesTitle) {
      series[e.seriesTitle] ??= []
      series[e.seriesTitle]!.push(e)
    } else {
      films.push(e)
    }
  }

  const lines: string[] = [
    `Here is my Netflix viewing history from the past ${LOOKBACK_DAYS} days:`,
    '',
  ]

  if (Object.keys(series).length > 0) {
    lines.push('SERIES:')
    for (const [title, eps] of Object.entries(series)) {
      const avgPct = Math.round(eps.reduce((s, e) => s + e.percentWatched, 0) / eps.length)
      lines.push(`- ${title}: ${eps.length} episode${eps.length !== 1 ? 's' : ''} (avg ${avgPct}% watched)`)
    }
    lines.push('')
  }

  if (films.length > 0) {
    lines.push('FILMS:')
    for (const f of films) lines.push(`- ${f.title} (${f.percentWatched}% watched)`)
    lines.push('')
  }

  lines.push(
    'Please update my entertainment taste profile in iCloud Drive and note any new genre or creator patterns. ' +
      'Treat percentWatched < 50% as an abandonment signal. ' +
      'Note any binge patterns (3 or more episodes of the same series on the same date).',
  )

  return lines.join('\n')
}

function readAllEntries(): HistoryEntry[] {
  if (!existsSync(HISTORY_PATH)) return []
  return readFileSync(HISTORY_PATH, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l) as HistoryEntry
      } catch {
        return null
      }
    })
    .filter((e): e is HistoryEntry => e !== null)
}

function buildFullHistoryPrompt(entries: HistoryEntry[]): string {
  const series: Record<string, HistoryEntry[]> = {}
  const films: HistoryEntry[] = []

  for (const e of entries) {
    if (e.seriesTitle) {
      series[e.seriesTitle] ??= []
      series[e.seriesTitle]!.push(e)
    } else {
      films.push(e)
    }
  }

  const lines: string[] = ['Here is my complete Netflix viewing history (all-time):', '']

  if (Object.keys(series).length > 0) {
    lines.push('SERIES:')
    for (const [title, eps] of Object.entries(series)) {
      const dates = eps.map((e) => e.date).sort()
      const earliest = dates[0] ?? ''
      const latest = dates[dates.length - 1] ?? ''
      lines.push(`- ${title}: ${eps.length} episode${eps.length !== 1 ? 's' : ''} (${earliest} to ${latest})`)
    }
    lines.push('')
  }

  if (films.length > 0) {
    lines.push('FILMS:')
    for (const f of films) lines.push(`- ${f.title} (${f.date})`)
    lines.push('')
  }

  lines.push(
    'Please do a comprehensive analysis of my full Netflix history. ' +
      'Build or completely refresh my taste profile in iCloud Drive (taste-profile.json). ' +
      'Identify my preferred genres, creators, themes, and show any binge patterns. ' +
      'Flag any abandoned shows (where I watched some but not all available episodes). ' +
      'This is a one-time full import -- treat it as the authoritative history.',
  )

  return lines.join('\n')
}

export async function runNetflixFullHistoryImport(ctxOverride?: IonContext): Promise<void> {
  log.info('scheduler: netflix_full_import: starting')

  const all = readAllEntries()
  if (all.length === 0) {
    log.warn('scheduler: netflix_full_import: no entries found, skipping')
    return
  }

  const ctx = ctxOverride ?? getSchedulerCtx()
  const advisorSpec = loadAdvisorSpec()
  const fullPrompt = buildFullHistoryPrompt(all)

  if (!ctx) {
    log.warn('scheduler: netflix_full_import: no ctx available, falling back to subprocess')
    await runClaudeAgent('netflix_full_import', `${advisorSpec}\n\n${fullPrompt}`, {
      timeoutMs: 300_000,
    })
    writeInbox(
      'netflix_full_import',
      `Netflix full history import complete (subprocess fallback) -- ${all.length} items processed.`,
    )
    log.info('scheduler: netflix_full_import: complete via subprocess fallback', { total: all.length })
    return
  }

  try {
    await ctx.dispatchAgent({
      name: 'entertainment-advisor',
      task: fullPrompt,
      systemPrompt: advisorSpec,
    })
  } catch (err) {
    log.warn('scheduler: netflix_full_import: dispatchAgent failed', { err: String(err) })
    writeInbox('netflix_full_import', `Netflix full history import failed: ${String(err)}`)
    return
  }

  writeInbox(
    'netflix_full_import',
    `Netflix full history import complete -- ${all.length} items sent to Entertainment Advisor for taste profile build.`,
  )
  log.info('scheduler: netflix_full_import: complete', { total: all.length })
}

export async function runNetflixHistorySync(ctxOverride?: IonContext): Promise<void> {
  if (!isEnabled(ROUTINE)) return
  log.info('scheduler: netflix_history_sync: starting')

  const scriptPath = join(homedir(), 'Jarvis', 'scripts', 'netflix-safari.py')
  const r = await runCommandAsync('/opt/homebrew/bin/uv', ['run', 'python', scriptPath], { timeoutMs: 300_000 })

  if (r.status !== 0 || r.error) {
    const errMsg = (r.stderr.slice(0, 500) || String(r.error ?? 'unknown error')).split('\n')[0] ?? ''
    log.warn('scheduler: netflix_history_sync: fetch failed', { errMsg })
    writeInbox(ROUTINE, `Netflix history sync failed. ${errMsg}`)
    logEvent(ROUTINE, 'routine_delivered', { routine: ROUTINE, exit_code: r.status, error: errMsg })
    return
  }

  let summary: SyncSummary | null = null
  try {
    summary = JSON.parse(r.stdout.trim()) as SyncSummary
  } catch {
    log.warn('scheduler: netflix_history_sync: could not parse fetch output')
  }

  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
  const recent = readRecentEntries(cutoff)
  log.info('scheduler: netflix_history_sync: recent entries', { count: recent.length })

  if (recent.length === 0) {
    writeInbox(ROUTINE, `Netflix history synced -- no new watches in the past ${LOOKBACK_DAYS} days.`)
    logEvent(ROUTINE, 'routine_delivered', { routine: ROUTINE, total: summary?.count ?? 0, recent: 0 })
    return
  }

  const ctx = ctxOverride ?? getSchedulerCtx()
  const advisorSpec = loadAdvisorSpec()

  if (!ctx) {
    log.warn('scheduler: netflix_history_sync: no ctx available, falling back to subprocess')
    const syncPrompt = buildAdvisorPrompt(recent)
    await runClaudeAgent(ROUTINE, `${advisorSpec}\n\n${syncPrompt}`, {
      timeoutMs: 300_000,
    })
    writeInbox(
      ROUTINE,
      `Netflix history synced (subprocess fallback) -- ${recent.length} item${recent.length !== 1 ? 's' : ''} from the past ${LOOKBACK_DAYS} days processed.`,
    )
    logEvent(ROUTINE, 'routine_delivered', { routine: ROUTINE, total: summary?.count ?? 0, recent: recent.length, via: 'subprocess_fallback' })
    log.info('scheduler: netflix_history_sync: complete via subprocess fallback', { recent: recent.length })
    return
  }
  try {
    await ctx.dispatchAgent({
      name: 'entertainment-advisor',
      task: buildAdvisorPrompt(recent),
      systemPrompt: advisorSpec,
    })
  } catch (err) {
    log.warn('scheduler: netflix_history_sync: dispatchAgent failed', { err: String(err) })
    writeInbox(ROUTINE, `Netflix history sync failed during advisor dispatch: ${String(err)}`)
    logEvent(ROUTINE, 'routine_delivered', { routine: ROUTINE, exit_code: -1, error: String(err) })
    return
  }

  writeInbox(
    ROUTINE,
    `Netflix history synced -- ${recent.length} item${recent.length !== 1 ? 's' : ''} from the past ${LOOKBACK_DAYS} days sent to Entertainment Advisor.`,
  )
  logEvent(ROUTINE, 'routine_delivered', { routine: ROUTINE, total: summary?.count ?? 0, recent: recent.length })
  log.info('scheduler: netflix_history_sync: complete', {
    recent: recent.length,
    total: summary?.count ?? 0,
  })
}
