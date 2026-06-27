import { log } from 'ion-sdk'
import { logEvent } from '../../memory/episodic'
import { runCommandAsync } from '../../util/ionPrompt'
import { isEnabled } from '../helpers'

const REPO = '<your-org>/jarvis'

const _MILESTONES: Record<string, string> = {
  'M1 — Reliability & Safety': 'M1 — Reliability & Safety',
  'M2 — Memory & Learning': 'M2 — Memory & Learning',
  'M3 — Staff & Identity': 'M3 — Staff & Identity',
  'M4 — Tools & Integrations': 'M4 — Tools & Integrations',
}

interface GithubIssue {
  number: number
  title: string
  body: string
  milestone: { title: string } | null
  labels: Array<{ name: string }>
}

function classifyMilestone(title: string, body: string): string {
  const content = (title + '\n' + body).toLowerCase()

  if (
    content.includes('harness-ts/src/scheduler/') ||
    content.includes('harness-ts/src/patrol/') ||
    content.includes('scripts/deploy-') ||
    content.includes('harness-ts/src/webhooks/')
  ) {
    return 'M1 — Reliability & Safety'
  }

  if (
    content.includes('harness-ts/src/memory/') ||
    content.includes('harness/memory/') ||
    content.includes('harness-ts/src/learning/') ||
    content.includes('harness-ts/src/reflection/') ||
    content.includes('tools-py/vector-store/')
  ) {
    return 'M2 — Memory & Learning'
  }

  if (
    content.includes('harness/agents/') ||
    content.includes('harness/workers/') ||
    content.includes('harness/identity/') ||
    content.includes('harness/config/staff.yaml') ||
    content.includes('harness/config/persona.yaml')
  ) {
    return 'M3 — Staff & Identity'
  }

  if (
    content.includes('harness-ts/src/tools/') ||
    content.includes('harness-ts/src/registrations/') ||
    content.includes('harness/config/integrations.yaml')
  ) {
    return 'M4 — Tools & Integrations'
  }

  return 'M1 — Reliability & Safety'
}

export async function runMilestoneSweep(): Promise<void> {
  if (!isEnabled('milestone_sweep')) return

  const ghBin = process.env['GH_BIN'] ?? 'gh'

  let issues: GithubIssue[] = []
  try {
    const r = await runCommandAsync(ghBin, [
      'issue', 'list',
      '--repo', REPO,
      '--state', 'open',
      '--label', 'jarvis-patrol',
      '--limit', '200',
      '--json', 'number,title,body,milestone,labels',
    ], { timeoutMs: 30_000 })
    if (r.error) {
      log.warn('scheduler: milestone_sweep: gh issue list error', { err: String(r.error) })
      return
    }
    issues = JSON.parse(r.stdout.trim()) as GithubIssue[]
  } catch (err) {
    log.warn('scheduler: milestone_sweep: failed to fetch issues', { err: String(err) })
    return
  }

  const unmilestoned = issues.filter((i) => i.milestone === null)
  if (unmilestoned.length === 0) {
    log.info('scheduler: milestone_sweep: no unmilestoned issues')
    logEvent('milestone_sweep', 'routine_delivered', { routine: 'milestone_sweep', checked: 0, assigned: 0, skipped: 0, errors: 0 })
    return
  }

  let assigned = 0
  let errors = 0

  for (const issue of unmilestoned) {
    const milestone = classifyMilestone(issue.title, issue.body)
    try {
      await runCommandAsync(ghBin, [
        'issue', 'edit', String(issue.number),
        '--repo', REPO,
        '--milestone', milestone,
      ], { timeoutMs: 30_000 })
      assigned++
    } catch (err) {
      log.warn('scheduler: milestone_sweep: failed to set milestone', { issue: issue.number, err: String(err) })
      errors++
    }
  }

  log.info('scheduler: milestone_sweep: complete', { checked: unmilestoned.length, assigned, errors })
  logEvent('milestone_sweep', 'routine_delivered', {
    routine: 'milestone_sweep',
    checked: unmilestoned.length,
    assigned,
    skipped: unmilestoned.length - assigned - errors,
    errors,
  })
}
