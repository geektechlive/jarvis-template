// Discord event notifications for the autonomy loop.
// All functions wrap postToChannel with rich embeds and degrade gracefully on failure.
//
// Layout follows the ion-ops release-bot style: bold sub-headlines + narrative
// paragraphs + inline-code identifiers. See ./format.ts for the builder.

import { log } from 'ion-sdk'
import { postToChannel } from './webhook'
import { buildRichEmbed, type RichEmbedBullet, type RichEmbedSection } from './format'
import { fetchIssueMetadata, metadataBadges, firstParagraph, type IssueMetadata } from './issueMeta'

const REPO = '<your-org>/jarvis'
const REPO_URL = `https://github.com/${REPO}`

// Color palette for event types
const COLORS = {
  safe: 0x2196F3,        // blue
  risky: 0xFFC107,       // amber
  green: 0x4CAF50,       // success
  red: 0xF44336,         // failure
  gray: 0x9E9E9E,        // neutral
}

// ---------------------------------------------------------------------------
// Opts
// ---------------------------------------------------------------------------

interface PatrolOpenedOpts {
  routine: string
  issueNumber: number
  issueUrl: string
  issueTitle: string
  riskTier: 'safe' | 'risky'
}

interface PatrolClosedOpts {
  routine: string
  issueNumber: number
  issueUrl: string
  reason: string
}

interface PatrolIssueRef {
  number: number
  title: string
  url: string
  riskTier: 'safe' | 'risky'
}

interface PatrolCycleOpts {
  routine: string
  opened: PatrolIssueRef[]
  closed: PatrolIssueRef[]
  openBacklog?: number | undefined
}

export interface ResolverShippedOpts {
  commitSha: string
  commitShort: string
  filesChanged: string[]
  issueNumber: number
  issueUrl: string
  commitSubject?: string
  commitBody?: string
}

interface ResolverAwaitingOpts {
  approvalId: number
  summary: string
  filesChanged: string[]
  issueNumber: number
  issueUrl: string
}

interface DeploySucceededOpts {
  sha: string
  component: string
  durationSec?: number
}

interface DeployFailedOpts {
  sha: string
  component: string
  errorSummary: string
}

interface DeploySkippedOpts {
  sha: string
  reason: string
}

interface ResolverFailedOpts {
  commitSha: string
  commitShort: string
  issueNumber: number
  issueUrl: string
  outcomeSnippet: string
}

export interface ResolverAgentFailedOpts {
  issueNumber: number
  issueUrl: string
  errorSummary: string
  usedSubprocess: boolean
}

export interface ResolverCheckFailedOpts {
  issueNumber: number
  issueUrl: string
  checkOutput: string
}

interface ResolverStartedOpts {
  issueNumber: number
  issueUrl: string
  issueTitle: string
}

interface ResolverNoChangesOpts {
  issueNumber: number
  issueUrl: string
}

interface ResolverAllCappedOpts {
  totalIssues: number
  skippedByFailure: Array<{ number: number; failures: number }>
}

interface ResolverAllPendingOpts {
  eligible: number
}

interface ResolverDirtyWorkspaceOpts {
  files: string
}

interface ResolverDailyCapOpts {
  resolved: number
  cap: number
}

interface ResolverCommitFailedOpts {
  issueNumber: number
  issueUrl: string
  errorSummary: string
}

interface ResolverPushFailedOpts {
  issueNumber: number
  issueUrl: string
  errorSummary: string
}

