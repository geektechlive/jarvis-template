// Non-calendar observer-pattern routines for the proactive scheduler.
// Routines: overnight_reflection, weekly_curator, self_improvement,
//   wellness_checkin, weekly_newsdesk, tech_advisor_watch, cfo_watch,
//   portfolio_watch, memory_consolidation, vault_export, github_watch,
//   discord_pulse, rss_fetch, infra_watch, unifi_watch.
// Patrol routines live in patrol.ts.

import * as os from 'node:os'
import { log } from 'ion-sdk'
import { logEvent, pruneOldEvents, pruneHighFrequencyEvents, pruneOldMessages, pruneOldGoalRuns, prunePerfMetrics, pruneStalePendingMemory, getSubstantiveCrossSessionMessages } from '../../memory/episodic'
import { purgeOldResourceItems } from '../../resources/store'
import { extractGapsAndPropose, processTriageCorrections } from '../../learning'
import { run as improveRun } from '../../improve'
import { fetchAndStoreFeeds } from '../../feeds'
import { runClaudeAgent } from '../../util/claudeAgent'
import { runCommandAsync } from '../../util/ionPrompt'
import { isEnabled, OBSERVER_DECISION_FRAMEWORK, shouldRunPrompt, isWeekend } from '../helpers'
import { loadGraphitiConfig, loadDiscordConfig } from '../../config'
import { postLongEmbed } from '../../discord/webhook'
import { dispatchObserver } from './_dispatch'
import { runReflection } from '../../reflection'
import { getSchedulerCtx } from '../ctx'

const VEC_SERVER = process.env['VEC_SERVER'] ?? 'http://127.0.0.1:9876'

/**
 * Retrieve stored interest tags for a category from user_profile.
 * Returns the values string (e.g. "AI policy geopolitics crypto") or null
 * when nothing is stored or the vec-server is unavailable.
 * Never throws — caller should fall through to default prompt on null.
 */
async function recallInterests(category: string): Promise<string | null> {
  const key = `interests::${category}`
  try {
    const res = await fetch(`${VEC_SERVER}/recall`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: key, collection: 'user_profile', n: 3 }),
      signal: AbortSignal.timeout(5000),
    })
    const data = (await res.json()) as { results?: string[] }
    const match = (data.results ?? []).find((r) => r.includes(key))
    if (!match) return null
    const colonIdx = match.indexOf(': ')
    return colonIdx !== -1 ? match.slice(colonIdx + 2).trim() : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Routine implementations
// ---------------------------------------------------------------------------

// In-flight guard: prevents concurrent invocations if the scheduler fires
// multiple times before the previous run finishes (e.g., after a deploy restart).
let overnightReflectionRunning = false

// Runs the reflection panel directly against recent substantive user conversations.
// Prior design sent an `ion prompt` asking Jarvis whether to reflect — that was
// unreliable: the LLM gate consistently chose to stand down because the jarvis
// key session contains only automated routine content, and the turn_start hook
// timed out under concurrent load. Now we gather cross-session messages directly
// and call runReflection() in-process, making it deterministic.
export async function runOvernightReflection(): Promise<void> {
  if (!isEnabled('overnight_reflection')) return
  if (overnightReflectionRunning) {
    log.info('scheduler: overnight_reflection: already in flight, skipping')
    return
  }
  overnightReflectionRunning = true

  try {
    const eventsDeleted = pruneOldEvents(90)
    const pollerDeleted = pruneHighFrequencyEvents(14)
    pruneOldMessages(90)
    pruneOldGoalRuns(90)
    const perfDeleted = prunePerfMetrics(90)
    try {
      purgeOldResourceItems()
    } catch (err) {
      log.warn('scheduler: overnight_reflection: resource purge failed', { err: String(err) })
    }
    if (eventsDeleted > 0 || perfDeleted > 0 || pollerDeleted > 0) {
      log.info('scheduler: overnight_reflection: pruned old rows', { eventsDeleted, pollerDeleted, perfDeleted })
    }

    // 36h window so late-evening conversations (e.g. 23:00 CDT = 04:00 UTC next day)
    // are still captured when the routine fires at 03:00 local time.
    const msgs = getSubstantiveCrossSessionMessages(36)
    if (msgs.length < 5) {
      log.info('scheduler: overnight_reflection: not enough substantive content, skipping reflection')
      logEvent('overnight_reflection', 'routine_delivered', {
        routine: 'overnight_reflection',
        facts_stored: 0,
        skipped: true,
      })
      return
    }

    const ctx = getSchedulerCtx()
    if (!ctx) {
      log.warn('scheduler: overnight_reflection: ctx unavailable, deferring')
      logEvent('overnight_reflection', 'routine_deferred', {
        routine: 'overnight_reflection',
        reason: 'no_ctx',
        message_count: msgs.length,
      })
      logEvent('overnight_reflection', 'routine_delivered', {
        routine: 'overnight_reflection',
        deferred: true,
        facts_stored: 0,
      })
      return
    }
    const storedIds = await runReflection(ctx, 'overnight_reflection', msgs)
    logEvent('overnight_reflection', 'routine_delivered', {
      routine: 'overnight_reflection',
      facts_stored: storedIds.length,
    })
    log.info('scheduler: overnight_reflection: complete', { facts_stored: storedIds.length })
  } catch (err) {
    log.warn('scheduler: overnight_reflection failed', { err: String(err) })
    logEvent('overnight_reflection', 'routine_delivered', {
      routine: 'overnight_reflection',
      exit_code: -1,
      error: String(err),
    })
  } finally {
    overnightReflectionRunning = false
  }
}

