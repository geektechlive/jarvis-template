// Unreplied thread sweep -- proactive trigger that surfaces mail from real
// correspondents that has gone unanswered. Fires once per day (22h cooldown).
// Returns true when a Discord embed was posted, false when skipped.
//
// Reply status is verified by mail-check --unreplied against the Sent folder
// (correspondent set derived from who Alex emails), NOT the unread flag -- so
// this no longer conflates "unread" with "unreplied" or flags junk senders.

import { log } from 'ion-sdk'
import { logEvent, recentEvents } from '../memory/episodic'
import { runCommandAsync } from '../util/ionPrompt'
import { buildRichEmbed } from '../discord/format'
import { postProactive } from './notify'

// Threads count as unreplied past this age.
const CUTOFF_HOURS = 48
// Cap the number of threads per sweep so the embed stays readable.
const MAX_THREADS = 5
// Internal cooldown guard (22h) -- matches the TRIGGERS entry cooldownHours.
const INTERNAL_COOLDOWN_HOURS = 22

interface UnrepliedThread {
  source?: unknown
  from?: string
  subject?: string
  age_hours?: number
  error?: string
}

function parseUnreplied(raw: string): UnrepliedThread[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed as UnrepliedThread[]
  } catch {
    return []
  }
}

function formatAge(hours: number | undefined): string {
  if (typeof hours !== 'number' || !isFinite(hours)) return ''
  const days = hours / 24
  return days >= 1 ? `${Math.round(days)}d` : `${Math.round(hours)}h`
}

export async function unreadThreadSweep(): Promise<boolean> {
  // Double-check internal cooldown (mail-check is expensive).
  const recent = recentEvents('unread_thread_sweep', 'proactive_fired', INTERNAL_COOLDOWN_HOURS)
  if (recent.length > 0) {
    log.debug('proactive: unreadThreadSweep -- internal cooldown active, skipping')
    return false
  }

  const mailBin = `${process.env['HOME'] ?? '/Users/<username>'}/bin/mail-check`

  let raw: string
  try {
    const result = await runCommandAsync(
      mailBin,
      ['--unreplied', '--hours', String(CUTOFF_HOURS), '--json'],
      { timeoutMs: 60_000 },
    )
    if (result.error) {
      log.warn('proactive: unreadThreadSweep -- mail-check error', { error: String(result.error) })
      return false
    }
    raw = result.stdout
  } catch (err) {
    log.warn('proactive: unreadThreadSweep -- failed to run mail-check', { err: String(err) })
    return false
  }

  const parsed = parseUnreplied(raw)
  const errors = parsed.filter(t => typeof t.error === 'string')
  if (errors.length > 0) {
    // A Sent-folder or credential failure must not be reported as "all clear".
    log.warn('proactive: unreadThreadSweep -- mail-check reported errors, skipping', {
      errors: errors.map(e => e.error).join('; '),
    })
    return false
  }

  const threads = parsed.filter(t => typeof t.from === 'string').slice(0, MAX_THREADS)
  if (threads.length === 0) {
    log.debug('proactive: unreadThreadSweep -- no unreplied threads from correspondents')
    return false
  }

  const count = threads.length
  const threadWord = count === 1 ? 'thread' : 'threads'
  const hasHave = count === 1 ? 'has' : 'have'
  const embed = buildRichEmbed({
    emoji: '📬',
    title: 'Unreplied threads.',
    subtitle: `${count} ${threadWord} from people you correspond with ${hasHave} gone unanswered for 48h or more.`,
    bullets: threads.map(t => {
      const age = formatAge(t.age_hours)
      const prefix = age ? `${age} — ` : ''
      return {
        label: `${prefix}${t.from ?? '(unknown sender)'} — ${t.subject ?? '(no subject)'}`,
        description: '',
      }
    }),
    color: 0xFEE75C,
  })

  await postProactive(null, { embed })
  logEvent('unread_thread_sweep', 'proactive_fired', { trigger: 'unread_thread_sweep', count })
  log.info('proactive: unreadThreadSweep -- posted embed', { count })

  return true
}
