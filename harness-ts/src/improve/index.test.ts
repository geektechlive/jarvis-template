import { describe, it, expect } from 'vitest'
import { IMPROVABLE_PATHS, CREATABLE_PATHS, applyTextChange, makeBranchTimestamp, isCreatable, createScript } from './index'

describe('IMPROVABLE_PATHS', () => {
  it('includes the staff and identity files we expect to be improvable', () => {
    expect(IMPROVABLE_PATHS.has('harness/config/staff.yaml')).toBe(true)
    expect(IMPROVABLE_PATHS.has('harness/config/models.yaml')).toBe(true)
    expect(IMPROVABLE_PATHS.has('harness/identity/BEHAVIOR.md')).toBe(true)
    expect(IMPROVABLE_PATHS.has('harness/identity/MISSION.md')).toBe(true)
    expect(IMPROVABLE_PATHS.has('harness/identity/GOALS.md')).toBe(true)
    expect(IMPROVABLE_PATHS.has('harness/identity/PROJECTS.md')).toBe(true)
  })

  it('does NOT include SOUL.md (persona is not improvable)', () => {
    expect(IMPROVABLE_PATHS.has('harness/identity/SOUL.md')).toBe(false)
  })

  it('does NOT include any harness-ts/ runtime path', () => {
    for (const p of IMPROVABLE_PATHS) {
      expect(p.startsWith('harness-ts/')).toBe(false)
    }
  })

  it('does NOT include infrastructure files', () => {
    expect(IMPROVABLE_PATHS.has('harness/memory/store.py')).toBe(false)
    expect(IMPROVABLE_PATHS.has('Makefile')).toBe(false)
    expect(IMPROVABLE_PATHS.has('CLAUDE.md')).toBe(false)
  })
})

describe('applyTextChange allowlist guard', () => {
  it('rejects a path that is not in IMPROVABLE_PATHS', () => {
    const r = applyTextChange('harness/memory/store.py', 'old', 'new')
    expect(r).toMatch(/not in the IMPROVABLE_PATHS allowlist/)
  })

  it('rejects harness-ts runtime files', () => {
    const r = applyTextChange('harness-ts/src/extension.ts', 'old', 'new')
    expect(r).toMatch(/not in the IMPROVABLE_PATHS allowlist/)
  })

  it('rejects SOUL.md', () => {
    const r = applyTextChange('harness/identity/SOUL.md', 'old', 'new')
    expect(r).toMatch(/not in the IMPROVABLE_PATHS allowlist/)
  })

  it('rejects path traversal attempts', () => {
    const r = applyTextChange('../../etc/passwd', 'old', 'new')
    expect(r).toMatch(/not in the IMPROVABLE_PATHS allowlist/)
  })
})

describe('makeBranchTimestamp', () => {
  it('produces a format that matches the branchesToday glob pattern', () => {
    const ts = makeBranchTimestamp()
    const branch = `auto/improve-${ts}`
    const today = new Date().toISOString().slice(0, 10)
    expect(branch.startsWith(`auto/improve-${today}-`)).toBe(true)
  })

  it('contains no colons or dots', () => {
    const ts = makeBranchTimestamp()
    expect(ts).not.toMatch(/[:.T]/)
  })
})

// ---------------------------------------------------------------------------
// isCreatable / CREATABLE_PATHS
// ---------------------------------------------------------------------------

describe('CREATABLE_PATHS', () => {
  it('contains the scripts/ prefix', () => {
    expect(CREATABLE_PATHS.has('scripts/')).toBe(true)
  })
})

describe('isCreatable', () => {
  it('returns true for a flat .sh script under scripts/', () => {
    expect(isCreatable('scripts/check.sh')).toBe(true)
  })

  it('returns true for a flat .py script under scripts/', () => {
    expect(isCreatable('scripts/check.py')).toBe(true)
  })

  it('returns false for a subdirectory path (no subdirs allowed)', () => {
    expect(isCreatable('scripts/sub/check.sh')).toBe(false)
  })

  it('returns false for a path outside scripts/', () => {
    expect(isCreatable('harness/config/models.yaml')).toBe(false)
  })

  it('returns false for the scripts/ prefix itself (no name)', () => {
    expect(isCreatable('scripts/')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// createScript -- path and header validation (no filesystem writes needed for
// error paths; success path requires a real scripts/ dir in HARNESS_DIR which
// is not available in tests -- we test the guard conditions only)
// ---------------------------------------------------------------------------

describe('createScript guard conditions', () => {
  it('rejects a path outside scripts/', async () => {
    const result = await createScript('harness/config/models.yaml', '# created_by: agent\necho hi')
    expect(result).toMatch(/not in the CREATABLE_PATHS allowlist/)
  })

  it('rejects a subdirectory path', async () => {
    const result = await createScript('scripts/sub/check.sh', '# created_by: agent\necho hi')
    expect(result).toMatch(/not in the CREATABLE_PATHS allowlist/)
  })

  it('rejects content missing the required created_by header', async () => {
    // Use an override of HARNESS_DIR so isCreatable passes but the header check triggers.
    // Since HARNESS_DIR points to a real dir and scripts/ may or may not exist, we
    // rely on the header check happening BEFORE the filesystem write.
    const result = await createScript('scripts/test-no-header.sh', '#!/bin/bash\necho hi\n')
    expect(result).toMatch(/missing required "# created_by: agent" header/)
  })
})