export async function runWeeklyCurator(): Promise<void> {
  if (!isEnabled('weekly_curator')) return
  log.info('scheduler: weekly_curator: starting')
  try {
    const proposals = await extractGapsAndPropose()
    log.info('scheduler: weekly_curator: gap proposals complete', { proposals: proposals.length })
  } catch (err) {
    log.warn('scheduler: weekly_curator: extractGapsAndPropose failed', { err: String(err) })
  }
  try {
    const written = await processTriageCorrections()
    log.info('scheduler: weekly_curator: triage corrections complete', { written })
  } catch (err) {
    log.warn('scheduler: weekly_curator: processTriageCorrections failed', { err: String(err) })
  }
  try {
    await dispatchObserver(
      'weekly_curator_audit',
      'knowledge-curator',
      'Standing weekly Knowledge Curator audit pass. Dispatch the Knowledge Curator now. ' +
      'She should scan the knowledge collection for duplicate facts, internal contradictions, ' +
      'and entries that have gone stale or are no longer accurate. ' +
      'Use surface_to_inbox for any contradiction that needs resolution. ' +
      'Use queue_for_brief for patterns worth noting (topic coverage gaps, collection health). ' +
      'All clear: stand down silently. ' +
      OBSERVER_DECISION_FRAMEWORK,
    )
    log.info('scheduler: weekly_curator: knowledge_curator audit complete')
  } catch (err) {
    log.warn('scheduler: weekly_curator: knowledge_curator audit failed', { err: String(err) })
  }
  logEvent('weekly_curator', 'routine_delivered', { routine: 'weekly_curator', ts: new Date().toISOString() })
  log.info('scheduler: weekly_curator: complete')
}

export async function runSelfImprovement(): Promise<void> {
  if (!isEnabled('self_improvement')) return
  log.info('scheduler: self_improvement: starting')
  try {
    const result = await improveRun(20)
    log.info('scheduler: self_improvement: complete', { result: result.slice(0, 200) })
    logEvent('self_improvement', 'routine_delivered', { routine: 'self_improvement' })
  } catch (err) {
    log.warn('scheduler: self_improvement: failed', { err: String(err) })
    logEvent('self_improvement', 'routine_delivered', { routine: 'self_improvement', exit_code: -1, error: String(err) })
  }
}

export async function runWellnessCheckin(): Promise<void> {
  if (!isEnabled('wellness_checkin')) return
  const wellnessInterests = await recallInterests('wellness')
  const interestsClause = wellnessInterests
    ? `Alex's stated wellness interests: ${wellnessInterests}. Factor these into the check-in. `
    : ''
  await dispatchObserver(
    'wellness_checkin',
    'wellness-coach',
    "Standing twice-weekly wellness observer pass (Monday and Thursday). Dispatch the Wellness Coach now. " +
    "She should call get_habits first to ground the check-in in real completion data, " +
    "pull calendar density for the past 7 days, check conversation tone, " +
    "and recall any wellness notes from memory. " +
    interestsClause +
    OBSERVER_DECISION_FRAMEWORK,
  )
}

