// Proactive Discord notifier -- posts to #jarvis-proactive channel.
// Wraps postToChannel() with the proactive webhook Keychain service.

import { postToChannel, type DiscordEmbed } from '../discord/webhook'
import { loadDiscordConfig } from '../config'

const PROACTIVE_WEBHOOK_SERVICE = 'jarvis-discord-proactive-webhook'

export async function postProactive(
  content: string | null,
  opts?: { embed?: DiscordEmbed },
): Promise<void> {
  const cfg = loadDiscordConfig()
  const webhookService = cfg?.proactive_webhook_keychain_service ?? PROACTIVE_WEBHOOK_SERVICE
  await postToChannel(content, { ...opts, webhookService })
}
