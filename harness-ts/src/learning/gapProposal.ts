// Behavior 2: extractGapsAndPropose -- weekly roster gap analysis + draft proposals
// Behavior 4: processTriageCorrections -- template triage preferences from correction events

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { log } from 'ion-sdk'
import { HARNESS_DIR, OLLAMA_HOST, isAllowedHost, loadStaff } from '../config'
import {
  getRecentMessages,
  logEvent,
  recentEvents,
  recentAgentEvents,
  lastEvent,
  eventsSince,
} from '../memory/episodic'
import { remember } from '../memory/recall'
import { ollamaChatJson, buildRosterSummary } from './shared'
import { ANALYSIS_WINDOW_DAYS } from './gapDetection'
import { rebuildRoutingVocabulary } from './routingCorrection'

const _MIN_USER_MESSAGES = 5
const _VALID_MODEL_KEYS = new Set(['default', 'research', 'writing'])

interface GapSignal {
  topic_cluster: string
  description: string
  evidence_messages: string[]
}

interface StaffProposal {
  title: string
  specialties: string[]
  when_to_call: string[]
  suggested_model_key: string
  draft_system_prompt: string
  topic_cluster: string
  evidence: string[]
}

const GAP_ANALYSIS_SYSTEM = `You are analysing conversation messages to identify recurring topic gaps in a staff roster.
Respond with a JSON array. If no gaps exist, return [].
Schema:
[{"topic_cluster": "short label", "description": "one sentence", "evidence_messages": ["msg1", "msg2"]}]
JSON only, no other text:`

const PROPOSAL_SYSTEM = `Given an identified staff coverage gap, propose a new staff member for a personal AI agent system.
Available model keys (pick one): default, research, writing
Generate a staff member proposal as a JSON object:
{"title": "Job title", "specialties": ["s1","s2","s3"], "when_to_call": ["phrase1","phrase2","phrase3"], "suggested_model_key": "one of: default, research, writing", "draft_system_prompt": "2-3 sentence role description"}
JSON only, no other text:`

/** Safely quote a string as a YAML single-quoted scalar. */
function yamlScalar(value: string): string {
  return `'${value.replace(/\n/g, ' ').replace(/'/g, "''")}'`
}

export function appendStaffYaml(staffId: string, proposal: StaffProposal): void {
  const staffYamlPath = join(HARNESS_DIR, 'harness/config/staff.yaml')
  const tmpPath = `${staffYamlPath}.tmp`

  let current = ''
  if (existsSync(staffYamlPath)) {
    current = readFileSync(staffYamlPath, 'utf8')
  }

  // Idempotency guard: skip if a staff entry with this id already exists.
  // Two distinct topic_cluster strings can slug to the same id; appending
  // unconditionally would produce duplicate id: rows that loadStaff() parses
  // sequentially with implementation-defined precedence.
  try {
    const existing = loadStaff()
    if (existing.some((s) => s.id === staffId)) {
      log.warn('learning: appendStaffYaml skipped, duplicate id', { staffId })
      return
    }
  } catch (err) {
    log.warn('learning: appendStaffYaml could not load existing staff, proceeding', { err: String(err) })
  }

  const specialtiesYaml = proposal.specialties
    .slice(0, 5)
    .map((s) => `      - ${yamlScalar(s)}`)
    .join('\n')
  const whenYaml = proposal.when_to_call
    .slice(0, 4)
    .map((w) => `      - ${yamlScalar(w)}`)
    .join('\n')
  const systemPromptLine = yamlScalar(
    `${proposal.draft_system_prompt.replace(/\n/g, ' ').slice(0, 500)} You report to Jarvis, the principal's chief of staff. He will re-speak your output. Be precise; tone is his job, not yours.`,
  )

  const fragment = `
  - id: ${staffId}
    title: ${yamlScalar(proposal.title)}
    status: draft
    specialties:
${specialtiesYaml}
    when_to_call:
${whenYaml}
    model_key: ${proposal.suggested_model_key}
    system_prompt_template: ${systemPromptLine}
`

  writeFileSync(tmpPath, current + fragment, 'utf8')
  renameSync(tmpPath, staffYamlPath)
  // Issue #231: invalidate the routing vocabulary cache so new staff names are
  // recognized by detectRoutingCorrection on the next call.
  rebuildRoutingVocabulary()
}

