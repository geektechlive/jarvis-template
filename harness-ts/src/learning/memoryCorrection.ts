// Behavior 7: detectMemoryCorrection -- overwrite contradicted user_profile facts
//               calls deepReencodeOnCorrection() (correction.ts) as fire-and-forget after
//               the primary correction is persisted (Issue #419).

import { log } from 'ion-sdk'
import { OLLAMA_HOST, isAllowedHost } from '../config'
import { logEvent, getRecentMessages } from '../memory/episodic'
import { recallMeta, forget, isStatedSource } from '../memory/recall'
import { guardedRemember, PRONOUN_SUBJECT_RE } from '../memory/write'
import { isEphemeralMode } from '../memory/ephemeralMode'
import { normalizeFact, normalizeChatJson } from './shared'
import { extractAndStore } from './factExtraction'
import { deepReencodeOnCorrection } from './correction'
import { tokenOverlap } from '../util/stringMetrics'

const MEMORY_CORRECTION_PATTERNS: RegExp[] = [
  /no[,.]?\s+actually\b/i,
  /that['']s\s+not\s+(?:right|correct|true|accurate)/i,
  /i\s+(?:don['']t|do\s+not)\s+\w+\s+anymore\b/i,
  /actually[,.]?\s+i\s+(?:prefer|use|like|drink|eat|do|am|have)\b/i,
  /i\s+changed\s+my\s+mind\b/i,
  /i\s+(?:switched|moved|went)\s+(?:to|from)\b/i,
  /(?:i\s+)?no\s+longer\b/i,
]

const CORRECTION_CLASSIFIER_SYSTEM = `You are a fact-correction detector for a personal AI assistant.
Given the last user message and a list of stored facts, determine if the user is correcting a previously stored fact about themselves.

Rules:
- is_correction: true ONLY if the user explicitly contradicts a stored fact (a preference, habit, or fact about themselves).
- contradicted: copy the stored fact text being overridden (must closely match one of the recalled facts).
- corrected: the replacement fact as one atomic sentence with subject "Alex". If unclear, null.
- If no correction is detected, set is_correction: false and both strings to null.
- Each stored fact is annotated with [source: ..., confidence: ...]. Facts from user-stated sources (cli/tui/agent/manual) at high confidence are authoritative; only mark one contradicted on an explicit, unambiguous correction.

JSON only, no other text.`

interface CorrectionClassification {
  is_correction: boolean
  contradicted: string | null
  corrected: string | null
}

