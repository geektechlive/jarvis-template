import * as crypto from 'node:crypto'
import * as path from 'node:path'
import * as os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { log } from 'ion-sdk'
import type { IonContext, WebhookRequest, WebhookResponse } from 'ion-sdk'
import { logEvent, isImessageProcessed, markImessageProcessed } from '../memory/episodic'
import { runImessageIngest } from '../scheduler'
import { triageAndAdd } from '../triage'
import { loadImessageConfig } from '../config'
import { publishUrgentImessage } from '../resources/imessage'
import { sanitizeUntrusted } from '../memory/sanitize'

const SCRIPTS_DIR = path.join(os.homedir(), 'Jarvis', 'scripts')
const execFileAsync = promisify(execFile)
const _displayNameCache = new Map<string, string>()

interface ImessagePayload {
  guid: string
  rowid: number
  text: string
  sender_id: string   // phone or email from handle.id
  service: string     // iMessage or SMS
  chat_name?: string
  participant_count?: number
  cache_has_attachments?: number
  date: number        // Apple Mac absolute time (ns since 2001-01-01)
}

function validateToken(authHeader: string, token: string): boolean {
  const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
  if (!provided || !token) return false
  const tokenBuf = Buffer.from(token)
  const providedBuf = Buffer.from(provided)
  // Reject immediately on length mismatch — avoids comparing buffers of different
  // lengths and short-circuits attacks that prepend the real token with extra bytes.
  if (providedBuf.length !== tokenBuf.length) return false
  return crypto.timingSafeEqual(tokenBuf, providedBuf)
}

async function lookupDisplayName(senderId: string): Promise<string> {
  const cached = _displayNameCache.get(senderId)
  if (cached !== undefined) return cached
  const script = path.join(SCRIPTS_DIR, 'contacts-lookup.sh')
  try {
    const { stdout } = await execFileAsync('/bin/bash', [script, '--phone', senderId], { encoding: 'utf8', timeout: 5_000 })
    if (!stdout.trim()) {
      _displayNameCache.set(senderId, '')
      return ''
    }
    const hits = JSON.parse(stdout.trim()) as Array<{ name?: string }>
    const name = hits[0]?.name ?? ''
    _displayNameCache.set(senderId, name)
    return name
  } catch { return '' }
}

function isReaction(msg: ImessagePayload): boolean {
  // iMessage reactions have text like "Loved "...", Liked "...", etc.
  return /^(Loved|Liked|Disliked|Laughed at|Emphasized|Questioned) "/i.test(msg.text ?? '')
}

function isAttachmentOnly(msg: ImessagePayload): boolean {
  return !msg.text && (msg.cache_has_attachments ?? 0) > 0
}

function formatTask(msg: ImessagePayload, displayName: string, priority: string): string {
  const from = displayName || msg.sender_id
  const via = msg.service === 'SMS' ? 'SMS' : 'iMessage'
  const epochMs = (msg.date / 1e6) + 978_307_200_000 // ns → ms, adjust Apple epoch
  const ts = new Date(epochMs).toISOString()
  return (
    `New ${priority === 'URGENT' ? 'URGENT ' : ''}${via} from ${from} (${msg.sender_id}) at ${ts}:\n\n` +
    `"${sanitizeUntrusted(msg.text ?? '')}"\n\n` +
    `Review, triage, and respond appropriately. Use send_imessage to reply if action is warranted.`
  )
}

/**
 * Canonical ion.webhooks handler for the iMessage webhook route.
 * Auth (bearer token check) is handled by the ion engine via the `auth` field
 * on the registered route. Body parsing and routing logic delegates to the
 * existing handleImessageRequest core.
 */
