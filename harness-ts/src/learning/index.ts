// Learning module -- post-turn fact extraction and staff gap detection.
// Mirrors harness/learning.py for the five behaviors used from hooks/scheduler.
//
// Behavior 1: extractAndStore(session)     -- post-turn LLM extraction of durable facts
// Behavior 2: extractGapsAndPropose()      -- weekly roster gap analysis + draft proposals
// Behavior 3: detectGapForMessage(message) -- per-turn quick gap check, 7-day suppression
// Behavior 4: processTriageCorrections()   -- template triage preferences from correction events
// Behavior 5: extractFromMeetings(session) -- meeting synthesis extraction into knowledge
// Behavior 7: detectMemoryCorrection(session) -- overwrite contradicted user_profile facts
//               calls deepReencodeOnCorrection() (correction.ts) as fire-and-forget after
//               the primary correction is persisted (Issue #419).
// Behavior 8: extractConcreteValues(session) -- detail-pass for concrete values (9+ messages)
//
// Wiring:
//   turn_end     -> extractAndStore(session)        (fire-and-forget)
//   turn_end     -> detectMemoryCorrection(session) (fire-and-forget, before extractAndStore)
//   turn_end     -> extractConcreteValues(session)  (fire-and-forget, 9+ messages only)
//   before_prompt -> detectGapForMessage(prompt)    (fire-and-forget)
//   session_end  -> extractFromMeetings(session)    (fire-and-forget)
//   weekly_curator -> extractGapsAndPropose() + processTriageCorrections()

export { extractAndStore, extractConcreteValues } from './factExtraction'
export type { ExtractAndStoreOptions } from './factExtraction'
export { detectGapForMessage, clearGapCheckSession, SUPPRESSION_WINDOW_HOURS, ANALYSIS_WINDOW_DAYS } from './gapDetection'
export { extractGapsAndPropose, processTriageCorrections, appendStaffYaml } from './gapProposal'
export { extractFromMeetings } from './meetingExtraction'
export {
  detectRoutingCorrection,
  getRoutingVocabularyRE,
  rebuildRoutingVocabulary,
  ROUTING_VOCABULARY_RE,
} from './routingCorrection'
export { detectMemoryCorrection } from './memoryCorrection'
