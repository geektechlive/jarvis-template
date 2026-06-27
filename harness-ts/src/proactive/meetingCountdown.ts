// Meeting countdown proactive trigger.
// Fires when a calendar event is 20-45 minutes away and not yet notified.
// Posts a rich Discord embed to #jarvis-proactive with contacts context and memory recall.
// The existing meeting_prep routine handles the 10-minute phone push -- this is the earlier Discord warning.

import { readFileSync } from 'node:fs'

import { log } from 'ion-sdk'
import { CONTACTS_PATH } from '../config'
import { logEvent, recentEvents } from '../memory/episodic'
import { recall } from '../memory/recall'
import { parseContactsYaml, type Contact } from '../scheduler/helpers'
import { getUpcomingEvents } from '../tools/calendar'
import { buildRichEmbed } from '../discord/format'
import { postProactive } from './notify'

const MIN_MINUTES = 20
const MAX_MINUTES = 45
const COOLDOWN_HOURS = 6

// Parse a locale time string like "09:30 AM" into today's Date.
// Returns null if the string cannot be parsed.
function parseStartTime(startTime: string): Date | null {
  const match = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(startTime.trim())
  if (!match) return null

  let hours = parseInt(match[1] ?? '0', 10)
  const minutes = parseInt(match[2] ?? '0', 10)
  const meridiem = (match[3] ?? 'AM').toUpperCase()

  if (meridiem === 'AM') {
    if (hours === 12) hours = 0
  } else {
    if (hours !== 12) hours += 12
  }

  const eventDate = new Date()
  eventDate.setHours(hours, minutes, 0, 0)
  return eventDate
}

// Build a contact context string for name tokens found in the event title.
function buildContactsContext(eventTitle: string): string {
  try {
    const contactsRaw = readFileSync(CONTACTS_PATH, 'utf8')
    const contacts: Contact[] = parseContactsYaml(contactsRaw)
    const titleLower = eventTitle.toLowerCase()
    const matched: string[] = []

    for (const contact of contacts) {
      const nameLower = contact.name.toLowerCase()
      const tokens = nameLower.split(/\s+/).filter((t) => t.length >= 2)
      const hits = tokens.some((token) => {
        const re = new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
        return re.test(titleLower)
      })
      if (!hits) continue

      const parts: string[] = [`${contact.name} (${contact.relationship ?? 'contact'}`]
      if (contact.last_seen) parts[0] += `, last seen ${contact.last_seen}`
      parts[0] += ')'
      const detail: string[] = []
      if (contact.notes) detail.push(contact.notes)
      if (contact.preferences?.length) detail.push(contact.preferences.join('; '))
      matched.push(parts[0] + (detail.length ? `: ${detail.join(' ')}` : ''))
    }

    return matched.length > 0 ? matched.join('\n') : ''
  } catch {
    return ''
  }
}

// Build a narrative paragraph from available context.
function buildNarrative(
  minutesUntil: number,
  contactsContext: string,
  recalledContext: string[],
): string {
  const parts: string[] = []

  if (contactsContext) {
    parts.push(`Attendees: ${contactsContext}`)
  }

  if (recalledContext.length > 0) {
    parts.push(`Context: ${recalledContext.join(' ')}`)
  }

  if (parts.length === 0) {
    return `No additional context on file.`
  }

  return parts.join(' ')
}

// Fires when a calendar event is 20-45 minutes away and not yet notified.
export async function meetingCountdown(): Promise<boolean> {
  const events = await getUpcomingEvents(MAX_MINUTES)
  if (events.length === 0) return false

  const now = new Date()
  let anyFired = false

  for (const event of events) {
    // Parse start_time to compute minutesUntil
    let minutesUntil: number
    try {
      const eventDate = parseStartTime(event.start_time)
      if (!eventDate) {
        log.debug('proactive: meetingCountdown -- could not parse start_time, skipping', { start_time: event.start_time })
        continue
      }
      minutesUntil = Math.round((eventDate.getTime() - now.getTime()) / 60_000)
    } catch {
      log.debug('proactive: meetingCountdown -- parse error, skipping', { start_time: event.start_time })
      continue
    }

    // Only fire in the 20-45 minute window
    if (minutesUntil < MIN_MINUTES || minutesUntil > MAX_MINUTES) continue

    // Per-event cooldown keyed on title + start_time
    const cooldownKey = `meeting_countdown:${event.title}|${event.start_time}`
    const recent = recentEvents(cooldownKey, 'proactive_fired', COOLDOWN_HOURS)
    if (recent.length > 0) {
      log.debug('proactive: meetingCountdown -- event on cooldown', { title: event.title, start_time: event.start_time })
      continue
    }

    // Contacts lookup (non-fatal)
    const contactsContext = buildContactsContext(event.title)

    // Memory recall (non-fatal)
    let recalledContext: string[] = []
    try {
      const { results } = await recall(`meeting context: ${event.title}`, 'user_profile', 3)
      recalledContext = results
    } catch {
      // vec-server may be down -- continue without recall
    }

    const narrative = buildNarrative(minutesUntil, contactsContext, recalledContext)

    const embed = buildRichEmbed({
      emoji: '📅',
      title: `Meeting in ${minutesUntil} minutes.`,
      subtitle: event.title,
      badges: [event.start_time],
      narrative,
      color: 0x5865F2,
      footerText: 'Reply `done` to suppress this reminder.',
    })

    try {
      await postProactive(null, { embed })
      logEvent(cooldownKey, 'proactive_fired', {
        trigger: 'meeting_countdown',
        title: event.title,
        start_time: event.start_time,
      })
      log.info('proactive: meetingCountdown fired', { title: event.title, minutesUntil })
      anyFired = true
    } catch (err) {
      log.warn('proactive: meetingCountdown -- postProactive failed', { title: event.title, err: String(err) })
    }
  }

  return anyFired
}
