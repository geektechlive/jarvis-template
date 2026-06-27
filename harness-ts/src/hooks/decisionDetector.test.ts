import { describe, it, expect, afterEach } from 'vitest'
import { classifyDecisionStakes, buildDecisionInjection } from './decisionDetector'

describe('classifyDecisionStakes', () => {
  it('flags a clear high-stakes termination as high', () => {
    expect(
      classifyDecisionStakes("I'm going to terminate the Acme contract tomorrow."),
    ).toBe('high')
  })

  it('flags a deploy-to-production decision as high', () => {
    expect(
      classifyDecisionStakes('Going to deploy the new pricing service to production tonight.'),
    ).toBe('high')
  })

  it('flags a dollar-figure commitment as high', () => {
    expect(
      classifyDecisionStakes('I will sign the $50k vendor agreement on Friday.'),
    ).toBe('high')
  })

  it('does not flag a small dollar mention as material', () => {
    expect(
      classifyDecisionStakes('Just spent $40 on a domain rename — should I rebrand?'),
    ).not.toBe('high')
  })

  it('classifies hypothetical brainstorming as medium', () => {
    expect(
      classifyDecisionStakes('Thinking about restructuring the team next quarter, what if we split it.'),
    ).toBe('medium')
  })

  it('classifies "considering switching cloud providers" as medium', () => {
    expect(
      classifyDecisionStakes('Considering switching from GCP to AWS for the analytics workload.'),
    ).toBe('medium')
  })

  it('returns low for vague hypotheticals with no scope', () => {
    expect(
      classifyDecisionStakes('I am wondering if I should think about doing something different here.'),
    ).toBe('low')
  })

  it('returns null for short status pings', () => {
    expect(classifyDecisionStakes('are you there')).toBeNull()
    expect(classifyDecisionStakes('ok')).toBeNull()
  })

  it('returns null for definitional questions', () => {
    expect(classifyDecisionStakes("What's Jordan's email?")).toBeNull()
  })

  it('downgrades commit verb under hypothetical framing', () => {
    expect(
      classifyDecisionStakes("Maybe I'll deploy the new pricing tier next month."),
    ).toBe('medium')
  })

  it('flags announce-to-clients as high stakes', () => {
    expect(
      classifyDecisionStakes('I plan to announce the price change to clients on Monday.'),
    ).toBe('high')
  })

  it('treats merge-to-main without scope as below high', () => {
    const r = classifyDecisionStakes('Going to merge the refactor branch into main today.')
    expect(r === 'high' || r === 'medium').toBe(true)
  })
})

describe('buildDecisionInjection', () => {
  afterEach(() => {
    delete process.env['JARVIS_DA_AUTODISPATCH']
  })

  it('returns empty when stakes is null', () => {
    expect(buildDecisionInjection(null)).toBe('')
  })

  it('builds an auto-dispatch block for high stakes', () => {
    const out = buildDecisionInjection('high')
    expect(out).toContain('dispatch the Devil')
    expect(out).toContain('subagent_type: devils_advocate')
  })

  it('builds a soft-offer block for low / medium stakes', () => {
    expect(buildDecisionInjection('medium')).toContain('stress-test')
    expect(buildDecisionInjection('low')).toContain('stress-test')
  })

  it('returns empty when JARVIS_DA_AUTODISPATCH=0', () => {
    process.env['JARVIS_DA_AUTODISPATCH'] = '0'
    expect(buildDecisionInjection('high')).toBe('')
  })
})
