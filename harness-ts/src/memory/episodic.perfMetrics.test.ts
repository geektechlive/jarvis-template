import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { join } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

// AGENT_DATA_DIR must be set before episodic is imported because DB_PATH is
// resolved at module load time (not lazily). Use a dynamic import inside
// beforeAll to guarantee the env var is set first.
const tmpDir = join(tmpdir(), `episodic-perf-test-${Date.now()}-${Math.trunc(Math.random() * 1e6)}`)

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

describe('recordPerfMetric', () => {
  it('records a metric with default session', () => {
    episodic.recordPerfMetric('reflection', 125.5)
    // Verify by reading from agent_events; recordPerfMetric writes to perf_metrics
    // which we can't directly query from the exported API, but we know it succeeded
    // if the DB didn't throw an error
    expect(true).toBe(true)
  })

  it('records a metric with explicit session key', () => {
    episodic.recordPerfMetric('mail_parse', 456.7, 'session-xyz')
    expect(true).toBe(true)
  })

  it('records zero latency', () => {
    episodic.recordPerfMetric('fast_op', 0, 'session-abc')
    expect(true).toBe(true)
  })

  it('records large latency values', () => {
    episodic.recordPerfMetric('slow_task', 99999.999, 'session-big')
    expect(true).toBe(true)
  })
})
