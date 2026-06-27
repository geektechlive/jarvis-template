import { describe, it, expect } from 'vitest'
import { classifyGoalType } from './index'

describe('classifyGoalType', () => {
  it('classifies external keywords as external', () => {
    expect(classifyGoalType('send email to Alex')).toBe('external')
    expect(classifyGoalType('push commit to main')).toBe('external')
    expect(classifyGoalType('deploy the service')).toBe('external')
    expect(classifyGoalType('send slack message to team')).toBe('external')
    expect(classifyGoalType('post to the webhook endpoint')).toBe('external')
  })

  it('classifies read keywords as read', () => {
    expect(classifyGoalType('check calendar for tomorrow')).toBe('read')
    expect(classifyGoalType('search for recent news')).toBe('read')
    expect(classifyGoalType('summarize the weekly report')).toBe('read')
    expect(classifyGoalType('find all open issues')).toBe('read')
    expect(classifyGoalType('recall my preferences')).toBe('read')
    expect(classifyGoalType('list active goals')).toBe('read')
    expect(classifyGoalType('monitor memory usage')).toBe('read')
  })

  it('classifies non-matching intent as write', () => {
    expect(classifyGoalType('update the GOALS.md file')).toBe('write')
    expect(classifyGoalType('refactor the scheduler module')).toBe('write')
    expect(classifyGoalType('save new preferences')).toBe('write')
  })

  it('external takes priority over read when both match', () => {
    // "notify" is external; "check" might appear too but external wins
    expect(classifyGoalType('notify and check status')).toBe('external')
  })

  it('is case-insensitive', () => {
    expect(classifyGoalType('SEND EMAIL to boss')).toBe('external')
    expect(classifyGoalType('CHECK the calendar')).toBe('read')
  })
})
