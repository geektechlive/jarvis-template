// Calendar- and communication-heavy routines for the proactive scheduler.
// Routines: morning_brief, midday_checkin, evening_journal, meeting_prep, comms_pulse.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { log } from 'ion-sdk'
import { HARNESS_DIR, CONTACTS_PATH, loadDiscordConfig } from '../../config'
import { getTodayEventsStr, getUpcomingEvents } from '../../tools/calendar'
import { drain } from '../../inbox'
import { logEvent, pendingActions, recentEvents, storePendingBrief, getActiveGoalIds, getLatestSummary } from '../../memory/episodic'
import { buildAmbientSafariSection } from '../../ambient/safari'
import { runCommandAsync, runIonPrompt } from '../../util/ionPrompt'
import { runClaudeAgent } from '../../util/claudeAgent'
import { dispatchStaff } from '../../staff/dispatch'
import { getSchedulerCtx } from '../ctx'
import { publishBriefing } from '../../resources/briefings'
import { postLongEmbed } from '../../discord/webhook'
import { truncateWords } from '../../discord/format'
import {
  isEnabled,
  shouldRunPrompt,
  parseContactsYaml,
  OBSERVER_DECISION_FRAMEWORK,
  type BriefSection,
  type BriefMessage,
} from '../helpers'

// ---------------------------------------------------------------------------
// Brief builder
// ---------------------------------------------------------------------------

export type { BriefSection, BriefMessage }

const SECTION_EMOJI: Record<string, string> = {
  'Inbox Digest':        '📬',
  'Staff Activity':      '👥',
  'Calendar':            '📅',
  'Overnight Commits':   '🔨',
  'Recent Mail Context': '📧',
  'Mail':                '📧',
  'Recent Files':        '📁',
  'Ambient signals':     '🌐',
  'Open Items':          '📋',
  'Portfolio':           '📈',
  'Goals':               '🎯',
  'Comms':               '📡',
  'Commitments':         '✅',
  'Reminders':           '🔔',
}

function formatCommitLine(line: string): string {
  // • abcdef1 feat(scope): message  →  • `abcdef1` **feat(scope)** — message
  const m = /^(• ?)([0-9a-f]{7,10}) ([\w()/-]+): (.+)/.exec(line)
  if (m) return `${m[1]}\`${m[2]}\` **${m[3]}** — ${m[4]}`
  return line
}

function formatBulletLine(line: string): string {
  // • Lead -- rest  or  • Lead — rest  →  • **Lead** — rest
  const m = /^(• ?)(.+?) (?:--|—) (.+)/.exec(line)
  if (m) return `${m[1]}**${m[2]}** — ${m[3]}`
  return line
}

function formatSectionContent(title: string, content: string): string {
  const lines = content.split('\n')
  if (title === 'Overnight Commits') {
    return lines.map(formatCommitLine).join('\n')
  }
  return lines.map(formatBulletLine).join('\n')
}

/**
 * Render brief sections as Discord-native markdown:
 * section headers become ## EMOJI **Title**, commit hashes get inline code,
 * bullet items with a dash separator get a bold lead.
 */
export function formatBriefForDiscord(sections: BriefSection[]): string {
  return sections.map((s) => {
    const emoji = SECTION_EMOJI[s.title] ?? '📌'
    const header = `## ${emoji} **${s.title}**`
    const content = formatSectionContent(s.title, s.content)
    return `${header}\n${content}`
  }).join('\n\n')
}

export function makeBrief(sections: BriefSection[]): BriefMessage {
  return {
    sections,
    generatedAt: new Date(),
    get text() {
      if (!sections.length) return 'Nothing to report this morning.'
      return sections.map((s) => `*${s.title}*\n${s.content}`).join('\n\n')
    },
  }
}

// ---------------------------------------------------------------------------
// Content-hash helpers (used only by runCommsPulse)
// ---------------------------------------------------------------------------

function simpleHash(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  }
  return h.toString(36)
}

// Tracks the last mail payload hash so comms_pulse skips dispatch when no new
// mail has arrived. Resets on daemon restart (first post-restart pulse always fires).
let _lastMailPayloadHash = ''

