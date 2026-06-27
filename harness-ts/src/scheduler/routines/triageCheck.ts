// Daily 12:00 triage check.
// Lists open jarvis repo issues missing a severity label or a milestone
// (excluding ones explicitly marked parked or research) and posts a digest
// to Discord. Keeps the backlog from silently drifting back to unlabeled.

import { log } from 'ion-sdk'
import { logEvent } from '../../memory/episodic'
import { runCommandAsync } from '../../util/ionPrompt'
import { isEnabled } from '../helpers'
import { postToChannel } from '../../discord/webhook'

const REPO = '<your-org>/jarvis'

interface IssueRow {
  number: number
  title: string
  labels: { name: string }[]
  milestone: { title: string } | null
}

export function needsTriage(i: IssueRow): { missingSeverity: boolean; missingMilestone: boolean } | null {
  const names = i.labels.map(l => l.name)
  if (names.includes('parked') || names.includes('research')) return null
  const missingSeverity = !names.some(n => n.startsWith('severity:'))
  const missingMilestone = i.milestone == null
  if (!missingSeverity && !missingMilestone) return null
  return { missingSeverity, missingMilestone }
}

export interface TriageRunDeps {
  fetchIssues?: () => Promise<IssueRow[]>
  post?: (content: string) => Promise<void>
}

async function defaultFetchIssues(): Promise<IssueRow[]> {
  const ghBin = process.env['GH_BIN'] ?? 'gh'
  const r = await runCommandAsync(ghBin, [
    'issue', 'list',
    '--repo', REPO,
    '--state', 'open',
    '--json', 'number,title,labels,milestone',
    '--limit', '500',
  ], { timeoutMs: 30_000 })
  if (r.error || r.status !== 0) {
    throw new Error(`gh issue list failed: ${r.error?.message ?? r.stderr}`)
  }
  return JSON.parse(r.stdout.trim()) as IssueRow[]
}

async function defaultPost(content: string): Promise<void> {
  await postToChannel(content)
}

export async function runTriageCheck(deps: TriageRunDeps = {}): Promise<void> {
  if (!isEnabled('triage_check')) return
  const fetchIssues = deps.fetchIssues ?? defaultFetchIssues
  const post = deps.post ?? defaultPost

  let issues: IssueRow[] = []
  try {
    issues = await fetchIssues()
  } catch (err) {
    log.warn('triage_check: fetch failed', { err: String(err) })
    return
  }

  const flagged: Array<{ n: number; title: string; missing: string[] }> = []
  for (const i of issues) {
    const r = needsTriage(i)
    if (!r) continue
    const missing: string[] = []
    if (r.missingSeverity) missing.push('severity')
    if (r.missingMilestone) missing.push('milestone')
    flagged.push({ n: i.number, title: i.title, missing })
  }

  let content: string
  if (flagged.length === 0) {
    content = `:white_check_mark: Triage check: all ${issues.length} open issues are labeled.`
  } else {
    const header = `:mag: Triage check — ${flagged.length} issue${flagged.length === 1 ? '' : 's'} need labels (of ${issues.length} open).`
    const lines = flagged.slice(0, 30).map(f => {
      const titleTrunc = f.title.length > 80 ? f.title.slice(0, 77) + '...' : f.title
      return `\`#${f.n}\` _(missing ${f.missing.join('+')})_ ${titleTrunc}`
    })
    const extra = flagged.length > 30 ? `\n_(+${flagged.length - 30} more)_` : ''
    content = `${header}\n${lines.join('\n')}${extra}`
  }

  try {
    await post(content)
    logEvent('triage_check', 'routine_delivered', {
      routine: 'triage_check',
      flagged: flagged.length,
      total: issues.length,
    })
  } catch (err) {
    log.warn('triage_check: post failed', { err: String(err) })
  }
}
