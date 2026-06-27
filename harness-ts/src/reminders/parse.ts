import * as chrono from 'chrono-node'

export interface ParseResult {
  fire_at: Date
  message: string
}

export function parseReminderInput(userText: string): ParseResult | null {
  // Use chrono.parse() to find the time reference, then strip it to get the message
  const results = chrono.parse(userText, new Date(), { forwardDate: true })
  if (results.length === 0) return null

  const result = results[0]
  if (!result) return null
  const fire_at = result.start.date()
  if (fire_at <= new Date()) return null

  // Strip the time expression from the user text to extract the reminder message
  const timeText = result.text
  let message = userText
    .replace(timeText, '')
    .replace(/^[\s,;:]+|[\s,;:]+$/g, '')      // trim leading/trailing punctuation
    .replace(/^(remind me|reminder|to|about)\s+/i, '')  // strip common prefixes
    .trim()

  if (!message) message = userText.trim()  // fallback: use full text

  return { fire_at, message }
}

export function formatReminderConfirmation(id: number, fireAt: Date, message: string): string {
  const formatted = fireAt.toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
  return `Reminder #${id} set for ${formatted} CT: ${message}`
}
