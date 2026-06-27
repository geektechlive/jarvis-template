// Autonomous goal proposal engine.
// Fires weekly (Monday 06:00). Queries recall signals, generates proposals via
// claude-haiku (runClaudeAgent), deduplicates against active SQL goals, and inserts them
// with status='active'. No confirmation gate.

import { runClaudeAgent } from '../util/claudeAgent'
import { tokenOverlap } from '../util/stringMetrics'
import { recall } from '../memory/recall'
import { activeGoalCount, listActiveGoalIntents, pendingActions, insertAction, logEvent } from '../memory/episodic'
import { postProactive } from '../proactive/notify'

const MAX_ACTIVE_GOALS = 10
const MAX_NEW_PER_RUN = 3
// Dedup: if a token-overlap fraction between the proposal and any active intent
// meets or exceeds this threshold, treat it as a duplicate.
const DEDUP_TOKEN_OVERLAP = 0.75

interface GoalProposal {
  intent: string
  cadence: string
  owner_staff_id: string
  budget_tool_calls: number
  budget_minutes: number
}

async function gatherSignals(): Promise<string[]> {
  const signals: string[] = []

  try {
    const { results } = await recall('recent activity patterns interests', 'knowledge', 5)
    if (results.length > 0) {
      signals.push(`Recurring knowledge interests: ${results.slice(0, 3).join(' | ')}`)
    }
  } catch { /* non-fatal */ }

  try {
    const { results } = await recall('goals projects priorities concerns', 'user_profile', 5)
    if (results.length > 0) {
      signals.push(`User profile context: ${results.slice(0, 3).join(' | ')}`)
    }
  } catch { /* non-fatal */ }

  return signals
}

async function proposalFromSignal(signal: string): Promise<GoalProposal | null> {
  const prompt = `You are proposing an autonomous recurring goal for a personal AI chief of staff named Jarvis.

Signal observed: ${signal}

Based on this signal, propose ONE durable recurring goal for Jarvis to pursue autonomously on behalf of the user. The goal should be concrete, measurable, and achievable by an AI agent using web search, memory recall, and calendar/mail tools.

Available staff agents for owner_staff_id: tech-advisor, news-desk, personal-cfo, portfolio-manager, systems-engineer, wellness-coach, chief-of-communications, repo-steward

Respond with ONLY valid JSON (no markdown, no explanation):
{"intent":"<what Jarvis should accomplish>","cadence":"weekly","owner_staff_id":"<staff agent>","budget_tool_calls":5,"budget_minutes":30}`

  try {
    const raw = await runClaudeAgent('goal_proposal', prompt, {
      model: 'claude-haiku-4-5-20251001',
      timeoutMs: 60_000,
    })
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return null
    const parsed = JSON.parse(jsonMatch[0]) as GoalProposal
    if (!parsed.intent || !parsed.owner_staff_id) return null
    return parsed
  } catch {
    return null
  }
}

function isDuplicate(intent: string): boolean {
  const activeIntents = listActiveGoalIntents()
  for (const existing of activeIntents) {
    if (tokenOverlap(intent, existing) >= DEDUP_TOKEN_OVERLAP) return true
  }
  // Also check pending goal_proposal actions — don't re-propose while approval is pending.
  const pending = pendingActions().filter((a) => a['action'] === 'goal_proposal')
  for (const a of pending) {
    try {
      const p = JSON.parse(a['payload'] as string) as { intent?: string }
      if (p.intent && tokenOverlap(intent, p.intent) >= DEDUP_TOKEN_OVERLAP) return true
    } catch { /* skip unparseable */ }
  }
  return false
}

export async function runGoalProposal(): Promise<void> {
  const currentCount = activeGoalCount()
  if (currentCount >= MAX_ACTIVE_GOALS) {
    logEvent('goal_proposal', 'goal_proposal', `Skipped: ${currentCount} active goals at cap (${MAX_ACTIVE_GOALS}).`)
    return
  }

  const signals = await gatherSignals()
  if (signals.length === 0) {
    logEvent('goal_proposal', 'goal_proposal', 'No signals found; no goals proposed.')
    return
  }

  let created = 0
  for (const signal of signals) {
    if (created >= MAX_NEW_PER_RUN) break
    if (activeGoalCount() >= MAX_ACTIVE_GOALS) break

    const proposal = await proposalFromSignal(signal)
    if (!proposal) continue

    if (isDuplicate(proposal.intent)) {
      logEvent('goal_proposal', 'goal_proposal', `Skipped duplicate: ${proposal.intent}`)
      continue
    }

    const actionId = insertAction(
      'goal_proposal',
      'safe',
      JSON.stringify(proposal),
    )

    logEvent('goal_proposal', 'goal_proposed', `Queued for approval #${actionId}: ${proposal.intent}`)

    await postProactive(null, {
      embed: {
        title: 'Goal proposed — awaiting approval.',
        description: `**#${actionId}** ${proposal.intent}`,
        color: 0x5865f2,
        footer: { text: `Use \`/approve ${actionId}\` to activate or \`/deny ${actionId}\` to discard. cadence: ${proposal.cadence} | owner: ${proposal.owner_staff_id}` },
      },
    })

    created++
  }

  if (created === 0) {
    logEvent('goal_proposal', 'goal_proposal', 'Run complete; no new goals created (all signals deduplicated or no proposals generated).')
  }
}
