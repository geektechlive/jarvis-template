// Multi-granularity conversation summarization routines.
// daily_summary: synthesizes 24h of conversation into a narrative summary.
// weekly_summary: synthesizes 7 daily summaries into a weekly narrative.
// monthly_summary: synthesizes 4 weekly summaries into a monthly narrative.

import { log } from 'ion-sdk'
import {
  logEvent,
  storeConversationSummary,
  getRecentSummaries,
  getSubstantiveCrossSessionMessagesWindow,
  recentEvents,
} from '../../memory/episodic'
import { runModelForRole } from '../../util/modelDispatch'
import { postLongEmbed } from '../../discord/webhook'
import { loadDiscordConfig } from '../../config'
import { isEnabled } from '../helpers'

const DAILY_SYSTEM = `You are synthesizing a day's worth of conversation and activity for a personal AI chief of staff named Jarvis.
Produce a concise (~150-200 word) first-person narrative summary from Jarvis's perspective.
Focus on: what topics were discussed, decisions made, work completed, staff agent findings surfaced, and any notable patterns.
Write in past tense. Start with "Today" or the day of week. Be specific -- name projects, issues, topics. No filler.`

const WEEKLY_SYSTEM = `You are synthesizing a week of daily summaries for a personal AI chief of staff named Jarvis.
Produce a coherent (~300-400 word) weekly narrative from Jarvis's perspective.
Focus on: major themes across the week, key decisions, recurring topics, progress on ongoing work.
Write in past tense. Start with "This week". Be specific and concrete.`

const MONTHLY_SYSTEM = `You are synthesizing 4 weeks of weekly summaries for a personal AI chief of staff named Jarvis.
Produce a high-level (~400-500 word) monthly narrative from Jarvis's perspective.
Focus on: overarching themes, significant shifts, recurring patterns, notable accomplishments, and open threads.
Write in past tense. Start with the month name. Identify themes, not just events.`

export async function runDailySummary(): Promise<void> {
  if (!isEnabled('daily_summary')) return

  const now = new Date()
  const periodEnd = now.toISOString()
  const periodStart = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()

  try {
    const messages = getSubstantiveCrossSessionMessagesWindow(24)
    const userMessages = messages.filter(m => m.role === 'user')

    if (userMessages.length < 3) {
      log.info('daily_summary: skipping -- insufficient conversation (<3 user messages)')
      logEvent('daily_summary', 'routine_delivered', { routine: 'daily_summary', skipped: true, reason: 'insufficient_messages' })
      return
    }

    const inboxItems = recentEvents('surface_to_inbox', 'inbox_item', 24)
    const briefItems = recentEvents('queue_for_brief', 'inbox_item', 24)
    const staffFindings = [...inboxItems, ...briefItems]
    const routineEvents = recentEvents('', 'routine_delivered', 24).filter(e => {
      const d = e.detail as Record<string, unknown> | null
      return d?.['routine'] && d['routine'] !== 'daily_summary'
    })
    const resolverShipped = recentEvents('issue_resolver', 'resolver_shipped', 24)

    const messageSample = messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .slice(-60)
      .map(m => `[${m.role}] ${(m.content).slice(0, 300)}`)
      .join('\n')

    const staffSection = staffFindings.length > 0
      ? '\n\nSTAFF FINDINGS:\n' + staffFindings.map(e => {
          const d = e.detail as Record<string, unknown> | null
          return `- [${String(d?.['routine'] ?? 'staff')}] ${String(d?.['text'] ?? '').slice(0, 200)}`
        }).join('\n')
      : ''

    const eventsSection = routineEvents.length > 0 || resolverShipped.length > 0
      ? '\n\nACTIVITY LOG:\n' +
        routineEvents.slice(0, 10).map(e => {
          const d = e.detail as Record<string, unknown> | null
          return `- routine_delivered: ${String(d?.['routine'] ?? 'unknown')}`
        }).join('\n') +
        resolverShipped.map(e => {
          const d = e.detail as Record<string, unknown> | null
          return `\n- resolver_shipped: issue #${String(d?.['issue'] ?? '?')}`
        }).join('')
      : ''

    const prompt = `${DAILY_SYSTEM}\n\nCONVERSATION SAMPLE:\n${messageSample}${staffSection}${eventsSection}\n\nWrite the daily summary now:`

    const summary = await runModelForRole('summary', 'daily_summary', prompt, { timeoutMs: 90_000 })

    if (!summary || summary.trim().length < 20) {
      log.warn('daily_summary: empty or too-short summary returned')
      return
    }

    const uniqueSessions = new Set(messages.map(m => m.session)).size
    storeConversationSummary('daily', periodStart, periodEnd, summary.trim(), uniqueSessions, userMessages.length)

    const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
    fetch('http://127.0.0.1:9876/graph/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: summary.trim(), name: `daily-summary-${today}`, group_id: 'jarvis' }),
    }).catch((err: unknown) => log.warn('daily_summary: graph ingest failed', { err: String(err) }))

    const discordCfg = loadDiscordConfig()
    const webhookSvc = discordCfg?.proactive_webhook_keychain_service ?? 'jarvis-discord-proactive-webhook'
    const dayStr = new Date(periodEnd).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'America/Chicago' })
    await postLongEmbed(summary.trim(), `Daily Summary -- ${dayStr}`, 0x3BA55D, webhookSvc)
      .catch((err: unknown) => log.warn('daily_summary: Discord post failed', { err: String(err) }))

    logEvent('daily_summary', 'routine_delivered', { routine: 'daily_summary', sessions: uniqueSessions, messages: userMessages.length })
    log.info('daily_summary: complete', { sessions: uniqueSessions, messages: userMessages.length })
  } catch (err) {
    log.warn('daily_summary: failed', { err: String(err) })
    logEvent('daily_summary', 'routine_delivered', { routine: 'daily_summary', exit_code: -1, error: String(err) })
  }
}

