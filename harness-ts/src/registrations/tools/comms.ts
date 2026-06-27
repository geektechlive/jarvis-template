import type { IonSDK } from 'ion-sdk'
import { log } from 'ion-sdk'
import { mailSend } from '../../tools/mail'
import { imessageSend, contactsLookup } from '../../tools/imessage'
import { postToChannel, postLongEmbed } from '../../discord/webhook'
import { logEvent, createReminder, type CreateReminderOptions } from '../../memory/episodic'
import { add as inboxAdd } from '../../inbox'
import { loadDiscordConfig } from '../../config'
import { blueskyPost, blueskyReply, blueskyRepost, blueskyLike, blueskyResolvePost, blueskyGetNotifications, blueskyMarkNotificationsSeen, blueskySearchPosts, blueskyGetTimeline } from '../../tools/bluesky'

// R5: comms/inbox tools (original positions 14–21)
// Note: create_reminder (pos 18) stays here with its original neighbors
// (mail_send@14…send_to_chat_channel@17, send_imessage@19…lookup_contact@21)
// rather than being pulled into calendar.ts. Order wins over domain purity.
export function registerCommsToolsR5(ion: IonSDK): void {
  ion.registerTool({
    name: 'mail_send',
    description:
      'Send an email via SMTP (credentials from Keychain: gmail_host, gmail_user, gmail_app_password, gmail_port), ' +
      'or draft a .eml file in ~/Documents/agent_outbox/ if SMTP creds are absent.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient email address.' },
        subject: { type: 'string', description: 'Email subject line.' },
        body: { type: 'string', description: 'Plain-text email body.' },
        cc: { type: 'string', description: 'Optional CC email address.' },
        from_name: { type: 'string', description: 'Optional display name for the From header (e.g. "Jarvis"). Defaults to the SMTP user address.' },
        html: { type: 'string', description: 'Optional HTML email body. When provided, sends a multipart/alternative message with both plain-text and HTML parts.' },
      },
      required: ['to', 'subject', 'body'],
    },
    execute: async (params) => {
      return await mailSend(
        params['to'] as string,
        params['subject'] as string,
        params['body'] as string,
        (params['cc'] as string | undefined) ?? '',
        (params['from_name'] as string | undefined) ?? '',
        (params['html'] as string | undefined),
      )
    },
  })

  ion.registerTool({
    name: 'surface_to_inbox',
    description:
      'Push content to Alex immediately via phone notification. ' +
      'Use only when a staff observation is urgent enough to interrupt now — unexpected charges, ' +
      'a health signal that needs attention today, a time-sensitive item. Not for routine findings.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The message to surface to Alex.' },
        label: { type: 'string', description: 'Short source label, e.g. "Wellness" or "CFO".' },
      },
      required: ['content'],
    },
    execute: async (params) => {
      const label = (params['label'] as string | undefined) ?? 'staff'
      const content = params['content'] as string
      inboxAdd({ source: label, content, score: 1.0, reason: 'urgent' })
      logEvent('surface_to_inbox', 'inbox_item', { routine: label, text: content })
      const discordCfg = loadDiscordConfig()
      const webhookSvc = discordCfg?.proactive_webhook_keychain_service ?? 'jarvis-discord-proactive-webhook'
      await postToChannel(null, {
        embed: {
          title: `⚡ ${label}`,
          description: content.slice(0, 4000),
          color: 0xED4245,
        },
        webhookService: webhookSvc,
      }).catch((err: unknown) => log.warn('surface_to_inbox: Discord post failed', { err: String(err) }))
      return { content: 'Surfaced to Discord proactive channel.' }
    },
  })

  ion.registerTool({
    name: 'queue_for_brief',
    description:
      'Queue a staff finding for the next morning brief. ' +
      'Use for notable-but-not-urgent observations — patterns worth mentioning, ' +
      'topics worth revisiting, low-urgency recommendations.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The finding to queue.' },
        source: { type: 'string', description: 'Staff member source label, e.g. "Wellness Coach" or "Tech Advisor".' },
        priority: { type: 'number', description: 'Priority 1–10 (default 5). Higher items appear first in the brief.' },
      },
      required: ['content', 'source'],
    },
    execute: async (params) => {
      const source = params['source'] as string
      const content = params['content'] as string
      const priority = ((params['priority'] as number | undefined) ?? 5) / 10
      inboxAdd({ source, content, score: priority, reason: 'staff observer' })
      const discordCfg = loadDiscordConfig()
      const webhookSvc = discordCfg?.proactive_webhook_keychain_service ?? 'jarvis-discord-proactive-webhook'
      await postToChannel(null, {
        embed: {
          title: `📋 ${source}`,
          description: content.slice(0, 4000),
          color: 0x5865F2,
        },
        webhookService: webhookSvc,
      }).catch((err: unknown) => log.warn('queue_for_brief: Discord post failed', { err: String(err) }))
      return { content: 'Queued for brief and sent to Discord.' }
    },
  })

  ion.registerTool({
    name: 'send_to_chat_channel',
    description:
      'Post long-form content to the #jarvis-chat Discord channel so the principal ' +
      'can read it without cluttering the iOS chat or triggering a TTS wall-of-text. ' +
      'Use when a staff response is something that must be READ rather than heard: ' +
      'research briefs, email summaries, news digests, financial reports, detailed ' +
      'analysis. After calling this, respond inline with ONE sentence: what was found ' +
      'and the single most important point. Do not reproduce the full content in chat.',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Embed title, e.g. "Research: EV Tariffs" or "Email Digest — 14 unread".',
        },
        content: {
          type: 'string',
          description: 'The full text to post to Discord.',
        },
      },
      required: ['title', 'content'],
    },
    execute: async (params) => {
      const discordCfg = loadDiscordConfig()
      const webhookSvc = discordCfg?.chat_webhook_keychain_service ?? 'jarvis-discord-chat-webhook'
      try {
        await postLongEmbed(
          params['content'] as string,
          params['title'] as string,
          0x2B2D31,
          webhookSvc,
        )
        return { content: 'Posted to #jarvis-chat.' }
      } catch (err: unknown) {
        log.warn('send_to_chat_channel: Discord post failed', { err: String(err) })
        return { content: `Failed to post to #jarvis-chat: ${String(err)}. Include key findings inline instead.`, isError: true }
      }
    },
  })

  ion.registerTool({
    name: 'create_reminder',
    description:
      'Create a durable reminder that survives session restarts. Delivers at the scheduled time via push notification (if idle) or inline injection (if active). Use when the user asks to be reminded about something at a future time. For time-critical tasks, set escalating:true so the reminder re-fires on an urgency-tiered schedule (more insistent as the deadline nears) until it is cancelled.',
    parameters: {
      type: 'object',
      properties: {
        user_text: {
          type: 'string',
          description: 'The original reminder request as the user stated it.',
        },
        fire_at: {
          type: 'string',
          description: 'ISO 8601 UTC timestamp for when to deliver the reminder (e.g. 2026-05-11T18:00:00.000Z).',
        },
        message: {
          type: 'string',
          description: 'The reminder message to deliver (concise, imperative: "Call the dentist").',
        },
        escalating: {
          type: 'boolean',
          description: 'Optional. When true, the reminder re-fires on an urgency-tiered follow-up schedule (interval set by how soon the deadline is) until cancelled or the cap is reached. Re-fires only happen during the 07:00-22:00 CT active window (any that would land overnight are deferred to the next morning). Default false (one-shot). Use only for things that genuinely need nagging.',
        },
        escalation_cap: {
          type: 'number',
          description: 'Optional. Max number of escalation re-fires before it stops. Defaults to 10. Ignored unless escalating is true.',
        },
      },
      required: ['user_text', 'fire_at', 'message'],
    },
    execute: async (params) => {
      const rawFireAt = params['fire_at'] as string
      const normalized = /[Zz]$|[+-]\d{2}:\d{2}$/.test(rawFireAt) ? rawFireAt : rawFireAt + 'Z'
      const fireAt = new Date(normalized)
      if (isNaN(fireAt.getTime()) || fireAt <= new Date()) {
        return { content: '[Reminder not created: fire_at is invalid or in the past]', isError: true }
      }
      const reminderOpts: CreateReminderOptions = { escalating: params['escalating'] === true }
      if (typeof params['escalation_cap'] === 'number') {
        reminderOpts.escalationCap = params['escalation_cap']
      }
      const id = createReminder(
        params['user_text'] as string,
        fireAt,
        params['message'] as string,
        reminderOpts,
      )
      const whenStr = fireAt.toLocaleString('en-US', { timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })
      return {
        content: `Reminder #${id} set for ${whenStr} CT${reminderOpts.escalating ? ' (escalating)' : ''}: ${params['message'] as string}`,
      }
    },
  })

  ion.registerTool({
    name: 'send_imessage',
    description:
      'Send an iMessage or SMS via Messages.app. ' +
      'Use when Alex explicitly asks to send a message. ' +
      'Do NOT call autonomously — surface draft replies via surface_to_inbox first.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient phone number or Apple ID email.' },
        body: { type: 'string', description: 'Message text to send.' },
        service: { type: 'string', description: '"iMessage" or "SMS" (default: iMessage).' },
      },
      required: ['to', 'body'],
    },
    execute: async (params) => ({
      content: imessageSend(
        params['to'] as string,
        params['body'] as string,
        ((params['service'] as string | undefined) ?? 'iMessage') as 'iMessage' | 'SMS',
      ),
    }),
  })

  ion.registerTool({
    name: 'discord_send',
    description:
      'Post a message to the Jarvis Discord channel. ' +
      'Use for CI/CD approval notifications or manual messages to the Discord approval channel.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The message text to post (max 2000 chars; longer content is truncated).' },
      },
      required: ['content'],
    },
    execute: async (params) => {
      try {
        const { messageId } = await postToChannel(params['content'] as string)
        return { content: `Posted to Discord (message id: ${messageId})` }
      } catch (err) {
        return { content: `[Discord send failed: ${String(err)}]`, isError: true }
      }
    },
  })

  ion.registerTool({
    name: 'lookup_contact',
    description: 'Look up a contact by name or phone number in macOS Contacts.app.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Name fragment or phone number to look up.' },
        mode: { type: 'string', description: '"name" to search by name (default), "phone" to resolve a phone to display name.' },
      },
      required: ['query'],
    },
    execute: async (params) => ({
      content: contactsLookup(
        params['query'] as string,
        ((params['mode'] as string | undefined) ?? 'name') as 'name' | 'phone',
      ),
    }),
  })
}