/**
 * Parse the local timestamp out of a caller-stamped `stored_at` value.
 *
 * Memory rows store `stored_at` as `"[YYYY-MM-DD HH:MM TZ] <text>"` (store.py
 * prefers the caller-provided stamp; recall.ts builds it from the local time),
 * so `new Date(stored_at)` is NaN. Extract the leading `YYYY-MM-DD HH:MM` and
 * parse it as local time — the Mini runs America/Chicago, matching the stamp's
 * zone. Also handles a bare ISO `stored_at` (Python-written rows). Returns epoch
 * ms, or null when no stamp can be parsed so callers can fail open rather than
 * silently drop the item. Exported for unit testing.
 */
export function parseStampedStoredAtMs(storedAt: string): number | null {
  const m = /^\[?(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/.exec(storedAt)
  if (!m) return null
  const ms = new Date(`${m[1]}T${m[2]}`).getTime()
  return isNaN(ms) ? null : ms
}

export async function runDailyNewsdesk(): Promise<void> {
  if (!isEnabled('daily_newsdesk')) return
  try {
    const res = await fetch(`${VEC_SERVER}/list?collection=news&limit=60`, {
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      log.warn('scheduler: daily_newsdesk — list request failed', { status: res.status })
      return
    }
    const data = (await res.json()) as { entries?: Array<{ id: string; text: string; source: string; stored_at: string }> }
    const entries = data.entries ?? []

    // Keep only items stamped within the last 24h. stored_at is a non-ISO stamped
    // string, so parse it via the shared helper; without a real cutoff the digest
    // would re-post the same 14-day-TTL items every day. Fail open on unparseable
    // stamps rather than silently dropping fresh news.
    const cutoff = Date.now() - 24 * 60 * 60 * 1000
    const fresh = entries.filter((e) => {
      const ms = parseStampedStoredAtMs(e.stored_at)
      return ms === null || ms >= cutoff
    })

    if (fresh.length === 0) {
      log.info('scheduler: daily_newsdesk — no fresh news', { collection: 'news' })
      return
    }

    // entry.text is the raw stored document "[category] title: description" — the
    // timestamp lives only in stored_at, not the text. Keep the [category] bracket
    // as useful topic context in the digest.
    const digest = fresh.slice(0, 25).map((entry) => `• ${entry.text}`).join('\n')

    const discordConfig = loadDiscordConfig()
    if (discordConfig?.proactive_webhook_keychain_service) {
      await postLongEmbed(digest, 'Daily News', 0x5865F2, discordConfig.proactive_webhook_keychain_service).catch((err: unknown) => {
        log.warn('scheduler: daily_newsdesk — discord delivery failed', { err: String(err) })
      })
    }
    logEvent('daily_newsdesk', 'routine_delivered', { routine: 'daily_newsdesk', items: fresh.length })
  } catch (err) {
    log.warn('scheduler: daily_newsdesk failed', { err: String(err) })
  }
}

export async function runWeeklyNewsdesk(): Promise<void> {
  if (!isEnabled('weekly_newsdesk')) return
  await dispatchObserver(
    'weekly_newsdesk',
    'news-desk',
    "Standing weekly News Desk observer pass. Dispatch the News Desk now. " +
    "She should query the past 7 days of conversation history for topics Alex mentioned or asked about, " +
    "then check for noteworthy developments on those topics. Cover 1-3 items max. " +
    "Recent feed items on technology and AI topics are already stored in the news collection. " +
    "Recall from there first before running WebSearch -- query with terms like 'AI technology news this week'. " +
    "Use WebSearch only to fill gaps or verify breaking developments not in the cache. " +
    "When fetching article URLs, prefer the jina_fetch tool over web_fetch -- it returns clean markdown and handles JS-rendered pages. " +
    OBSERVER_DECISION_FRAMEWORK,
  )
}

export async function runTechAdvisorWatch(): Promise<void> {
  if (!isEnabled('tech_advisor_watch')) return
  const techInterests = await recallInterests('tech')
  const interestsClause = techInterests
    ? `Alex's stated tech interests: ${techInterests}. Bias toward these when scanning for topics. `
    : ''
  await dispatchObserver(
    'tech_advisor_watch',
    'tech-advisor',
    "Standing weekly Tech Advisor observer pass. Dispatch the Tech Advisor now. " +
    "He should query the past 7 days of conversation history for any technology topic Alex mentioned " +
    "2 or more times, or any tech decision that was raised but not resolved. " +
    interestsClause +
    "When fetching article URLs, prefer the jina_fetch tool over web_fetch -- it returns clean markdown and handles JS-rendered pages. " +
    OBSERVER_DECISION_FRAMEWORK,
  )
}

export async function runCfoWatch(): Promise<void> {
  if (!isEnabled('cfo_watch')) return
  await dispatchObserver(
    'cfo_watch',
    'personal-cfo',
    "Standing weekly Personal CFO observer pass. Dispatch the Personal CFO now. " +
    "First, recall recent receipt facts from memory (query: 'receipt charged subscription invoice payment') " +
    "and check for subscription drift signals against the finance directory subscriptions.json: " +
    "price changes > 10%, new subscriptions not in subscriptions.json, or known subscriptions with no receipt for > 35 days. " +
    "Then scan for uncategorized subscriptions or unusual spend patterns that appeared this week and have not been surfaced yet. " +
    "Urgent items (price change, missing renewal, unexpected charge): use surface_to_inbox. " +
    "Informational items (new subscription to categorize, pattern to note): use queue_for_brief. " +
    OBSERVER_DECISION_FRAMEWORK,
  )
}

export async function runPortfolioWatch(): Promise<void> {
  if (!isEnabled('portfolio_watch')) return
  if (isWeekend()) return  // skip weekends; market is closed
  await dispatchObserver(
    'portfolio_watch',
    'portfolio-manager',
    "Standing daily Portfolio Manager observer pass. Dispatch the Portfolio Manager now. " +
    "FIRST, refresh the holdings file: fetch the current price for each held ticker via the " +
    "Yahoo Finance chart API, then Edit the holdings file in place to update each market_price, " +
    "recompute market_value (shares x price) and unrealized_gain (market_value - shares x cost_basis), " +
    "and set a top-level last_priced field to today's date. Leave a ticker's price null if the fetch fails. " +
    "THEN scan held positions for significant moves or breaking news since yesterday: " +
    "price moves greater than 2%, earnings surprises, analyst actions, material news on a held ticker. " +
    "Urgent items (position crossed a risk threshold, material adverse news): use surface_to_inbox. " +
    "Notable but not urgent items (notable move, proposed action): use queue_for_brief. " +
    "If nothing crossed the bar after refreshing prices, stand down silently. " +
    OBSERVER_DECISION_FRAMEWORK,
  )
}

export async function runMemoryConsolidation(): Promise<void> {
  if (!isEnabled('memory_consolidation')) return
  const VEC_SERVER = process.env['VEC_SERVER'] ?? 'http://127.0.0.1:9876'
  try {
    const res = await fetch(`${VEC_SERVER}/consolidate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(180_000),
    })
    const data = (await res.json()) as {
      sessions_summarized?: number
      cross_session_facts?: number
      preferences_merged?: number
      entries_archived?: number
      errors?: string[]
      error?: string
    }
    if (data.error) {
      log.warn('scheduler: memory_consolidation failed', { error: data.error })
      logEvent('memory_consolidation', 'routine_delivered', { routine: 'memory_consolidation', exit_code: -1, error: data.error })
      return
    }
    const errCount = data.errors?.length ?? 0
    log.info('scheduler: memory_consolidation complete', {
      sessions: data.sessions_summarized ?? 0,
      facts: data.cross_session_facts ?? 0,
      merged: data.preferences_merged ?? 0,
      archived: data.entries_archived ?? 0,
      errors: errCount,
    })
    logEvent('memory_consolidation', 'routine_delivered', { routine: 'memory_consolidation' })
  } catch (err) {
    log.warn('scheduler: memory_consolidation unavailable', { err: String(err) })
    logEvent('memory_consolidation', 'routine_delivered', { routine: 'memory_consolidation', exit_code: -1, error: String(err) })
  }

  // Prune pending_memory rows older than 30 days. Facts that haven't been
  // written to ChromaDB in this window are stale — the conversation is long past.
  // Failed writes keep retrying until this TTL; nothing is deleted on failure. (#719)
  try {
    const pruned = pruneStalePendingMemory(30)
    if (pruned > 0) {
      log.info('scheduler: memory_consolidation pruned stale pending_memory rows', { pruned, ttl_days: 30 })
    }
  } catch (err) {
    log.warn('scheduler: pruneStalePendingMemory failed', { err: String(err) })
  }
}

export async function runVaultExport(): Promise<void> {
  if (!isEnabled('vault_export')) return
  const uvBin = '/opt/homebrew/bin/uv'
  const scriptPath = `${os.homedir()}/Jarvis/scripts/export-vault.py`
  try {
    const r = await runCommandAsync(uvBin, [
      'run',
      '--project', `${os.homedir()}/Jarvis`,
      'python', scriptPath,
    ], { timeoutMs: 120_000 })
    if (r.status !== 0) {
      log.warn('scheduler: vault_export failed', { status: r.status, stderr: r.stderr })
      logEvent('vault_export', 'routine_delivered', { routine: 'vault_export', exit_code: r.status ?? -1, error: r.stderr })
      return
    }
    log.info('scheduler: vault_export complete', { output: r.stdout.trim() })
    logEvent('vault_export', 'routine_delivered', { routine: 'vault_export' })
  } catch (err) {
    log.warn('scheduler: vault_export error', { err: String(err) })
    logEvent('vault_export', 'routine_delivered', { routine: 'vault_export', exit_code: -1, error: String(err) })
  }
}

export async function runGithubWatch(): Promise<void> {
  if (!isEnabled('github_watch')) return
  if (!shouldRunPrompt('github_watch')) return
  await dispatchObserver(
    'github_watch',
    'repo-steward',
    'Standing daily Repo Steward observer pass. Dispatch the Repo Steward now. ' +
    "He should scan Alex's active personal repositories for: open PRs that need review or are blocked, " +
    'failing CI on recent commits, new issues opened in the last 24 hours. ' +
    'Urgent items (failing CI on main, stale PR blocking a deploy): use surface_to_inbox. ' +
    'Notable items (new issue, PR ready to merge): use queue_for_brief. ' +
    'If nothing needs attention, stand down silently. ' +
    OBSERVER_DECISION_FRAMEWORK,
  )
}

export async function runDiscordPulse(): Promise<void> {
  if (!isEnabled('discord_pulse')) return
  await dispatchObserver(
    'discord_pulse',
    'chief-of-communications',
    'Standing Discord comms pulse. Dispatch the Chief of Communications now. ' +
    'She should scan watched Discord channels and DMs for messages since the last pulse. ' +
    'If something urgent arrived, surface_to_inbox immediately. ' +
    'If something notable but not urgent, queue_for_brief. ' +
    'If nothing material arrived, stand down silently. ' +
    OBSERVER_DECISION_FRAMEWORK,
  )
}

export async function runRssFetch(): Promise<void> {
  if (!isEnabled('rss_fetch')) return
  try {
    const count = await fetchAndStoreFeeds()
    log.info('scheduler: rss_fetch complete', { items_stored: count })
    logEvent('rss_fetch', 'routine_delivered', { routine: 'rss_fetch', items_stored: count })
  } catch (err) {
    log.warn('scheduler: rss_fetch failed', { err: String(err) })
    logEvent('rss_fetch', 'routine_delivered', { routine: 'rss_fetch', exit_code: -1, error: String(err) })
  }
}

export async function runInfraWatch(): Promise<void> {
  if (!isEnabled('infra_watch')) return
  if (!shouldRunPrompt('infra_watch')) return
  await dispatchObserver(
    'infra_watch',
    'systems-engineer',
    'Standing infrastructure observer pass. Dispatch the Systems Engineer now. ' +
    'Check Cloudflare zone health (SSL, Workers, Pages, DNS) and UniFi network health ' +
    '(device connectivity, bandwidth anomalies, recent firewall/security events, unknown clients). ' +
    'Urgent (outage, active attack, IDS alert): use surface_to_inbox. ' +
    'Notable (device offline, unusual traffic pattern): use queue_for_brief. ' +
    'All clear: stand down silently. ' +
    OBSERVER_DECISION_FRAMEWORK,
  )
  try {
    const graphiti = loadGraphitiConfig()
    const graphitiClause = graphiti.enabled
      ? `Neo4j/Graphiti availability (curl ${graphiti.neo4jHttpUrl}/ — expect HTTP 200; ` +
        'if unreachable or non-200, graph ingest will silently fail every turn): ' +
        'Urgent (Neo4j down): use surface_to_inbox. '
      : ''
    await dispatchObserver(
      'infra_watch_observability',
      'observability-watcher',
      'Standing infrastructure observer pass — internal health check. Dispatch the Observability Watcher now. ' +
      'Check: ion engine log for errors or warnings in the past 24h, vec server health (curl http://127.0.0.1:9876/health), ' +
      'Ollama status (ollama list), and whether all scheduled routines fired today. ' +
      graphitiClause +
      'Urgent (vec server down, ion not responding, Neo4j down): use surface_to_inbox. ' +
      'Notable (missed routine, log spike): use queue_for_brief. ' +
      'All clear: stand down silently.',
    )
  } catch (err) {
    log.warn('scheduler: infra_watch: observability pass failed', { err: String(err) })
  }
}

// UniFi-only check -- used by webhook handler when an event arrives.
// Cloudflare is proactive (daily cadence); no need to poll it on every webhook.
export async function runUnifiWatch(): Promise<void> {
  await dispatchObserver(
    'unifi_webhook',
    'systems-engineer',
    'A UniFi event just fired. Dispatch the Systems Engineer now. ' +
    'Check UniFi only: device connectivity, recent firewall/security events, IDS alerts, unknown clients. ' +
    'Do NOT check Cloudflare -- this was triggered by a local network event, not a cloud event. ' +
    'Urgent (active attack, IDS alert, WAN down): use surface_to_inbox. ' +
    'Notable (device offline, unusual traffic): use queue_for_brief. ' +
    'All clear: stand down silently. ' +
    OBSERVER_DECISION_FRAMEWORK,
  )
}

export async function runSecurityWatch(): Promise<void> {
  if (!isEnabled('security_watch')) return
  await dispatchObserver(
    'security_watch',
    'security-analyst',
    'Standing weekly Security Analyst observer pass. Dispatch the Security Analyst now. ' +
    'She should: (1) scan package.json and requirements files for any dependencies with known CVEs ' +
    '(check against OSV or NVD if web access is available), ' +
    '(2) scan recent git commits for any accidentally committed credentials or API keys, ' +
    '(3) check whether any API keys stored in the harness have appeared in public breach databases. ' +
    'Urgent (active CVE in production dependency, leaked credential): use surface_to_inbox. ' +
    'Notable (outdated dependency with patch available, low-severity finding): use queue_for_brief. ' +
    'All clear: stand down silently. ' +
    OBSERVER_DECISION_FRAMEWORK,
  )
}

// Called by UniFi webhook on critical security events (IDS, firewall drops, WAN down).
export async function runSecurityAnalystAlert(): Promise<void> {
  await dispatchObserver(
    'unifi_security_alert',
    'security-analyst',
    'A critical security event just arrived from the UniFi network. Dispatch the Security Analyst now. ' +
    'Review the event details, assess the severity, check for related patterns in recent network history, ' +
    'and determine if this is an active threat or a false positive. ' +
    'Active threat: use surface_to_inbox immediately. ' +
    'False positive or low risk: use queue_for_brief with context.',
  )
}

// Called by UniFi webhook on warning-level events (device offline, unknown client).
export async function runObservabilityAlert(): Promise<void> {
  await dispatchObserver(
    'unifi_health_alert',
    'observability-watcher',
    'A network health event just arrived from the UniFi device. Dispatch the Observability Watcher now. ' +
    'Check device status, recent connectivity history, and whether this is a known or unexpected device. ' +
    'Persistent outage or unknown client: use surface_to_inbox. ' +
    'Transient disconnect: use queue_for_brief if pattern is unusual.',
  )
}

export async function runRelayHealthCheck(): Promise<void> {
  if (!isEnabled('relay_health_check')) return
  await dispatchObserver(
    'relay_health_check',
    'observability-watcher',
    'Standing relay health check. Dispatch the Observability Watcher now. ' +
    'Verify: (1) cloudflared tunnel status (systemctl or launchctl for com.example.cloudflared), ' +
    '(2) ion-relay binding on 127.0.0.1:8443 (nc -z or curl check), ' +
    '(3) presence of a valid push-channel token in ~/.ion/push-channel. ' +
    'Any failure (tunnel down, relay not listening, no push-channel token): use surface_to_inbox immediately. ' +
    'All clear: stand down silently. ' +
    OBSERVER_DECISION_FRAMEWORK,
  )
}

// Called by the iMessage webhook when an inbound message needs attention.
// Uses ctx.sendPrompt (ion-native async path via h.onSendMessage) so that ion-registered
// tools like send_imessage are available. dispatchAgent is unavailable in async HTTP handlers.
export async function runImessageIngest(task: string): Promise<void> {
  const ctx = getSchedulerCtx()
  if (ctx) {
    try {
      await ctx.sendPrompt(task)
      logEvent('imessage_ingest', 'routine_delivered', { routine: 'imessage_ingest' })
      return
    } catch (err) {
      log.warn('scheduler: imessage_ingest: sendPrompt failed', { err: String(err) })
    }
  }
  // Cold-start fallback — no tools available but at least logs and batches.
  await runClaudeAgent('imessage_ingest', task)
  logEvent('imessage_ingest', 'routine_delivered', { routine: 'imessage_ingest' })
}


