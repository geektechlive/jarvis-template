// Discord gateway bot for the Jarvis CI/CD approval loop.
// Standalone process — runs under its own LaunchAgent, not under the ion daemon.
// Entry: `node dist/discord-bot.js`
//
// Intents required: Guilds, GuildMessages, MessageContent (privileged).
// The privileged MessageContent intent must also be enabled in the Discord
// Developer Portal under the bot's Settings > Privileged Gateway Intents.

import { Client, Events, GatewayIntentBits, type Message } from 'discord.js'
import { spawnSync } from 'node:child_process'
import { existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getPending, decide, findByLocalIndex, findByIssueNumber, expireOlderThan, type Approval } from '../approvals/index'
import { postPendingDigest } from './digest'
import { loadDiscordConfig } from '../config'
import { db, logEvent, recentEvents } from '../memory/episodic'
import { runClaudeAgent } from '../util/claudeAgent'
import { applyApprovedResolver, denyResolverApproval } from '../patrol/resolver'
import { cleanupResolverApprovalBranch } from '../patrol/resolver-shared'

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const logb = {
  info: (msg: string, ...a: unknown[]) => console.log(`[INFO] [discord-bot] ${msg}`, ...a),
  warn: (msg: string, ...a: unknown[]) => console.warn(`[WARN] [discord-bot] ${msg}`, ...a),
  error: (msg: string, ...a: unknown[]) => console.error(`[ERROR] [discord-bot] ${msg}`, ...a),
}

// Suppress discord.js DeprecationWarning noise (ready→clientReady etc.) that
// bypasses console and floods stderr via process.emitWarning.
process.on('warning', (warning) => {
  if (warning.name === 'DeprecationWarning') return
  console.warn(`[WARN] [discord-bot] ${warning.name}: ${warning.message}`)
})

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HEARTBEAT_INTERVAL_MS = 60_000

// ---------------------------------------------------------------------------
// Keychain helper (inline — no ion-sdk log dependency)
// ---------------------------------------------------------------------------

function readBotToken(): string {
  const service = 'jarvis-discord-bot-token'
  const account = process.env['USER'] ?? '<username>'
  const result = spawnSync('security', [
    'find-generic-password',
    '-s', service,
    '-a', account,
    '-w',
  ])
  if (result.status !== 0) {
    throw new Error(`Discord bot token not found in Keychain (service=${service}, account=${account})`)
  }
  return result.stdout.toString().trim()
}

// ---------------------------------------------------------------------------
// Heartbeat file
// ---------------------------------------------------------------------------

function writeHeartbeat(heartbeatFile: string): void {
  try {
    const resolved = heartbeatFile.replace('~', homedir())
    mkdirSync(join(resolved, '..'), { recursive: true })
    writeFileSync(resolved, String(Date.now()), 'utf8')
  } catch (err) {
    logb.error('heartbeat write failed:', err)
  }
}

// ---------------------------------------------------------------------------
// GitHub workflow dispatch
// ---------------------------------------------------------------------------

// launchd on M2 doesn't inherit PATH, so gh may not be on PATH at all
function ghBinPath(): string {
  return existsSync('/opt/homebrew/bin/gh') ? '/opt/homebrew/bin/gh' : 'gh'
}

/**
 * Dispatch desktop-deploy.yml for desktop_deploy approvals.
 * Returns true on success, false if gh exits nonzero.
 * Exported for testing via dependency injection.
 */
export function dispatchDeployWorkflow(
  approval: Approval,
  spawn: typeof spawnSync = spawnSync,
): boolean {
  if (approval.kind !== 'desktop_deploy') return false
  if (!approval.github_run_id) {
    logb.error(`desktop_deploy approval ${approval.id} has no github_run_id (SHA); skipping dispatch`)
    return false
  }

  const result = spawn(ghBinPath(), [
    'workflow', 'run', 'desktop-deploy.yml',
    '-R', '<your-org>/jarvis',
    '-f', `sha=${approval.github_run_id}`,
    '-f', `approve_id=${String(approval.id)}`,
  ], { encoding: 'utf8' })

  if (result.status !== 0) {
    logb.error(`gh workflow run failed for approval ${approval.id}:`, result.stderr)
    return false
  }

  return true
}

/**
 * Kind-aware approval dispatch.
 * - resolver: apply the stash via applyApprovedResolver
 * - desktop_deploy: trigger GitHub Actions workflow
 * - others: approval recorded is sufficient
 */
