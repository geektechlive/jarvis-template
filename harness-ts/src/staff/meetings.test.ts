import { describe, it, expect } from 'vitest'
import { trimRoundForCarryover } from './meetings'
import type { RoundResponse } from './meetings'

// Constants (mirror the module internals — not exported, so tested behaviorally)
const PREVIOUS_ROUND_CHAR_BUDGET = 50_000
const PER_AGENT_TRIM_CHARS = 8_000

// ── Helpers ──

function resp(agent: string, response: string, isError = false): RoundResponse {
  return {
    agent,
    agentLabel: agent.charAt(0).toUpperCase() + agent.slice(1),
    response,
    isError,
  }
}

// ── Tests ──

describe('trimRoundForCarryover', () => {
  it('returns empty string for empty input', () => {
    expect(trimRoundForCarryover([])).toBe('')
  })

  it('passes through under-budget responses unchanged', () => {
    const responses = [
      resp('alice', 'short response'),
      resp('bob', 'another short one'),
    ]
    const result = trimRoundForCarryover(responses)
    expect(result).toBe('**Alice**: short response\n\n**Bob**: another short one')
    expect(result.includes('[trimmed')).toBe(false)
  })

  it('single response under budget is formatted correctly', () => {
    const responses = [resp('alice', 'hello world')]
    const result = trimRoundForCarryover(responses)
    expect(result).toBe('**Alice**: hello world')
  })

  it('includes agent label in formatted output', () => {
    const responses = [resp('eng-lead', 'my analysis')]
    const result = trimRoundForCarryover(responses)
    expect(result).toContain('**Eng-lead**:')
    expect(result).toContain('my analysis')
  })

  // ── Pass 2: per-agent trimming ──

  it('trims oversized individual responses when total exceeds budget', () => {
    // One very large response that pushes over the budget; the other is small.
    const bigResponse = 'x'.repeat(60_000)
    const responses = [
      resp('alice', bigResponse),
      resp('bob', 'tiny'),
    ]
    const result = trimRoundForCarryover(responses)
    expect(result).toContain('[trimmed for carryover]')
    expect(result.length).toBeLessThan(bigResponse.length)
    // Bob's short response should not be trimmed
    expect(result).toContain('**Bob**: tiny')
  })

  it('trimmed response is capped near PER_AGENT_TRIM_CHARS', () => {
    const bigResponse = 'y'.repeat(60_000)
    const responses = [resp('alice', bigResponse)]
    const result = trimRoundForCarryover(responses)
    // Should contain the trim sentinel
    expect(result).toContain('[trimmed for carryover]')
    // Trimmed body: PER_AGENT_TRIM_CHARS + label overhead + sentinel text
    // Must be well below the original 60k
    expect(result.length).toBeLessThan(PER_AGENT_TRIM_CHARS + 200)
  })

  it('does not trim responses already within per-agent budget', () => {
    // Each response is under PER_AGENT_TRIM_CHARS (8000). If combined they
    // exceed PREVIOUS_ROUND_CHAR_BUDGET, but individually they should not
    // get the trim sentinel.
    const mid = 'z'.repeat(7_000)
    // Need enough agents so the total exceeds 50k. 7000 * 8 = 56000 > 50000.
    const responses = Array.from({ length: 8 }, (_, i) => resp(`agent${i}`, mid))
    const result = trimRoundForCarryover(responses)
    // Second pass: none of the individual responses is over 8000, so no sentinel
    // However the total is still over budget, so pass 3 (drop-oldest) engages.
    // All remaining entries should not have the trim sentinel.
    expect(result).not.toContain('[trimmed for carryover]')
  })

  // ── Pass 3: drop-oldest ──

  it('drops oldest agents when trimmed total still exceeds budget', () => {
    // Each response is over PER_AGENT_TRIM_CHARS so pass 2 trims each to ~8036.
    // With 7 agents: 7 * 8036 ≈ 56252 > 50000 → pass 3 drops oldest.
    const bigBody = 'a'.repeat(9_000) // > 8000 → trimmed to 8000 + sentinel
    const responses = Array.from({ length: 7 }, (_, i) => resp(`agent${i}`, bigBody))

    const result = trimRoundForCarryover(responses)

    // Final result must fit within budget
    expect(result.length).toBeLessThanOrEqual(PREVIOUS_ROUND_CHAR_BUDGET)
    // The last/newest agent must be present
    expect(result).toContain('**Agent6**:')
    // The first/oldest agent must be absent
    expect(result).not.toContain('**Agent0**:')
  })

  it('keeps at least one entry even if it exceeds budget', () => {
    // A single response so large that even after trimming it exceeds the budget.
    // The while loop stops at queue.length === 1, so the last entry is preserved.
    const responses = [resp('alone', 'x'.repeat(60_000))]
    const result = trimRoundForCarryover(responses)
    expect(result).toContain('**Alone**:')
    expect(result.length).toBeGreaterThan(0)
  })

  it('last agent always survives drop-oldest pass', () => {
    const bigBody = 'b'.repeat(9_000)
    const responses = Array.from({ length: 10 }, (_, i) => resp(`agent${i}`, bigBody))
    const result = trimRoundForCarryover(responses)
    expect(result).toContain('**Agent9**:')
  })

  it('handles isError flag transparently (does not affect trimming logic)', () => {
    const responses = [
      resp('alice', 'short fine response', false),
      resp('bob', '[Error: timeout]', true),
    ]
    const result = trimRoundForCarryover(responses)
    expect(result).toContain('**Alice**: short fine response')
    expect(result).toContain('**Bob**: [Error: timeout]')
  })

  it('exact-budget responses pass through without trim', () => {
    // Construct a response that will format to exactly PREVIOUS_ROUND_CHAR_BUDGET chars.
    // Format: "**Alice**: " + body = 11 + body.length chars
    const labelPrefix = '**Alice**: '
    const body = 'c'.repeat(PREVIOUS_ROUND_CHAR_BUDGET - labelPrefix.length)
    const responses = [resp('alice', body)]
    const result = trimRoundForCarryover(responses)
    expect(result.length).toBe(PREVIOUS_ROUND_CHAR_BUDGET)
    expect(result).not.toContain('[trimmed')
  })

  it('one-char-over-budget response triggers pass 2', () => {
    const labelPrefix = '**Alice**: '
    const body = 'c'.repeat(PREVIOUS_ROUND_CHAR_BUDGET - labelPrefix.length + 1)
    const responses = [resp('alice', body)]
    const result = trimRoundForCarryover(responses)
    // body > PER_AGENT_TRIM_CHARS (50001 - 11 = 49990 > 8000), so sentinel appears
    expect(result).toContain('[trimmed for carryover]')
  })
})
