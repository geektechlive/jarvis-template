// Real unit tests for spotlight.ts existsSync filtering.
// Mocks node:fs, node:child_process, and the yaml config loader.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock node:child_process — execFile must use callback style for promisify.
// Use vi.hoisted to make the mock accessible both inside the factory and in tests.
// ---------------------------------------------------------------------------

const { _mockExecFile } = vi.hoisted(() => ({
  _mockExecFile: vi.fn(),
}))

vi.mock('node:child_process', () => ({
  execFile: _mockExecFile,
}))

// ---------------------------------------------------------------------------
// Mock node:fs — existsSync returns true/false per path; readFileSync for config
// ---------------------------------------------------------------------------

const _existsMap = new Map<string, boolean>()
let _configYaml = ''

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync: vi.fn((_path: unknown, _enc?: unknown) => _configYaml),
    existsSync: vi.fn((p: unknown) => {
      const path = String(p)
      // If explicitly set, use that. Otherwise default to true.
      if (_existsMap.has(path)) return _existsMap.get(path)!
      return true
    }),
  }
})

// ---------------------------------------------------------------------------
// Helper: configure existsSync behavior
// ---------------------------------------------------------------------------

function setExists(path: string, exists: boolean): void {
  _existsMap.set(path, exists)
}

function clearExists(): void {
  _existsMap.clear()
}

// ---------------------------------------------------------------------------
// Helper: configure spotlight YAML config
// ---------------------------------------------------------------------------

function setSpotlightConfig(roots: string[], nasRoots: string[] = []): void {
  _configYaml = `spotlight:
  roots:
${roots.map((r) => `    - ${r}`).join('\n')}
  nas_roots:
${nasRoots.map((r) => `    - ${r}`).join('\n')}
  timeout_seconds: 10
  max_results: 20
`
}

// ---------------------------------------------------------------------------
// Helper: make execFile call back with success
// ---------------------------------------------------------------------------

function mockExecFileSuccess(stdout: string): void {
  _mockExecFile.mockImplementation(
    (_bin: unknown, _args: unknown, _opts: unknown, cb: (err: null, result: { stdout: string; stderr: string }) => void) => {
      cb(null, { stdout, stderr: '' })
    },
  )
}

function mockExecFileError(err: Error): void {
  _mockExecFile.mockImplementation(
    (_bin: unknown, _args: unknown, _opts: unknown, cb: (err: Error) => void) => {
      cb(err)
    },
  )
}

// ---------------------------------------------------------------------------
// Import under test (after mocks registered)
// ---------------------------------------------------------------------------

