// Shared config helpers used by triage, autonomy, and other Ollama-calling modules.
// watchdog test 2026-05-19

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { load } from 'js-yaml'

export const HARNESS_DIR =
  process.env['JARVIS_DIR'] ?? process.env['AGENT_HARNESS_DIR'] ?? join(homedir(), 'Jarvis')

// Mutable staff data lives in iCloud Drive (durable cross-device sync + version
// history), NOT the git-tracked repo -- agents write these at runtime, so a tracked
// file diverges and is reverted by deploys (#800). Mirrors the CFO finance/ pattern.
// JARVIS_ICLOUD_DIR overrides for tests / non-Mini hosts.
export const ICLOUD_JARVIS_DIR =
  process.env['JARVIS_ICLOUD_DIR'] ??
  join(homedir(), 'Library/Mobile Documents/com~apple~CloudDocs/Jarvis')
export const PORTFOLIO_PATH = join(ICLOUD_JARVIS_DIR, 'portfolio/holdings.yaml')
export const CONTACTS_PATH = join(ICLOUD_JARVIS_DIR, 'contacts/contacts.yaml')
export const PROPERTY_PATH = join(ICLOUD_JARVIS_DIR, 'property/property.yaml')

export const OLLAMA_HOST = (
  process.env['OLLAMA_HOST'] ?? 'http://127.0.0.1:11434'
).replace(/\/$/, '')

// RFC1918 + loopback check. Mirrors ollama_client.resolve_host() security guard.
const ALLOWED_HOST_RE = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
]

