// Risk tier classifier for the Jarvis approval queue.
// Categorises a set of changed file paths as 'safe' or 'risky'.
//
// safe  -- all files are under harness-ts/src/ and none match a risky glob
// risky -- any file matches a sensitive path pattern, or the list is empty

export type RiskTier = 'safe' | 'risky'

// Risky patterns: infrastructure, self-referential, identity, CI.
// Expressed as prefix strings or suffix patterns; checked in order.
const RISKY_PREFIXES = [
  'harness/identity/',
  'harness/config/',
  'harness-ts/src/patrol/',
  'harness-ts/src/improve/',
  'harness-ts/src/approvals/',
  'harness-ts/src/discord/',
  'harness-ts/src/scheduler/',
  'harness-ts/src/learning/',
  'harness-ts/src/hooks/',
] as const

const RISKY_SUFFIXES = ['.plist'] as const

/**
 * Classify a set of changed file paths as 'safe' or 'risky'.
 *
 * Safe requires ALL of the following:
 *   - At least one file in the list
 *   - Every file lives under harness-ts/src/
 *   - No file matches a risky prefix or suffix
 *
 * @param filesChanged - Relative file paths from the repo root
 */
export function classifyRiskTier(filesChanged: string[]): RiskTier {
  // Defensive: empty list is risky
  if (filesChanged.length === 0) return 'risky'

  for (const f of filesChanged) {
    // Must be under the harness-ts source tree
    if (!f.startsWith('harness-ts/src/')) return 'risky'

    // Check risky prefixes
    for (const prefix of RISKY_PREFIXES) {
      if (f.startsWith(prefix)) return 'risky'
    }

    // Check risky suffixes
    for (const suffix of RISKY_SUFFIXES) {
      if (f.endsWith(suffix)) return 'risky'
    }
  }

  return 'safe'
}