// Issue #356: split analysis and proposal budgets so a slow analysis call
// cannot exhaust all budget before proposal generation runs.
// Analysis gets 60s (one LLM call). Each proposal gets an independent 45s
// budget -- slow proposals don't cascade into subsequent ones.
const GAP_ANALYSIS_BUDGET_MS = 60_000
const GAP_PROPOSAL_BUDGET_MS = 45_000

export async function extractGapsAndPropose(): Promise<StaffProposal[]> {
  if (!isAllowedHost(OLLAMA_HOST)) return []
  const budget = AbortSignal.timeout(GAP_ANALYSIS_BUDGET_MS)

  // Pull recent user messages from the past 7 days (time-bound, not row-count-bound).
  // Issue #359: row-count alone produces undefined time windows -- too few rows after
  // quiet periods, too many after bursts. Filter to the past 7 days to match the
  // weekly routine cadence. Row-count cap of 500 remains as a safety limit.
  const cutoff7d = new Date(Date.now() - ANALYSIS_WINDOW_DAYS * 86_400_000).toISOString()
  const recentEvts = recentAgentEvents(500).filter((e) => e.ts >= cutoff7d)
  const sessions = [...new Set(recentEvts.map((e) => e.session))].slice(0, 20)

  const allUserMessages: string[] = []
  for (const sess of sessions) {
    const rows = getRecentMessages(sess, 50)
    const userRows = rows.filter((r) => r.role === 'user')
    // Sessions with fewer than 2 user messages are automated/routine runs, not real interactions.
    if (userRows.length < 2) continue
    for (const row of userRows) allUserMessages.push(row.content)
  }

  if (allUserMessages.length < _MIN_USER_MESSAGES) {
    log.info('learning: not enough user messages for gap analysis', { count: allUserMessages.length })
    return []
  }

  const rosterSummary = buildRosterSummary()
  const msgText = allUserMessages.slice(-50).map((m) => `- ${m.slice(0, 200)}`).join('\n')

  // Pull recent reflection findings to inform gap detection.
  // reflection_complete is logged under the conversation session ID, not a fixed routine name,
  // so we scan recentAgentEvents and filter by event type.
  let reflectionContext = ''
  try {
    const cutoffTs = new Date(Date.now() - 168 * 3_600_000).toISOString()
    const reflEvents = recentAgentEvents(200)
      .filter((ev) => ev.event === 'reflection_complete' && ev.ts >= cutoffTs)
    if (reflEvents.length) {
      const snippets = reflEvents
        .slice(0, 4)
        .map((ev) => {
          const d = ev['detail'] as Record<string, unknown> | undefined
          if (!d) return ''
          // reflection_complete detail: { facts_stored, patterns_length, gaps_length,
          // patterns_excerpt?, gaps_excerpt? }. Prefer the qualitative excerpts (#647);
          // fall back to counts for older events logged before excerpts existed.
          const factsStored = Number(d['facts_stored'] ?? 0)
          const patternsLen = Number(d['patterns_length'] ?? 0)
          const gapsLen = Number(d['gaps_length'] ?? 0)
          const patternsExcerpt = typeof d['patterns_excerpt'] === 'string' ? d['patterns_excerpt'].trim() : ''
          const gapsExcerpt = typeof d['gaps_excerpt'] === 'string' ? d['gaps_excerpt'].trim() : ''
          if (patternsExcerpt || gapsExcerpt) {
            const parts: string[] = []
            if (patternsExcerpt) parts.push(`patterns: ${patternsExcerpt}`)
            if (gapsExcerpt) parts.push(`gaps: ${gapsExcerpt}`)
            return `Reflection panel findings — ${parts.join(' | ')}`
          }
          if (factsStored > 0 || patternsLen > 0 || gapsLen > 0) {
            return `Reflection panel ran: ${factsStored} facts stored, ${patternsLen} pattern chars, ${gapsLen} gap chars`
          }
          return ''
        })
        .filter(Boolean)
      if (snippets.length) {
        reflectionContext = `\nRecent reflection findings (use to inform gap detection):\n${snippets.map((s) => `- ${s}`).join('\n')}\n`
      }
    }
  } catch { /* non-fatal */ }

  const gaps: GapSignal[] = []
  try {
    const userPrompt = `Current staff roles and specialties:\n${rosterSummary}\n\nRecent user messages:\n${msgText}${reflectionContext}\n\nTask: Identify 0-3 recurring topic domains NOT well-covered by current staff. A gap is real only if the same general domain appears in at least 2 separate messages. Do not flag topics already covered by current staff specialties.`
    const data = await ollamaChatJson(GAP_ANALYSIS_SYSTEM, userPrompt, 0.1, budget)
    if (Array.isArray(data)) {
      for (const item of data) {
        if (typeof item !== 'object' || !item) continue
        const cluster = String((item as Record<string, unknown>)['topic_cluster'] ?? '').trim()
        const description = String((item as Record<string, unknown>)['description'] ?? '').trim()
        const evidence = ((item as Record<string, unknown>)['evidence_messages'] as unknown[] ?? [])
          .slice(0, 5)
          .map(String)
        if (cluster && description) {
          gaps.push({ topic_cluster: cluster, description, evidence_messages: evidence })
        }
      }
    }
  } catch (err) {
    log.warn('learning: gap analysis failed', { err: String(err) })
    return []
  }

  if (!gaps.length) return []

  // 7-day suppression: skip clusters already proposed recently or detected per-turn recently
  const proposedClusters = recentEvents('', 'staff_gap_proposed', 168)
    .map((e) => {
      const d = e.detail as Record<string, unknown> | null
      return String(d?.['topic_cluster'] ?? '').toLowerCase()
    })
    .filter(Boolean)

  const perTurnDetectedClusters = recentEvents('', 'per_turn_gap_detected', 168)
    .map((e) => {
      const d = e.detail as Record<string, unknown> | null
      return String(d?.['topic_cluster'] ?? '').toLowerCase()
    })
    .filter(Boolean)

  const existingClusters = new Set([...proposedClusters, ...perTurnDetectedClusters])

  const newProposals: StaffProposal[] = []

  for (const gap of gaps) {
    if (existingClusters.has(gap.topic_cluster.toLowerCase())) {
      log.debug('learning: skipping already-proposed gap', { cluster: gap.topic_cluster })
      continue
    }

    logEvent('', 'gap_detected', {
      topic_cluster: gap.topic_cluster,
      description: gap.description,
      evidence_count: gap.evidence_messages.length,
    })

    let proposal: StaffProposal | null = null
    try {
      // Issue #356: each proposal gets its own independent budget so one slow
      // proposal doesn't block the rest.
      const proposalBudget = AbortSignal.timeout(GAP_PROPOSAL_BUDGET_MS)
      const evidenceText = gap.evidence_messages.map((e) => `- ${e}`).join('\n') || '(no specific examples)'
      const userPrompt = `Gap: ${gap.description}\nTopic: ${gap.topic_cluster}\nEvidence from conversations:\n${evidenceText}`
      const data = await ollamaChatJson(PROPOSAL_SYSTEM, userPrompt, 0.2, proposalBudget)
      if (typeof data === 'object' && data) {
        const d = data as Record<string, unknown>
        const title = String(d['title'] ?? '').trim()
        if (title) {
          let modelKey = String(d['suggested_model_key'] ?? 'default').trim()
          if (!_VALID_MODEL_KEYS.has(modelKey)) modelKey = 'default'
          proposal = {
            title,
            specialties: (d['specialties'] as unknown[] ?? []).slice(0, 5).map(String),
            when_to_call: (d['when_to_call'] as unknown[] ?? []).slice(0, 4).map(String),
            suggested_model_key: modelKey,
            draft_system_prompt: String(d['draft_system_prompt'] ?? '').trim(),
            topic_cluster: gap.topic_cluster,
            evidence: gap.evidence_messages.slice(0, 3),
          }
        }
      }
    } catch (err) {
      log.debug('learning: proposal generation failed', { cluster: gap.topic_cluster, err: String(err) })
      continue
    }

    if (!proposal) continue

    // Derive a safe YAML id from the topic cluster
    const staffId = gap.topic_cluster
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 32)

    if (!staffId) continue

    // Write draft entry to staff.yaml (atomic rename)
    try {
      appendStaffYaml(staffId, proposal)
      log.info('learning: wrote draft staff entry', { staffId, title: proposal.title })
    } catch (err) {
      log.warn('learning: could not write staff.yaml', { staffId, err: String(err) })
      continue
    }

    // Emit suppression-tracking event (used by detectGapForMessage 7-day gate)
    logEvent('', 'staff_gap_proposed', {
      topic_cluster: gap.topic_cluster,
      staff_id: staffId,
      title: proposal.title,
    })

    // Emit inbox_item with routine='staff_proposal' so staff-log command picks it up
    logEvent('', 'inbox_item', {
      routine: 'staff_proposal',
      text: `Draft staff member proposed: ${proposal.title} (id: ${staffId}). Topic: ${gap.topic_cluster}. Use /hire confirm to promote to active.`,
      priority: 0.5,
    })

    existingClusters.add(gap.topic_cluster.toLowerCase())
    newProposals.push(proposal)
  }

  log.info('learning: extractGapsAndPropose complete', { proposals: newProposals.length })
  return newProposals
}