interface ResolverPostApprovalCheckFailedOpts {
  approvalId: number
  issueNumber: number | null
  issueUrl: string | null
  checkOutput: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shortenTitle(title: string, max = 80): string {
  if (!title) return ''
  return title.length > max ? title.slice(0, max - 1) + '…' : title
}

function filesAsBullets(files: string[], max = 6): RichEmbedBullet[] {
  const head = files.slice(0, max).map(f => ({ label: `\`${f}\`` }))
  if (files.length > max) {
    head.push({ label: `_+${files.length - max} more_` })
  }
  return head
}

function buildResolverNarrative(
  opts: ResolverShippedOpts,
  meta: IssueMetadata | null,
): string {
  const commitBody = opts.commitBody?.trim()
  if (commitBody) {
    const para = firstParagraph(commitBody, 500)
    if (para) return para
  }
  if (meta?.body) {
    const para = firstParagraph(meta.body, 500)
    if (para) return para
  }
  return ''
}

// Some patrol bodies start with a few key:value lines (e.g. "Affected: …\n").
// Strip those when picking a narrative paragraph so the body text reads cleanly.
function patrolBodyForNarrative(body: string): string {
  if (!body) return ''
  const lines = body.split('\n')
  let i = 0
  while (i < lines.length) {
    const l = lines[i] ?? ''
    if (!l.trim()) { i++; continue }
    if (/^[A-Z][a-zA-Z]+: /.test(l)) { i++; continue }   // "Affected: ..."
    break
  }
  return lines.slice(i).join('\n').trim()
}

// ---------------------------------------------------------------------------
// Patrol
// ---------------------------------------------------------------------------

export async function notifyPatrolCycle(opts: PatrolCycleOpts): Promise<void> {
  const { routine, opened, closed, openBacklog } = opts
  if (opened.length === 0 && closed.length === 0) return

  try {
    const anyRisky = opened.some(o => o.riskTier === 'risky')
    const color = anyRisky ? COLORS.risky : COLORS.safe

    const title = `Patrol cycle: ${routine} — opened ${opened.length}, closed ${closed.length}`

    // Build one section per opened issue. Pull metadata in parallel.
    const sections: RichEmbedSection[] = []
    const MAX_SECTIONS = 6
    const slice = opened.slice(0, MAX_SECTIONS)
    const metas = await Promise.all(slice.map(o => fetchIssueMetadata(o.number)))

    for (let idx = 0; idx < slice.length; idx++) {
      const o = slice[idx]!
      const meta = metas[idx] ?? null
      const heading = `#${o.number} — ${shortenTitle(o.title, 100)}`
      const body = meta ? patrolBodyForNarrative(meta.body) : ''
      const badges = metadataBadges(meta)
      const bodyParts: string[] = []
      if (badges.length > 0) bodyParts.push(badges.join(' · '))
      if (body) bodyParts.push(firstParagraph(body, 400))
      bodyParts.push(`${REPO_URL}/issues/${o.number}`)
      sections.push({ heading, body: bodyParts.join('\n') })
    }

    if (opened.length > MAX_SECTIONS) {
      sections.push({
        heading: `+${opened.length - MAX_SECTIONS} more opened`,
        body: `${REPO_URL}/issues?q=label:jarvis-patrol+is:open`,
      })
    }

    const closedBullets: RichEmbedBullet[] = closed.slice(0, 8).map(c => ({
      label: `#${c.number} ${shortenTitle(c.title, 90)}`,
    }))
    if (closed.length > 8) {
      closedBullets.push({ label: `_+${closed.length - 8} more closed_` })
    }

    const embed = buildRichEmbed({
      emoji: '🔍',
      title,
      sectionsHeading: sections.length > 0 ? `Opened (${opened.length})` : undefined,
      sections,
      bulletsHeading: closedBullets.length > 0 ? `Closed (${closed.length})` : undefined,
      bullets: closedBullets.length > 0 ? closedBullets : undefined,
      footerText: openBacklog !== undefined ? `Open backlog: ${openBacklog}` : undefined,
      footerLinks: [
        { name: 'All open patrol issues', url: `${REPO_URL}/issues?q=label:jarvis-patrol+is:open` },
      ],
      color,
    })
    await postToChannel(null, { embed })
  } catch (err) {
    log.warn('discord: notifyPatrolCycle failed', { err: String(err) })
  }
}

// Legacy single-issue wrappers. Kept so existing callers compile; both invoke
// the digest path with a one-item set so the format is consistent.

export async function notifyPatrolOpened(opts: PatrolOpenedOpts): Promise<void> {
  await notifyPatrolCycle({
    routine: opts.routine,
    opened: [{
      number: opts.issueNumber,
      title: opts.issueTitle,
      url: opts.issueUrl,
      riskTier: opts.riskTier,
    }],
    closed: [],
  })
}

export async function notifyPatrolClosed(opts: PatrolClosedOpts): Promise<void> {
  await notifyPatrolCycle({
    routine: opts.routine,
    opened: [],
    closed: [{
      number: opts.issueNumber,
      title: opts.reason,
      url: opts.issueUrl,
      riskTier: 'safe',
    }],
  })
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

export async function notifyResolverShipped(opts: ResolverShippedOpts): Promise<void> {
  try {
    const meta = await fetchIssueMetadata(opts.issueNumber)
    const issueTitle = meta?.title ?? `#${opts.issueNumber}`
    const subtitle = opts.commitSubject?.trim() || `Closed #${opts.issueNumber}`
    const narrative = buildResolverNarrative(opts, meta)

    const embed = buildRichEmbed({
      emoji: '✅',
      title: `Resolver shipped fix for #${opts.issueNumber} — ${shortenTitle(issueTitle)}`,
      subtitle,
      badges: metadataBadges(meta),
      narrative: narrative || undefined,
      bullets: opts.filesChanged.length > 0 ? filesAsBullets(opts.filesChanged) : undefined,
      footerLinks: [
        { name: 'Diff', url: `${REPO_URL}/commit/${opts.commitSha}` },
        { name: 'Issue', url: opts.issueUrl },
      ],
      color: COLORS.green,
    })
    await postToChannel(null, { embed })
  } catch (err) {
    log.warn('discord: notifyResolverShipped failed', { err: String(err) })
  }
}

export async function notifyResolverAwaiting(opts: ResolverAwaitingOpts): Promise<void> {
  try {
    const meta = await fetchIssueMetadata(opts.issueNumber)
    const issueTitle = meta?.title ?? `#${opts.issueNumber}`
    const badges = metadataBadges(meta)
    badges.push(`approval #${opts.approvalId}`)

    const narrative = meta?.body
      ? firstParagraph(patrolBodyForNarrative(meta.body), 500)
      : undefined

    const embed = buildRichEmbed({
      emoji: '⏳',
      title: `Resolver awaiting approval — #${opts.issueNumber} — ${shortenTitle(issueTitle)}`,
      subtitle: opts.summary,
      badges,
      narrative,
      bullets: opts.filesChanged.length > 0 ? filesAsBullets(opts.filesChanged) : undefined,
      footerLinks: [
        { name: 'Approve in Discord', url: `via \`/approve ${opts.approvalId}\` or \`/deny ${opts.approvalId}\`` },
        { name: 'Issue', url: opts.issueUrl },
      ],
      color: COLORS.risky,
    })
    await postToChannel(null, { embed })
  } catch (err) {
    log.warn('discord: notifyResolverAwaiting failed', { err: String(err) })
  }
}

export async function notifyResolverFailed(opts: ResolverFailedOpts): Promise<void> {
  try {
    const meta = await fetchIssueMetadata(opts.issueNumber)
    const issueTitle = meta?.title ?? `#${opts.issueNumber}`
    const snippet = opts.outcomeSnippet?.slice(-800).trim() || '(no output captured)'

    const embed = buildRichEmbed({
      emoji: '❌',
      title: `Resolver's fix broke deploy — #${opts.issueNumber} — ${shortenTitle(issueTitle)}`,
      subtitle: `Commit ${opts.commitShort} reverted; issue reopened`,
      badges: metadataBadges(meta),
      sections: [{ heading: 'Watchdog output (tail)', body: '```\n' + snippet + '\n```' }],
      footerLinks: [
        { name: 'Issue (reopened)', url: opts.issueUrl },
        { name: 'Diff', url: `${REPO_URL}/commit/${opts.commitSha}` },
      ],
      color: COLORS.red,
    })
    await postToChannel(null, { embed })
  } catch (err) {
    log.warn('discord: notifyResolverFailed failed', { err: String(err) })
  }
}

export async function notifyResolverAgentFailed(opts: ResolverAgentFailedOpts): Promise<void> {
  try {
    const meta = await fetchIssueMetadata(opts.issueNumber)
    const issueTitle = meta?.title ?? `#${opts.issueNumber}`
    const subtitle = opts.usedSubprocess
      ? 'Claude CLI subprocess exited with error — label kept, resolver will retry on next cycle'
      : 'Ion dispatch failed — label kept, resolver will retry on next cycle'

    const narrative = meta?.body
      ? firstParagraph(patrolBodyForNarrative(meta.body), 500)
      : undefined

    const bullets = opts.errorSummary
      ? [{ label: `\`\`\`${opts.errorSummary.slice(0, 200)}\`\`\`` }]
      : undefined

    const embed = buildRichEmbed({
      emoji: '⚠️',
      title: `Resolver agent failed — #${opts.issueNumber} — ${shortenTitle(issueTitle)}`,
      subtitle,
      badges: metadataBadges(meta),
      narrative,
      bullets,
      footerLinks: [
        { name: 'Issue', url: opts.issueUrl },
      ],
      color: COLORS.risky,
    })
    await postToChannel(null, { embed })
  } catch (err) {
    log.warn('discord: notifyResolverAgentFailed failed', { err: String(err) })
  }
}

export async function notifyResolverCheckFailed(opts: ResolverCheckFailedOpts): Promise<void> {
  try {
    const meta = await fetchIssueMetadata(opts.issueNumber)
    const issueTitle = meta?.title ?? `#${opts.issueNumber}`

    const embed = buildRichEmbed({
      emoji: '🔴',
      title: `Resolver fix broke checks — #${opts.issueNumber} — ${shortenTitle(issueTitle)}`,
      subtitle: 'Changes rolled back. jarvis-auto label removed. Re-add label once issue is understood.',
      badges: metadataBadges(meta),
      sections: [{ heading: 'make check output (tail)', body: '```\n' + opts.checkOutput.slice(-600) + '\n```' }],
      footerLinks: [
        { name: 'Issue', url: opts.issueUrl },
        { name: 'Open issues', url: `${REPO_URL}/issues?q=label:jarvis-auto+is:open` },
      ],
      color: COLORS.red,
    })
    await postToChannel(null, { embed })
  } catch (err) {
    log.warn('discord: notifyResolverCheckFailed failed', { err: String(err) })
  }
}

export async function notifyResolverStarted(opts: ResolverStartedOpts): Promise<void> {
  try {
    const embed = buildRichEmbed({
      emoji: '🔄',
      title: `Resolver started — #${opts.issueNumber} — ${shortenTitle(opts.issueTitle)}`,
      subtitle: 'Agent is working on a fix. Will report back when done.',
      footerLinks: [{ name: 'Issue', url: opts.issueUrl }],
      color: COLORS.safe,
    })
    await postToChannel(null, { embed })
  } catch (err) {
    log.warn('discord: notifyResolverStarted failed', { err: String(err) })
  }
}

export async function notifyResolverNoChanges(opts: ResolverNoChangesOpts): Promise<void> {
  try {
    const meta = await fetchIssueMetadata(opts.issueNumber)
    const issueTitle = meta?.title ?? `#${opts.issueNumber}`
    const embed = buildRichEmbed({
      emoji: '💭',
      title: `Resolver: agent made no changes — #${opts.issueNumber} — ${shortenTitle(issueTitle)}`,
      subtitle: 'jarvis-auto label removed. Re-add once the issue has enough context for an automated fix.',
      badges: metadataBadges(meta),
      footerLinks: [{ name: 'Issue', url: opts.issueUrl }],
      color: COLORS.gray,
    })
    await postToChannel(null, { embed })
  } catch (err) {
    log.warn('discord: notifyResolverNoChanges failed', { err: String(err) })
  }
}

export async function notifyResolverAllCapped(opts: ResolverAllCappedOpts): Promise<void> {
  try {
    const bullets = opts.skippedByFailure.slice(0, 8).map(i => ({
      label: `#${i.number} — ${i.failures} failures`,
    }))
    if (opts.skippedByFailure.length > 8) {
      bullets.push({ label: `_+${opts.skippedByFailure.length - 8} more_` })
    }
    const embed = buildRichEmbed({
      emoji: '⚠️',
      title: 'Resolver standing down — all issues at failure cap',
      subtitle: `${opts.totalIssues} jarvis-auto issue(s) have each failed ≥3 times. Re-add the label on any issue to reset its count.`,
      bullets: bullets.length > 0 ? bullets : undefined,
      footerLinks: [{ name: 'All jarvis-auto issues', url: `${REPO_URL}/issues?q=label:jarvis-auto+is:open` }],
      color: COLORS.risky,
    })
    await postToChannel(null, { embed })
  } catch (err) {
    log.warn('discord: notifyResolverAllCapped failed', { err: String(err) })
  }
}

export async function notifyResolverAllPending(opts: ResolverAllPendingOpts): Promise<void> {
  try {
    const embed = buildRichEmbed({
      emoji: '⏳',
      title: 'Resolver: all eligible issues awaiting approval',
      subtitle: `${opts.eligible} issue(s) have staged fixes pending Discord approval. Use /approve <id> or /deny <id>.`,
      footerLinks: [{ name: 'Open patrol issues', url: `${REPO_URL}/issues?q=label:jarvis-auto+is:open` }],
      color: COLORS.safe,
    })
    await postToChannel(null, { embed })
  } catch (err) {
    log.warn('discord: notifyResolverAllPending failed', { err: String(err) })
  }
}

export async function notifyResolverDirtyWorkspace(opts: ResolverDirtyWorkspaceOpts): Promise<void> {
  try {
    const embed = buildRichEmbed({
      emoji: '⚠️',
      title: 'Resolver aborted — dirty workspace',
      subtitle: 'Uncommitted changes found in the working tree. Resolver will retry once the workspace is clean.',
      sections: [{ heading: 'Dirty files', body: '```\n' + opts.files.slice(0, 400) + '\n```' }],
      color: COLORS.risky,
    })
    await postToChannel(null, { embed })
  } catch (err) {
    log.warn('discord: notifyResolverDirtyWorkspace failed', { err: String(err) })
  }
}

export async function notifyResolverDailyCap(opts: ResolverDailyCapOpts): Promise<void> {
  try {
    const embed = buildRichEmbed({
      emoji: '💤',
      title: 'Resolver daily cap reached',
      subtitle: `Resolved ${opts.resolved}/${opts.cap} issues today. Will resume tomorrow.`,
      footerLinks: [{ name: 'Resolved today', url: `${REPO_URL}/issues?q=label:jarvis-auto+is:closed` }],
      color: COLORS.gray,
    })
    await postToChannel(null, { embed })
  } catch (err) {
    log.warn('discord: notifyResolverDailyCap failed', { err: String(err) })
  }
}

export async function notifyResolverCommitFailed(opts: ResolverCommitFailedOpts): Promise<void> {
  try {
    const meta = await fetchIssueMetadata(opts.issueNumber)
    const issueTitle = meta?.title ?? `#${opts.issueNumber}`
    const bullets = opts.errorSummary
      ? [{ label: `\`\`\`${opts.errorSummary.slice(0, 300)}\`\`\`` }]
      : undefined
    const embed = buildRichEmbed({
      emoji: '❌',
      title: `Resolver commit failed — #${opts.issueNumber} — ${shortenTitle(issueTitle)}`,
      subtitle: 'Changes discarded. jarvis-auto label removed.',
      badges: metadataBadges(meta),
      bullets,
      footerLinks: [{ name: 'Issue', url: opts.issueUrl }],
      color: COLORS.red,
    })
    await postToChannel(null, { embed })
  } catch (err) {
    log.warn('discord: notifyResolverCommitFailed failed', { err: String(err) })
  }
}

export async function notifyResolverPushFailed(opts: ResolverPushFailedOpts): Promise<void> {
  try {
    const meta = await fetchIssueMetadata(opts.issueNumber)
    const issueTitle = meta?.title ?? `#${opts.issueNumber}`
    const bullets = opts.errorSummary
      ? [{ label: `\`\`\`${opts.errorSummary.slice(0, 300)}\`\`\`` }]
      : undefined
    const embed = buildRichEmbed({
      emoji: '❌',
      title: `Resolver push failed — #${opts.issueNumber} — ${shortenTitle(issueTitle)}`,
      subtitle: 'Local commit reset. jarvis-auto label removed.',
      badges: metadataBadges(meta),
      bullets,
      footerLinks: [{ name: 'Issue', url: opts.issueUrl }],
      color: COLORS.red,
    })
    await postToChannel(null, { embed })
  } catch (err) {
    log.warn('discord: notifyResolverPushFailed failed', { err: String(err) })
  }
}

export async function notifyResolverPostApprovalCheckFailed(opts: ResolverPostApprovalCheckFailedOpts): Promise<void> {
  try {
    const meta = opts.issueNumber != null ? await fetchIssueMetadata(opts.issueNumber) : null
    const footerLinks: Array<{ name: string; url: string }> = []
    if (opts.issueNumber != null && opts.issueUrl != null) {
      footerLinks.push({ name: 'Issue', url: opts.issueUrl })
    }
    footerLinks.push({ name: 'Approvals', url: REPO_URL })
    const embed = buildRichEmbed({
      emoji: '🔴',
      title: `Resolver approval #${opts.approvalId} — make check failed after stash apply`,
      subtitle: 'Stash entry preserved for retry. Approve again once the underlying issue is resolved.',
      badges: meta != null ? metadataBadges(meta) : undefined,
      sections: [{ heading: 'make check output (tail)', body: '```\n' + opts.checkOutput.slice(-600) + '\n```' }],
      footerLinks,
      color: COLORS.red,
    })
    await postToChannel(null, { embed })
  } catch (err) {
    log.warn('discord: notifyResolverPostApprovalCheckFailed failed', { err: String(err) })
  }
}

// ---------------------------------------------------------------------------
// Watchdog / deploy
// ---------------------------------------------------------------------------

export async function notifyDeploySucceeded(opts: DeploySucceededOpts): Promise<void> {
  try {
    const shortSha = opts.sha.length > 7 ? opts.sha.slice(0, 7) : opts.sha
    const duration = opts.durationSec !== undefined ? `${opts.durationSec}s` : 'unknown'

    const embed = buildRichEmbed({
      emoji: '✅',
      title: `Deploy succeeded — ${opts.component} ${shortSha}`,
      subtitle: `Live in ${duration}`,
      footerLinks: [
        { name: 'Commit', url: `${REPO_URL}/commit/${opts.sha}` },
      ],
      color: COLORS.green,
    })
    await postToChannel(null, { embed })
  } catch (err) {
    log.warn('discord: notifyDeploySucceeded failed', { err: String(err) })
  }
}

export async function notifyDeployFailed(opts: DeployFailedOpts): Promise<void> {
  try {
    const shortSha = opts.sha.length > 7 ? opts.sha.slice(0, 7) : opts.sha
    const snippet = (opts.errorSummary ?? '').slice(-800).trim() || '(no error captured)'

    const embed = buildRichEmbed({
      emoji: '❌',
      title: `Deploy failed — ${opts.component} ${shortSha}`,
      sections: [{ heading: 'Error', body: '```\n' + snippet + '\n```' }],
      footerLinks: [
        { name: 'Commit', url: `${REPO_URL}/commit/${opts.sha}` },
      ],
      color: COLORS.red,
    })
    await postToChannel(null, { embed })
  } catch (err) {
    log.warn('discord: notifyDeployFailed failed', { err: String(err) })
  }
}

export async function notifyDeploySkipped(opts: DeploySkippedOpts): Promise<void> {
  try {
    const shortSha = opts.sha.length > 7 ? opts.sha.slice(0, 7) : opts.sha

    const embed = buildRichEmbed({
      emoji: '💤',
      title: `Deploy deferred — ${shortSha}`,
      subtitle: opts.reason,
      footerLinks: [
        { name: 'Commit', url: `${REPO_URL}/commit/${opts.sha}` },
      ],
      color: COLORS.gray,
    })
    await postToChannel(null, { embed })
  } catch (err) {
    log.warn('discord: notifyDeploySkipped failed', { err: String(err) })
  }
}

// ---------------------------------------------------------------------------
// Intervention digest
// ---------------------------------------------------------------------------

interface InterventionDigestOpts {
  stuck: Array<{ number: number; title: string; url: string }>
  pendingApprovals: Array<{ approvalId: number; issueNumber: number | null; issueUrl: string; summary: string }>
  recentFailures: Array<{ issueNumber: number; eventType: string; reasonSnippet: string; createdAt: string }>
}

export async function notifyInterventionDigest(opts: InterventionDigestOpts): Promise<void> {
  const { stuck, pendingApprovals, recentFailures } = opts

  try {
    const sections: RichEmbedSection[] = []

    if (stuck.length > 0) {
      const stuckBullets = stuck.slice(0, 8).map(s => ({
        label: `#${s.number} ${shortenTitle(s.title, 90)}`,
      }))
      if (stuck.length > 8) {
        stuckBullets.push({ label: `_+${stuck.length - 8} more stuck_` })
      }
      const body = stuckBullets.map(b => `• ${b.label}`).join('\n')
      sections.push({
        heading: `Stuck (${stuck.length})`,
        body,
      })
    }

    if (pendingApprovals.length > 0) {
      const approvalBullets: RichEmbedBullet[] = pendingApprovals.slice(0, 8).map(a => {
        const issueRef = a.issueNumber ? `#${a.issueNumber}` : 'no issue'
        return {
          label: `approval #${a.approvalId} — ${issueRef}`,
          description: shortenTitle(a.summary, 60),
        }
      })
      if (pendingApprovals.length > 8) {
        approvalBullets.push({ label: `_+${pendingApprovals.length - 8} more pending_` })
      }
      const body = approvalBullets.map(b => {
        const desc = b.description ? ` — ${b.description}` : ''
        return `• ${b.label}${desc}`
      }).join('\n')
      sections.push({
        heading: `Pending approvals (${pendingApprovals.length})`,
        body,
      })
    }

    if (recentFailures.length > 0) {
      const failureBullets: RichEmbedBullet[] = recentFailures.slice(0, 8).map(f => ({
        label: `#${f.issueNumber}`,
        description: f.reasonSnippet,
      }))
      if (recentFailures.length > 8) {
        failureBullets.push({ label: `_+${recentFailures.length - 8} more failures_` })
      }
      const body = failureBullets.map(b => {
        const desc = b.description ? ` — ${b.description}` : ''
        return `• ${b.label}${desc}`
      }).join('\n')
      sections.push({
        heading: `Recent failures (${recentFailures.length})`,
        body,
      })
    }

    const embed = buildRichEmbed({
      emoji: '🛠️',
      title: 'Intervention digest',
      sections,
      footerLinks: [
        { name: 'All open patrol issues', url: `${REPO_URL}/issues?q=label:jarvis-patrol+is:open` },
      ],
      color: COLORS.gray,
    })
    await postToChannel(null, { embed })
  } catch (err) {
    log.warn('discord: notifyInterventionDigest failed', { err: String(err) })
  }
}
