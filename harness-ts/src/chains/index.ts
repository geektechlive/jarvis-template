// Daily handoff-chain miner.
//
// Scans agent_dispatch events from the last 30 days, finds consecutive A→B
// dispatch pairs (same session, ≤10 min apart, no other dispatch between them),
// filters to user-confirmed chains (a real user message between A and B, not a
// correction instruction), and writes patterns to ChromaDB + agent_events once
// a pair crosses 3 confirmed instances.

import { log } from 'ion-sdk'
import { logEvent, recentEvents, getDispatchPairs, getUserMessageBetween } from '../memory/episodic'
import { remember } from '../memory/recall'
import { isEnabled } from '../scheduler/helpers'

// Patterns that indicate the user is correcting Jarvis, not confirming the chain.
const CORRECTION_PATTERNS = [
  /should(?:'ve|have)\s+(?:called|dispatched|used|asked|sent\s+to|routed\s+to)/i,
  /wrong\s+(?:agent|staff|person)/i,
  /not\s+(?:the\s+)?(?:right|correct)/i,
  /should\s+(?:have\s+)?go(?:ne)?\s+to/i,
  /next\s+time\s+(?:use|call|ask|dispatch)/i,
]

function isUserConfirmation(message: string): boolean {
  if (message.length > 80) return false
  return !CORRECTION_PATTERNS.some((re) => re.test(message))
}

interface PairStats {
  count: number
  lastSeen: string
  agentA: string
  agentB: string
}

export async function runChainMiner(): Promise<void> {
  if (!isEnabled('chain_miner')) return

  logEvent('chain_miner', 'routine_started', { routine: 'chain_miner' })

  try {
    const pairs = getDispatchPairs(30)

    // Count confirmed A→B instances keyed by "agentA→agentB".
    const stats = new Map<string, PairStats>()

    for (const pair of pairs) {
      const userMsg = getUserMessageBetween(pair.session, pair.tsA, pair.tsB)
      if (userMsg === null) continue
      if (!isUserConfirmation(userMsg)) continue

      const key = `${pair.agentA}→${pair.agentB}`
      const existing = stats.get(key)
      if (existing) {
        existing.count++
        if (pair.tsB > existing.lastSeen) {
          existing.lastSeen = pair.tsB
        }
      } else {
        stats.set(key, {
          count: 1,
          lastSeen: pair.tsB,
          agentA: pair.agentA,
          agentB: pair.agentB,
        })
      }
    }

    const THRESHOLD = 3
    let chainsAboveThreshold = 0

    for (const [pairKey, s] of stats) {
      if (s.count < THRESHOLD) continue

      chainsAboveThreshold++

      // Check if a chain_established event already exists for this pair in the
      // last 7 days with count >= currentCount (stable; skip re-write).
      const recentEstablished = recentEvents('chain_miner', 'chain_established', 24 * 7)
      const existingForPair = recentEstablished.find((e) => {
        const d = e.detail as Record<string, unknown> | null
        return d?.['pairKey'] === pairKey && (d?.['count'] as number | undefined ?? 0) >= s.count
      })
      if (existingForPair) continue

      const memoryText =
        `Handoff pattern: after ${s.agentA} handles a request, ${s.agentB} is typically called next` +
        ` (${s.count} confirmed instances, last seen ${s.lastSeen.slice(0, 10)})`

      const result = await remember(memoryText, 'knowledge', 'handoff_chain', 'jarvis_inference')

      if (!result.ok) {
        log.warn('chains: remember failed', { pairKey, reason: result.reason })
        continue
      }

      logEvent('chain_miner', 'chain_established', {
        pairKey,
        agentA: s.agentA,
        agentB: s.agentB,
        count: s.count,
        lastSeen: s.lastSeen,
      })

      log.info('chains: established', { pairKey, count: s.count })
    }

    logEvent('chain_miner', 'routine_delivered', {
      routine: 'chain_miner',
      chainsAboveThreshold,
    })
  } catch (err) {
    log.warn('chains: runChainMiner error', { err: String(err) })
  }
}