export async function runWeeklySummary(): Promise<void> {
  if (!isEnabled('weekly_summary')) return

  const now = new Date()
  const periodEnd = now.toISOString()
  const periodStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()

  try {
    const dailies = getRecentSummaries('daily', 7)

    if (dailies.length < 3) {
      log.info('weekly_summary: skipping -- fewer than 3 daily summaries available', { count: dailies.length })
      return
    }

    const dailyText = dailies
      .slice()
      .reverse()
      .map(d => {
        const date = new Date(d.period_end).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'America/Chicago' })
        return `[${date}]\n${d.summary}`
      })
      .join('\n\n')

    const prompt = `${WEEKLY_SYSTEM}\n\nDAILY SUMMARIES:\n${dailyText}\n\nWrite the weekly summary now:`

    const summary = await runModelForRole('summary', 'weekly_summary', prompt, { timeoutMs: 90_000 })

    if (!summary || summary.trim().length < 20) {
      log.warn('weekly_summary: empty or too-short summary')
      return
    }

    storeConversationSummary('weekly', periodStart, periodEnd, summary.trim())

    const discordCfg = loadDiscordConfig()
    const webhookSvc = discordCfg?.proactive_webhook_keychain_service ?? 'jarvis-discord-proactive-webhook'
    const weekStr = new Date(periodStart).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Chicago' })
    await postLongEmbed(summary.trim(), `Weekly Summary -- week of ${weekStr}`, 0x5865F2, webhookSvc)
      .catch((err: unknown) => log.warn('weekly_summary: Discord post failed', { err: String(err) }))

    logEvent('weekly_summary', 'routine_delivered', { routine: 'weekly_summary', dailies_used: dailies.length })
    log.info('weekly_summary: complete', { dailies: dailies.length })
  } catch (err) {
    log.warn('weekly_summary: failed', { err: String(err) })
    logEvent('weekly_summary', 'routine_delivered', { routine: 'weekly_summary', exit_code: -1, error: String(err) })
  }
}

export async function runMonthlySummary(): Promise<void> {
  if (!isEnabled('monthly_summary')) return

  // Guard: only run in the first 7 days of the month (Chicago time)
  const chicagoDay = parseInt(
    new Intl.DateTimeFormat('en', { timeZone: 'America/Chicago', day: 'numeric' }).format(new Date()),
    10,
  )
  if (chicagoDay > 7) {
    log.info('monthly_summary: skipping -- outside first-7-days window', { dayOfMonth: chicagoDay })
    logEvent('monthly_summary', 'routine_skipped', { routine: 'monthly_summary', reason: 'outside_first_7_days', day_of_month: chicagoDay })
    return
  }

  const now = new Date()
  const periodEnd = now.toISOString()
  const periodStart = new Date(now.getTime() - 35 * 24 * 60 * 60 * 1000).toISOString()

  try {
    const weeklies = getRecentSummaries('weekly', 4)

    if (weeklies.length < 2) {
      log.info('monthly_summary: skipping -- fewer than 2 weekly summaries', { count: weeklies.length })
      return
    }

    const weeklyText = weeklies
      .slice()
      .reverse()
      .map(w => {
        const date = new Date(w.period_end).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Chicago' })
        return `[Week of ${date}]\n${w.summary}`
      })
      .join('\n\n')

    const prompt = `${MONTHLY_SYSTEM}\n\nWEEKLY SUMMARIES:\n${weeklyText}\n\nWrite the monthly summary now:`

    const summary = await runModelForRole('summary', 'monthly_summary', prompt, { timeoutMs: 120_000 })

    if (!summary || summary.trim().length < 20) {
      log.warn('monthly_summary: empty or too-short summary')
      return
    }

    storeConversationSummary('monthly', periodStart, periodEnd, summary.trim())

    const discordCfg = loadDiscordConfig()
    const webhookSvc = discordCfg?.proactive_webhook_keychain_service ?? 'jarvis-discord-proactive-webhook'
    const monthStr = new Date(now).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'America/Chicago' })
    await postLongEmbed(summary.trim(), `Monthly Summary -- ${monthStr}`, 0xEB459E, webhookSvc)
      .catch((err: unknown) => log.warn('monthly_summary: Discord post failed', { err: String(err) }))

    logEvent('monthly_summary', 'routine_delivered', { routine: 'monthly_summary', weeklies_used: weeklies.length })
    log.info('monthly_summary: complete', { weeklies: weeklies.length })
  } catch (err) {
    log.warn('monthly_summary: failed', { err: String(err) })
    logEvent('monthly_summary', 'routine_delivered', { routine: 'monthly_summary', exit_code: -1, error: String(err) })
  }
}