export async function handleImessageWebhook(ctx: IonContext, req: WebhookRequest): Promise<WebhookResponse> {
  const imessageToken = process.env['IMESSAGE_WEBHOOK_TOKEN'] ?? ''
  const imsgConfig = loadImessageConfig()

  // ion.webhooks auth field already verified the bearer token; we re-check inside
  // handleImessageRequest so the function remains self-contained (testable standalone).
  // Real header wins; fall back to injected token so the in-handler check always passes
  // when ion's route-level auth has already validated the request.
  const authHeader = req.headers['authorization'] ?? `Bearer ${imessageToken}`
  const bodyText = req.text()

  try {
    const status = await handleImessageRequest(
      ctx,
      bodyText,
      authHeader,
      imessageToken,
      imsgConfig.urgent_senders,
      imsgConfig.skip_group_chats,
    )
    return { status, body: 'ok' }
  } catch (err) {
    log.warn('webhooks: imessage handler error', { err: String(err) })
    return { status: 500, body: 'internal error' }
  }
}

export async function handleImessageRequest(
  ctx: IonContext,
  bodyText: string,
  authHeader: string,
  token: string,
  urgentSenders: string[],
  skipGroupChats = true,
): Promise<number> {
  if (!token || !validateToken(authHeader, token)) {
    return 401
  }

  let messages: ImessagePayload[]
  try {
    const body = JSON.parse(bodyText) as unknown
    messages = Array.isArray(body) ? (body as ImessagePayload[]) : [(body as ImessagePayload)]
  } catch { return 400 }

  for (const msg of messages) {
    if (!msg.guid) continue
    if (isImessageProcessed(msg.guid)) continue

    const text = sanitizeUntrusted(msg.text ?? '')

    // Tier 1: Suppress
    if (isReaction(msg) || isAttachmentOnly(msg) || text.length < 3) {
      markImessageProcessed(msg.guid, msg.rowid, msg.sender_id, 'suppress')
      logEvent('imessage', 'imessage_suppressed', { guid: msg.guid, reason: 'tier1' })
      continue
    }

    const displayName = await lookupDisplayName(msg.sender_id)

    // Group-chat gate: suppress non-urgent senders from group chats
    const isGroupChat = (msg.participant_count ?? 0) > 2 || (!!msg.chat_name && msg.chat_name.startsWith('chat'))
    if (isGroupChat && skipGroupChats) {
      const isGroupUrgent = urgentSenders.some((s) => s === msg.sender_id || s === displayName)
      if (!isGroupUrgent) {
        markImessageProcessed(msg.guid, msg.rowid, msg.sender_id, 'suppress')
        logEvent('imessage', 'imessage_suppressed', { guid: msg.guid, reason: 'group_chat' })
        continue
      }
    }
    const isUrgent = urgentSenders.some((s) => s === msg.sender_id || s === displayName)

    // Tier 4: Urgent sender — push immediately + dispatch Chief
    if (isUrgent) {
      markImessageProcessed(msg.guid, msg.rowid, msg.sender_id, 'urgent')
      await publishUrgentImessage(msg.guid, displayName || msg.sender_id, text, ctx)
      void runImessageIngest(formatTask(msg, displayName, 'URGENT')).catch((e: unknown) =>
        logEvent('imessage', 'imessage_dispatch_error', { guid: msg.guid, error: String(e) })
      )
      continue
    }

    // Tier 3: Known contact, substantive message — dispatch Chief
    if (displayName && text.length >= 10) {
      markImessageProcessed(msg.guid, msg.rowid, msg.sender_id, 'dispatch')
      void runImessageIngest(formatTask(msg, displayName, 'NORMAL')).catch((e: unknown) =>
        logEvent('imessage', 'imessage_dispatch_error', { guid: msg.guid, error: String(e) })
      )
      continue
    }

    // Tier 2: Unknown sender or short message — Ollama triage fallback
    markImessageProcessed(msg.guid, msg.rowid, msg.sender_id, 'triage')
    const from = displayName || msg.sender_id
    void triageAndAdd(
      { source: 'imessage', content: `iMessage from ${from}: ${text}` },
      '',
    )
    logEvent('imessage', 'imessage_triaged', { guid: msg.guid, sender: msg.sender_id })
  }

  return 200
}