async function dispatchForKind(approval: Approval): Promise<{ ok: boolean; message?: string }> {
  if (approval.kind === 'resolver') {
    return applyApprovedResolver(approval.id)
  }
  if (approval.kind === 'desktop_deploy') {
    const ok = dispatchDeployWorkflow(approval)
    return { ok }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Command parsing (pure — exported for testing)
// ---------------------------------------------------------------------------

export type BotCommand =
  | { type: 'approve_index'; index: number }
  | { type: 'deny_index'; index: number }
  | { type: 'approve_issue'; issueNumber: number }
  | { type: 'approve_all'; filter?: string | undefined }
  | { type: 'status' }
  | { type: 'pending' }
  | { type: 'help' }
  | { type: 'unknown' }
  | { type: 'note_domain'; domain: string }
  | { type: 'skip_domain'; domain: string }
  | { type: 'meeting_done' }
  | { type: 'on_demand_brief' }

/**
 * Parse the text of a Discord message into a structured BotCommand.
 * All matching is case-insensitive.
 */
export function parseCommand(text: string): BotCommand {
  const t = text.trim().toLowerCase()

  // approve all [filter]
  const approveAllMatch = /^approve all(?:\s+(\S+))?$/.exec(t)
  if (approveAllMatch) {
    const filter = approveAllMatch[1]
    return filter !== undefined ? { type: 'approve_all', filter } : { type: 'approve_all' }
  }

  // approve #<issue>
  const approveIssueMatch = /^approve\s+#(\d+)$/.exec(t)
  if (approveIssueMatch) {
    const n = parseInt(approveIssueMatch[1] ?? '0', 10)
    return { type: 'approve_issue', issueNumber: n }
  }

  // approve <N>
  const approveIndexMatch = /^approve\s+(\d+)$/.exec(t)
  if (approveIndexMatch) {
    const n = parseInt(approveIndexMatch[1] ?? '0', 10)
    return { type: 'approve_index', index: n }
  }

  // deny <N>
  const denyMatch = /^deny\s+(\d+)$/.exec(t)
  if (denyMatch) {
    const n = parseInt(denyMatch[1] ?? '0', 10)
    return { type: 'deny_index', index: n }
  }

  if (t === 'status') return { type: 'status' }
  if (t === 'pending') return { type: 'pending' }
  if (t === 'help' || t === '?') return { type: 'help' }

  return { type: 'unknown' }
}

const HELP_TEXT = [
  '**Jarvis bot commands:**',
  '`status` — bot health + pending count',
  '`pending` — post a fresh digest of all pending approvals',
  '`approve <N>` — approve by local index from the most recent digest',
  '`approve #<issue>` — approve by GitHub issue number',
  '`approve all` — approve every pending item',
  '`approve all <filter>` — approve pending items whose kind contains <filter> (e.g. `approve all engine`)',
  '`deny <N>` — deny by local index',
  '`help` or `?` — show this message',
].join('\n')

/**
 * Parse the text of a Discord message from the proactive channel into a BotCommand.
 * All matching is case-insensitive.
 */
export function parseProactiveCommand(text: string): BotCommand {
  const t = text.trim().toLowerCase()

  // note <domain>
  const noteMatch = /^note\s+(\S+)$/.exec(t)
  if (noteMatch) {
    return { type: 'note_domain', domain: noteMatch[1] ?? '' }
  }

  // skip <domain>
  const skipMatch = /^skip\s+(\S+)$/.exec(t)
  if (skipMatch) {
    return { type: 'skip_domain', domain: skipMatch[1] ?? '' }
  }

  if (t === 'done') return { type: 'meeting_done' }
  if (t === 'brief') return { type: 'on_demand_brief' }
  if (t === 'help' || t === '?') return { type: 'help' }

  return { type: 'unknown' }
}

const PROACTIVE_HELP_TEXT = [
  '**Jarvis proactive commands:**',
  '`note <domain>` — dispatch Curator to build a research note for the domain',
  '`skip <domain>` — suppress Safari clustering alerts for this domain for 4h',
  '`done` — suppress the current meeting countdown reminder',
  '`brief` — on-demand brief with current data (scheduled briefs arrive automatically at 07:30, 13:00, and 21:00)',
  '`help` or `?` — show this message',
].join('\n')

// ---------------------------------------------------------------------------
// Command execution
// ---------------------------------------------------------------------------

async function handleProactiveMessage(message: Message, config: ReturnType<typeof loadDiscordConfig>): Promise<void> {
  if (!config) return
  const cmd = parseProactiveCommand(message.content)

  switch (cmd.type) {
    case 'note_domain': {
      await message.react('📝')
      await message.reply(`Filing a research note for \`${cmd.domain}\`.`)
      void runClaudeAgent(
        'weekly_curator',
        `Build a research note for the domain ${cmd.domain}. The user has been actively reading it today. Summarise what you know about this topic and suggest follow-up angles worth exploring.`,
      ).catch((err: unknown) => {
        logb.error('note_domain curator failed:', err)
      })
      break
    }

    case 'skip_domain': {
      // Write a suppression event using the same cooldown key safariClustering checks.
      // safariClustering.ts checks: recentEvents('safari_clustering:${domain}', 'proactive_fired', 4)
      // We write a future-dated-equivalent by writing many events to fill the cooldown window.
      // Simpler: write one event and extend COOLDOWN_HOURS to 24 by logging now — the trigger
      // compares ts >= cutoff, so writing a "proactive_fired" event now suppresses for COOLDOWN_HOURS.
      // We fire one logEvent; the 24h effect requires matching the cooldown in safariClustering.
      // Since COOLDOWN_HOURS there is 4h, we fire 6 events to cover 24h worth of checks.
      // Actually — cleanest is to log once; the trigger will refire at 4h unless we log repeatedly.
      // Best approach: log with future ts is not supported by logEvent (uses now()).
      // Log one event — this buys 4h of real suppression. Document the limitation.
      logEvent(`safari_clustering:${cmd.domain}`, 'proactive_fired', {
        trigger: 'safari_clustering',
        domain: cmd.domain,
        suppressed_by: 'user_command',
      })
      await message.react('⏭️')
      await message.reply(`Skipping \`${cmd.domain}\` clustering alerts for 4 hours.`)
      break
    }

    case 'meeting_done': {
      // Find the most recent meeting countdown event and log suppression using the same key.
      // meetingCountdown.ts checks: recentEvents('meeting_countdown:${title}|${start_time}', 'proactive_fired', 6)
      // We query via db() since recentEvents requires an exact session match.
      const lastFired = db().prepare(
        `SELECT session FROM agent_events WHERE event = 'proactive_fired'
         AND session LIKE 'meeting_countdown:%' ORDER BY id DESC LIMIT 1`,
      ).get() as { session: string } | undefined
      const meetingKey = lastFired?.session ?? `meeting_countdown:unknown|${Date.now()}`
      logEvent(meetingKey, 'proactive_fired', {
        trigger: 'meeting_countdown',
        suppressed_by: 'user_command',
      })
      await message.react('✅')
      break
    }

    case 'on_demand_brief': {
      // Rate-limit: one on-demand brief per 2 hours
      const recentBriefs = recentEvents('on_demand_brief', 'proactive_notification', 2)
      if (recentBriefs.length > 0) {
        await message.reply('Brief requested recently. Check #jarvis-proactive for the last one.')
        return
      }
      await message.react('📋')
      const { runMorningBrief } = await import('../scheduler/routines/brief')
      void runMorningBrief()
        .then(() => {
          logEvent('on_demand_brief', 'proactive_notification', { trigger: 'on_demand_brief', key: 'brief' })
        })
        .catch((err: unknown) => {
          logb.error('on_demand_brief failed:', err)
        })
      break
    }

    case 'help': {
      await message.reply(PROACTIVE_HELP_TEXT)
      break
    }

    default: {
      if (message.content.trim().length > 0) {
        await message.reply(PROACTIVE_HELP_TEXT)
      }
      break
    }
  }
}

async function handleCIMessage(message: Message, config: ReturnType<typeof loadDiscordConfig>): Promise<void> {
  if (!config) return
  const cmd = parseCommand(message.content)

  switch (cmd.type) {
    case 'approve_index': {
      const approval = findByLocalIndex(cmd.index)
      if (!approval) {
        await message.reply(`No pending approval at index ${cmd.index}.`)
        return
      }
      decide(approval.id, 'approved', message.author.id)
      const r0 = await dispatchForKind(approval)
      if (r0.ok) {
        await message.react('✅')
      } else {
        await message.react('❌')
        await message.reply(r0.message ?? `Approval recorded but dispatch failed for approval ${approval.id}.`)
      }
      break
    }

    case 'deny_index': {
      const approval = findByLocalIndex(cmd.index)
      if (!approval) {
        await message.reply(`No pending approval at index ${cmd.index}.`)
        return
      }
      if (approval.kind === 'resolver') {
        // Mark denied AND delete the backing auto/resolver-* branch.
        await denyResolverApproval(approval.id, message.author.id)
      } else {
        decide(approval.id, 'denied', message.author.id)
      }
      await message.react('❌')
      break
    }

    case 'approve_issue': {
      const approval = findByIssueNumber(cmd.issueNumber)
      if (!approval) {
        await message.reply(`No pending approval for issue #${cmd.issueNumber}.`)
        return
      }
      decide(approval.id, 'approved', message.author.id)
      const ri = await dispatchForKind(approval)
      if (ri.ok) {
        await message.react('✅')
      } else {
        await message.react('❌')
        await message.reply(ri.message ?? `Approval recorded but dispatch failed for approval ${approval.id}.`)
      }
      break
    }

    case 'approve_all': {
      const pending = getPending()
      const filtered = cmd.filter
        ? pending.filter((a) => a.kind.toLowerCase().includes(cmd.filter ?? ''))
        : pending
      if (filtered.length === 0) {
        await message.reply('No pending approvals to approve.')
        return
      }
      const failedIds: number[] = []
      for (const a of filtered) {
        decide(a.id, 'approved', message.author.id)
        const ra = await dispatchForKind(a)
        if (!ra.ok) failedIds.push(a.id)
      }
      if (failedIds.length === 0) {
        await message.react('✅')
        await message.reply(`Approved ${filtered.length} item(s).`)
      } else {
        await message.react('❌')
        await message.reply(
          `Approved ${filtered.length} item(s) but dispatch failed for approval(s): ${failedIds.join(', ')}.`,
        )
      }
      break
    }

    case 'status': {
      const pending = getPending()
      await message.react('✅')
      await message.reply(`Bot online. ${pending.length} pending.`)
      break
    }

    case 'pending': {
      await postPendingDigest()
      break
    }

    case 'help': {
      await message.reply(HELP_TEXT)
      break
    }

    default: {
      if (message.content.trim().length > 0) {
        await message.reply("Didn't understand. Try `help` for commands.")
      }
      break
    }
  }
}

async function handleMessage(message: Message, config: ReturnType<typeof loadDiscordConfig>): Promise<void> {
  if (!config) return
  if (message.author.id !== config.owner_user_id) return

  if (message.channelId === config.channel_id) {
    return handleCIMessage(message, config)
  }
  if (config.proactive_channel_id && message.channelId === config.proactive_channel_id) {
    return handleProactiveMessage(message, config)
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export default async function main(): Promise<void> {
  const config = loadDiscordConfig()
  if (!config || !config.channel_id || !config.owner_user_id) {
    throw new Error('[discord-bot] Missing discord config: channel_id and owner_user_id required in integrations.yaml')
  }

  const token = readBotToken()
  const heartbeatFile = (config.heartbeat_file ?? '~/.jarvis/discord-bot.heartbeat').replace('~', homedir())

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  })

  client.once(Events.ClientReady, () => {
    logb.info(`Ready as ${client.user?.tag ?? 'unknown'}`)
    writeHeartbeat(heartbeatFile)
    // Expire stale approvals on startup (per-kind window: resolver gets a longer fuse).
    const expireHours = config.approval_expire_hours ?? 24
    const gatedExpireHours = config.approval_expire_hours_gated ?? 168
    const { expiredCount, expiredResolverIds } = expireOlderThan(expireHours, gatedExpireHours)
    if (expiredCount > 0) {
      logb.info(`Expired ${expiredCount} stale approval(s) (default ${expireHours}h, gated ${gatedExpireHours}h)`)
    }
    // Delete the orphaned branch for any expired resolver approval (mirrors the deny path).
    for (const approvalId of expiredResolverIds) {
      void cleanupResolverApprovalBranch(approvalId, 'expire')
    }
    // Write heartbeat to vec-server agent_memories
    void fetch('http://127.0.0.1:9876/remember', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        collection: 'agent_memories',
        text: `discord_bot_heartbeat ${Date.now()}`,
      }),
    }).catch((err: unknown) => {
      logb.warn('vec-server heartbeat failed:', err)
    })
  })

  // Periodic heartbeat
  const heartbeatTimer = setInterval(() => {
    writeHeartbeat(heartbeatFile)
  }, HEARTBEAT_INTERVAL_MS)

  client.on('messageCreate', (message: Message) => {
    logb.info(`messageCreate channel=${message.channelId} author=${message.author.id} bot=${String(message.author.bot)}`)
    void handleMessage(message, config).catch((err: unknown) => {
      logb.error('messageCreate error:', err)
    })
  })

  // Graceful shutdown
  const shutdown = (): void => {
    logb.info('Shutting down.')
    clearInterval(heartbeatTimer)
    void client.destroy()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  await client.login(token)
}

// Run when executed directly.
// This check works for both ts-node and the compiled bundle.
if (require.main === module) {
  main().catch((err: unknown) => {
    logb.error('Fatal:', err)
    process.exit(1)
  })
}
