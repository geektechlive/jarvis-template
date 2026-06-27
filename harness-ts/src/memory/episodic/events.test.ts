import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDb } from './base'
import { recordError, recentEvents, _resetHarnessErrorRateLimit } from './events'

// Integration test against a throwaway SQLite DB. Exercises the harness_error
// rate-limit guard: repeated failures sharing a rateKey collapse to one row
// inside the window, while distinct keys and unkeyed calls always write.

let dataDir: string
let prevDataDir: string | undefined

beforeEach(() => {
  prevDataDir = process.env['AGENT_DATA_DIR']
  dataDir = mkdtempSync(join(tmpdir(), 'jarvis-events-'))
  process.env['AGENT_DATA_DIR'] = dataDir
  closeDb() // force a fresh connection bound to the temp dir
  _resetHarnessErrorRateLimit()
})

afterEach(() => {
  closeDb()
  _resetHarnessErrorRateLimit()
  if (prevDataDir === undefined) delete process.env['AGENT_DATA_DIR']
  else process.env['AGENT_DATA_DIR'] = prevDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

function harnessErrors() {
  return recentEvents('system', 'harness_error', 24)
}

describe('recordError', () => {
  it('writes a harness_error row with the uniform detail shape', () => {
    recordError('voice', new Error('connection refused'))
    const rows = harnessErrors()
    expect(rows).toHaveLength(1)
    const detail = rows[0]!.detail as { subsystem: string; message: string; fatal: boolean }
    expect(detail.subsystem).toBe('voice')
    expect(detail.message).toBe('connection refused')
    expect(detail.fatal).toBe(false)
  })

  it('collapses repeated failures sharing a rateKey to one row in the window', () => {
    for (let i = 0; i < 5; i++) {
      recordError('voice', new Error(`fail ${i}`), { rateKey: 'voice' })
    }
    expect(harnessErrors()).toHaveLength(1)
  })

  it('does not rate-limit calls without a rateKey', () => {
    recordError('extension_init', new Error('a'))
    recordError('extension_init', new Error('b'))
    recordError('extension_init', new Error('c'))
    expect(harnessErrors()).toHaveLength(3)
  })

  it('tracks distinct rateKeys independently', () => {
    recordError('voice', new Error('v'), { rateKey: 'voice' })
    recordError('working_memory', new Error('w'), { rateKey: 'working_memory' })
    recordError('voice', new Error('v2'), { rateKey: 'voice' })
    expect(harnessErrors()).toHaveLength(2)
  })

  it('honours a custom rateMs window of 0 (every call writes)', () => {
    recordError('graph_ingest', new Error('a'), { rateKey: 'g', rateMs: 0 })
    recordError('graph_ingest', new Error('b'), { rateKey: 'g', rateMs: 0 })
    expect(harnessErrors()).toHaveLength(2)
  })

  it('coerces non-Error values to a string message', () => {
    recordError('mail_send', 'plain string failure')
    const detail = harnessErrors()[0]!.detail as { message: string }
    expect(detail.message).toBe('plain string failure')
  })
})
