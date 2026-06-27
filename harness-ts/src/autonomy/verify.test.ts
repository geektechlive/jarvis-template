import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { parseVerificationResponse, verifyGoalOutput, verificationEvent } from './verify'

// ---------------------------------------------------------------------------
// parseVerificationResponse — pure function tests, no I/O
// ---------------------------------------------------------------------------

describe('parseVerificationResponse', () => {
  it('"OK" → genuine pass (not skipped)', () => {
    const result = parseVerificationResponse('OK')
    expect(result).toEqual({ ok: true, issue: '', skipped: false })
  })

  it('"ok" (lowercase) → genuine pass', () => {
    const result = parseVerificationResponse('ok')
    expect(result).toEqual({ ok: true, issue: '', skipped: false })
  })

  it('"OK" with trailing text → genuine pass (starts with OK)', () => {
    const result = parseVerificationResponse('OK, the task was completed')
    expect(result).toEqual({ ok: true, issue: '', skipped: false })
  })

  it('"FAIL: did not send the email" → ok false with issue', () => {
    const result = parseVerificationResponse('FAIL: did not send the email')
    expect(result.ok).toBe(false)
    expect(result.issue).toBe('did not send the email')
  })

  it('"fail: did not send the email" (lowercase) → ok false', () => {
    const result = parseVerificationResponse('fail: did not send the email')
    expect(result.ok).toBe(false)
    expect(result.issue).toBe('did not send the email')
  })

  it('"FAIL" (no colon, no reason) → ok false, empty issue', () => {
    const result = parseVerificationResponse('FAIL')
    expect(result.ok).toBe(false)
    expect(result.issue).toBe('')
  })

  it('empty string → skipped (unparseable), fail-open', () => {
    const result = parseVerificationResponse('')
    expect(result).toEqual({ ok: true, issue: '', skipped: true, reason: 'unparseable' })
  })

  it('whitespace-only → skipped (unparseable), fail-open', () => {
    const result = parseVerificationResponse('   \n  ')
    expect(result).toEqual({ ok: true, issue: '', skipped: true, reason: 'unparseable' })
  })

  it('random prose → skipped (unparseable), fail-open', () => {
    const result = parseVerificationResponse('The agent did a great job and the task seems fine.')
    expect(result).toEqual({ ok: true, issue: '', skipped: true, reason: 'unparseable' })
  })

  it('JSON garbage → skipped (unparseable), fail-open', () => {
    const result = parseVerificationResponse('{"status": "unknown"}')
    expect(result).toEqual({ ok: true, issue: '', skipped: true, reason: 'unparseable' })
  })

  it('issue is capped at 200 chars', () => {
    const longReason = 'x'.repeat(300)
    const result = parseVerificationResponse(`FAIL: ${longReason}`)
    expect(result.ok).toBe(false)
    expect(result.issue.length).toBe(200)
  })

  it('issue exactly 200 chars is not truncated further', () => {
    const exactly200 = 'y'.repeat(200)
    const result = parseVerificationResponse(`FAIL: ${exactly200}`)
    expect(result.ok).toBe(false)
    expect(result.issue.length).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// verifyGoalOutput — behavioural tests using module mocks
// ---------------------------------------------------------------------------

vi.mock('../util/claudeAgent', () => ({
  runClaudeAgent: vi.fn(),
}))

vi.mock('../config', () => ({
  loadBoolFlag: vi.fn(() => true),
  loadModelForRole: vi.fn(() => 'claude-haiku-4-5-20251001'),
  loadTimeoutForRole: vi.fn(() => 30),
}))

// Import mocked modules at module scope (after vi.mock hoisting)
import * as claudeAgentMod from '../util/claudeAgent'
import * as configMod from '../config'

describe('verifyGoalOutput', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default: feature enabled
    vi.mocked(configMod.loadBoolFlag).mockReturnValue(true)
    // Default: critic returns OK
    vi.mocked(claudeAgentMod.runClaudeAgent).mockResolvedValue('OK')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('empty output → skipped (empty_output), model not called', async () => {
    const result = await verifyGoalOutput('Do something', '')
    expect(result).toEqual({ ok: true, issue: '', skipped: true, reason: 'empty_output' })
    expect(claudeAgentMod.runClaudeAgent).not.toHaveBeenCalled()
  })

  it('whitespace-only output → skipped (empty_output), model not called', async () => {
    const result = await verifyGoalOutput('Do something', '   \n  ')
    expect(result).toEqual({ ok: true, issue: '', skipped: true, reason: 'empty_output' })
    expect(claudeAgentMod.runClaudeAgent).not.toHaveBeenCalled()
  })

  it('verification_enabled=false → skipped (disabled), model not called', async () => {
    vi.mocked(configMod.loadBoolFlag).mockReturnValue(false)
    const result = await verifyGoalOutput('Do something', 'some output')
    expect(result).toEqual({ ok: true, issue: '', skipped: true, reason: 'disabled' })
    expect(claudeAgentMod.runClaudeAgent).not.toHaveBeenCalled()
  })

  it('critic returns "OK" → genuine pass (not skipped)', async () => {
    vi.mocked(claudeAgentMod.runClaudeAgent).mockResolvedValue('OK')
    const result = await verifyGoalOutput('Send email', 'Email sent to user@example.com')
    expect(result).toEqual({ ok: true, issue: '', skipped: false })
    expect(claudeAgentMod.runClaudeAgent).toHaveBeenCalledOnce()
  })

  it('returns ok:false with issue when critic returns FAIL', async () => {
    vi.mocked(claudeAgentMod.runClaudeAgent).mockResolvedValue('FAIL: email was not actually sent')
    const result = await verifyGoalOutput('Send email', 'I attempted to send the email.')
    expect(result.ok).toBe(false)
    expect(result.issue).toBe('email was not actually sent')
  })

  it('critic throws → skipped (error), fail-open', async () => {
    vi.mocked(claudeAgentMod.runClaudeAgent).mockRejectedValue(new Error('subprocess crash'))
    const result = await verifyGoalOutput('Do something', 'output text')
    expect(result).toEqual({ ok: true, issue: '', skipped: true, reason: 'error' })
  })

  it('critic returns garbage → skipped (unparseable), fail-open', async () => {
    vi.mocked(claudeAgentMod.runClaudeAgent).mockResolvedValue('{"status":"unknown"}')
    const result = await verifyGoalOutput('Do something', 'output text')
    expect(result).toEqual({ ok: true, issue: '', skipped: true, reason: 'unparseable' })
  })
})

// ---------------------------------------------------------------------------
// verificationEvent — pure telemetry-routing tests (#837)
// ---------------------------------------------------------------------------

describe('verificationEvent', () => {
  const base = { goal_id: 'g1', model: 'claude-haiku-4-5-20251001' }

  it('genuine pass → verification_pass, no reason/issue leaked', () => {
    const r = verificationEvent({ ok: true, issue: '', skipped: false }, base)
    expect(r.event).toBe('verification_pass')
    expect(r.detail).toEqual(base)
  })

  it('genuine fail → verification_fail with issue', () => {
    const r = verificationEvent({ ok: false, issue: 'did not send', skipped: false }, base)
    expect(r.event).toBe('verification_fail')
    expect(r.detail).toEqual({ ...base, issue: 'did not send' })
  })

  it('skipped:disabled → verification_skipped (NOT pass), carries reason', () => {
    const r = verificationEvent({ ok: true, issue: '', skipped: true, reason: 'disabled' }, base)
    expect(r.event).toBe('verification_skipped')
    expect(r.detail).toEqual({ ...base, reason: 'disabled' })
  })

  it('skipped:error → verification_skipped, carries reason', () => {
    const r = verificationEvent({ ok: true, issue: '', skipped: true, reason: 'error' }, base)
    expect(r.event).toBe('verification_skipped')
    expect(r.detail).toEqual({ ...base, reason: 'error' })
  })

  it('a disabled run never produces verification_pass (the #837 regression)', () => {
    const r = verificationEvent({ ok: true, issue: '', skipped: true, reason: 'empty_output' }, base)
    expect(r.event).not.toBe('verification_pass')
  })
})
