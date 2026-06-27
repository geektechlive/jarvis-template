// Autonomous self-improvement loop -- public surface.
//
// The implementation is split across cohesive modules; this file is the barrel
// that re-exports the public API so external importers and tests keep importing
// from '../improve' / './index' unchanged:
//   paths.ts      -- improvable/creatable path policy + branch-name pattern
//   suggestion.ts -- parse the LLM's XML change proposals + apply an edit
//   prompt.ts     -- system prompt, source-file reading, history block, LLM call
//   branches.ts   -- git plumbing, auto/improve-* branch mgmt, pytest gate, createScript
//   approval.ts   -- merge / reject / apply-approved (human-in-the-loop)
//   run.ts        -- the loop itself
//   curator.ts    -- script-usage curation (imported directly elsewhere)

export { IMPROVABLE_PATHS, CREATABLE_PATHS, isImprovable, isCreatable } from './paths'
export { applyTextChange } from './suggestion'
export { makeBranchTimestamp, createScript, hasImproveBranchToday } from './branches'
export { mergeBranch, rejectBranch, applyApprovedImprove } from './approval'
export { run } from './run'
