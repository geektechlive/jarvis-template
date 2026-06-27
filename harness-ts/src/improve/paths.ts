// Self-improvement path policy: which files the loop may edit or create, and
// the branch-name pattern it produces. Pure -- no I/O, no other improve deps.

// ---------------------------------------------------------------------------
// Improvable file allowlist. The Python rewrite removed harness/agent.py,
// harness/subagents/domain/*, and harness/reflection.py; the orchestration
// logic now lives in harness-ts/, which is intentionally NOT improvable
// (self-improvement should not edit its own runtime).
// ---------------------------------------------------------------------------

export const IMPROVABLE_PATHS = new Set([
  'harness/config/models.yaml',
  'harness/config/staff.yaml',
  'harness/config/routines.yaml',
  'harness/identity/BEHAVIOR.md',
  'harness/identity/ENVIRONMENT.md',
  'harness/identity/MISSION.md',
  'harness/identity/GOALS.md',
  'harness/identity/PROJECTS.md',
])

// scripts/ is the only prefix where agent-created scripts may land.
export const CREATABLE_PATHS = new Set(['scripts/'])

// Branch names produced by this module follow a fixed pattern.
// Validate all user-supplied branch names against this before any git operation.
export const BRANCH_RE = /^auto\/improve-[\w-]+$/

// Agent specs are improvable as a class -- any .md file under harness/agents/.
export function isImprovable(filepath: string): boolean {
  if (IMPROVABLE_PATHS.has(filepath)) return true
  return /^harness\/agents\/[^/]+\.md$/.test(filepath)
}

// Only flat filenames under scripts/ -- no subdirectory creation allowed.
export function isCreatable(filepath: string): boolean {
  const prefix = 'scripts/'
  if (!filepath.startsWith(prefix)) return false
  const name = filepath.slice(prefix.length)
  return name.length > 0 && !name.includes('/')
}
