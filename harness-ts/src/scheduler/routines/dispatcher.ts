// Findings dispatcher — drains the findings queue and routes by criticality.
//
// critical      → individual push per finding + storePendingBrief
// important     → bundled single push + storePendingBrief
// informational → storePendingBrief only (no push); appears in next morning brief
//
// Entity batching (live mode only):
//   Findings sharing a named entity within a 30-min window are synthesized into
//   a single brief by a fast local model, suppressing the originals from delivery.

import { log, type IonContext } from 'ion-sdk'
import { storePendingBrief, writeWorkingMemory, logEvent } from '../../memory/episodic'
import { isWorkingMemoryEnabled, isEntityBatchingEnabled, isQuietHours } from '../helpers'
import {
  pendingFindings,
  markProcessed,
  purgeOldFindings,
  atomicClaim,
  reclaimStale,
  recordFailedAttempt,
  type FindingRow,
} from '../../findings'
import { groupByEntity } from './entityBatch'
import { ollamaOneShot } from '../../util/ollamaChat'
import { getSchedulerCtx } from '../ctx'
import { publishBriefing } from '../../resources/briefings'
import { publishFinding } from '../../resources/finding'
import { loadModelForRole, loadBackendForRole } from '../../config'

const SYNTHESIZER_MODEL = loadModelForRole('synthesizer', 'llama3.1:8b')
const SYNTHESIZER_BACKEND = loadBackendForRole('synthesizer', 'ollama')

