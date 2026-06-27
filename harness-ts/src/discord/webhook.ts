// Discord outbound notifier via webhook.
// Uses native fetch (Node 22). No axios, no node-fetch.
// Webhook URL is read from macOS Keychain via the security CLI.

import { spawnSync } from 'node:child_process'

const DISCORD_CONTENT_LIMIT = 2000

export interface DiscordEmbed {
  title?: string
  description?: string
  color?: number
  fields?: Array<{ name: string; value: string; inline?: boolean }>
  footer?: { text: string; icon_url?: string }
}

export interface PostResult {
  messageId: string
}

function readWebhookUrl(service = 'jarvis-discord-webhook'): string {
  const account = process.env['USER'] ?? '<username>'
  const result = spawnSync('security', [
    'find-generic-password',
    '-s', service,
    '-a', account,
    '-w',
  ])
  if (result.status !== 0) {
    throw new Error(`Discord webhook URL not found in Keychain (service=${service}, account=${account})`)
  }
  return result.stdout.toString().trim()
}

/**
 * Post a message to the configured Discord channel via webhook.
 * Appends ?wait=true so Discord returns the created message (needed for messageId).
 * Content can be null for embed-only messages.
 */
export async function postToChannel(
  content: string | null,
  opts?: { embed?: DiscordEmbed; webhookService?: string },
): Promise<PostResult> {
  const webhookUrl = readWebhookUrl(opts?.webhookService)
  const url = `${webhookUrl}?wait=true`

  const body: Record<string, unknown> = {}

  if (content !== null) {
    const truncated =
      content.length > DISCORD_CONTENT_LIMIT
        ? content.slice(0, DISCORD_CONTENT_LIMIT - 15) + '... (truncated)'
        : content
    body['content'] = truncated
  }

  if (opts?.embed) {
    body['embeds'] = [opts.embed]
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '(no body)')
    throw new Error(`Discord webhook failed: HTTP ${res.status} — ${text}`)
  }

  const json = (await res.json()) as Record<string, unknown>
  const messageId = String(json['id'] ?? '')
  if (!messageId) {
    throw new Error('Discord webhook response missing message id')
  }

  return { messageId }
}

/** Bold GitHub issue numbers (#123 → **#123**) for Discord markdown. */
function formatForDiscord(text: string): string {
  return text.replace(/#(\d+)\b/g, '**#$1**')
}

/** Split text into chunks ≤ maxLen, preferring double-newline then single-newline boundaries.
 *  Default 4000 is intentionally below Discord's 4096 embed description hard limit. */
function splitIntoChunks(text: string, maxLen = 4000): string[] {
  if (text.length <= maxLen) return [text]

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf('\n\n', maxLen)
    if (splitAt < maxLen * 0.4) {
      splitAt = remaining.lastIndexOf('\n', maxLen)
    }
    if (splitAt <= 0) splitAt = maxLen
    chunks.push(remaining.slice(0, splitAt).trim())
    remaining = remaining.slice(splitAt).trim()
  }

  if (remaining.length > 0) chunks.push(remaining)
  return chunks
}

/**
 * Post a (potentially long) embed to Discord, splitting into multiple numbered
 * messages if the text exceeds 4000 chars. Applies bold formatting to GitHub
 * issue numbers (#123 → **#123**).
 */
export async function postLongEmbed(
  text: string,
  title: string,
  color: number,
  webhookService: string,
): Promise<void> {
  const formatted = formatForDiscord(text)
  const chunks = splitIntoChunks(formatted)

  for (let i = 0; i < chunks.length; i++) {
    const partTitle = chunks.length > 1 ? `${title} (${i + 1}/${chunks.length})` : title
    const chunk = chunks[i] ?? ''
    await postToChannel(null, {
      embed: { title: partTitle, description: chunk, color },
      webhookService,
    })
    if (i < chunks.length - 1) {
      await new Promise<void>((r) => setTimeout(r, 500))
    }
  }
}
