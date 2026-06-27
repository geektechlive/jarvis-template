import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { join } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

// AGENT_DATA_DIR must be set before episodic is imported because DB_PATH is
// resolved at module load time (not lazily). Use a dynamic import inside
// beforeAll to guarantee the env var is set first.
const tmpDir = join(tmpdir(), `episodic-pi-test-${Date.now()}-${Math.trunc(Math.random() * 1e6)}`)

let episodic: typeof import('./episodic')

beforeAll(async () => {
  mkdirSync(tmpDir, { recursive: true })
  process.env['AGENT_DATA_DIR'] = tmpDir
  episodic = await import('./episodic')
})

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
  delete process.env['AGENT_DATA_DIR']
})

beforeEach(() => {
  // Reset the pending_improve flag between tests by consuming it.
  episodic.clearPendingImprove()
})

describe('hasPendingImprove / setPendingImprove / clearPendingImprove', () => {
  it('hasPendingImprove returns false when no flag is set', () => {
    expect(episodic.hasPendingImprove()).toBe(false)
  })

  it('hasPendingImprove returns true after setPendingImprove', () => {
    episodic.setPendingImprove()
    expect(episodic.hasPendingImprove()).toBe(true)
  })

  it('setPendingImprove is idempotent -- two calls still leave exactly one active row', () => {
    episodic.setPendingImprove()
    episodic.setPendingImprove()
    // After calling twice the flag should be set but only as one logical unit.
    // clearPendingImprove should resolve it.
    expect(episodic.hasPendingImprove()).toBe(true)
    episodic.clearPendingImprove()
    expect(episodic.hasPendingImprove()).toBe(false)
  })

  it('clearPendingImprove causes hasPendingImprove to return false', () => {
    episodic.setPendingImprove()
    expect(episodic.hasPendingImprove()).toBe(true)
    episodic.clearPendingImprove()
    expect(episodic.hasPendingImprove()).toBe(false)
  })
})