import { spotlightSearch } from './spotlight'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Spotlight tool — existsSync filtering', () => {
  beforeEach(() => {
    clearExists()
    _mockExecFile.mockReset()
    _configYaml = ''
  })

  afterEach(() => {
    clearExists()
    vi.clearAllMocks()
  })

  // -------------------------------------------------------------------------
  // Test 1: All roots valid
  // -------------------------------------------------------------------------

  describe('all roots valid', () => {
    it('invokes mdfind with -onlyin for each root and no skipped note', async () => {
      setSpotlightConfig(['/valid/root1', '/valid/root2', '/valid/root3'])
      setExists('/valid/root1', true)
      setExists('/valid/root2', true)
      setExists('/valid/root3', true)

      mockExecFileSuccess('/valid/root1/file.txt\n/valid/root2/other.txt\n')

      const result = await spotlightSearch('my query')

      expect(_mockExecFile).toHaveBeenCalledOnce()

      const callArgs = _mockExecFile.mock.calls[0]! as unknown[]
      const args = callArgs[1] as string[]

      // Should contain -onlyin for each root
      expect(args).toContain('-onlyin')
      expect(args).toContain('/valid/root1')
      expect(args).toContain('/valid/root2')
      expect(args).toContain('/valid/root3')
      // Query should be the last arg
      expect(args[args.length - 1]).toBe('my query')

      // No skipped note in result
      expect(result).not.toContain('skipped')
      expect(result).toContain('/valid/root1/file.txt')
    })
  })

  // -------------------------------------------------------------------------
  // Test 2: Some roots missing
  // -------------------------------------------------------------------------

  describe('some roots missing', () => {
    it('excludes missing roots from mdfind args and appends skipped note', async () => {
      setSpotlightConfig([
        '/valid/root1',
        '/missing/root2',
        '/valid/root3',
        '/missing/root4',
        '/valid/root5',
      ])
      setExists('/valid/root1', true)
      setExists('/missing/root2', false)
      setExists('/valid/root3', true)
      setExists('/missing/root4', false)
      setExists('/valid/root5', true)

      mockExecFileSuccess('/valid/root1/result.pdf\n')

      const result = await spotlightSearch('search term')

      expect(_mockExecFile).toHaveBeenCalledOnce()

      const callArgs = _mockExecFile.mock.calls[0]! as unknown[]
      const args = callArgs[1] as string[]

      // Valid roots present
      expect(args).toContain('/valid/root1')
      expect(args).toContain('/valid/root3')
      expect(args).toContain('/valid/root5')

      // Missing roots absent
      expect(args).not.toContain('/missing/root2')
      expect(args).not.toContain('/missing/root4')

      // Skipped note mentions the count
      expect(result).toContain('2 configured root(s) were skipped')
      expect(result).toContain('not mounted or missing')
    })
  })

  // -------------------------------------------------------------------------
  // Test 3: All roots missing
  // -------------------------------------------------------------------------

  describe('all roots missing', () => {
    it('does not call mdfind and returns the all-missing error string', async () => {
      setSpotlightConfig(['/missing/root1', '/missing/root2', '/missing/root3'])
      setExists('/missing/root1', false)
      setExists('/missing/root2', false)
      setExists('/missing/root3', false)

      const result = await spotlightSearch('anything')

      // mdfind should NOT be invoked
      expect(_mockExecFile).not.toHaveBeenCalled()

      // Result should contain the all-missing error
      expect(result).toContain('all 3 configured root(s) are missing or unmounted')
    })
  })

  // -------------------------------------------------------------------------
  // Test 4: No roots configured
  // -------------------------------------------------------------------------

  describe('no roots configured', () => {
    it('falls through with empty roots and runs mdfind with no -onlyin args', async () => {
      // spotlight.ts uses DEFAULTS.roots when roots array is empty.
      // DEFAULTS.roots = [join(homedir(), 'Documents')].
      // When the default exists, mdfind will be called.
      // When it doesn't exist, we get the all-missing error.
      // Test the case where the default root does NOT exist.
      _configYaml = `spotlight:
  roots: []
  nas_roots: []
  timeout_seconds: 10
  max_results: 20
`
      // The YAML above has empty roots; loadSpotlightConfig falls back to DEFAULTS.roots
      // which is [homedir()/Documents]. Set that to missing so behavior is deterministic.
      const { homedir } = await import('node:os')
      const defaultRoot = homedir() + '/Documents'
      setExists(defaultRoot, false)

      const result = await spotlightSearch('test query')

      // With default root missing, we get all-missing error
      expect(_mockExecFile).not.toHaveBeenCalled()
      expect(result).toContain('all 1 configured root(s) are missing or unmounted')
    })

    it('runs mdfind against default Documents root when it exists', async () => {
      _configYaml = `spotlight:
  roots: []
  nas_roots: []
  timeout_seconds: 10
  max_results: 20
`
      const { homedir } = await import('node:os')
      const defaultRoot = homedir() + '/Documents'
      setExists(defaultRoot, true)

      mockExecFileSuccess('/Documents/file.txt\n')

      const result = await spotlightSearch('test query')

      expect(_mockExecFile).toHaveBeenCalledOnce()
      const callArgs = _mockExecFile.mock.calls[0]! as unknown[]
      const args = callArgs[1] as string[]
      expect(args).toContain('-onlyin')
      expect(args).toContain(defaultRoot)
      expect(result).toContain('/Documents/file.txt')
    })
  })

  // -------------------------------------------------------------------------
  // Test 5: Mixed roots and nas_roots
  // -------------------------------------------------------------------------

  describe('mixed roots and nas_roots', () => {
    it('combines roots and nas_roots, skipping missing ones', async () => {
      setSpotlightConfig(
        ['/valid/root1', '/valid/root2'],
        ['/nas/missing', '/nas/valid'],
      )
      setExists('/valid/root1', true)
      setExists('/valid/root2', true)
      setExists('/nas/missing', false)
      setExists('/nas/valid', true)

      mockExecFileSuccess('/valid/root1/doc.pdf\n')

      const result = await spotlightSearch('query')

      expect(_mockExecFile).toHaveBeenCalledOnce()

      const callArgs = _mockExecFile.mock.calls[0]! as unknown[]
      const args = callArgs[1] as string[]

      // All valid roots included
      expect(args).toContain('/valid/root1')
      expect(args).toContain('/valid/root2')
      expect(args).toContain('/nas/valid')

      // Missing NAS root excluded
      expect(args).not.toContain('/nas/missing')

      // Note mentions 1 skipped root
      expect(result).toContain('1 configured root(s) were skipped')
    })
  })

  // -------------------------------------------------------------------------
  // Test 6: Empty query
  // -------------------------------------------------------------------------

  describe('empty and invalid queries', () => {
    it('returns early for empty query without calling mdfind', async () => {
      setSpotlightConfig(['/valid/root1'])
      setExists('/valid/root1', true)

      const result = await spotlightSearch('')

      expect(_mockExecFile).not.toHaveBeenCalled()
      expect(result).toBe('Empty spotlight query.')
    })

    it('rejects queries starting with - to prevent mdfind flag injection', async () => {
      setSpotlightConfig(['/valid/root1'])
      setExists('/valid/root1', true)

      const result = await spotlightSearch('-onlyin /etc')

      expect(_mockExecFile).not.toHaveBeenCalled()
      expect(result).toContain('Invalid spotlight query')
      expect(result).toContain("cannot start with '-'")
    })
  })

  // -------------------------------------------------------------------------
  // Test 7: name: prefix bypasses root filtering
  // -------------------------------------------------------------------------

  describe('name: prefix search', () => {
    it('invokes mdfind -name without -onlyin regardless of existsSync', async () => {
      setSpotlightConfig(['/missing/root'])
      setExists('/missing/root', false)

      mockExecFileSuccess('/Users/test/project/readme.md\n')

      const result = await spotlightSearch('name:readme.md')

      expect(_mockExecFile).toHaveBeenCalledOnce()
      const callArgs = _mockExecFile.mock.calls[0]! as unknown[]
      const args = callArgs[1] as string[]

      expect(args[0]).toBe('-name')
      expect(args[1]).toBe('readme.md')
      expect(args).not.toContain('-onlyin')
      expect(result).toContain('readme.md')
    })

    it('returns empty filename error for "name:" with no filename', async () => {
      const result = await spotlightSearch('name:')

      expect(_mockExecFile).not.toHaveBeenCalled()
      expect(result).toBe('Empty filename in name: query.')
    })
  })

  // -------------------------------------------------------------------------
  // Test 8: No results from mdfind
  // -------------------------------------------------------------------------

  describe('no results', () => {
    it('returns no-files message when mdfind stdout is empty', async () => {
      setSpotlightConfig(['/valid/root1'])
      setExists('/valid/root1', true)

      mockExecFileSuccess('')

      const result = await spotlightSearch('nonexistent file xyz')

      expect(result).toContain('No files found matching')
    })
  })

  // -------------------------------------------------------------------------
  // Test 9: mdfind timeout
  // -------------------------------------------------------------------------

  describe('mdfind timeout', () => {
    it('returns timeout message when execFile rejects with ETIMEDOUT', async () => {
      setSpotlightConfig(['/valid/root1'])
      setExists('/valid/root1', true)

      const err = new Error('Command ETIMEDOUT after 10s')
      mockExecFileError(err)

      const result = await spotlightSearch('slow query')

      expect(result).toContain('timed out')
    })
  })
})
