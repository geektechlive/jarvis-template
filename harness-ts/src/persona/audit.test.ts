import { describe, it, expect } from 'vitest'
import { auditReply, bannedTokenEnforcement } from './audit'

describe('auditReply', () => {
  it('passes a clean reply', () => {
    const r = auditReply('Yes, the meeting is at three.')
    expect(r.passed).toBe(true)
    expect(r.violations).toEqual([])
  })

  it('catches em dash', () => {
    const r = auditReply('The plan — as agreed — is fine.')
    expect(r.passed).toBe(false)
    expect(r.violations.some((v) => v.includes('—'))).toBe(true)
  })

  it('catches exclamation marks', () => {
    const r = auditReply('Done!')
    expect(r.passed).toBe(false)
    expect(r.violations.some((v) => v.includes('!'))).toBe(true)
  })

  it('catches "certainly" (case-insensitive)', () => {
    const r = auditReply("Certainly, I'll handle it.")
    expect(r.passed).toBe(false)
    expect(r.violations.some((v) => v.toLowerCase().includes('certainly'))).toBe(true)
  })

  it('catches "of course"', () => {
    expect(auditReply('Of course.').passed).toBe(false)
  })

  it('catches "absolutely" mid-sentence', () => {
    expect(auditReply('That is absolutely correct.').passed).toBe(false)
  })

  it('reports multiple violations in one reply', () => {
    const r = auditReply('Certainly! Of course.')
    expect(r.passed).toBe(false)
    expect(r.violations.length).toBeGreaterThanOrEqual(3)
  })
})

describe('bannedTokenEnforcement', () => {
  const addendum = bannedTokenEnforcement()

  it('includes em dash reference in the system addendum', () => {
    expect(addendum).toContain('U+2014')
  })

  it('includes exclamation mark', () => {
    expect(addendum).toContain('!')
  })

  it('includes "absolutely" as a banned phrase', () => {
    expect(addendum).toContain('absolutely')
  })

  it('declares Hard constraints heading', () => {
    expect(addendum).toContain('Hard constraints')
  })
})
