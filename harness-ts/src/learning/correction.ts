// Deep re-encode on memory correction (Issue #419).
//
// When a user corrects a stored fact, the primary correction is applied by
// detectMemoryCorrection(). This module adds a deeper follow-up pass:
//
//   1. Re-run extractAndStore with 2x the normal budget so the session facts
//      are extracted under more relaxed time constraints.
//   2. Recall the top-10 related facts from the knowledge collection.
//   3. For each related fact, ask qwen2.5:14b: does the correction invalidate
//      or update this fact? If yes, write the updated version and supersede
//      the original.
//   4. Emit a correction_deep_encode event with facts_updated / related_checked.
//
// Failures are swallowed -- the caller (detectMemoryCorrection) treats this
// as fire-and-forget. The primary correction is always persisted before this
// runs.

import { log } from 'ion-sdk'
import { OLLAMA_HOST, isAllowedHost, loadModelForRole, loadBackendForRole } from '../config'
import { logEvent } from '../memory/episodic'
import { recallMeta, forget } from '../memory/recall'
import { guardedRemember, PRONOUN_SUBJECT_RE } from '../memory/write'
import { runClaudeAgent } from '../util/claudeAgent'
import { extractJsonBlock } from './shared'

// Same model used for normalization + correction classification in index.ts.
const NORMALIZE_MODEL = loadModelForRole('normalize', 'qwen2.5:14b')
const NORMALIZE_BACKEND = loadBackendForRole('normalize', 'ollama')

// Per-LLM-call timeout for the invalidation check. Kept shorter than the
// outer budget so a single slow call cannot stall the cascade.
const PER_CALL_TIMEOUT_MS = 60_000

// Outer budget for the entire cascade. We query up to 10 related facts with one
// Ollama call each; 10 × 60s + padding = 660s would be too aggressive. In practice
// most calls return fast and few facts hit "yes". Cap at 300s (5 min).
const CASCADE_BUDGET_MS = 300_000

interface InvalidationResult {
  invalidates: boolean
  updated_fact: string | null
}

/**
 * Ask the model whether a correction invalidates or updates a related fact.
 * Returns null on network error or unparseable response.
 */
async function checkInvalidation(
  correctionText: string,
  relatedFact: string,
  outerSignal: AbortSignal,
  meta?: { source: string; confidence: number },
): Promise<InvalidationResult | null> {
  const system = `You are a memory consistency checker for a personal AI assistant.
Given a correction the user made and a stored related fact, determine whether the correction invalidates or requires updating the related fact.

Rules:
- invalidates: true ONLY if the correction directly contradicts or supersedes the related fact.
- updated_fact: if invalidates is true, write the corrected version of the related fact as one atomic sentence with subject "Alex". If no update is needed or invalidates is false, set to null.
- Be conservative -- only invalidate when the contradiction is clear.

JSON only, no other text.`

  const provenance = meta
    ? `\n\nRelated fact provenance: source=${meta.source}, confidence=${meta.confidence.toFixed(2)}. The higher the confidence (and for user-stated sources), the more conservative you must be -- invalidate only on a clear, direct contradiction.`
    : ''
  const userContent = `Correction: "${correctionText}"\n\nRelated fact: "${relatedFact}"${provenance}\n\nDoes the correction invalidate or require updating the related fact?`

  try {
    const signal = AbortSignal.any([AbortSignal.timeout(PER_CALL_TIMEOUT_MS), outerSignal])
    let parsed: InvalidationResult
    if (NORMALIZE_BACKEND === 'cli') {
      const prompt = `${system}\n\n${userContent}`
      const raw = (await runClaudeAgent('checkInvalidation', prompt, { model: NORMALIZE_MODEL, signal, timeoutMs: PER_CALL_TIMEOUT_MS })).trim()
      if (!raw) return null
      parsed = JSON.parse(extractJsonBlock(raw)) as InvalidationResult
    } else {
      // Default: ollama
      const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: NORMALIZE_MODEL,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: userContent },
          ],
          stream: false,
          format: 'json',
          options: { temperature: 0 },
        }),
        signal,
      })
      if (!res.ok) {
        log.warn('correction: checkInvalidation HTTP error', { status: res.status })
        return null
      }
      const data = (await res.json()) as { message?: { content?: string } }
      const raw = (data.message?.content ?? '').trim()
      if (!raw) return null
      parsed = JSON.parse(extractJsonBlock(raw)) as InvalidationResult
    }
    // Validate shape minimally
    if (typeof parsed.invalidates !== 'boolean') return null
    return parsed
  } catch (err) {
    log.warn('correction: checkInvalidation failed', { err: String(err), fact: relatedFact.slice(0, 60) })
    return null
  }
}

/**
 * Deep re-encode after a confirmed memory correction.
 *
 * Designed to be called as fire-and-forget (void) from detectMemoryCorrection.
 * All failures are caught internally and logged -- this function never throws.
 */
