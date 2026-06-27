/**
 * guardedRemember -- the single guarded write path into durable memory.
 *
 * Background (#861, #862, #863, #869): the secret, agent-identity, and
 * sentence-initial-pronoun guards were copy-pasted unevenly across the memory
 * write paths, so each new path risked forgetting one and persisting a secret, a
 * Jarvis-identity claim, or a dangling-pronoun fact. This funnels the
 * correction, cascade, and drain paths (and any future write) through one place
 * where the guards are applied by default and a skip is an explicit, visible
 * opt-out at the call site.
 *
 * It deliberately does NOT normalize: normalization is path-specific (budget
 * handling, fallback events, regex alias pre-passes, pending_memory queueing on
 * abort) and stays in the caller, which passes the already-normalized text here.
 * The battle-tested extraction paths (extractAndStore / extractConcreteValues /
 * extractFromMeetings) keep their complete inline guard logic -- they are the
 * reference, not deficient -- and only share the pronoun regex below.
 */

import { log } from 'ion-sdk'
import { logEvent } from './episodic'
import { remember } from './recall'
import { looksLikeSecret, looksLikeAgentIdentityClaim } from './sanitize'

/**
 * Sentence-initial pronoun subject. A leading He/She/They/It/His/Her/Their means
 * normalization failed to substitute "Alex"; storing it blends topics in the
 * embedding and hides a dangling reference. Single shared instance (no `g` flag,
 * so `.test()` is stateless and safe to reuse) replacing the copies that were
 * duplicated across the learning write paths.
 */
export const PRONOUN_SUBJECT_RE = /^(He|She|They|It|His|Her|Their)\b/i

type RememberCollection =
  | 'user_profile'
  | 'knowledge'
  | 'agent_memories'
  | 'task_memory'
  | 'procedural'
  | 'news'

export interface GuardedRememberOpts {
  metadata?: Record<string, unknown>
  goalId?: string
  signal?: AbortSignal
  /**
   * Session id for dedup-event emission. When set, a vec-server dedup rejection
   * emits a `memory_dedup_rejected` agent_event so the drain/correction dedup
   * rate is observable (#864). Omit to skip the event.
   */
  session?: string
  /** Skip the secret guard. Default false -- the guard is ON. */
  skipSecretGuard?: boolean
  /** Skip the agent-identity-claim guard. Default false -- the guard is ON. */
  skipIdentityGuard?: boolean
  /**
   * Skip the sentence-initial pronoun guard. Default false -- the guard is ON.
   * Set true only when the caller has already applied its own pronoun check with
   * path-specific logging and wants to avoid a redundant test.
   */
  skipPronounGuard?: boolean
}

export type GuardedRememberResult =
  | { ok: true; id: string }
  | { ok: false; reason: 'secret' | 'identity' | 'pronoun' | 'dedup' | 'network' | 'disabled' | 'other'; detail?: string }

/**
 * Write `text` to durable memory after applying the universal write-path guards.
 * Guards run in order (secret -> identity -> pronoun); the first to trip returns
 * a typed reason and nothing is stored. On a vec-server dedup rejection, emits
 * `memory_dedup_rejected` when a session is provided. Normalization is the
 * caller's responsibility -- pass normalized text.
 */
export async function guardedRemember(
  text: string,
  collection: RememberCollection,
  source: string,
  sourceActor: string,
  opts: GuardedRememberOpts = {},
): Promise<GuardedRememberResult> {
  if (!opts.skipSecretGuard && looksLikeSecret(text)) {
    log.warn('memory: guardedRemember dropped secret-like text (not stored)', { source, preview: text.slice(0, 40) })
    return { ok: false, reason: 'secret' }
  }
  if (!opts.skipIdentityGuard && looksLikeAgentIdentityClaim(text)) {
    log.warn('memory: guardedRemember dropped Jarvis-identity claim (not stored)', { source, preview: text.slice(0, 40) })
    return { ok: false, reason: 'identity' }
  }
  if (!opts.skipPronounGuard && PRONOUN_SUBJECT_RE.test(text)) {
    log.debug('memory: guardedRemember dropped pronoun-subject text (not stored)', { source, preview: text.slice(0, 80) })
    return { ok: false, reason: 'pronoun' }
  }

  const result = await remember(text, collection, source, sourceActor, opts.metadata, opts.goalId, opts.signal)
  if (result.ok) return { ok: true, id: result.id }
  if (result.reason === 'dedup') {
    if (opts.session !== undefined) {
      logEvent(opts.session, 'memory_dedup_rejected', { collection, source, preview: text.slice(0, 80) })
    }
    return { ok: false, reason: 'dedup' }
  }
  // Pass remember()'s reason through unchanged so callers can tell a transient
  // 'network' failure (worth retrying) from a terminal 'other' (4xx /
  // unrecoverable). The drain relies on this distinction to avoid requeuing a
  // permanently-failing row forever.
  return { ok: false, reason: result.reason, ...(result.detail !== undefined ? { detail: result.detail } : {}) }
}
