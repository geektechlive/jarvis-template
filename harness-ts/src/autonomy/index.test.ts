import { describe, it, expect, vi, beforeEach } from 'vitest'
import { extractConclusion, alreadySurfaced, deliverGoalResult, enable, registerAutonomyJob } from './index'
import type { GoalRow } from '../memory/episodic'

// ---------------------------------------------------------------------------
// extractConclusion
// ---------------------------------------------------------------------------

describe('extractConclusion', () => {
  it('returns empty string for empty input', () => {
    expect(extractConclusion('')).toBe('')
  })

  it('returns empty string for whitespace-only input', () => {
    expect(extractConclusion('   \n  ')).toBe('')
  })

  it('returns the final paragraph, not the chain-of-thought head', () => {
    const input = [
      'Let me think about this.',
      'I have the tools.',
      '',
      'Two unfiled clusters surfaced to your inbox: ion-ops and NASA.',
    ].join('\n')
    const result = extractConclusion(input)
    expect(result).toBe('Two unfiled clusters surfaced to your inbox: ion-ops and NASA.')
    expect(result).not.toContain('Let me think')
    expect(result).not.toContain('I have the tools')
  })

  it('collapses newlines within a paragraph to spaces', () => {
    // Final paragraph 'Final answer:\nIt works.' is ~22 chars — under the 40-char threshold,
    // so the helper merges it with the preceding paragraph. Both are joined and newlines
    // collapsed to spaces.
    const input = 'Line one\nLine two\n\nFinal answer:\nIt works.'
    const result = extractConclusion(input)
    expect(result).toBe('Line one Line two Final answer: It works.')
    expect(result).not.toMatch(/\n/)
  })

  it('merges last two paragraphs when final paragraph is very short (<40 chars)', () => {
    const input = 'Here is the full analysis of the situation.\n\nDone.'
    const result = extractConclusion(input)
    // 'Done.' is 5 chars — under threshold; should include preceding paragraph
    expect(result).toContain('Here is the full analysis')
    expect(result).toContain('Done.')
  })

  it('keeps only the final paragraph when it is long enough (>=40 chars)', () => {
    const input = 'First paragraph with some content.\n\nThis is the final conclusion paragraph that is definitely long enough.'
    const result = extractConclusion(input)
    expect(result).toBe('This is the final conclusion paragraph that is definitely long enough.')
    expect(result).not.toContain('First paragraph')
  })

  it('caps output at 300 characters', () => {
    const longText = 'A'.repeat(400)
    const result = extractConclusion(longText)
    expect(result.length).toBe(300)
  })

  it('handles single-paragraph input (no blank lines)', () => {
    const input = 'Just one paragraph here with no blank lines at all.'
    expect(extractConclusion(input)).toBe('Just one paragraph here with no blank lines at all.')
  })
})

// ---------------------------------------------------------------------------
// alreadySurfaced — stubbing eventsSince via vi.mock
// ---------------------------------------------------------------------------

vi.mock('../memory/episodic', async (importOriginal) => {
  const original = await importOriginal<typeof import('../memory/episodic')>()
  return {
    ...original,
    eventsSince: vi.fn(),
    logEvent: vi.fn(),
    // Additional stubs for runGoal path
    goalsDueNow: vi.fn(),
    goalRunsToday: vi.fn(),
    lastMessageTs: vi.fn(),
    logGoalRun: vi.fn(),
    updateGoalRun: vi.fn(),
    markGoalSucceeded: vi.fn(),
    markGoalFailed: vi.fn(),
    logExternalAudit: vi.fn(),
    updateExternalAudit: vi.fn(),
  }
})