export async function deepReencodeOnCorrection(
  session: string,
  correctionText: string,
  originalFact: string,
): Promise<void> {
  if (!isAllowedHost(OLLAMA_HOST)) return

  try {
    // Note: step 1 (re-run extractAndStore with 2× budget) is handled by the caller
    // (detectMemoryCorrection in index.ts) before this function is invoked. This avoids
    // a circular import between correction.ts and index.ts.

    const budget = AbortSignal.timeout(CASCADE_BUDGET_MS)

    // Step 2: recall top-10 related facts from both knowledge and user_profile.
    interface RelatedFact {
      text: string
      collection: 'knowledge' | 'user_profile'
      source: string
      confidence: number
    }
    // Issue #793: store.py prefixes archive-collection top-up hits with "[archive] ".
    // Such a hit's document lives in the `archive` collection, not knowledge/
    // user_profile, so forget(text, 'knowledge') below would always miss
    // (deleted:false) and leave the stale fact -- and it is already decay-superseded,
    // so re-cascading it is pointless. Skip archive hits entirely: removes the doomed
    // forget, keeps the [archive] noise out of the invalidation check, and avoids
    // redundant work on already-superseded facts.
    const ARCHIVE_PREFIX = '[archive] '
    const relatedFacts: RelatedFact[] = []
    try {
      // recallMeta (not recall) so the invalidation check gets each related
      // fact's source + confidence -- a high-confidence, user-stated fact should
      // be invalidated more conservatively than a low-confidence inference (#842).
      const [knowledgeResult, profileResult] = await Promise.allSettled([
        recallMeta(originalFact, 'knowledge', 10),
        recallMeta(originalFact, 'user_profile', 10),
      ])
      if (knowledgeResult.status === 'fulfilled') {
        for (const item of knowledgeResult.value.results) {
          if (item.archived || item.text.startsWith(ARCHIVE_PREFIX)) continue
          relatedFacts.push({ text: item.text, collection: 'knowledge', source: item.source, confidence: item.confidence })
        }
      } else {
        log.warn('correction: deepReencodeOnCorrection -- knowledge recall failed', { session, err: String(knowledgeResult.reason) })
      }
      if (profileResult.status === 'fulfilled') {
        for (const item of profileResult.value.results) {
          if (item.archived || item.text.startsWith(ARCHIVE_PREFIX)) continue
          relatedFacts.push({ text: item.text, collection: 'user_profile', source: item.source, confidence: item.confidence })
        }
      } else {
        log.warn('correction: deepReencodeOnCorrection -- user_profile recall failed', { session, err: String(profileResult.reason) })
      }
    } catch (err) {
      log.warn('correction: deepReencodeOnCorrection -- recall failed', { session, err: String(err) })
    }

    const relatedChecked = relatedFacts.length
    let factsUpdated = 0

    // Step 3: cascade check -- for each related fact, ask the model whether the
    // correction invalidates it. On "yes", write the updated version and supersede
    // the original. We never delete-before-write (same discipline as detectMemoryCorrection).
    for (const fact of relatedFacts) {
      if (budget.aborted) {
        log.warn('correction: deepReencodeOnCorrection -- cascade budget exhausted', {
          session,
          related_checked: relatedChecked,
          facts_updated: factsUpdated,
        })
        break
      }

      const result = await checkInvalidation(correctionText, fact.text, budget, { source: fact.source, confidence: fact.confidence })
      if (!result?.invalidates) continue

      const updatedText = result.updated_fact?.trim()
      if (!updatedText) continue

      // Pronoun guard -- matches the check in detectMemoryCorrection.
      if (PRONOUN_SUBJECT_RE.test(updatedText)) {
        log.debug('correction: deepReencodeOnCorrection -- dropping pronoun-subject update', {
          fact: updatedText.slice(0, 80),
        })
        continue
      }

      try {
        // Write replacement first (issue #227 discipline). No superseded_by here:
        // this is the ACTIVE replacement fact. The tombstone belongs on the OLD
        // fact, retired by the forget() below (#838).
        //
        // #861: route through the guarded chokepoint so the cascade can never
        // persist a secret or a Jarvis-identity claim. #869: the cascade
        // deliberately does NOT normalize -- it preserves the checkInvalidation
        // model's updated_fact phrasing -- so no normalizeFact call here; that
        // skip is intentional, not an oversight. The pronoun guard already ran
        // above, so skip the redundant re-check.
        const rememberResult = await guardedRemember(
          updatedText,
          fact.collection,
          'correction_deep_encode',
          'jarvis_inference',
          { session, skipPronounGuard: true },
        )
        if (!rememberResult.ok) {
          log.warn('correction: deepReencodeOnCorrection -- remember failed, skipping forget', {
            session,
            related: fact.text.slice(0, 60),
            reason: rememberResult.reason,
          })
          continue
        }

        // Supersede the original related fact.
        const forgetResult = await forget(fact.text, fact.collection)
        if (!forgetResult.deleted) {
          log.warn('correction: deepReencodeOnCorrection -- forget returned deleted=false', {
            session,
            fact: fact.text.slice(0, 60),
          })
        }

        factsUpdated++
        log.info('correction: deepReencodeOnCorrection -- cascaded update', {
          session,
          collection: fact.collection,
          old: fact.text.slice(0, 60),
          new: updatedText.slice(0, 60),
        })
      } catch (err) {
        log.warn('correction: deepReencodeOnCorrection -- store/delete failed for related fact', {
          session,
          err: String(err),
          fact: fact.text.slice(0, 60),
        })
      }
    }

    // Step 4: emit audit event.
    logEvent(session, 'correction_deep_encode', {
      related_checked: relatedChecked,
      facts_updated: factsUpdated,
      original_fact: originalFact.slice(0, 200),
    })

    log.info('correction: deepReencodeOnCorrection complete', { session, relatedChecked, factsUpdated })
  } catch (err) {
    // Outer catch: this function must never propagate -- it runs fire-and-forget.
    log.warn('correction: deepReencodeOnCorrection -- unhandled error (non-fatal)', { session, err: String(err) })
  }
}
