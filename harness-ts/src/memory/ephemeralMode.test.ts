import { describe, it, expect, beforeEach } from 'vitest'
import {
  setEphemeralGlobalEnabled,
  isEphemeralGlobalEnabled,
  setEphemeralMode,
  isEphemeralMode,
} from './ephemeralMode'

beforeEach(() => {
  setEphemeralGlobalEnabled(false)
  setEphemeralMode(false)
})

describe('ephemeralMode', () => {
  it('isEphemeralMode returns false by default', () => {
    expect(isEphemeralMode()).toBe(false)
  })

  it('setEphemeralMode/isEphemeralMode toggles active flag', () => {
    setEphemeralGlobalEnabled(true)
    setEphemeralMode(true)
    expect(isEphemeralMode()).toBe(true)
    setEphemeralMode(false)
    expect(isEphemeralMode()).toBe(false)
  })

  it('isEphemeralGlobalEnabled reflects global kill-switch', () => {
    expect(isEphemeralGlobalEnabled()).toBe(false)
    setEphemeralGlobalEnabled(true)
    expect(isEphemeralGlobalEnabled()).toBe(true)
  })

  it('global kill-switch: isEphemeralMode returns false even when _active is true if _enabled is false', () => {
    setEphemeralGlobalEnabled(false)
    setEphemeralMode(true)
    expect(isEphemeralMode()).toBe(false)
  })

  it('isEphemeralMode returns true only when both _enabled and _active are true', () => {
    setEphemeralGlobalEnabled(true)
    setEphemeralMode(false)
    expect(isEphemeralMode()).toBe(false)

    setEphemeralGlobalEnabled(false)
    setEphemeralMode(true)
    expect(isEphemeralMode()).toBe(false)

    setEphemeralGlobalEnabled(true)
    setEphemeralMode(true)
    expect(isEphemeralMode()).toBe(true)
  })
})