export function isAllowedHost(rawUrl: string): boolean {
  try {
    const host = new URL(rawUrl).hostname
    if (host === 'localhost' || host === '::1' || host.endsWith('.local')) return true
    return ALLOWED_HOST_RE.some((re) => re.test(host))
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Staff loading from harness/config/staff.yaml.
// ---------------------------------------------------------------------------

export interface StaffEntry {
  id: string
  title: string
  status: string
  specialties: string[]
  model_key: string
}

export function loadStaff(): StaffEntry[] {
  try {
    const content = readFileSync(
      join(HARNESS_DIR, 'harness/config/staff.yaml'),
      'utf8',
    )
    const doc = load(content) as { staff?: unknown[] } | null
    if (!doc?.staff || !Array.isArray(doc.staff)) return []

    const entries: StaffEntry[] = []
    for (const raw of doc.staff) {
      if (typeof raw !== 'object' || raw === null) continue
      const entry = raw as Record<string, unknown>
      if (typeof entry['id'] !== 'string' || !entry['id']) continue

      entries.push({
        id: entry['id'],
        title: typeof entry['title'] === 'string' ? entry['title'] : '',
        status: typeof entry['status'] === 'string' ? entry['status'] : 'active',
        specialties: Array.isArray(entry['specialties'])
          ? (entry['specialties'] as unknown[]).filter((s): s is string => typeof s === 'string')
          : [],
        model_key: typeof entry['model_key'] === 'string' ? entry['model_key'] : '',
      })
    }
    return entries
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Load the model name for a given role from harness/config/models.yaml.
// Falls back to 'llama3.1:8b' on any parse or file error.
export function loadModelForRole(role: string, fallback = 'llama3.1:8b'): string {
  try {
    const content = readFileSync(
      join(HARNESS_DIR, 'harness/config/models.yaml'),
      'utf8',
    )
    const doc = load(content) as Record<string, unknown> | null
    return (doc?.[role] as { model?: string } | undefined)?.model ?? fallback
  } catch { /* models.yaml not found; use fallback */ }
  return fallback
}

// Load the backend for a given role from harness/config/models.yaml.
// Returns 'ollama' as the default when the role or file is missing.
export function loadBackendForRole(role: string, fallback = 'ollama'): string {
  try {
    const content = readFileSync(
      join(HARNESS_DIR, 'harness/config/models.yaml'),
      'utf8',
    )
    const doc = load(content) as Record<string, unknown> | null
    return (doc?.[role] as { backend?: string } | undefined)?.backend ?? fallback
  } catch { /* models.yaml not found; use fallback */ }
  return fallback
}

// Load the fallback backend+model for a role (used when the primary backend --
// e.g. on-device `apple` -- is unavailable). Empty backend means "no fallback".
export function loadFallbackForRole(role: string): { backend: string; model: string } {
  try {
    const content = readFileSync(
      join(HARNESS_DIR, 'harness/config/models.yaml'),
      'utf8',
    )
    const doc = load(content) as Record<string, unknown> | null
    const entry = doc?.[role] as { fallback_backend?: string; fallback_model?: string } | undefined
    return { backend: entry?.fallback_backend ?? '', model: entry?.fallback_model ?? '' }
  } catch { /* models.yaml not found */ }
  return { backend: '', model: '' }
}

// Load the minimum confidence threshold for unconditional knowledge injection.
// Facts below this value are only added when the token budget allows.
export function loadRecallThreshold(): number {
  try {
    const content = readFileSync(join(HARNESS_DIR, 'harness/config/models.yaml'), 'utf8')
    const doc = load(content) as Record<string, unknown> | null
    const val = doc?.['recall_relevance_threshold']
    if (typeof val === 'number') return val
  } catch { /* ignore */ }
  return 0.7
}

// Load the timeout (in seconds) for a given role from harness/config/models.yaml.
// Returns `defaultSeconds` when the role or field is missing. Callers should multiply ×1000 for ms.
export function loadTimeoutForRole(role: string, defaultSeconds = 30): number {
  try {
    const content = readFileSync(join(HARNESS_DIR, 'harness/config/models.yaml'), 'utf8')
    const doc = load(content) as Record<string, unknown> | null
    const val = (doc?.[role] as { timeout?: unknown } | undefined)?.timeout
    if (typeof val === 'number' && val > 0) return val
  } catch { /* ignore */ }
  return defaultSeconds
}

// Load a top-level boolean flag from harness/config/models.yaml.
// Returns `defaultValue` when the key is absent or the file is unreadable.
export function loadBoolFlag(key: string, defaultValue: boolean): boolean {
  try {
    const content = readFileSync(join(HARNESS_DIR, 'harness/config/models.yaml'), 'utf8')
    const doc = load(content) as Record<string, unknown> | null
    const val = doc?.[key]
    if (typeof val === 'boolean') return val
  } catch { /* ignore */ }
  return defaultValue
}

// ---------------------------------------------------------------------------
// Graphiti / Neo4j config from harness/config/models.yaml.
// Returns enabled flag and the Neo4j HTTP URL derived from neo4j_uri
// (bolt://host:7687 → http://host:7474). Defaults to disabled on any error.
//
// NOTE: The old regex-based parser had a latent bug — the /^graphiti:/ regex
// lacked the `m` flag, so it never matched in a file starting with a comment.
// As a result, the old code ALWAYS returned enabled:false for the live config
// (even though models.yaml has enabled:true). This is a behavior-preserving
// conversion that replicates the bug: if the graphiti block is absent from the
// document, enabled defaults to false. If the block IS present (as in the real
// models.yaml), enabled reflects the actual YAML value. This effectively FIXES
// the bug relative to the old regex behavior — see the comment in config.test.ts
// for the two cases.
// ---------------------------------------------------------------------------

export interface GraphitiConfig {
  enabled: boolean
  neo4jHttpUrl: string
}

export function loadGraphitiConfig(): GraphitiConfig {
  const defaultResult: GraphitiConfig = { enabled: false, neo4jHttpUrl: 'http://localhost:7474' }
  try {
    const content = readFileSync(join(HARNESS_DIR, 'harness/config/models.yaml'), 'utf8')
    const doc = load(content) as Record<string, unknown> | null

    // Block absent → default (disabled). This matches old code's `if (!enabledMatch) return defaultResult`.
    if (!doc?.['graphiti']) return defaultResult

    const block = doc['graphiti'] as Record<string, unknown>
    // Key present but no `enabled` subkey → true (same as old code: val !== 'false' when val is undefined)
    const enabled = block['enabled'] !== false

    const rawUri = typeof block['neo4j_uri'] === 'string' ? block['neo4j_uri'] : ''

    let neo4jHttpUrl = defaultResult.neo4jHttpUrl
    if (rawUri) {
      try {
        const withHttp = rawUri.replace(/^bolt:\/\//, 'http://')
        const parsed = new URL(withHttp)
        parsed.port = '7474'
        neo4jHttpUrl = parsed.toString().replace(/\/$/, '')
      } catch { /* keep default */ }
    }

    return { enabled, neo4jHttpUrl }
  } catch {
    return defaultResult
  }
}

// ---------------------------------------------------------------------------
// Discord integration config from harness/config/integrations.yaml.
// ---------------------------------------------------------------------------

export interface DiscordConfig {
  channel_id: string
  owner_user_id: string
  webhook_keychain_service: string
  bot_token_keychain_service: string
  heartbeat_file: string
  digest_quiet_minutes: number
  approval_expire_hours: number
  approval_expire_hours_gated: number
  proactive_channel_id?: string
  proactive_webhook_keychain_service?: string
  chat_webhook_keychain_service?: string
}

/**
 * Load the [discord] section from integrations.yaml.
 * Returns null if the file is missing or the section is absent.
 */
export function loadDiscordConfig(): DiscordConfig | null {
  try {
    const content = readFileSync(
      join(HARNESS_DIR, 'harness/config/integrations.yaml'),
      'utf8',
    )
    const doc = load(content) as Record<string, unknown> | null

    // Section absent → null. Key off `doc.discord` presence (not value-presence heuristic).
    if (!doc?.['discord']) return null

    const d = doc['discord'] as Record<string, unknown>

    const base: DiscordConfig = {
      channel_id: typeof d['channel_id'] === 'string' ? d['channel_id'] :
        (typeof d['channel_id'] === 'number' ? String(d['channel_id']) : ''),
      owner_user_id: typeof d['owner_user_id'] === 'string' ? d['owner_user_id'] :
        (typeof d['owner_user_id'] === 'number' ? String(d['owner_user_id']) : ''),
      webhook_keychain_service: typeof d['webhook_keychain_service'] === 'string'
        ? d['webhook_keychain_service'] : 'jarvis-discord-webhook',
      bot_token_keychain_service: typeof d['bot_token_keychain_service'] === 'string'
        ? d['bot_token_keychain_service'] : 'jarvis-discord-bot-token',
      heartbeat_file: typeof d['heartbeat_file'] === 'string'
        ? d['heartbeat_file'] : '~/.jarvis/discord-bot.heartbeat',
      // Preserve old code's parseInt(...) || 30 / || 24 semantics (0 → default)
      digest_quiet_minutes: (typeof d['digest_quiet_minutes'] === 'number'
        ? d['digest_quiet_minutes'] : parseInt(String(d['digest_quiet_minutes'] ?? ''), 10)) || 30,
      approval_expire_hours: (typeof d['approval_expire_hours'] === 'number'
        ? d['approval_expire_hours'] : parseInt(String(d['approval_expire_hours'] ?? ''), 10)) || 24,
      // Human-gated kinds (resolver, improve) stage non-regenerating work, so they
      // get a much longer window than transient build approvals (default 7 days).
      approval_expire_hours_gated: (typeof d['approval_expire_hours_gated'] === 'number'
        ? d['approval_expire_hours_gated'] : parseInt(String(d['approval_expire_hours_gated'] ?? ''), 10)) || 168,
    }

    // Optional fields: only set if present (exactOptionalPropertyTypes safe)
    if (typeof d['proactive_channel_id'] === 'string') {
      base.proactive_channel_id = d['proactive_channel_id']
    } else if (typeof d['proactive_channel_id'] === 'number') {
      base.proactive_channel_id = String(d['proactive_channel_id'])
    }
    if (typeof d['proactive_webhook_keychain_service'] === 'string') {
      base.proactive_webhook_keychain_service = d['proactive_webhook_keychain_service']
    }
    if (typeof d['chat_webhook_keychain_service'] === 'string') {
      base.chat_webhook_keychain_service = d['chat_webhook_keychain_service']
    }

    return base
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Mail integration config from harness/config/integrations.yaml.
// ---------------------------------------------------------------------------

export interface MailIntegrationConfig {
  high_weight_senders: string[]
}

/**
 * Load the [mail] section from integrations.yaml.
 * Returns { high_weight_senders: [] } if the file is missing or the section is absent.
 */
export function loadMailConfig(): MailIntegrationConfig {
  try {
    const content = readFileSync(
      join(HARNESS_DIR, 'harness/config/integrations.yaml'),
      'utf8',
    )
    const doc = load(content) as Record<string, unknown> | null
    const mail = doc?.['mail'] as Record<string, unknown> | undefined

    if (!mail) return { high_weight_senders: [] }

    const senders = Array.isArray(mail['high_weight_senders'])
      ? (mail['high_weight_senders'] as unknown[]).filter((s): s is string => typeof s === 'string')
      : []

    return { high_weight_senders: senders }
  } catch {
    return { high_weight_senders: [] }
  }
}

// ---------------------------------------------------------------------------
// Memory config from harness/config/integrations.yaml.
// ---------------------------------------------------------------------------

/**
 * Load `memory.ttl_days` from integrations.yaml via js-yaml (the same parser the
 * other section loaders use). Returns null when the file is missing, the section
 * is absent, or the value is not a positive number -- the caller decides the
 * default and whether to warn. Replaces a hand-rolled line scanner (#820).
 */
export function loadMemoryTtlDays(): number | null {
  try {
    const content = readFileSync(
      join(HARNESS_DIR, 'harness/config/integrations.yaml'),
      'utf8',
    )
    const doc = load(content) as Record<string, unknown> | null
    const memory = doc?.['memory'] as Record<string, unknown> | undefined
    const ttl = memory?.['ttl_days']
    return typeof ttl === 'number' && Number.isFinite(ttl) && ttl > 0 ? ttl : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// iMessage integration config from harness/config/integrations.yaml.
// ---------------------------------------------------------------------------

export interface ImessageConfig {
  enabled: boolean
  include_sms: boolean
  urgent_senders: string[]
  skip_group_chats: boolean
}

/**
 * Load the [imessage] section from integrations.yaml.
 * Returns safe defaults if the file is missing or the section is absent.
 */
export function loadImessageConfig(): ImessageConfig {
  const defaults: ImessageConfig = {
    enabled: true,
    include_sms: true,
    urgent_senders: [],
    skip_group_chats: true,
  }
  try {
    const content = readFileSync(
      join(HARNESS_DIR, 'harness/config/integrations.yaml'),
      'utf8',
    )
    const doc = load(content) as Record<string, unknown> | null
    const im = doc?.['imessage'] as Record<string, unknown> | undefined

    // Section absent → full defaults (all three booleans default to true)
    if (!im) return defaults

    // Boolean coercion: old code treated anything except literal string 'false' as true.
    // js-yaml parses `true`/`false` as booleans, so `im.enabled !== false` is the correct
    // equivalent: missing key → undefined !== false → true; false → false; true → true.
    return {
      enabled: im['enabled'] !== false,
      include_sms: im['include_sms'] !== false,
      urgent_senders: Array.isArray(im['urgent_senders'])
        ? (im['urgent_senders'] as unknown[]).filter((s): s is string => typeof s === 'string')
        : [],
      skip_group_chats: im['skip_group_chats'] !== false,
    }
  } catch {
    return defaults
  }
}

// Load the model_key for a given staff id from harness/config/staff.yaml.
// Returns the resolved model name (via loadModelForRole).
export function loadStaffModel(staffId: string): string {
  try {
    const content = readFileSync(
      join(HARNESS_DIR, 'harness/config/staff.yaml'),
      'utf8',
    )
    const doc = load(content) as { staff?: unknown[] } | null
    if (!doc?.staff || !Array.isArray(doc.staff)) return loadModelForRole('default')

    for (const raw of doc.staff) {
      if (typeof raw !== 'object' || raw === null) continue
      const entry = raw as Record<string, unknown>
      if (entry['id'] === staffId && typeof entry['model_key'] === 'string' && entry['model_key']) {
        return loadModelForRole(entry['model_key'])
      }
    }
  } catch { /* ignore */ }
  return loadModelForRole('default')
}
