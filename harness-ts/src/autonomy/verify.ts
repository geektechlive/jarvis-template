// LLM-as-judge critic for autonomy goal output (#tier2).
// Evaluates goal output before delivery. Fail-open on any critic error — a
// broken verifier must never block or suppress goal output.

import { log } from 'ion-sdk'
import { loadBoolFlag, loadModelForRole, loadTimeoutForRole } from '../config'
import { runClaudeAgent } from '../util/claudeAgent'

export interface VerificationResult {
  ok: boolean
  issue: string
  // skipped: the critic rendered NO verdict -- feature disabled, nothing to verify,
  // or the critic itself failed / returned no parseable output. Still fail-open
  // (ok stays true), but flagged so deliverGoalResult logs verification_skipped
  // instead of verification_pass, which otherwise inflates the pass-rate stat (#837).
  skipped: boolean
  reason?: 'disabled' | 'empty_output' | 'error' | 'unparseable'
}

// Non-verdict (fail-open) result carrying why the critic was bypassed.
const skip = (reason: NonNullable<VerificationResult['reason']>): VerificationResult => ({
  ok: true,
  issue: '',
  skipped: true,
  reason,
})
const PASS: VerificationResult = { ok: true, issue: '', skipped: false }
const fail = (issue: string): VerificationResult => ({ ok: false, issue, skipped: false })

// ---------------------------------------------------------------------------
// parseVerificationResponse — pure function, no I/O.
// Contract:
//   - Starts with "OK" (case-insensitive) → genuine pass {ok:true, skipped:false}
//   - Starts with "FAIL" (case-insensitive) → genuine fail {ok:false, issue: text
//     after "FAIL" / "FAIL:" stripped, trimmed, capped at 200 chars}
//   - Anything else (empty, garbage) → skipped {ok:true, skipped:true,
//     reason:'unparseable'} (fail-open, but no verdict was rendered)
// ---------------------------------------------------------------------------

export function parseVerificationResponse(raw: string): VerificationResult {
  const trimmed = raw.trim()
  if (!trimmed) return skip('unparseable')

  if (/^ok\b/i.test(trimmed)) return PASS

  if (/^fail/i.test(trimmed)) {
    // Strip "FAIL" (and optional ":") from the front, trim whitespace
    const afterFail = trimmed.replace(/^fail\s*:?\s*/i, '').trim()
    return fail(afterFail.slice(0, 200))
  }

  // Garbage / unparseable — fail-open but record as skipped (critic gave no verdict)
  return skip('unparseable')
}

// ---------------------------------------------------------------------------
// verificationEvent — pure mapping from a result to its telemetry event (#837).
// Centralizes the rule: a skipped (non-verdict) result gets its OWN event with a
// reason, so it never inflates the verification_pass rate. Genuine pass/fail keep
// their events. `base` carries shared detail (goal_id, model).
// ---------------------------------------------------------------------------

export interface VerificationEvent {
  event: 'verification_pass' | 'verification_fail' | 'verification_skipped'
  detail: Record<string, unknown>
}

export function verificationEvent(
  v: VerificationResult,
  base: Record<string, unknown>,
): VerificationEvent {
  if (v.skipped) return { event: 'verification_skipped', detail: { ...base, reason: v.reason } }
  if (!v.ok) return { event: 'verification_fail', detail: { ...base, issue: v.issue } }
  return { event: 'verification_pass', detail: { ...base } }
}

// ---------------------------------------------------------------------------
// verifyGoalOutput — call the LLM critic and return a VerificationResult.
// Fail-open everywhere (ok stays true), but the non-verdict paths return
// skipped:true with a reason so telemetry can tell a real pass from a bypass:
//   - empty output  → reason:'empty_output'
//   - feature off   → reason:'disabled'
//   - critic threw  → reason:'error'
//   - critic gave no parseable verdict → reason:'unparseable' (via parse fn)
// ---------------------------------------------------------------------------

export async function verifyGoalOutput(task: string, output: string): Promise<VerificationResult> {
  // Nothing to verify if output is blank
  if (!output.trim()) return skip('empty_output')

  // Config gate — disabled flag → skip without touching the model
  if (!loadBoolFlag('verification_enabled', true)) return skip('disabled')

  const model = loadModelForRole('verifier', 'claude-haiku-4-5-20251001')
  const timeoutMs = loadTimeoutForRole('verifier', 30) * 1_000

  const judgePrompt =
    'You are verifying an autonomous agent\'s work. Reply with EXACTLY one line: ' +
    'either "OK" or "FAIL: <one short reason>". ' +
    'Fail if the output does not actually accomplish the task, claims success it did not achieve, ' +
    'or asserts unsupported/fabricated facts.\n\n' +
    'TASK:\n' + task.slice(0, 1500) + '\n\n' +
    'OUTPUT:\n' + output.slice(0, 4000)

  try {
    const stdout = await runClaudeAgent('verify', judgePrompt, { model, timeoutMs })
    return parseVerificationResponse(stdout)
  } catch (err: unknown) {
    log.warn('autonomy.verify: critic call failed, fail-open', { err: String(err) })
    return skip('error')
  }
}
