// ClarificationManager -- tracks pending clarifying questions per session.
//
// When the agent isn't sure what you mean, it asks a question and stores the
// ambiguity here. The next user message in that session resolves the question.
// The resolution gets logged as a clarification_resolved event so the learning
// loop can turn the answer into a durable preference.
//
// In-memory only with a TTL. Survives within a session -- if you walk away
// mid-clarification and come back later, the old question times out and the
// agent re-asks instead of stale-resolving against an unrelated message.

import { logEvent } from '../memory/episodic'

const DEFAULT_TTL_MS = 10 * 60 * 1000 // 10 minutes

export interface PendingClarification {
  session: string
  originalMessage: string
  intentAction: string
  intentArgs: Record<string, unknown>
  missingArgs: string[]
  question: string
  askedAt: number // Date.now()
}

class ClarificationManager {
  private readonly ttlMs: number
  private readonly pending = new Map<string, PendingClarification>()

  constructor(ttlMs = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs
  }

  set(clarification: PendingClarification): void {
    this.pending.set(clarification.session, clarification)
  }

  get(session: string): PendingClarification | null {
    const existing = this.pending.get(session)
    if (!existing) return null
    if (Date.now() - existing.askedAt > this.ttlMs) {
      this.pending.delete(session)
      return null
    }
    return existing
  }

  // Return and remove the pending clarification (if not expired).
  // Also logs a clarification_resolved event with the user's answer.
  pop(session: string, userAnswer: string): PendingClarification | null {
    const existing = this.get(session)
    if (!existing) return null
    this.pending.delete(session)
    logEvent(session, 'clarification_resolved', {
      session,
      original_message: existing.originalMessage,
      intent_action: existing.intentAction,
      intent_args: existing.intentArgs,
      missing_args: existing.missingArgs,
      question: existing.question,
      answer: userAnswer,
    })
    return existing
  }

  clear(session: string): void {
    this.pending.delete(session)
  }
}

export const clarificationManager = new ClarificationManager()
