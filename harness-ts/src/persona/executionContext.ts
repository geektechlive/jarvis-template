// Execution-environment grounding for dispatched child agents.
//
// Jarvis runs as the ion engine ON the M2 Mac Mini (user <username>). A child
// agent's Bash tool therefore executes locally on that same host. ENVIRONMENT.md
// tells the *root* Jarvis session this, but that context is never passed to
// dispatched staff/worker agents -- so they fall back to a training-data
// assumption that the Mini is a remote box and try to SSH to <mac-mini-ip>
// (itself), which fails ("SSH to Mini unreachable"). This preamble is appended
// to every child-dispatch system prompt to ground them.
//
// Modeled on the per-spec "Environment" section in
// harness/agents/reflection-analyst.md. Kept ASCII-only and free of banned
// tokens (no "!", no em dash) so it never trips bannedTokenEnforcement().

export const EXECUTION_CONTEXT_PREAMBLE =
  `\n\n## Execution environment\n\n` +
  `You run locally on the Mac Mini (user <username>). Your Bash tool executes on this host. ` +
  `Never SSH to <mac-mini-ip> or any host; you are already on it. ` +
  `Use localhost / 127.0.0.1 and local home paths. ` +
  `Ignore any task context that implies a remote machine or a dev laptop.`

// Appended to every autonomy goal prompt. Goals run unattended and their output
// is delivered straight to Alex, so an agent that hits empty or missing data
// must report that plainly -- not pivot to asking Alex a setup or meta question
// (the bug behind goals #14 birthdays and #15 wellness). Mirrors the empty-state
// guidance baked into the contacts_pulse routine.
export const GOAL_DIRECTIVE =
  `\n\n## Reporting\n\n` +
  `Deliver a concrete result. If the data this goal needs is missing or empty, ` +
  `say so plainly in one line (for example "No upcoming birthdays found" or ` +
  `"Health data unavailable"). Do not ask Alex setup or meta questions, and do ` +
  `not propose how he should configure things; either report a finding or report ` +
  `that there is nothing to surface.`