// R10: Bluesky tools (original positions 30–34)
export function registerCommsToolsR10(ion: IonSDK): void {
  ion.registerTool({
    name: 'bluesky_post',
    description:
      "Post to Bluesky on behalf of Alex. " +
      "Automatically detects mentions (@handle), hashtags (#tag), and URLs and creates rich-text facets. " +
      "Use when Alex explicitly asks to post or share something on Bluesky. " +
      "Do NOT post autonomously -- confirm intent before calling.",
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Post text (max 300 graphemes). Mentions, hashtags, and URLs are auto-linked.' },
      },
      required: ['text'],
    },
    execute: async (params) => {
      const result = await blueskyPost(params['text'] as string)
      if (!result.ok) return { content: `[bluesky_post failed: ${result.error}]`, isError: true }
      return { content: `Posted. URI: ${result.uri ?? ''}` }
    },
  })

  ion.registerTool({
    name: 'bluesky_reply',
    description:
      "Reply to an existing Bluesky post on behalf of Alex. " +
      "Requires the parent post's AT URI (at://did:.../app.bsky.feed.post/...) and CID. " +
      "When replying deep in a thread, also provide root_uri and root_cid for the thread root. " +
      "Use when Alex explicitly asks to reply to a specific Bluesky post.",
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Reply text (max 300 graphemes).' },
        parent_uri: { type: 'string', description: "AT URI of the post being replied to (at://did:.../app.bsky.feed.post/...)." },
        parent_cid: { type: 'string', description: 'CID of the post being replied to.' },
        root_uri: { type: 'string', description: 'AT URI of the thread root post. Omit when the parent IS the root.' },
        root_cid: { type: 'string', description: 'CID of the thread root post. Omit when the parent IS the root.' },
      },
      required: ['text', 'parent_uri', 'parent_cid'],
    },
    execute: async (params) => {
      const result = await blueskyReply(
        params['text'] as string,
        params['parent_uri'] as string,
        params['parent_cid'] as string,
        params['root_uri'] as string | undefined,
        params['root_cid'] as string | undefined,
      )
      if (!result.ok) return { content: `[bluesky_reply failed: ${result.error}]`, isError: true }
      return { content: `Reply posted. URI: ${result.uri ?? ''}` }
    },
  })

  ion.registerTool({
    name: 'bluesky_repost',
    description:
      "Repost (boost) an existing Bluesky post on behalf of Alex. " +
      "Requires the post's AT URI and CID. " +
      "Use when Alex explicitly asks to repost or boost a specific post.",
    parameters: {
      type: 'object',
      properties: {
        subject_uri: { type: 'string', description: "AT URI of the post to repost." },
        subject_cid: { type: 'string', description: 'CID of the post to repost.' },
      },
      required: ['subject_uri', 'subject_cid'],
    },
    execute: async (params) => {
      const result = await blueskyRepost(
        params['subject_uri'] as string,
        params['subject_cid'] as string,
      )
      if (!result.ok) return { content: `[bluesky_repost failed: ${result.error}]`, isError: true }
      return { content: 'Reposted.' }
    },
  })

  ion.registerTool({
    name: 'bluesky_like',
    description:
      "Like a Bluesky post on behalf of Alex. " +
      "Requires the post's AT URI and CID. " +
      "Use when Alex explicitly asks to like a specific post.",
    parameters: {
      type: 'object',
      properties: {
        subject_uri: { type: 'string', description: "AT URI of the post to like." },
        subject_cid: { type: 'string', description: 'CID of the post to like.' },
      },
      required: ['subject_uri', 'subject_cid'],
    },
    execute: async (params) => {
      const result = await blueskyLike(
        params['subject_uri'] as string,
        params['subject_cid'] as string,
      )
      if (!result.ok) return { content: `[bluesky_like failed: ${result.error}]`, isError: true }
      return { content: 'Liked.' }
    },
  })

  ion.registerTool({
    name: 'bluesky_resolve_post',
    description:
      "Resolve a Bluesky post URL to its AT URI and CID, which are required for bluesky_reply, bluesky_repost, and bluesky_like. " +
      "Accepts a full bsky.app URL (https://bsky.app/profile/handle/post/rkey) or handle/rkey pair.",
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The bsky.app post URL or handle/rkey to resolve.',
        },
      },
      required: ['url'],
    },
    execute: async (params) => {
      try {
        const { uri, cid } = await blueskyResolvePost(params['url'] as string)
        return { content: JSON.stringify({ uri, cid }) }
      } catch (err) {
        return { content: `[bluesky_resolve_post failed: ${String(err)}]`, isError: true }
      }
    },
  })

  // Inbound / read tools (#595) — let the Chief of Communications monitor Bluesky.
  ion.registerTool({
    name: 'bluesky_get_notifications',
    description:
      "Read recent Bluesky notifications for Alex's account (mentions, replies, likes, reposts, follows, quotes). " +
      "Use to surface inbound Bluesky activity that may need a response. " +
      "Returns author handle, reason, post text, AT uri/cid (for replying), read state, and timestamp.",
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max notifications to return (1-100, default 25).' },
      },
      required: [],
    },
    execute: async (params) => {
      const limit = typeof params['limit'] === 'number' ? params['limit'] : 25
      const result = await blueskyGetNotifications(limit)
      if (!result.ok) return { content: `[bluesky_get_notifications failed: ${result.error}]`, isError: true }
      if (result.notifications.length === 0) return { content: 'No Bluesky notifications.' }
      return { content: JSON.stringify(result.notifications) }
    },
  })

  ion.registerTool({
    name: 'bluesky_mark_notifications_seen',
    description:
      "Mark Bluesky notifications as seen up to now (or an optional ISO timestamp). " +
      "Call this AFTER reading and processing notifications from bluesky_get_notifications, " +
      "so the same mention/reply is not re-surfaced (and re-drafted) on the next pass.",
    parameters: {
      type: 'object',
      properties: {
        seen_at: { type: 'string', description: 'Optional ISO timestamp; defaults to now.' },
      },
      required: [],
    },
    execute: async (params) => {
      const seenAt = typeof params['seen_at'] === 'string' ? params['seen_at'] : undefined
      const result = await blueskyMarkNotificationsSeen(seenAt)
      if (!result.ok) return { content: `[bluesky_mark_notifications_seen failed: ${result.error}]`, isError: true }
      return { content: 'Bluesky notifications marked seen.' }
    },
  })

  ion.registerTool({
    name: 'bluesky_search_posts',
    description:
      "Search public Bluesky posts by keyword or hashtag. " +
      "Use to find conversations relevant to Alex, monitor a topic, or locate a post to reply to. " +
      "Returns author handle, post text, AT uri/cid, engagement counts, and timestamp.",
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query — keywords or #hashtag.' },
        limit: { type: 'number', description: 'Max posts to return (1-100, default 25).' },
      },
      required: ['query'],
    },
    execute: async (params) => {
      const limit = typeof params['limit'] === 'number' ? params['limit'] : 25
      const result = await blueskySearchPosts(params['query'] as string, limit)
      if (!result.ok) return { content: `[bluesky_search_posts failed: ${result.error}]`, isError: true }
      if (result.posts.length === 0) return { content: 'No matching Bluesky posts.' }
      return { content: JSON.stringify(result.posts) }
    },
  })

  ion.registerTool({
    name: 'bluesky_get_timeline',
    description:
      "Read the home timeline for Alex's Bluesky account (posts from followed accounts). " +
      "Use to get a sense of recent activity in his feed. " +
      "Returns author handle, post text, AT uri/cid, engagement counts, and timestamp.",
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max posts to return (1-100, default 25).' },
      },
      required: [],
    },
    execute: async (params) => {
      const limit = typeof params['limit'] === 'number' ? params['limit'] : 25
      const result = await blueskyGetTimeline(limit)
      if (!result.ok) return { content: `[bluesky_get_timeline failed: ${result.error}]`, isError: true }
      if (result.posts.length === 0) return { content: 'Bluesky timeline is empty.' }
      return { content: JSON.stringify(result.posts) }
    },
  })
}