// ---------------------------------------------------------------------------
// Behavior 4: processTriageCorrections (weekly, no LLM)
// ---------------------------------------------------------------------------

export async function processTriageCorrections(): Promise<number> {
  // Mirrors harness/learning.py::process_triage_corrections() exactly.
  // No LLM call -- just template a preference string and store it.

  // Issue #273: cursor-based processing -- only process events not yet seen.
  // Reads the last processed event ID from the triage_correction_cursor event,
  // then fetches only new triage_correction events after that ID.
  // This eliminates O(4-week-window) vec server roundtrips on every weekly run.
  const cursorRow = lastEvent('', 'triage_correction_cursor')
  const afterId = Number((cursorRow?.detail as Record<string, unknown> | null)?.['processed_through_id'] ?? 0)
  const corrections = eventsSince(afterId, '', 'triage_correction')

  if (!corrections.length) {
    log.info('learning: no new triage corrections to process')
    return 0
  }

  // Dedup guard within this run (same source+snippet may appear multiple times in a burst)
  const seenPreferences = new Set<string>()

  let written = 0
  let skippedDup = 0
  for (const evt of corrections) {
    const detail = evt.detail as Record<string, unknown> | null
    if (!detail) continue
    const source = String(detail['source'] ?? 'unknown')
    const content = String(detail['content'] ?? '').trim()
    if (!content) continue
    const snippet = content.slice(0, 200)
    const preference = `Alex prefers not to receive triage notifications from source '${source}'. Example content that was dismissed: ${snippet}`
    if (seenPreferences.has(preference)) {
      skippedDup++
      continue
    }
    seenPreferences.add(preference)
    try {
      const result = await remember(preference, 'agent_memories', 'triage_correction', 'jarvis_inference')
      if (result.ok) {
        written++
      } else {
        log.debug('learning: triage correction not stored', { reason: result.reason })
      }
    } catch (err) {
      log.debug('learning: skipping triage correction', { err: String(err) })
    }
  }

  // Issue #273: advance the cursor to the highest processed event ID so the
  // next weekly run only sees truly new corrections.
  const maxId = Math.max(...corrections.map((e) => e.id))
  logEvent('', 'triage_correction_cursor', { processed_through_id: maxId })

  if (written > 0 || skippedDup > 0) {
    logEvent('', 'triage_correction_processed', { count: written, skipped_dup: skippedDup })
    log.info('learning: processTriageCorrections complete', { written, skipped_dup: skippedDup })
  }
  return written
}