// Brief composition template appended to the delivery inject so the brief stays
// richly structured regardless of how much persona context a given turn loads.
// (#800 follow-up: the 06-17 brief collapsed to flat bullets after the per-turn
// persona was trimmed; this decouples brief structure from those trims.)
export const BRIEF_FORMAT_TEMPLATE =
  ' Compose it to be scannable, matching a well-structured brief even on a light day:\n' +
  '- Open with one lead line on the single most important item.\n' +
  '- Group into labeled sections with headers; put HIGH-priority or at-risk items first, each as a tight what + why (one or two lines).\n' +
  '- Keep section headers even when a section is short -- never collapse the brief into a flat, unlabeled bullet list.\n' +
  '- Include a short Headlines line (2-3 current items) when there is notable news.\n' +
  '- Do not pad a quiet day, but never silently drop the structure -- "Nothing notable" under the header beats omitting the section.'

// ---------------------------------------------------------------------------
// Dispatch helpers
// ---------------------------------------------------------------------------

// Dispatch Portfolio Manager for a one-line read and capture the response.
// Returns the one-liner or empty string if the dispatch fails or returns nothing.
// Used by morning brief and midday checkin to add a Portfolio section.
export async function fetchPortfolioOneLiner(prompt: string): Promise<string> {
  const ctx = getSchedulerCtx()
  if (ctx) {
    try {
      // maxTurns 6 (was 3): the one-liner still requires Read holdings -> fetch
      // news/quotes on held tickers -> synthesize, which overruns a 3-turn budget
      // and surfaces as a dispatch error / empty Portfolio section (#800).
      const r = await dispatchStaff(ctx, 'portfolio-manager', prompt, { maxTurns: 6 })
      return r.output.trim().split('\n')[0]?.trim() ?? ''
    } catch {
      return ''
    }
  }
  const ionBin = process.env['ION_BIN'] ?? 'ion'
  try {
    const r = await runCommandAsync(
      ionBin,
      ['prompt', '--key', 'jarvis', prompt, '--attach'],
      { timeoutMs: 90_000 },
    )
    return r.status === 0 ? r.stdout.trim().split('\n')[0]?.trim() ?? '' : ''
  } catch {
    return ''
  }
}

