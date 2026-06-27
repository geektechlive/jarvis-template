import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
  statSync: vi.fn(),
  existsSync: vi.fn(),
}))

vi.mock('ion-sdk', () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

vi.mock('../config', () => ({
  HARNESS_DIR: '/fake/harness',
}))

import * as fs from 'node:fs'
import { loadUsage, registerAgentScript, runCurator, incrementScriptUsage, type UsageJson } from './curator'

const SCRIPTS_DIR = '/fake/harness/scripts'
const ARCHIVE_DIR = join(SCRIPTS_DIR, '.archive')

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('loadUsage', () => {
  it('returns empty object when file does not exist', () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT') })
    expect(loadUsage()).toEqual({})
  })

  it('returns parsed JSON when file exists', () => {
    const data: UsageJson = {
      'test.sh': { created_by: 'human', state: 'active', created_at: null, use_count: 0, last_activity_at: null },
    }
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(data))
    expect(loadUsage()).toEqual(data)
  })
})

describe('registerAgentScript', () => {
  it('writes a candidate entry with created_by: agent', () => {
    vi.mocked(fs.readFileSync).mockReturnValue('{}')
    vi.mocked(fs.writeFileSync).mockImplementation(() => undefined)

    const before = new Date('2026-01-01T00:00:00Z')
    vi.setSystemTime(before)

    registerAgentScript('my-script.sh')

    const written = vi.mocked(fs.writeFileSync).mock.calls[0]
    expect(written).toBeDefined()
    const [, content] = written as [string, string, string]
    const parsed = JSON.parse(content) as UsageJson
    expect(parsed['my-script.sh']).toMatchObject({
      created_by: 'agent',
      state: 'candidate',
    })
    expect(parsed['my-script.sh']?.created_at).toBe('2026-01-01T00:00:00.000Z')
  })
})

describe('runCurator', () => {
  it('archives a stale agent-created script', () => {
    const now = new Date('2026-05-17T00:00:00Z').getTime()
    vi.setSystemTime(now)

    const staleTime = now - 31 * 86_400_000

    const data: UsageJson = {
      'agent-script.sh': {
        created_by: 'agent',
        state: 'candidate',
        created_at: new Date(staleTime).toISOString(),
        use_count: 0,
        last_activity_at: null,
      },
    }

    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(data))
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: staleTime } as ReturnType<typeof fs.statSync>)
    vi.mocked(fs.mkdirSync).mockImplementation(() => undefined)
    vi.mocked(fs.renameSync).mockImplementation(() => undefined)
    vi.mocked(fs.writeFileSync).mockImplementation(() => undefined)

    const result = runCurator()

    expect(result).toContain('Archived 1 stale agent-created script(s)')
    expect(result).toContain('agent-script.sh')
    expect(fs.renameSync).toHaveBeenCalledWith(
      join(SCRIPTS_DIR, 'agent-script.sh'),
      join(ARCHIVE_DIR, 'agent-script.sh'),
    )
  })

  it('does NOT archive a human-created script even if stale', () => {
    const now = new Date('2026-05-17T00:00:00Z').getTime()
    vi.setSystemTime(now)
    const staleTime = now - 31 * 86_400_000

    const data: UsageJson = {
      'human-script.sh': {
        created_by: 'human',
        state: 'active',
        created_at: null,
        use_count: 0,
        last_activity_at: null,
      },
    }

    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(data))
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: staleTime } as ReturnType<typeof fs.statSync>)

    const result = runCurator()

    expect(result).toBe('No stale agent-created scripts found.')
    expect(fs.renameSync).not.toHaveBeenCalled()
  })

  it('does NOT archive an already-archived script', () => {
    const now = new Date('2026-05-17T00:00:00Z').getTime()
    vi.setSystemTime(now)
    const staleTime = now - 31 * 86_400_000

    const data: UsageJson = {
      'agent-script.sh': {
        created_by: 'agent',
        state: 'archived',
        created_at: new Date(staleTime).toISOString(),
        use_count: 0,
        last_activity_at: null,
      },
    }

    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(data))
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: staleTime } as ReturnType<typeof fs.statSync>)

    const result = runCurator()

    expect(result).toBe('No stale agent-created scripts found.')
    expect(fs.renameSync).not.toHaveBeenCalled()
  })

  it('does NOT archive a recently modified agent-created script', () => {
    const now = new Date('2026-05-17T00:00:00Z').getTime()
    vi.setSystemTime(now)
    const recentTime = now - 5 * 86_400_000

    const data: UsageJson = {
      'agent-script.sh': {
        created_by: 'agent',
        state: 'candidate',
        created_at: new Date(recentTime).toISOString(),
        use_count: 0,
        last_activity_at: null,
      },
    }

    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(data))
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: recentTime } as ReturnType<typeof fs.statSync>)

    const result = runCurator()

    expect(result).toBe('No stale agent-created scripts found.')
    expect(fs.renameSync).not.toHaveBeenCalled()
  })

  it('uses last_activity_at instead of mtime when populated', () => {
    const now = new Date('2026-05-17T00:00:00Z').getTime()
    vi.setSystemTime(now)
    const staleTime = now - 31 * 86_400_000
    const recentActivity = now - 2 * 86_400_000

    // mtime is stale but last_activity_at is recent -- should NOT archive
    const data: UsageJson = {
      'agent-script.sh': {
        created_by: 'agent',
        state: 'candidate',
        created_at: new Date(staleTime).toISOString(),
        use_count: 5,
        last_activity_at: new Date(recentActivity).toISOString(),
      },
    }

    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(data))
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: staleTime } as ReturnType<typeof fs.statSync>)

    const result = runCurator()

    expect(result).toBe('No stale agent-created scripts found.')
    expect(fs.renameSync).not.toHaveBeenCalled()
  })
})