// Boundary mocks for deliverGoalResult — keep the unit free of DB/network/LLM.
vi.mock('../discord/webhook', () => ({
  postLongEmbed: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../config', async (importOriginal) => {
  const original = await importOriginal<typeof import('../config')>()
  return {
    ...original,
    loadModelForRole: vi.fn().mockReturnValue('claude-haiku-4-5-20251001'),
    loadDiscordConfig: vi.fn().mockReturnValue({
      proactive_webhook_keychain_service: 'jarvis-discord-proactive-webhook',
    }),
  }
})
vi.mock('./verify', () => ({
  verifyGoalOutput: vi.fn(),
  verificationEvent: vi.fn().mockReturnValue({ event: 'verification_pass', detail: {} }),
}))

// Mocks for runGoal CLI-fallback path tests
vi.mock('../staff/dispatch', () => ({
  dispatchStaff: vi.fn(),
}))
vi.mock('../util/ionPrompt', () => ({
  runIonPromptCapture: vi.fn(),
}))
vi.mock('../scheduler/helpers', () => ({
  loadRoutinesConfig: vi.fn().mockReturnValue({}),
}))
vi.mock('../proactive/notify', () => ({
  postProactive: vi.fn().mockResolvedValue(undefined),
}))

// Import after mocks are set up
import * as episodic from '../memory/episodic'
import { postLongEmbed } from '../discord/webhook'
import { verifyGoalOutput } from './verify'
import { dispatchStaff } from '../staff/dispatch'
import { runIonPromptCapture } from '../util/ionPrompt'

describe('alreadySurfaced', () => {
  beforeEach(() => {
    vi.mocked(episodic.eventsSince).mockReset()
  })

  it('returns false when no inbox_batch events exist after startEventId', () => {
    vi.mocked(episodic.eventsSince).mockReturnValue([])
    expect(alreadySurfaced(42)).toBe(false)
  })

  it('returns true when an event with reason "urgent" is found', () => {
    vi.mocked(episodic.eventsSince).mockReturnValue([
      { id: 43, session: 'inbox', event: 'inbox_batch', detail: { reason: 'urgent' }, ts: '' },
    ])
    expect(alreadySurfaced(42)).toBe(true)
  })

  it('returns true when an event with reason "staff observer" is found', () => {
    vi.mocked(episodic.eventsSince).mockReturnValue([
      { id: 43, session: 'inbox', event: 'inbox_batch', detail: { reason: 'staff observer' }, ts: '' },
    ])
    expect(alreadySurfaced(42)).toBe(true)
  })

  it('returns false when events exist but reason does not match', () => {
    vi.mocked(episodic.eventsSince).mockReturnValue([
      { id: 43, session: 'inbox', event: 'inbox_batch', detail: { reason: 'other' }, ts: '' },
    ])
    expect(alreadySurfaced(42)).toBe(false)
  })

  it('returns false when detail has no reason field', () => {
    vi.mocked(episodic.eventsSince).mockReturnValue([
      { id: 43, session: 'inbox', event: 'inbox_batch', detail: {}, ts: '' },
    ])
    expect(alreadySurfaced(42)).toBe(false)
  })

  it('returns false when detail is null', () => {
    vi.mocked(episodic.eventsSince).mockReturnValue([
      { id: 43, session: 'inbox', event: 'inbox_batch', detail: null, ts: '' },
    ])
    expect(alreadySurfaced(42)).toBe(false)
  })

  it('returns false when eventsSince throws', () => {
    vi.mocked(episodic.eventsSince).mockImplementation(() => { throw new Error('db error') })
    expect(alreadySurfaced(42)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// maxRunMs cap math (preserved from original test)
// ---------------------------------------------------------------------------

describe('autonomy maxRunMs cap math', () => {
  it('caps at _maxRunMs when budget exceeds it', () => {
    const budgetMinutes = 10
    const maxRunMs = 180_000
    const result = Math.min(budgetMinutes * 60_000, maxRunMs, 240_000)
    expect(result).toBe(180_000)
  })

  it('caps at budgetMinutes * 60_000 when budget is smallest', () => {
    const budgetMinutes = 1
    const maxRunMs = 180_000
    const result = Math.min(budgetMinutes * 60_000, maxRunMs, 240_000)
    expect(result).toBe(60_000)
  })

  it('caps at 240_000 hard ceiling regardless of _maxRunMs when _maxRunMs exceeds ceiling', () => {
    const budgetMinutes = 10
    const maxRunMs = 300_000
    const result = Math.min(budgetMinutes * 60_000, maxRunMs, 240_000)
    expect(result).toBe(240_000)
  })

  it('caps at _maxRunMs when it is smaller than both budget and 240_000', () => {
    const budgetMinutes = 5
    const maxRunMs = 120_000
    const result = Math.min(budgetMinutes * 60_000, maxRunMs, 240_000)
    expect(result).toBe(120_000)
  })
})

// ---------------------------------------------------------------------------
// deliverGoalResult — full-report Discord delivery (no truncation, #16 fix)
// ---------------------------------------------------------------------------

describe('deliverGoalResult', () => {
  beforeEach(() => {
    vi.mocked(postLongEmbed).mockClear()
    vi.mocked(verifyGoalOutput).mockReset()
    // No prior inbox surface → completion post proceeds.
    vi.mocked(episodic.eventsSince).mockReturnValue([])
  })

  it('posts the FULL result text to Discord, not a 300-char summary', async () => {
    vi.mocked(verifyGoalOutput).mockResolvedValue({ ok: true, skipped: false, issue: '' })
    // A structured, multi-section report well over the old 300-char delivery cap.
    const fullReport = [
      '**iOS Build System Audit**',
      'A'.repeat(500),
      '**Flags**',
      'B'.repeat(500),
    ].join('\n\n')

    await deliverGoalResult(16, 'repo_steward', 'audit iOS build', fullReport, 1)

    expect(postLongEmbed).toHaveBeenCalledOnce()
    const [text, title, , webhookService] = vi.mocked(postLongEmbed).mock.calls[0]!
    expect(text).toBe(fullReport)
    expect(text.length).toBeGreaterThan(300)
    expect(title).toContain('goal #16')
    expect(webhookService).toBe('jarvis-discord-proactive-webhook')
  })

  it('prepends [unverified - ...] to the full text when verification fails', async () => {
    vi.mocked(verifyGoalOutput).mockResolvedValue({
      ok: false,
      skipped: false,
      issue: 'truncated mid-sentence',
    })

    await deliverGoalResult(15, 'wellness_coach', 'weekly wellness', 'Observation only.', 1)

    const [text] = vi.mocked(postLongEmbed).mock.calls[0]!
    expect(text.startsWith('[unverified - truncated mid-sentence]\n')).toBe(true)
    expect(text).toContain('Observation only.')
  })

  it('does not annotate when verification is skipped', async () => {
    vi.mocked(verifyGoalOutput).mockResolvedValue({ ok: false, skipped: true, issue: '' })

    await deliverGoalResult(14, 'chief_of_communications', 'birthdays', 'No upcoming birthdays.', 1)

    const [text] = vi.mocked(postLongEmbed).mock.calls[0]!
    expect(text).toBe('No upcoming birthdays.')
  })

  it('posts full result text for CLI fallback path results (2000–8000 chars)', async () => {
    // Regression guard for the CLI fallback path that previously sliced at 2000.
    // Any result between 2000 and 8000 chars was silently truncated before reaching Discord.
    vi.mocked(verifyGoalOutput).mockResolvedValue({ ok: true, skipped: false, issue: '' })
    const cliFallbackResult = 'R'.repeat(5000) // 5000 chars: above old 2000 cap, within new 8000 cap
    await deliverGoalResult(17, 'repo_steward', 'audit', cliFallbackResult, 1)
    expect(postLongEmbed).toHaveBeenCalledOnce()
    const [text] = vi.mocked(postLongEmbed).mock.calls[0]!
    expect(text).toBe(cliFallbackResult)
    expect(text.length).toBe(5000)
  })

  it('suppresses the Discord post when already surfaced to inbox', async () => {
    vi.mocked(verifyGoalOutput).mockResolvedValue({ ok: true, skipped: false, issue: '' })
    vi.mocked(episodic.eventsSince).mockReturnValue([
      { id: 2, session: 'inbox', event: 'inbox_batch', detail: { reason: 'urgent' }, ts: '' },
    ])

    await deliverGoalResult(16, 'repo_steward', 'audit', 'report', 1)

    expect(postLongEmbed).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// runGoal CLI-fallback path — invoked via registerAutonomyJob handler (#860)
// ---------------------------------------------------------------------------
// runGoal is not exported; it is reached by capturing the handler registered
// through registerAutonomyJob → ion.schedule.interval, then calling it with a
// fake ctx that makes dispatchStaff throw 'dispatch not available'.
// ---------------------------------------------------------------------------

describe('runGoal CLI-fallback path', () => {
  const GOAL_ID = 99

  const fakeGoal: GoalRow = {
    id: GOAL_ID,
    intent: 'check system health',
    cadence: 'daily',
    owner_staff_id: 'repo_steward',
    status: 'active',
    goal_type: 'read',
    budget_tool_calls: 10,
    budget_minutes: 5,
    last_run_at: null,
    next_run_at: null,
    created_at: new Date().toISOString(),
  }

  // Minimal IonContext stub — only the fields touched by runGoal's dispatch path
  // and deliverGoalResult's interceptToOtherSessions (which is fail-safe).
  // Cast to `unknown` first so TypeScript accepts the partial shape.
  const fakeCtx = {
    sessionKey: 'test-session',
    sessions: {
      list: vi.fn().mockResolvedValue([]),
    },
    intercept: vi.fn().mockResolvedValue(undefined),
  } as unknown

  // Capture the handler registered by registerAutonomyJob.
  function captureHandler(): (ctx: unknown) => Promise<void> {
    const mockIon = {
      schedule: {
        interval: vi.fn().mockResolvedValue({}),
      },
    } as unknown as Parameters<typeof registerAutonomyJob>[0]
    registerAutonomyJob(mockIon)
    const call = vi.mocked(mockIon.schedule.interval).mock.calls[0]
    if (!call) throw new Error('registerAutonomyJob did not call schedule.interval')
    return (call[0] as { handler: (ctx: unknown) => Promise<void> }).handler
  }

  beforeEach(() => {
    vi.mocked(postLongEmbed).mockClear()
    vi.mocked(verifyGoalOutput).mockReset()
    vi.mocked(episodic.eventsSince).mockReturnValue([])
    vi.mocked(episodic.logEvent).mockReturnValue(1)

    // Episodic guards that tick() checks before calling runGoal
    vi.mocked(episodic.goalsDueNow as ReturnType<typeof vi.fn>).mockReturnValue([fakeGoal])
    vi.mocked(episodic.goalRunsToday as ReturnType<typeof vi.fn>).mockReturnValue(0)
    vi.mocked(episodic.lastMessageTs as ReturnType<typeof vi.fn>).mockReturnValue(null) // null → isIdle() = true

    // Episodic writes — stub so no SQLite access happens
    vi.mocked(episodic.logGoalRun as ReturnType<typeof vi.fn>).mockReturnValue(1)
    vi.mocked(episodic.updateGoalRun as ReturnType<typeof vi.fn>).mockReturnValue(undefined)
    vi.mocked(episodic.markGoalSucceeded as ReturnType<typeof vi.fn>).mockReturnValue(undefined)
    vi.mocked(episodic.markGoalFailed as ReturnType<typeof vi.fn>).mockReturnValue(0)
  })

  it('delivers full stdout to Discord when dispatchStaff throws dispatch not available', async () => {
    vi.mocked(dispatchStaff).mockRejectedValue(new Error('dispatch not available'))
    const cliFallbackText = 'R'.repeat(5000)
    vi.mocked(runIonPromptCapture).mockResolvedValue({
      stdout: cliFallbackText,
      status: 0,
      error: undefined,
    })
    vi.mocked(verifyGoalOutput).mockResolvedValue({ ok: true, skipped: false, issue: '' })

    enable()
    const handler = captureHandler()
    await handler(fakeCtx)

    expect(runIonPromptCapture).toHaveBeenCalledOnce()
    expect(postLongEmbed).toHaveBeenCalledOnce()
    const [text] = vi.mocked(postLongEmbed).mock.calls[0]!
    expect(text).toBe(cliFallbackText)
    expect(text.length).toBe(5000)
  })

  it('calls markGoalSucceeded after CLI fallback completes successfully', async () => {
    vi.mocked(dispatchStaff).mockRejectedValue(new Error('dispatch not available'))
    vi.mocked(runIonPromptCapture).mockResolvedValue({
      stdout: 'Goal output text.',
      status: 0,
      error: undefined,
    })
    vi.mocked(verifyGoalOutput).mockResolvedValue({ ok: true, skipped: false, issue: '' })

    enable()
    const handler = captureHandler()
    await handler(fakeCtx)

    expect(episodic.markGoalSucceeded).toHaveBeenCalledWith(GOAL_ID, expect.anything())
  })

  it('does not truncate CLI fallback stdout below the 8000-char cap', async () => {
    // Regression: old path sliced at 2000 before calling deliverGoalResult.
    // Verify the full slice(0, 8000) is what reaches Discord — not an earlier cap.
    vi.mocked(dispatchStaff).mockRejectedValue(new Error('dispatch not available'))
    const longOutput = 'Z'.repeat(7500) // 7500 chars: above old 2000 cap, within 8000
    vi.mocked(runIonPromptCapture).mockResolvedValue({
      stdout: longOutput,
      status: 0,
      error: undefined,
    })
    vi.mocked(verifyGoalOutput).mockResolvedValue({ ok: true, skipped: false, issue: '' })

    enable()
    const handler = captureHandler()
    await handler(fakeCtx)

    const [text] = vi.mocked(postLongEmbed).mock.calls[0]!
    expect(text).toBe(longOutput)
    expect(text.length).toBe(7500)
  })
})