// Dispatch Chief of Communications for a brief comms summary.
// Returns the summary text or empty string on failure.
// Used by morning brief and midday checkin to add a Comms section.
export async function fetchCommsSummary(prompt: string): Promise<string> {
  const ctx = getSchedulerCtx()
  if (ctx) {
    try {
      const r = await dispatchStaff(ctx, 'chief-of-communications', prompt, { maxTurns: 5 })
      return r.output.trim()
    } catch {
      return ''
    }
  }
  const ionBin = process.env['ION_BIN'] ?? 'ion'
  try {
    const r = await runCommandAsync(
      ionBin,
      ['prompt', '--key', 'jarvis', prompt, '--attach'],
      { timeoutMs: 60_000 },
    )
    return r.status === 0 ? r.stdout.trim() : ''
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// Staff activity digest
// ---------------------------------------------------------------------------

function buildStaffActivitySection(): string | null {
  const OBSERVER_ROUTINES = [
    { id: 'comms_pulse', label: 'Chief of Communications' },
    { id: 'wellness_checkin', label: 'Wellness Coach' },
    { id: 'cfo_watch', label: 'Personal CFO' },
    { id: 'tech_advisor_watch', label: 'Tech Advisor' },
    { id: 'portfolio_watch', label: 'Portfolio Manager' },
    { id: 'github_watch', label: 'Repo Steward' },
    { id: 'infra_watch', label: 'Systems Engineer' },
    { id: 'weekly_newsdesk', label: 'News Desk' },
  ] as const
  const WINDOW_HOURS = 168  // 7 days

  const urgentItems = recentEvents('surface_to_inbox', 'inbox_item', WINDOW_HOURS)
  const lines: string[] = []
  let anyRuns = false

  for (const { id, label } of OBSERVER_ROUTINES) {
    const runs = recentEvents(id, 'routine_started', WINDOW_HOURS)
    if (!runs.length) continue
    anyRuns = true

    const last = runs[runs.length - 1]!
    const lastDate = new Date(last.ts)
    const dayName = lastDate.toLocaleDateString('en-US', { weekday: 'short' })
    const hh = String(lastDate.getHours()).padStart(2, '0')
    const mm = String(lastDate.getMinutes()).padStart(2, '0')
    const runStr = id === 'comms_pulse' ? 'active' : runs.length === 1 ? '1 run' : `${runs.length} runs`

    const urgentCount = urgentItems.filter((item) => {
      const detail = item.detail as { routine?: string } | null
      return detail?.routine === id
    }).length

    const flag = urgentCount > 0
      ? `${urgentCount} urgent flag${urgentCount > 1 ? 's' : ''}`
      : 'nothing urgent'
    lines.push(`• ${label} — ${runStr}, last ${dayName} ${hh}:${mm}: ${flag}`)
  }

  if (!anyRuns) return null
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Routine implementations
// ---------------------------------------------------------------------------

export async function runMorningBrief(onDemand = false): Promise<void> {
  if (!onDemand && !isEnabled('morning_brief')) return
  const sections: BriefSection[] = []
  const goalIds = getActiveGoalIds()

  // Inbox digest
  try {
    const items = drain(20)
    if (items.length) {
      if (items.length >= 5) {
        // Many items queued — build a synthesis summary instead of a bullet list
        const urgent = items.filter(i => i.score >= 0.7)
        const urgentLines = urgent.length
          ? urgent.map((i) => `• [${i.source}] ${truncateWords(i.content, 200)}`).join('\n')
          : 'None.'
        const summary =
          `${items.length} items accumulated since last session. ` +
          `${urgent.length} crossed the urgency threshold.\n\n` +
          `**High priority:**\n${urgentLines}\n\n` +
          `Remaining ${items.length - urgent.length} low-priority items are available on request.`
        sections.push({ title: 'Inbox Digest', content: summary })
      } else {
        const lines = items.map((i) => `• [${i.source}] ${truncateWords(i.content, 200)}`)
        sections.push({ title: 'Inbox Digest', content: lines.join('\n') })
      }
    }
  } catch (err) {
    log.warn('scheduler: morning_brief inbox drain failed', { err: String(err) })
  }

  // Staff activity digest
  try {
    const staffActivity = buildStaffActivitySection()
    if (staffActivity && staffActivity.includes('urgent flag')) {
      sections.push({ title: 'Staff Activity', content: staffActivity })
    }
  } catch (err) {
    log.warn('scheduler: morning_brief staff activity failed', { err: String(err) })
  }

  // Calendar
  try {
    const events = await getTodayEventsStr()
    if (events && !events.startsWith('Calendar') && !events.includes('No events')) {
      sections.push({ title: 'Calendar', content: events })
    }
  } catch (err) {
    log.warn('scheduler: morning_brief calendar failed', { err: String(err) })
  }

  // Overnight commits
  try {
    const r = await runCommandAsync(
      'git', ['log', '--oneline', '--since=12 hours ago', '--all'],
      { cwd: HARNESS_DIR, timeoutMs: 10_000 },
    )
    const commits = r.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    if (commits.length) {
      sections.push({
        title: 'Overnight Commits',
        content: commits.slice(0, 10).map((c) => `• ${c}`).join('\n'),
      })
    }
  } catch (err) {
    log.warn('scheduler: morning_brief commits failed', { err: String(err) })
  }

  // Yesterday's conversation summary (daily digest if within 36h)
  try {
    const yesterday = getLatestSummary('daily')
    if (yesterday && (Date.now() - new Date(yesterday.period_end).getTime()) < 36 * 60 * 60 * 1000) {
      sections.push({ title: 'Yesterday', content: yesterday.summary })
    }
  } catch (err) {
    log.warn('scheduler: morning_brief yesterday summary failed', { err: String(err) })
  }

  // Historical mail context from semantic memory
  try {
    const { recallMeta, formatRecalledMemory } = await import('../../memory/recall')
    const mailMemory = await recallMeta('email correspondence commitments projects people', 'knowledge', 5, goalIds.length ? goalIds : undefined)
    const mailItems = mailMemory.results.filter(
      (r) => typeof r.source === 'string' && r.source.startsWith('mail') && (r.age_days ?? 9999) <= 30,
    )
    if (mailItems.length > 0) {
      const formatted = formatRecalledMemory(mailItems)
      sections.push({ title: 'Recent Mail Context', content: formatted })
    }
  } catch (err) {
    log.warn('scheduler: morning_brief historical mail recall failed', { err: String(err) })
  }

  // Mail / Comms summary via Chief of Communications
  try {
    const commsSummary = await fetchCommsSummary(
      'Dispatch Chief of Communications for the morning mail summary. ' +
      'She should check unread mail across both inboxes (recent 10), cluster by sender or topic, ' +
      'lead with anything time-sensitive or unusual. 3-7 bullets max. No preamble. ' +
      'After triage of each email, for any email containing a substantive fact, decision, event, or person mention, store a factual extract to semantic memory via POST http://127.0.0.1:9876/remember using the schema in her agent spec.',
    )
    if (commsSummary) {
      sections.push({ title: 'Mail', content: commsSummary })
    }
  } catch (err) {
    log.warn('scheduler: morning_brief comms summary failed', { err: String(err) })
  }

  // Recent files (Downloads, Documents, iCloud Drive)
  try {
    const home = process.env['HOME'] ?? '/Users/<username>'
    const filesCheck = await runCommandAsync(
      `${home}/bin/files-check`,
      ['--hours', '24', '--limit', '10'],
      { timeoutMs: 15_000 },
    )
    const filesOut = filesCheck.stdout.trim()
    if (filesOut && filesCheck.status === 0 && !filesOut.startsWith('No recent')) {
      sections.push({ title: 'Recent Files', content: filesOut })
    }
  } catch (err) {
    log.warn('scheduler: morning_brief files check failed', { err: String(err) })
  }

  // Ambient signals — Safari history + open tabs since last morning brief.
  try {
    const ambient = buildAmbientSafariSection(24)
    if (ambient) {
      sections.push({ title: 'Ambient signals', content: ambient })
    }
  } catch (err) {
    log.warn('scheduler: morning_brief ambient signals failed', { err: String(err) })
  }

  // Pending auto/improve branches
  try {
    const r = await runCommandAsync('git', ['branch', '--list', 'auto/improve-*'], {
      cwd: HARNESS_DIR,
      timeoutMs: 10_000,
    })
    const branches = r.stdout
      .split('\n')
      .map((l) => l.trim().replace(/^\* /, ''))
      .filter(Boolean)
    if (branches.length) {
      sections.push({
        title: 'Open Items',
        content: branches.map((b) => `• Pending self-improvement: ${b}`).join('\n'),
      })
    }
  } catch (err) {
    log.warn('scheduler: morning_brief open items failed', { err: String(err) })
  }

  // Portfolio pre-market read (silently omitted on failure or empty result)
  try {
    const portfolioLine = await fetchPortfolioOneLiner(
      'Dispatch Portfolio Manager for a one-line pre-market read on holdings. ' +
      'One sentence only. No preamble.',
    )
    if (portfolioLine) {
      sections.push({ title: 'Portfolio', content: portfolioLine })
    }
  } catch (err) {
    log.warn('scheduler: morning_brief portfolio failed', { err: String(err) })
  }

  if (!sections.length) {
    log.info('scheduler: morning_brief no sections, skipping delivery')
    logEvent('morning_brief', 'routine_delivered', { routine: 'morning_brief', sections: 0 })
    return
  }

  const brief = makeBrief(sections)
  storePendingBrief(brief.text)
  publishBriefing(brief.text, 'Morning Brief').catch((err: unknown) => {
    log.warn('scheduler: morning_brief resource publish failed', { err: String(err) })
  })

  // Discord primary delivery
  const discordConfig = loadDiscordConfig()
  if (discordConfig?.proactive_webhook_keychain_service) {
    await postLongEmbed(formatBriefForDiscord(brief.sections), 'Morning Brief', 0x5865F2, discordConfig.proactive_webhook_keychain_service).catch((err: unknown) => {
      console.warn('[morning_brief] Discord delivery failed:', err)
    })
  }

  await runIonPrompt('morning_brief_inject', 'Deliver the morning brief now.' + BRIEF_FORMAT_TEMPLATE)
  log.info('scheduler: morning_brief delivered', { sections: sections.length })
  logEvent('morning_brief', 'routine_delivered', {
    routine: 'morning_brief',
    sections: sections.length,
  })
}

export async function runMiddayCheckin(): Promise<void> {
  if (!isEnabled('midday_checkin')) return
  const sections: BriefSection[] = []

  // Portfolio intraday read (silently omitted on failure or empty result)
  try {
    const portfolioLine = await fetchPortfolioOneLiner(
      'Dispatch Portfolio Manager for a one-line intraday read on holdings. ' +
      'One sentence: any movers since open or breaking news on a held ticker. ' +
      'If nothing notable, say so in one sentence.',
    )
    if (portfolioLine) {
      sections.push({ title: 'Portfolio', content: portfolioLine })
    }
  } catch (err) {
    log.warn('scheduler: midday_checkin portfolio failed', { err: String(err) })
  }

  // Comms check since morning (silently omitted on failure or empty result)
  try {
    const commsLine = await fetchCommsSummary(
      'Dispatch Chief of Communications for a one-line midday comms check. ' +
      'One sentence: anything notable in mail or other active channels since the morning brief. ' +
      'If nothing notable, say nothing -- return empty.',
    )
    if (commsLine) {
      sections.push({ title: 'Comms', content: commsLine })
    }
  } catch (err) {
    log.warn('scheduler: midday_checkin comms failed', { err: String(err) })
  }

  const pending = pendingActions()
  const unresolved = pending.filter(
    (a) => a['action'] === 'triage_question' || a['action'] === 'triage_review',
  )

  if (unresolved.length) {
    const lines = [`Unresolved items (${unresolved.length}):`]
    for (const item of unresolved) {
      const action = String(item['action'] ?? 'unknown')
      let snippet = ''
      try {
        const payload = JSON.parse(String(item['payload'] ?? '{}')) as Record<string, unknown>
        snippet = truncateWords(String(payload['content'] ?? ''), 80)
      } catch { /* ignore */ }
      lines.push(`  ${action}${snippet ? ` -- ${snippet}` : ''}`)
    }
    sections.push({ title: 'Open Items', content: lines.join('\n') })
  }

  if (!sections.length) {
    log.info('scheduler: midday_checkin no content to deliver')
    logEvent('midday_checkin', 'routine_delivered', { routine: 'midday_checkin', count: 0 })
    return
  }

  const midday = makeBrief(sections)
  storePendingBrief(midday.text)
  publishBriefing(midday.text, 'Midday Check-in').catch((err: unknown) => {
    log.warn('scheduler: midday_checkin resource publish failed', { err: String(err) })
  })

  // Discord primary delivery
  const discordConfig = loadDiscordConfig()
  if (discordConfig?.proactive_webhook_keychain_service) {
    await postLongEmbed(formatBriefForDiscord(midday.sections), 'Midday Check-in', 0x57F287, discordConfig.proactive_webhook_keychain_service).catch((err: unknown) => {
      console.warn('[midday_checkin] Discord delivery failed:', err)
    })
  }

  await runIonPrompt('midday_checkin_inject', 'Deliver the midday check-in now.')
  log.info('scheduler: midday_checkin delivered', { sections: sections.length })
  logEvent('midday_checkin', 'routine_delivered', {
    routine: 'midday_checkin',
    count: sections.length,
  })
}

export async function runMeetingPrep(): Promise<void> {
  if (!isEnabled('meeting_prep')) return

  const upcoming = await getUpcomingEvents(10)
  if (!upcoming.length) return

  const goalIds = getActiveGoalIds()
  const now = new Date()
  for (const event of upcoming) {
    // Dedup: skip if we already prepped this start_time+title in the last 24h
    const recent = recentEvents('meeting_prep', 'meeting_prepped', 24)
    const alreadyDone = recent.some((row) => {
      const d = row.detail as Record<string, unknown> | null
      return d?.['start_time'] === event.start_time && d?.['title'] === event.title
    })
    if (alreadyDone) continue

    // Recall personal context for names/topics in the event title
    let personalContext = ''
    try {
      const { recall } = await import('../../memory/recall')
      const title = event.title ?? ''
      if (title.trim()) {
        const { results } = await recall(`personal context for: ${title}`, 'user_profile', 4, goalIds.length ? goalIds : undefined)
        if (results.length) {
          personalContext = '\n\nPersonal context:\n' + results.map((m) => `- ${m}`).join('\n')
        }
      }
    } catch { /* recall failure is non-fatal */ }

    // Contacts lookup: find contacts whose name appears as a word in the event title
    let contactsContext = ''
    try {
      const contactsPath = CONTACTS_PATH
      const contactsRaw = readFileSync(contactsPath, 'utf8')
      const contacts = parseContactsYaml(contactsRaw)
      const title = event.title ?? ''
      const titleLower = title.toLowerCase()
      const matched: string[] = []
      for (const contact of contacts) {
        const nameLower = contact.name.toLowerCase()
        // Match any word-length token from the contact name against the event title.
        // Use word boundaries to avoid false matches (e.g. "Sam" inside "Samsung").
        const tokens = nameLower.split(/\s+/).filter((t) => t.length >= 2)
        const hits = tokens.some((token) => {
          const re = new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
          return re.test(titleLower)
        })
        if (hits) {
          const parts: string[] = [`${contact.name} (${contact.relationship ?? 'contact'}`]
          if (contact.last_seen) parts[0] += `, last seen ${contact.last_seen}`
          parts[0] += ')'
          const detail: string[] = []
          if (contact.notes) detail.push(contact.notes)
          if (contact.preferences?.length) detail.push(contact.preferences.join('; '))
          matched.push(parts[0] + (detail.length ? `: ${detail.join(' ')}` : ''))
        }
      }
      if (matched.length) {
        contactsContext = '\n\nContacts:\n' + matched.map((m) => `- ${m}`).join('\n')
      }
    } catch { /* contacts.yaml missing or parse failure is non-fatal */ }

    const text = `Meeting in ~15 minutes: ${event.title} at ${event.start_time}${personalContext}${contactsContext}`

    // Discord delivery
    const discordConfig = loadDiscordConfig()
    if (discordConfig?.proactive_webhook_keychain_service) {
      await postLongEmbed(text, `Meeting: ${event.title ?? 'Upcoming'}`, 0xFEE75C, discordConfig.proactive_webhook_keychain_service).catch((err: unknown) => {
        console.warn('[meeting_prep] Discord delivery failed:', err)
      })
    }

    logEvent('meeting_prep', 'meeting_prepped', {
      title: event.title,
      start_time: event.start_time,
      prepped_at: now.toISOString(),
    })
    log.info('scheduler: meeting_prep delivered', { title: event.title })
  }
}

export async function runEveningJournal(): Promise<void> {
  if (!isEnabled('evening_journal')) return
  const ionBin = process.env['ION_BIN'] ?? 'ion'
  try {
    const r = await runCommandAsync(
      ionBin,
      [
        'prompt', '--key', 'jarvis',
        'Evening journal. In 3-5 bullet points, what is worth remembering from today? ' +
        'Focus on: people interacted with, decisions made, things learned, things left open, anything notable. ' +
        'Be specific and personal. Terse bullets only.',
        '--attach',
      ],
      { timeoutMs: 60_000 },
    )
    if (r.status !== 0 || !r.stdout.trim()) {
      log.warn('scheduler: evening_journal empty response')
      return
    }

    const dateStr = new Date().toISOString().slice(0, 10)
    const journalDir = join(homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'Jarvis', 'journal')
    const journalPath = join(journalDir, `${dateStr}.md`)

    const { mkdirSync, writeFileSync, existsSync, readFileSync: readFS } = await import('node:fs')
    try { mkdirSync(journalDir, { recursive: true }) } catch { /* already exists */ }

    const existing = existsSync(journalPath) ? readFS(journalPath, 'utf8') : ''
    const entry = existing
      ? `${existing}\n\n---\n\n${r.stdout.trim()}`
      : `# Journal ${dateStr}\n\n${r.stdout.trim()}`
    writeFileSync(journalPath, entry, 'utf8')
    const journalText = r.stdout.trim()
    storePendingBrief(journalText)
    publishBriefing(journalText, 'Evening Journal').catch((err: unknown) => {
      log.warn('scheduler: evening_journal resource publish failed', { err: String(err) })
    })

    // Discord delivery
    const discordConfig = loadDiscordConfig()
    if (discordConfig?.proactive_webhook_keychain_service) {
      await postLongEmbed(journalText, 'Evening Journal', 0xEB459E, discordConfig.proactive_webhook_keychain_service).catch((err: unknown) => {
        console.warn('[evening_journal] Discord delivery failed:', err)
      })
    }

    log.info('scheduler: evening_journal written', { path: journalPath })
    logEvent('evening_journal', 'routine_delivered', { routine: 'evening_journal', path: journalPath })
    await runIonPrompt('evening_journal_inject', 'Deliver the evening journal now.')
  } catch (err) {
    log.warn('scheduler: evening_journal failed', { err: String(err) })
  }
}

export async function runCommsPulse(): Promise<void> {
  if (!isEnabled('comms_pulse')) return
  if (!shouldRunPrompt('comms_pulse')) return
  const home = process.env['HOME'] ?? '/Users/<username>'
  let mailCache = ''
  try {
    const r = await runCommandAsync(`${home}/bin/mail-check`, ['--recent', '5', '--json'], { timeoutMs: 30_000 })
    if (r.status === 0 && r.stdout.trim()) mailCache = r.stdout.trim()
  } catch { /* mail unavailable; proceed without cache */ }

  // Skip dispatch if mail payload is identical to the previous pulse. Prevents
  // repeated agent calls and session-journal noise when no new mail has arrived.
  if (mailCache) {
    const hash = simpleHash(mailCache)
    if (hash === _lastMailPayloadHash) {
      log.info('scheduler: comms_pulse skipped (mail payload unchanged)')
      return
    }
    _lastMailPayloadHash = hash
  }

  const cacheNote = mailCache
    ? `Pre-fetched mail data (use this; do not re-run mail-check):\n${mailCache.slice(0, 3000)}\n\n`
    : 'Mail pre-fetch unavailable this pulse. '

  const commsTask =
    `Standing comms pulse. ${cacheNote}` +
    'Classify and summarize the above mail for anything material. ' +
    'If something urgent landed, surface_to_inbox immediately. ' +
    'If something notable but not urgent, queue_for_brief. ' +
    'If nothing material arrived, stand down silently. ' +
    'After triage of each email, for any email containing a substantive fact, decision, event, or person mention, store a factual extract to semantic memory via POST http://127.0.0.1:9876/remember using the schema in your agent spec. ' +
    OBSERVER_DECISION_FRAMEWORK +
    '\n\nIf nothing material found: respond with exactly the single word "Clear" and nothing else. ' +
    'No narration. No "standing down". No email count summary unless there is a specific action item.'

  const schedulerCtx = getSchedulerCtx()
  if (schedulerCtx) {
    try {
      await dispatchStaff(schedulerCtx, 'chief-of-communications', commsTask, { maxTurns: 10 })
      logEvent('comms_pulse', 'routine_delivered', { routine: 'comms_pulse', exit_code: 0 })
      return
    } catch (err) {
      if (String(err).includes('dispatch not available')) {
        log.info('scheduler: comms_pulse: ion dispatch unavailable in async context, falling back to Claude CLI')
      } else {
        logEvent('comms_pulse', 'routine_error', { routine: 'comms_pulse', err: String(err) })
        log.warn('scheduler: comms_pulse: dispatchAgent failed', { err: String(err) })
        return
      }
    }
  }
  await runClaudeAgent(
    'comms_pulse',
    `Standing comms pulse. Dispatch the Chief of Communications now. ${cacheNote}` +
    'She should classify and summarize the above mail for anything material. ' +
    'If something urgent landed, surface_to_inbox immediately. ' +
    'If something notable but not urgent, queue_for_brief. ' +
    'If nothing material arrived, stand down silently. ' +
    'After triage of each email, for any email containing a substantive fact, decision, event, or person mention, store a factual extract to semantic memory via POST http://127.0.0.1:9876/remember using the schema in her agent spec. ' +
    OBSERVER_DECISION_FRAMEWORK +
    '\n\nIf nothing material found: respond with exactly the single word "Clear" and nothing else. ' +
    'No narration. No "standing down". No email count summary unless there is a specific action item.',
  )
  logEvent('comms_pulse', 'routine_delivered', { routine: 'comms_pulse', exit_code: 0 })
}
