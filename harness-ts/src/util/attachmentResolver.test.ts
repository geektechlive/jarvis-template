import { describe, it, expect, vi } from 'vitest'
import { expandTilde } from './attachmentResolver'
import { resolveAttachmentMarkers, rewriteMarker } from './attachmentResolver'
import { homedir } from 'node:os'

// ---------------------------------------------------------------------------
// expandTilde
// ---------------------------------------------------------------------------

describe('expandTilde', () => {
  it('expands ~/path to <HOME>/path', () => {
    expect(expandTilde('~/a/b')).toBe(`${homedir()}/a/b`)
  })

  it('expands bare ~ to HOME', () => {
    expect(expandTilde('~')).toBe(homedir())
  })

  it('leaves absolute paths unchanged', () => {
    expect(expandTilde('/Users/<username>/file.pdf')).toBe('/Users/<username>/file.pdf')
  })

  it('leaves relative paths unchanged', () => {
    expect(expandTilde('relative/path')).toBe('relative/path')
  })
})

// ---------------------------------------------------------------------------
// rewriteMarker
// ---------------------------------------------------------------------------

describe('rewriteMarker', () => {
  it('replaces the tilde path with the absolute path in the prompt', () => {
    const original = '[Attached file: ~/Library/Mobile Documents/x.pdf]'
    const prompt = `Please review this ${original} and summarize.`
    const abs = `${homedir()}/Library/Mobile Documents/x.pdf`
    const result = rewriteMarker(prompt, original, abs)
    expect(result).toContain(`[Attached file: ${abs}]`)
    expect(result).not.toContain('~/Library')
  })

  it('handles image marker', () => {
    const original = '[Attached image: ~/Desktop/photo.png]'
    const prompt = original
    const abs = `${homedir()}/Desktop/photo.png`
    const result = rewriteMarker(prompt, original, abs)
    expect(result).toBe(`[Attached image: ${abs}]`)
  })

  it('handles plan marker', () => {
    const original = '[Attached plan: ~/Documents/plan.md]'
    const prompt = `Here is my plan: ${original}`
    const abs = `${homedir()}/Documents/plan.md`
    const result = rewriteMarker(prompt, original, abs)
    expect(result).toContain(`[Attached plan: ${abs}]`)
  })
})

// ---------------------------------------------------------------------------
// resolveAttachmentMarkers — fast path (no markers)
// ---------------------------------------------------------------------------

describe('resolveAttachmentMarkers — no markers', () => {
  it('returns original string immediately without any dep calls', async () => {
    const isFileReady = vi.fn()
    const download = vi.fn()
    const sleep = vi.fn()

    const prompt = 'Just a normal message with no attachments.'
    const result = await resolveAttachmentMarkers(prompt, {
      isFileReady,
      download,
      sleep,
      maxAttempts: 2,
      intervalMs: 0,
    })

    expect(result).toBe(prompt)
    expect(isFileReady).not.toHaveBeenCalled()
    expect(download).not.toHaveBeenCalled()
    expect(sleep).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// resolveAttachmentMarkers — file materializes immediately
// ---------------------------------------------------------------------------

describe('resolveAttachmentMarkers — file materializes', () => {
  it('rewrites the marker to the absolute path when the file is ready', async () => {
    const abs = `${homedir()}/Library/Mobile Documents/x.pdf`
    const isFileReady = vi.fn().mockReturnValue(true)
    const download = vi.fn().mockResolvedValue(undefined)
    const sleep = vi.fn().mockResolvedValue(undefined)

    const rawPrompt = `Please review [Attached file: ~/Library/Mobile Documents/x.pdf] and summarize.`
    const result = await resolveAttachmentMarkers(rawPrompt, {
      isFileReady,
      download,
      sleep,
      maxAttempts: 2,
      intervalMs: 0,
    })

    expect(result).toContain(`[Attached file: ${abs}]`)
    expect(result).not.toContain('~/Library')
    // download called once (initial trigger), sleep not called (ready on first check)
    expect(download).toHaveBeenCalledWith(abs)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('handles multiple markers in a single prompt', async () => {
    const home = homedir()
    const isFileReady = vi.fn().mockReturnValue(true)
    const download = vi.fn().mockResolvedValue(undefined)
    const sleep = vi.fn().mockResolvedValue(undefined)

    const rawPrompt =
      `Check [Attached file: ~/doc.pdf] and [Attached image: ~/photo.png] please.`
    const result = await resolveAttachmentMarkers(rawPrompt, {
      isFileReady,
      download,
      sleep,
      maxAttempts: 2,
      intervalMs: 0,
    })

    expect(result).toContain(`[Attached file: ${home}/doc.pdf]`)
    expect(result).toContain(`[Attached image: ${home}/photo.png]`)
  })
})

// ---------------------------------------------------------------------------
// resolveAttachmentMarkers — timeout case
// ---------------------------------------------------------------------------

describe('resolveAttachmentMarkers — timeout', () => {
  it('leaves marker unchanged when file never materializes', async () => {
    const isFileReady = vi.fn().mockReturnValue(false)
    const download = vi.fn().mockResolvedValue(undefined)
    const sleep = vi.fn().mockResolvedValue(undefined)

    const rawPrompt = `[Attached file: ~/ghost.pdf]`
    const result = await resolveAttachmentMarkers(rawPrompt, {
      isFileReady,
      download,
      sleep,
      maxAttempts: 2,
      intervalMs: 0,
    })

    // Marker unchanged
    expect(result).toBe(rawPrompt)
    // We polled maxAttempts times total (1 initial + 1 retry = 2 isFileReady calls,
    // but initial check is before the loop; loop runs maxAttempts-1 times = 1 sleep)
    expect(sleep).toHaveBeenCalledTimes(1)
  })

  it('does not throw on timeout', async () => {
    const isFileReady = vi.fn().mockReturnValue(false)
    const download = vi.fn().mockResolvedValue(undefined)
    const sleep = vi.fn().mockResolvedValue(undefined)

    await expect(
      resolveAttachmentMarkers('[Attached plan: ~/missing.md]', {
        isFileReady,
        download,
        sleep,
        maxAttempts: 1,
        intervalMs: 0,
      })
    ).resolves.toBe('[Attached plan: ~/missing.md]')
  })
})

// ---------------------------------------------------------------------------
// resolveAttachmentMarkers — already-absolute path
// ---------------------------------------------------------------------------

describe('resolveAttachmentMarkers — absolute path marker', () => {
  it('materializes an already-absolute path and rewrites it (path unchanged in marker)', async () => {
    const abs = '/Users/<username>/Documents/report.pdf'
    const isFileReady = vi.fn().mockReturnValue(true)
    const download = vi.fn().mockResolvedValue(undefined)
    const sleep = vi.fn().mockResolvedValue(undefined)

    const rawPrompt = `See [Attached file: ${abs}]`
    const result = await resolveAttachmentMarkers(rawPrompt, {
      isFileReady,
      download,
      sleep,
      maxAttempts: 2,
      intervalMs: 0,
    })

    // Path is already absolute — expandTilde leaves it as-is; rewrite substitutes same value
    expect(result).toContain(`[Attached file: ${abs}]`)
  })
})