export async function runFindingsDispatcher(ctx: IonContext): Promise<void> {
  // Reclaim stale claims from a previous crashed dispatcher run before querying.
  reclaimStale()

  if (isQuietHours()) return

  const findings = pendingFindings()
  if (findings.length === 0) return

  // ---------------------------------------------------------------------------
  // Entity batching (shadow or live)
  // ---------------------------------------------------------------------------
  const groups = groupByEntity(findings)
  const suppressedIds = new Set<number>()
  const synthesizedImportant: Array<{ content: string; originalIds: number[] }> = []

  if (groups.length > 0) {
    if (isEntityBatchingEnabled()) {
      for (const g of groups) {
        try {
          const lines = g.findings.map(f => `[${f.source}] ${f.content}`).join('\n')
          const task = `Synthesize these ${g.findings.length} related intelligence briefings about "${g.entity}" into one concise summary. Be specific and factual. Under 200 words. Output only the synthesized text, no preamble or markdown.\n\n${lines}`
          const dispatchCtx = getSchedulerCtx()
          let synthesized = ''
          if (dispatchCtx) {
            try {
              const r = await dispatchCtx.dispatchAgent({ name: 'entity-synthesizer', task, model: SYNTHESIZER_MODEL, maxTurns: 1 })
              synthesized = r.output.trim()
            } catch (err) {
              log.warn('findings dispatcher: entity synthesis dispatchAgent failed', { entity: g.entity, err: String(err) })
            }
          } else if (SYNTHESIZER_BACKEND === 'cli') {
            // cli synthesis requires the scheduler ctx (dispatchAgent); there is
            // none during the cold-start window. Skip synthesis gracefully rather
            // than sending a claude model id to Ollama (silent 404). Findings still
            // flow through un-synthesized.
            log.warn('findings dispatcher: synthesizer backend=cli but no scheduler ctx (cold start) -- skipping synthesis', { entity: g.entity })
          } else {
            synthesized = await ollamaOneShot(
              SYNTHESIZER_MODEL,
              'Synthesize related intelligence briefings into one concise summary. Be specific and factual. Under 200 words.',
              `Synthesize these ${g.findings.length} related findings about "${g.entity}":\n${lines}`,
              20_000,
            )
          }
          if (synthesized) {
            // Note: if any of the originals were critical, they are tier-downgraded to
            // synthesized-important. This is logged so shadow-mode review can catch it.
            const hadCritical = g.findings.some(f => f.criticality === 'critical')
            if (hadCritical) {
              log.info('findings dispatcher: entity synthesis downgraded critical findings', {
                entity: g.entity,
                count: g.findings.length,
              })
            }
            synthesizedImportant.push({ content: synthesized, originalIds: g.findings.map(f => f.id) })
            for (const f of g.findings) suppressedIds.add(f.id)
          }
        } catch (err) {
          log.warn('findings dispatcher: entity synthesis failed', { entity: g.entity, err: String(err) })
        }
      }
    } else {
      // Shadow mode: log what would have been batched, but deliver normally
      for (const g of groups) {
        log.info('findings dispatcher: entity group (shadow)', {
          entity: g.entity,
          count: g.findings.length,
          sources: g.findings.map(f => f.source),
        })
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Build delivery lists (excluding synthesized originals)
  // ---------------------------------------------------------------------------
  const critical: FindingRow[] = []
  const important: FindingRow[] = []
  const informational: FindingRow[] = []

  for (const f of findings) {
    if (suppressedIds.has(f.id)) continue
    if (!atomicClaim(f.id)) continue  // skip already-claimed (concurrent dispatcher)
    if (f.criticality === 'critical') critical.push(f)
    else if (f.criticality === 'important') important.push(f)
    else informational.push(f)
  }

  // --- critical: one push per finding ---
  for (const f of critical) {
    try {
      const briefingText = `[${f.source}] ${f.content}`
      try {
        markProcessed(f.id)
      } catch (markErr) {
        log.warn('findings dispatcher: markProcessed failed, skipping push', {
          id: f.id,
          err: String(markErr),
        })
        continue
      }
      await publishFinding(`finding_${f.id}`, 'Jarvis — Urgent', briefingText, f.content.slice(0, 100), ctx)
      storePendingBrief(briefingText)
      publishBriefing(briefingText, 'Urgent Finding', ctx).catch((err: unknown) => {
        log.warn('findings dispatcher: critical resource publish failed', { err: String(err) })
      })
      if (isWorkingMemoryEnabled()) {
        writeWorkingMemory(`[${f.source}] ${f.content.slice(0, 300)}`, 'findings_dispatcher')
      }
    } catch (err) {
      const blocked = recordFailedAttempt(f.id)
      if (blocked) {
        log.warn('findings dispatcher: finding auto-blocked after 3 failures', { id: f.id, source: f.source })
        logEvent('findings_dispatcher', 'inbox_item', {
          routine: 'findings_dispatcher',
          text: `Finding #${f.id} from ${f.source} auto-blocked after 3 failed delivery attempts.`,
        })
      }
      log.warn('findings dispatcher: error processing critical finding', {
        id: f.id,
        err: String(err),
      })
    }
  }

  // --- synthesized important: deliver after critical, before regular important ---
  for (const s of synthesizedImportant) {
    try {
      const briefingText = `[Synthesized: ${s.originalIds.map(id => `#${id}`).join(', ')}] ${s.content}`
      if (!s.originalIds.length) {
        log.warn('findings dispatcher: synthesis has no originalIds, skipping resource publish')
        continue
      }
      await publishFinding(`synthesis_${s.originalIds[0]}`, 'Jarvis — Intelligence Brief', briefingText, s.content.slice(0, 100), ctx)
      storePendingBrief(briefingText)
      publishBriefing(briefingText, 'Intelligence Brief', ctx).catch((err: unknown) => {
        log.warn('findings dispatcher: synthesis resource publish failed', { err: String(err) })
      })
      if (isWorkingMemoryEnabled()) {
        writeWorkingMemory(s.content.slice(0, 400), 'findings_dispatcher')
      }
      for (const id of s.originalIds) markProcessed(id)
    } catch (err) {
      log.warn('findings dispatcher: error delivering synthesis', { err: String(err) })
    }
  }

  // --- important: bundled push ---
  if (important.length > 0) {
    try {
      const lines = important.map((f) => `[${f.source}] ${f.content}`)
      const briefingText = lines.join('\n')
      const firstId = important[0]?.id
      if (firstId === undefined) {
        log.warn('findings dispatcher: important batch has no id on first item, skipping resource publish')
      } else {
        await publishFinding(`findings_important_${firstId}`, 'Jarvis — Findings', briefingText, `${important.length} item(s) worth your attention.`, ctx)
        storePendingBrief(briefingText)
        publishBriefing(briefingText, 'Important Finding', ctx).catch((err: unknown) => {
          log.warn('findings dispatcher: important resource publish failed', { err: String(err) })
        })
        for (const f of important) {
          markProcessed(f.id)
        }
        if (isWorkingMemoryEnabled()) {
          const summary = important.map(f => `[${f.source}] ${f.content.slice(0, 150)}`).join(' | ')
          writeWorkingMemory(summary, 'findings_dispatcher')
        }
      }
    } catch (err) {
      log.warn('findings dispatcher: error processing important findings', {
        count: important.length,
        err: String(err),
      })
    }
  }

  // --- informational: brief injection only, no push ---
  if (informational.length > 0) {
    try {
      const lines = informational.map((f) => `[${f.source}] ${f.content}`)
      const briefingText = lines.join('\n')
      storePendingBrief(briefingText)
      publishBriefing(briefingText, 'Finding', ctx).catch((err: unknown) => {
        log.warn('findings dispatcher: informational resource publish failed', { err: String(err) })
      })
      for (const f of informational) {
        markProcessed(f.id)
      }
    } catch (err) {
      log.warn('findings dispatcher: error processing informational findings', {
        count: informational.length,
        err: String(err),
      })
    }
  }

  logEvent('findings_dispatcher', 'routine_delivered', {
    routine: 'findings_dispatcher',
    critical: critical.length,
    important: important.length + synthesizedImportant.length,
    informational: informational.length,
  })
  purgeOldFindings()
}