export async function detectMemoryCorrection(session: string): Promise<void> {
  if (!isAllowedHost(OLLAMA_HOST)) return
  // Issue #394: task/ephemeral sessions may produce correction-pattern messages
  // that are scoped to the task, not the user's permanent preferences.
  // Skip memory correction entirely in ephemeral mode to avoid polluting user_profile.
  if (isEphemeralMode()) return

  const rows = getRecentMessages(session, 10)
  const lastUser = [...rows].reverse().find((r) => r.role === 'user')
  if (!lastUser) return
  const message = lastUser.content.trim()
  if (!message) return

  // Cheap regex gate -- skip LLM call when no correction signal is present.
  if (!MEMORY_CORRECTION_PATTERNS.some((p) => p.test(message))) return

  // Issue #797: factual corrections land in the `knowledge` collection (Issue #774
  // routes [fact]-tagged extractions there) while preferences stay in `user_profile`.
  // Recall from BOTH and track each hit's origin collection so the forget() and the
  // replacement remember() below target the collection the contradicted fact actually
  // lives in -- mirrors the dual-collection pattern in deepReencodeOnCorrection.
  // Issue #274: recall swallows errors internally today; allSettled future-proofs against
  // it throwing and ensures one collection failing does not drop the other's hits.
  // Issue #835: recallMeta (vs recall) carries source + confidence per hit so the
  // classifier prompt and the deletion guard below can weigh provenance -- a typed-in
  // user fact (source cli/tui/agent/manual, confidence ~1.0) must not be deleted as
  // readily as a low-confidence inference. Calling per-collection still yields the
  // origin collection (the one queried), which #797 needs for forget()/remember().
  const ARCHIVE_PREFIX = '[archive] '
  const CORRECTION_COLLECTIONS = ['user_profile', 'knowledge'] as const
  const settled = await Promise.allSettled(
    CORRECTION_COLLECTIONS.map((c) => recallMeta(message, c, 15)),
  )
  let anyRecallThrew = false
  const seenFacts = new Set<string>()
  const recalledFacts: {
    text: string
    collection: 'user_profile' | 'knowledge'
    source: string
    confidence: number
  }[] = []
  CORRECTION_COLLECTIONS.forEach((collection, i) => {
    const outcome = settled[i]
    if (!outcome) return
    if (outcome.status === 'rejected') {
      anyRecallThrew = true
      log.warn('learning: detectMemoryCorrection -- recall threw, dropping that collection', {
        session, collection, snippet: message.slice(0, 80), err: String(outcome.reason),
      })
      return
    }
    for (const item of outcome.value.results) {
      // Issue #772: recallMeta already strips the '[archive] ' label (and sets
      // item.archived); strip defensively in case the server path returns the prefixed
      // text, so the guard match and forget() call read the natural fact text.
      const text = item.text.startsWith(ARCHIVE_PREFIX) ? item.text.slice(ARCHIVE_PREFIX.length) : item.text
      const dedupKey = text.toLowerCase().replace(/\s+/g, ' ').trim()
      if (seenFacts.has(dedupKey)) continue
      seenFacts.add(dedupKey)
      recalledFacts.push({ text, collection, source: item.source, confidence: item.confidence })
    }
  })
  if (!recalledFacts.length) {
    // recall_error: every queried collection threw. no_recalled_facts: queries succeeded
    // but matched nothing -- distinct so operators can tell a vec outage from an empty hit.
    const reason = anyRecallThrew ? 'recall_error' : 'no_recalled_facts'
    log.warn('learning: detectMemoryCorrection -- no usable recalled facts for correction message', {
      session, snippet: message.slice(0, 80), reason,
    })
    logEvent(session, 'memory_correction_failed', { reason, snippet: message.slice(0, 200) })
    return
  }

  const recalledBlock = recalledFacts
    .map((f, i) => `${i + 1}. ${f.text} [source: ${f.source}, confidence: ${f.confidence.toFixed(2)}]`)
    .join('\n')
  const userPrompt = `User message: "${message}"\n\nStored facts about this user:\n${recalledBlock}`

  let classification: CorrectionClassification
  try {
    // #855: route the classifier through the backend-aware normalize helper so it
    // honors NORMALIZE_BACKEND=cli. The prior direct Ollama fetch failed silently
    // in production, where Ollama runs embeddings-only and the chat model is not
    // resident -- every correction was dropped without a trace.
    classification = (await normalizeChatJson(CORRECTION_CLASSIFIER_SYSTEM, userPrompt, 0)) as CorrectionClassification
  } catch (err) {
    // Surface the failure as an event so the observability watcher can see a
    // classifier outage instead of a silent drop (#855).
    log.warn('learning: detectMemoryCorrection classifier failed', { session, err: String(err) })
    logEvent(session, 'memory_correction_classify_failed', { snippet: message.slice(0, 200), err: String(err) })
    return
  }

  if (!classification.is_correction || !classification.contradicted || !classification.corrected) return

  const contradicted = classification.contradicted.trim()
  const corrected = classification.corrected.trim()

  // Hallucination guard: the contradicted text must genuinely match a recalled fact,
  // so the LLM can't make us delete an unrelated memory.
  // Issue #826: the old guard was substring-only, which dropped valid PARAPHRASED
  // corrections ("uses qwen" vs "uses qwen2.5:14b for normalization"). Hybrid: accept a
  // substring match OR a token-overlap >= 0.55 (tokenOverlap is max-normalized + keeps
  // digits, so "Mac M1" vs "Mac M2" = 0.67 matches a real correction while "coffee beans"
  // vs "tea" = 0.5 stays below threshold and is rejected as a hallucination).
  // Issue #835: a high-trust user-stated fact (cli/tui/agent/manual, confidence >= 0.9)
  // requires the STRICT substring match -- never delete a typed-in fact on a fuzzy overlap.
  const OVERLAP_THRESHOLD = 0.55
  const HIGH_CONFIDENCE = 0.9
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ')
  const normContradicted = norm(contradicted)
  // Walk the facts: substring is a definitive match; otherwise token overlap, except a
  // high-trust stated fact is protected (only substring may delete it). Track the best
  // overlap + whether a protected fact WOULD have matched, so a skip records WHY and HOW
  // close it was -- a refused protection is not a hallucination, and the score is needed
  // to tune the 0.55 gate (mirrors the #837 telemetry-precision fix).
  let matchedFact: typeof recalledFacts[number] | undefined
  let bestOverlap = 0
  let closestFact: typeof recalledFacts[number] | undefined
  let protectedBlocked = false
  for (const f of recalledFacts) {
    const nf = norm(f.text)
    if (nf.includes(normContradicted) || normContradicted.includes(nf)) {
      matchedFact = f
      break
    }
    const overlap = tokenOverlap(contradicted, f.text)
    if (overlap > bestOverlap) {
      bestOverlap = overlap
      closestFact = f
    }
    if (overlap >= OVERLAP_THRESHOLD) {
      if (isStatedSource(f.source) && f.confidence >= HIGH_CONFIDENCE) {
        protectedBlocked = true
        continue
      }
      matchedFact = f
      break
    }
  }

  if (!matchedFact) {
    // stated_fact_protected: a high-trust typed-in fact matched on overlap but we refused
    // to delete it on a fuzzy match. hallucinated: nothing matched -- the LLM likely invented
    // the contradicted text. Distinct so operators (and Grafana) can tell them apart.
    const reason = protectedBlocked ? 'stated_fact_protected' : 'hallucinated'
    log.info('learning: detectMemoryCorrection skipped -- contradicted fact not deletable', {
      session,
      reason,
      contradicted: contradicted.slice(0, 80),
      best_overlap: Number(bestOverlap.toFixed(3)),
    })
    logEvent(session, 'memory_correction_skipped', {
      reason,
      contradicted: contradicted.slice(0, 200),
      corrected: corrected.slice(0, 200),
      best_overlap: Number(bestOverlap.toFixed(3)),
      closest_source: closestFact?.source,
    })
    return
  }

  try {
    // Issue #227: write the replacement BEFORE deleting the old fact.
    // If remember fails, the old fact is preserved (no data loss).
    // Deleting first is a silent half-write: old gone, new never lands.
    const normalizeResult = await normalizeFact(corrected)
    const normalizedText = normalizeResult.text
    if (PRONOUN_SUBJECT_RE.test(normalizedText)) {
      if (normalizeResult.fallback) {
        log.warn('learning: detectMemoryCorrection dropping un-normalized fact with pronoun subject', { session, fact: normalizedText.slice(0, 80) })
      } else {
        log.debug('learning: detectMemoryCorrection skipping pronoun-subject result', { session })
      }
      return
    }

    // Issue #797: write the replacement to the SAME collection the contradicted fact
    // lives in (knowledge for [fact]s, user_profile for preferences) so it is recalled
    // from the right source and dedups against the old entry rather than orphaning it.
    // #862: route the replacement write through the guarded chokepoint so the
    // primary correction path can never persist a secret or a Jarvis-identity
    // claim. The pronoun guard already ran above (with path-specific fallback
    // logging), so skip the redundant re-check here.
    const rememberResult = await guardedRemember(normalizedText, matchedFact.collection, 'memory_correction', 'jarvis_inference', { session, skipPronounGuard: true })
    if (!rememberResult.ok) {
      log.warn('learning: detectMemoryCorrection aborting -- remember failed, old fact preserved', {
        session,
        old: matchedFact.text.slice(0, 80),
        attempted: normalizedText.slice(0, 80),
        reason: rememberResult.reason,
      })
      return
    }
    const newId = rememberResult.id

    const forgetResult = await forget(matchedFact.text, matchedFact.collection)
    if (!forgetResult.deleted) {
      log.warn('learning: detectMemoryCorrection forget returned deleted=false (new fact already written)', {
        session,
        fact: matchedFact.text.slice(0, 80),
        collection: matchedFact.collection,
      })
    }

    logEvent(session, 'memory_correction', {
      old_fact: matchedFact.text.slice(0, 300),
      new_fact: normalizedText.slice(0, 300),
      collection: matchedFact.collection,
      old_source: matchedFact.source,
      new_id: newId,
      deleted_id: forgetResult.id,
    })
    logEvent('', 'feedback_correction', { text: normalizedText, before: matchedFact.text, detector: 'regex+llm', confidence: 0.6, ts: new Date().toISOString() })
    log.info('learning: detectMemoryCorrection applied', {
      session,
      old: matchedFact.text.slice(0, 80),
      new: normalizedText.slice(0, 80),
      collection: matchedFact.collection,
    })

    // Issue #419: kick off the deep re-encode pass as fire-and-forget.
    // Step 1 (re-extraction with 2× budget) runs here so that correction.ts
    // does not need to import from index.ts (circular dependency avoided).
    // Steps 2-4 (cascade check over related knowledge facts) run in correction.ts.
    // All failures are caught internally and must not propagate -- the primary
    // correction is already persisted above.
    void (async () => {
      try {
        // Issue #771: this deep re-encode holds the in-flight lock for up to ~360s
        // (budgetMs:'double'). Use a distinct lockKey so it does not block a concurrent
        // turn_end extractAndStore on the same session. `session` is still passed as the
        // first arg so message retrieval reads the real conversation.
        await extractAndStore(session, { budgetMs: 'double', lockKey: `${session}::reencode` })
      } catch (err) {
        log.warn('learning: detectMemoryCorrection -- deep re-extraction failed (non-fatal)', { session, err: String(err) })
      }
      void deepReencodeOnCorrection(session, message, matchedFact.text)
    })()
  } catch (err) {
    log.warn('learning: detectMemoryCorrection store/delete failed', { session, err: String(err) })
    logEvent(session, 'forget_failed', { err: String(err) })
  }
}
