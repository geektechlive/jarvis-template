// Decision detector — classifies a user prompt by stakes so Jarvis can
// either auto-dispatch the Devil's Advocate on high-stakes decisions or
// surface a one-line "want me to stress-test this?" offer on lower-stakes
// ones.
//
// High-tier requires two-of-three signals to fire:
//   1. Commitment verb (ship, deploy, fire, sign, commit, announce, terminate...)
//   2. Object/scope marker (production, $5k+, headcount, contract, client, board)
//   3. Non-hypothetical framing (no "thinking about", "considering", "what if")
//
// The two-of-three rule keeps "production logs" from triggering DA every
// time Alex asks about an error. Low/medium fall through to the soft offer.

export type DecisionStakes = 'low' | 'medium' | 'high' | null

const COMMITMENT_VERBS = [
  'ship',
  'shipping',
  'deploy',
  'deploying',
  'fire',
  'firing',
  'terminate',
  'sign',
  'signing',
  'commit',
  'committing',
  'announce',
  'announcing',
  'kill',
  'cancel',
  'cancelling',
  'cancelling',
  'merge',
  'release',
  'releasing',
  'pull the trigger',
  'go ahead',
  'pull the plug',
]

const SCOPE_MARKERS = [
  'production',
  'prod',
  'live',
  'public',
  'public-facing',
  'board',
  'investor',
  'investors',
  'client',
  'clients',
  'contract',
  'headcount',
  'team',
  'role',
  'employee',
  'vendor',
  'budget',
  'subscription',
  'quarterly',
  'annual',
]

const HYPOTHETICAL_MARKERS = [
  'thinking about',
  'considering',
  'what if',
  'might',
  'maybe',
  'on the fence',
  'leaning toward',
  'weighing',
  'wondering',
  'mulling',
  'brainstorm',
]

const MEDIUM_VERBS = [
  'restructure',
  'restructuring',
  'reorganize',
  'reorganizing',
  'reorg',
  'rewrite',
  'rewriting',
  'switch',
  'switching',
  'migrate',
  'migrating',
  'replace',
  'replacing',
]

// Match $5,000 / $5k / $5000 / 5 million etc. with a lower-bound threshold.
const DOLLAR_RE = /\$[\s]?(\d{1,3}(?:,\d{3})+|\d{4,})(?:\.\d+)?\b|\$[\s]?\d+\s?[km]\b/i

function containsAny(haystackLower: string, needles: string[]): boolean {
  return needles.some((n) => haystackLower.includes(n))
}

function hasMaterialDollar(text: string): boolean {
  // Match anything that looks like $5k or larger. $5k / $5K and $5000+ both qualify.
  // $4 and $500 do not.
  const m = DOLLAR_RE.exec(text)
  if (!m) return false
  const raw = m[0].toLowerCase().replace(/[\s$,]/g, '')
  if (raw.endsWith('k')) {
    const num = parseInt(raw.slice(0, -1), 10)
    return Number.isFinite(num) && num >= 5
  }
  if (raw.endsWith('m')) return true
  const num = parseInt(raw, 10)
  return Number.isFinite(num) && num >= 5000
}

export function classifyDecisionStakes(prompt: string): DecisionStakes {
  if (!prompt || prompt.trim().length < 8) return null
  const lower = prompt.toLowerCase()

  const hasHypothetical = containsAny(lower, HYPOTHETICAL_MARKERS)
  const hasCommitVerb = containsAny(lower, COMMITMENT_VERBS)
  const hasScope = containsAny(lower, SCOPE_MARKERS)
  const dollar = hasMaterialDollar(prompt)
  const hasMediumVerb = containsAny(lower, MEDIUM_VERBS)

  // High: two-of-three among {commitment verb, scope/dollar, non-hypothetical}.
  const scopeOrDollar = hasScope || dollar
  const nonHypothetical = !hasHypothetical
  const highSignals = [hasCommitVerb, scopeOrDollar, nonHypothetical].filter(Boolean).length
  if (highSignals >= 3) return 'high'
  if (highSignals === 2 && (hasCommitVerb || scopeOrDollar)) return 'high'

  // Medium: hypothetical framing OR restructure-class verbs OR scope without commitment.
  if (hasMediumVerb || (hasScope && hasHypothetical) || (hasCommitVerb && hasHypothetical)) {
    return 'medium'
  }
  if (hasHypothetical && lower.length > 40) return 'low'
  return null
}

// Build the system-prompt injection block for a given stakes level.
// Empty string when stakes is null or the env flag is off.
export function buildDecisionInjection(stakes: DecisionStakes): string {
  if (!stakes) return ''
  if (process.env['JARVIS_DA_AUTODISPATCH'] === '0') return ''
  if (stakes === 'high') {
    return (
      '\n\n---\nDevil\'s Advocate trigger (high-stakes decision detected): ' +
      'Before delivering your answer, dispatch the Devil\'s Advocate via the Agent tool ' +
      '(subagent_type: devils_advocate) on the principal\'s decision. ' +
      'When she returns, quote her objections verbatim as a distinct voice, then give ' +
      'your own recommendation in your own voice. Do not skip her on a decision at this scope.'
    )
  }
  // low / medium
  return (
    '\n\n---\nDevil\'s Advocate offer (decision tone detected): ' +
    'In a single short line, surface a stress-test offer to the principal — e.g., ' +
    '"Want me to have the Devil\'s Advocate stress-test this before you commit?" — then answer the question. ' +
    'Do not dispatch her unless he accepts.'
  )
}
