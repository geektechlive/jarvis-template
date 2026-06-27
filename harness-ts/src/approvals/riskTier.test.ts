import { describe, it, expect } from 'vitest'
import { classifyRiskTier } from './riskTier'

describe('classifyRiskTier', () => {
  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  it('returns risky for an empty list (defensive)', () => {
    expect(classifyRiskTier([])).toBe('risky')
  })

  // ---------------------------------------------------------------------------
  // Safe cases
  // ---------------------------------------------------------------------------

  it('returns safe for a single harness-ts/src file', () => {
    expect(classifyRiskTier(['harness-ts/src/memory/recall.ts'])).toBe('safe')
  })

  it('returns safe for multiple harness-ts/src files with no risky matches', () => {
    expect(classifyRiskTier([
      'harness-ts/src/clarify/index.ts',
      'harness-ts/src/inbox/index.ts',
      'harness-ts/src/triage/index.ts',
    ])).toBe('safe')
  })

  it('returns safe for a file in a non-risky subdirectory', () => {
    expect(classifyRiskTier(['harness-ts/src/tools/calendar.ts'])).toBe('safe')
  })

  // ---------------------------------------------------------------------------
  // Risky: not under harness-ts/src/
  // ---------------------------------------------------------------------------

  it('returns risky when file is outside harness-ts/src/', () => {
    expect(classifyRiskTier(['scripts/morning.sh'])).toBe('risky')
  })

  it('returns risky when one file is outside harness-ts/src/ mixed with safe ones', () => {
    expect(classifyRiskTier([
      'harness-ts/src/scheduler/index.ts',
      'Makefile',
    ])).toBe('risky')
  })

  // ---------------------------------------------------------------------------
  // Risky: harness/identity/**
  // ---------------------------------------------------------------------------

  it('returns risky for harness/identity/ files', () => {
    expect(classifyRiskTier(['harness/identity/SOUL.md'])).toBe('risky')
    expect(classifyRiskTier(['harness/identity/BEHAVIOR.md'])).toBe('risky')
  })

  // ---------------------------------------------------------------------------
  // Risky: harness/config/**
  // ---------------------------------------------------------------------------

  it('returns risky for harness/config/ files', () => {
    expect(classifyRiskTier(['harness/config/staff.yaml'])).toBe('risky')
    expect(classifyRiskTier(['harness/config/models.yaml'])).toBe('risky')
  })

  // ---------------------------------------------------------------------------
  // Risky: .plist suffix
  // ---------------------------------------------------------------------------

  it('returns risky for .plist files', () => {
    expect(classifyRiskTier(['harness-ts/src/com.example.jarvis.plist'])).toBe('risky')
    expect(classifyRiskTier(['launchd/com.example.foo.plist'])).toBe('risky')
  })

  // ---------------------------------------------------------------------------
  // Risky: self-referential harness-ts paths
  // ---------------------------------------------------------------------------

  it('returns risky for harness-ts/src/patrol/ files', () => {
    expect(classifyRiskTier(['harness-ts/src/patrol/resolver.ts'])).toBe('risky')
  })

  it('returns risky for harness-ts/src/improve/ files', () => {
    expect(classifyRiskTier(['harness-ts/src/improve/index.ts'])).toBe('risky')
  })

  it('returns risky for harness-ts/src/approvals/ files', () => {
    expect(classifyRiskTier(['harness-ts/src/approvals/index.ts'])).toBe('risky')
  })

  it('returns risky for harness-ts/src/discord/ files', () => {
    expect(classifyRiskTier(['harness-ts/src/discord/digest.ts'])).toBe('risky')
  })

  it('returns risky for harness-ts/src/scheduler/ files', () => {
    expect(classifyRiskTier(['harness-ts/src/scheduler/index.ts'])).toBe('risky')
  })

  it('returns risky for harness-ts/src/learning/ files', () => {
    expect(classifyRiskTier(['harness-ts/src/learning/index.ts'])).toBe('risky')
  })

  it('returns risky for harness-ts/src/hooks/ files', () => {
    expect(classifyRiskTier(['harness-ts/src/hooks/promptPipeline.ts'])).toBe('risky')
  })

  // ---------------------------------------------------------------------------
  // Mixed: single risky file among otherwise-safe files
  // ---------------------------------------------------------------------------

  it('returns risky when one risky file is mixed with safe files', () => {
    expect(classifyRiskTier([
      'harness-ts/src/scheduler/index.ts',
      'harness-ts/src/inbox/index.ts',
      'harness-ts/src/patrol/resolver.ts',   // risky
    ])).toBe('risky')
  })

  it('returns risky when one identity file is mixed with safe files', () => {
    expect(classifyRiskTier([
      'harness-ts/src/learning/index.ts',
      'harness/identity/GOALS.md',
    ])).toBe('risky')
  })
})