describe('incrementScriptUsage', () => {
  it('increments use_count and sets last_activity_at for an existing entry', () => {
    const now = new Date('2026-05-17T12:00:00Z')
    vi.setSystemTime(now)

    const data: UsageJson = {
      'calendar-check': {
        created_by: 'human',
        state: 'active',
        created_at: null,
        use_count: 3,
        last_activity_at: null,
      },
    }

    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(data))
    vi.mocked(fs.writeFileSync).mockImplementation(() => undefined)

    incrementScriptUsage('calendar-check')

    const written = vi.mocked(fs.writeFileSync).mock.calls[0]
    expect(written).toBeDefined()
    const [, content] = written as [string, string, string]
    const parsed = JSON.parse(content) as UsageJson
    expect(parsed['calendar-check']?.use_count).toBe(4)
    expect(parsed['calendar-check']?.last_activity_at).toBe(now.toISOString())
  })

  it('strips extension when looking up entry', () => {
    const now = new Date('2026-05-17T12:00:00Z')
    vi.setSystemTime(now)

    const data: UsageJson = {
      'my-script': {
        created_by: 'agent',
        state: 'active',
        created_at: null,
        use_count: 0,
        last_activity_at: null,
      },
    }

    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(data))
    vi.mocked(fs.writeFileSync).mockImplementation(() => undefined)

    incrementScriptUsage('my-script.sh')

    const written = vi.mocked(fs.writeFileSync).mock.calls[0]
    const [, content] = written as [string, string, string]
    const parsed = JSON.parse(content) as UsageJson
    expect(parsed['my-script']?.use_count).toBe(1)
  })

  it('creates a minimal entry when script is not in usage.json', () => {
    const now = new Date('2026-05-17T12:00:00Z')
    vi.setSystemTime(now)

    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue('{}')
    vi.mocked(fs.writeFileSync).mockImplementation(() => undefined)

    incrementScriptUsage('new-script')

    const written = vi.mocked(fs.writeFileSync).mock.calls[0]
    const [, content] = written as [string, string, string]
    const parsed = JSON.parse(content) as UsageJson
    expect(parsed['new-script']?.use_count).toBe(1)
    expect(parsed['new-script']?.last_activity_at).toBe(now.toISOString())
  })

  it('is a no-op when usage.json does not exist', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)

    incrementScriptUsage('any-script')

    expect(fs.writeFileSync).not.toHaveBeenCalled()
  })
})
