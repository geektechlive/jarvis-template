import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { EventEmitter } from 'node:events'
import type * as tls from 'node:tls'

vi.mock('../secrets', () => ({
  getSecret: vi.fn((key: string) => {
    if (key === 'gmail_host') return null
    if (key === 'gmail_user') return null
    if (key === 'gmail_app_password') return null
    return null
  }),
}))

import { draftEml, attachAuthStateMachine, buildMimeBody } from './mail'

// ---------------------------------------------------------------------------
// Minimal TLSSocket mock: EventEmitter + write + destroy spies.
// ---------------------------------------------------------------------------
class MockSocket extends EventEmitter {
  written: string[] = []
  destroyed = false

  write(s: string) {
    this.written.push(s)
    return true
  }

  destroy() {
    this.destroyed = true
  }
}

function makeMockSocket() {
  return new MockSocket() as unknown as tls.TLSSocket & MockSocket
}

// Helper: emit a raw data buffer from the "server" side.
function serverSend(socket: ReturnType<typeof makeMockSocket>, data: string) {
  socket.emit('data', Buffer.from(data))
}

// ---------------------------------------------------------------------------
// Issue #631 — SMTP RCPT TO buffer drain
// ---------------------------------------------------------------------------
describe('#631 - SMTP multi-recipient buffer drain', () => {
  it('sends DATA after all RCPT TO responses arrive in a single TCP chunk', () => {
    const socket = makeMockSocket()
    const resolve = vi.fn()
    const reject = vi.fn()

    attachAuthStateMachine(
      socket,
      'user@example.com',
      'password',
      'to@example.com',
      'Subject',
      'Body',
      'cc1@example.com, cc2@example.com',
      resolve,
      reject,
    )

    // Phase 0: EHLO 250 → AUTH LOGIN
    serverSend(socket, '250 mx.example.com Hello\r\n')
    expect(socket.written.at(-1)).toBe('AUTH LOGIN\r\n')

    // Phase 1: AUTH 334 → base64 user
    serverSend(socket, '334 VXNlcm5hbWU6\r\n')
    expect(socket.written.at(-1)).toBe(Buffer.from('user@example.com').toString('base64') + '\r\n')

    // Phase 2: AUTH 334 → base64 pass
    serverSend(socket, '334 UGFzc3dvcmQ6\r\n')
    expect(socket.written.at(-1)).toBe(Buffer.from('password').toString('base64') + '\r\n')

    // Phase 3: AUTH 235 → MAIL FROM
    serverSend(socket, '235 Authentication successful\r\n')
    expect(socket.written.at(-1)).toBe('MAIL FROM:<user@example.com>\r\n')

    // Phase 4: MAIL FROM 250 → 3 RCPT TOs (to + 2 CC)
    serverSend(socket, '250 OK\r\n')
    const rcptCommands = socket.written.filter((w) => w.startsWith('RCPT TO:'))
    expect(rcptCommands).toHaveLength(3)
    expect(rcptCommands[0]).toBe('RCPT TO:<to@example.com>\r\n')
    expect(rcptCommands[1]).toBe('RCPT TO:<cc1@example.com>\r\n')
    expect(rcptCommands[2]).toBe('RCPT TO:<cc2@example.com>\r\n')

    // Phase 5: All three RCPT TO 250 responses arrive in ONE TCP chunk.
    // Before the fix, only the first was processed; rcptPending stalled at 2.
    serverSend(socket, '250 OK\r\n250 OK\r\n250 OK\r\n')

    // DATA must be sent after the third 250 drains rcptPending to 0.
    expect(socket.written.at(-1)).toBe('DATA\r\n')
    expect(reject).not.toHaveBeenCalled()
  })

  it('sends DATA when RCPT TO responses arrive in separate chunks', () => {
    const socket = makeMockSocket()
    const resolve = vi.fn()
    const reject = vi.fn()

    attachAuthStateMachine(
      socket,
      'user@example.com',
      'password',
      'to@example.com',
      'Subject',
      'Body',
      'cc@example.com',
      resolve,
      reject,
    )

    serverSend(socket, '250 Hello\r\n')
    serverSend(socket, '334 user\r\n')
    serverSend(socket, '334 pass\r\n')
    serverSend(socket, '235 OK\r\n')
    serverSend(socket, '250 OK\r\n') // MAIL FROM

    // Two RCPT TO responses arrive in separate TCP chunks.
    serverSend(socket, '250 OK\r\n')
    serverSend(socket, '250 OK\r\n')

    expect(socket.written.at(-1)).toBe('DATA\r\n')
    expect(reject).not.toHaveBeenCalled()
  })

  it('handles a RCPT TO response split across two chunks', () => {
    const socket = makeMockSocket()
    const resolve = vi.fn()
    const reject = vi.fn()

    attachAuthStateMachine(
      socket,
      'user@example.com',
      'password',
      'to@example.com',
      'Subject',
      'Body',
      '',
      resolve,
      reject,
    )

    serverSend(socket, '250 Hello\r\n')
    serverSend(socket, '334 user\r\n')
    serverSend(socket, '334 pass\r\n')
    serverSend(socket, '235 OK\r\n')
    serverSend(socket, '250 OK\r\n') // MAIL FROM

    // Response arrives split: first half in one chunk, second in next.
    serverSend(socket, '250 ')
    // DATA must NOT be sent yet — partial line not yet complete.
    expect(socket.written.at(-1)).not.toBe('DATA\r\n')

    serverSend(socket, 'OK\r\n')
    expect(socket.written.at(-1)).toBe('DATA\r\n')
    expect(reject).not.toHaveBeenCalled()
  })

  it('rejects immediately on any 4xx RCPT TO error', () => {
    const socket = makeMockSocket()
    const resolve = vi.fn()
    const reject = vi.fn()

    attachAuthStateMachine(
      socket,
      'user@example.com',
      'password',
      'to@example.com',
      'Subject',
      'Body',
      '',
      resolve,
      reject,
    )

    serverSend(socket, '250 Hello\r\n')
    serverSend(socket, '334 user\r\n')
    serverSend(socket, '334 pass\r\n')
    serverSend(socket, '235 OK\r\n')
    serverSend(socket, '250 OK\r\n') // MAIL FROM
    serverSend(socket, '550 No such user\r\n')

    expect(reject).toHaveBeenCalledWith(expect.any(Error))
    expect((reject.mock.calls[0]?.[0] as Error).message).toMatch(/550/)
    expect(socket.destroyed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Existing draftEml tests (unchanged)
// ---------------------------------------------------------------------------
describe('Mail tools', () => {
  let createdFiles: string[] = []

  beforeEach(() => {
    createdFiles = []
  })

  afterEach(() => {
    for (const file of createdFiles) {
      try {
        if (fs.existsSync(file)) fs.unlinkSync(file)
      } catch {
        // ignore cleanup errors
      }
    }
    const outbox = path.join(os.homedir(), 'Documents', 'agent_outbox')
    if (fs.existsSync(outbox)) {
      try {
        fs.rmSync(outbox, { recursive: true })
      } catch {
        // ignore
      }
    }
  })

  describe('#347 - RFC 2822 compliance in draftEml', () => {
    it('uses CRLF line endings', () => {
      const result = draftEml('test@example.com', 'Test Subject', 'Test body')
      const match = result.match(/Email drafted to (.+?)(\(|$)/)
      const filePath = match?.[1]?.trim() ?? ''

      expect(filePath).toBeTruthy()
      createdFiles.push(filePath)
      const content = fs.readFileSync(filePath, 'utf8')

      expect(content).toContain('\r\n')
      expect(content.endsWith('\r\n')).toBe(true)
    })

    it('includes Date header with UTC string', () => {
      const result = draftEml('test@example.com', 'Test Subject', 'Test body')
      const match = result.match(/Email drafted to (.+?)(\(|$)/)
      const filePath = match?.[1]?.trim() ?? ''

      expect(filePath).toBeTruthy()
      createdFiles.push(filePath)
      const content = fs.readFileSync(filePath, 'utf8')

      expect(content).toMatch(/^Date: \w{3}, \d{1,2} \w{3}/)
    })

    it('includes From header', () => {
      const result = draftEml('test@example.com', 'Test Subject', 'Test body')
      const match = result.match(/Email drafted to (.+?)(\(|$)/)
      const filePath = match?.[1]?.trim() ?? ''

      expect(filePath).toBeTruthy()
      createdFiles.push(filePath)
      const content = fs.readFileSync(filePath, 'utf8')

      expect(content).toContain('From: Jarvis <jarvis@local>')
    })

    it('includes Message-ID header with UUID format', () => {
      const result = draftEml('test@example.com', 'Test Subject', 'Test body')
      const match = result.match(/Email drafted to (.+?)(\(|$)/)
      const filePath = match?.[1]?.trim() ?? ''

      expect(filePath).toBeTruthy()
      createdFiles.push(filePath)
      const content = fs.readFileSync(filePath, 'utf8')

      expect(content).toMatch(/^Message-ID: <[0-9a-f-]{36}@jarvis\.local>/m)
    })

    it('sanitizes from value to prevent header injection', () => {
      const result = draftEml('test@example.com', 'Test Subject', 'Test body', '', '', 'test\r\nBcc: hacker@evil.com')
      const match = result.match(/Email drafted to (.+?)(\(|$)/)
      const filePath = match?.[1]?.trim() ?? ''

      expect(filePath).toBeTruthy()
      createdFiles.push(filePath)
      const content = fs.readFileSync(filePath, 'utf8')

      const headerSection = content.split('\r\n\r\n')[0] ?? ''
      const bccHeaderExists = /^Bcc:/m.test(headerSection)
      expect(bccHeaderExists).toBe(false)
    })

    it('accepts custom from parameter', () => {
      const result = draftEml('test@example.com', 'Test Subject', 'Test body', '', '', 'Custom <custom@example.com>')
      const match = result.match(/Email drafted to (.+?)(\(|$)/)
      const filePath = match?.[1]?.trim() ?? ''

      expect(filePath).toBeTruthy()
      createdFiles.push(filePath)
      const content = fs.readFileSync(filePath, 'utf8')

      expect(content).toContain('From: Custom <custom@example.com>')
    })

    it('includes To, Subject, and Cc headers in correct order', () => {
      const result = draftEml('test@example.com', 'Test Subject', 'Test body', 'cc@example.com')
      const match = result.match(/Email drafted to (.+?)(\(|$)/)
      const filePath = match?.[1]?.trim() ?? ''

      expect(filePath).toBeTruthy()
      createdFiles.push(filePath)
      const content = fs.readFileSync(filePath, 'utf8')

      const dateIdx = content.indexOf('Date:')
      const fromIdx = content.indexOf('From:')
      const toIdx = content.indexOf('To:')
      const subjectIdx = content.indexOf('Subject:')
      const ccIdx = content.indexOf('Cc:')
      const messageIdIdx = content.indexOf('Message-ID:')

      expect(dateIdx).toBeLessThan(fromIdx)
      expect(fromIdx).toBeLessThan(toIdx)
      expect(toIdx).toBeLessThan(subjectIdx)
      expect(messageIdIdx).toBeLessThan(ccIdx)
    })
  })
})

// ---------------------------------------------------------------------------
// #700 — HTML email (multipart/alternative) support
// ---------------------------------------------------------------------------
describe('#700 - HTML email support', () => {
  // --- buildMimeBody pure unit tests ---
  describe('buildMimeBody', () => {
    it('returns text/plain when html is absent', () => {
      const { contentType, mimeBody } = buildMimeBody('Hello plain')
      expect(contentType).toBe('text/plain; charset=utf-8')
      expect(mimeBody).toBe('Hello plain')
    })

    it('returns text/plain when html is empty string', () => {
      const { contentType, mimeBody } = buildMimeBody('Hello plain', '')
      expect(contentType).toBe('text/plain; charset=utf-8')
      expect(mimeBody).toBe('Hello plain')
    })

    it('returns multipart/alternative when html is provided', () => {
      const { contentType, mimeBody } = buildMimeBody('Plain text', '<p>HTML</p>')
      expect(contentType).toMatch(/^multipart\/alternative; boundary="[0-9a-f]{32}"$/)
      expect(mimeBody).toContain('Content-Type: text/plain; charset=utf-8')
      expect(mimeBody).toContain('Content-Type: text/html; charset=utf-8')
      expect(mimeBody).toContain('Plain text')
      expect(mimeBody).toContain('<p>HTML</p>')
    })

    it('includes correct boundary delimiters', () => {
      const { contentType, mimeBody } = buildMimeBody('Plain', '<b>Bold</b>')
      // Extract boundary from Content-Type
      const bMatch = contentType.match(/boundary="([^"]+)"/)
      expect(bMatch).toBeTruthy()
      const b = bMatch![1]!
      expect(mimeBody).toContain(`--${b}\r\n`)
      expect(mimeBody).toContain(`--${b}--`)
      // Two part delimiters (open) + one close
      const openCount = (mimeBody.match(new RegExp(`--${b}\r\n`, 'g')) ?? []).length
      expect(openCount).toBe(2)
    })

    it('plain part appears before html part', () => {
      const { mimeBody } = buildMimeBody('plain content', '<p>html content</p>')
      const plainIdx = mimeBody.indexOf('Content-Type: text/plain')
      const htmlIdx = mimeBody.indexOf('Content-Type: text/html')
      expect(plainIdx).toBeGreaterThanOrEqual(0)
      expect(htmlIdx).toBeGreaterThan(plainIdx)
    })

    it('uses CRLF line endings throughout', () => {
      const { mimeBody } = buildMimeBody('Plain', '<b>HTML</b>')
      // Should have no bare \n that isn't preceded by \r
      expect(mimeBody).not.toMatch(/(?<!\r)\n/)
    })
  })

  // --- SMTP phase 6 integration: multipart assembled before dot-stuffing ---
  describe('attachAuthStateMachine phase 6 with html', () => {
    function driveToPhase6(socket: ReturnType<typeof makeMockSocket>, html?: string) {
      const resolve = vi.fn()
      const reject = vi.fn()
      attachAuthStateMachine(
        socket, 'user@example.com', 'password',
        'to@example.com', 'Subject', 'Body text', '', resolve, reject, '', html,
      )
      serverSend(socket, '250 Hello\r\n')
      serverSend(socket, '334 user\r\n')
      serverSend(socket, '334 pass\r\n')
      serverSend(socket, '235 OK\r\n')
      serverSend(socket, '250 OK\r\n') // MAIL FROM
      serverSend(socket, '250 OK\r\n') // RCPT TO
      serverSend(socket, '354 Start input\r\n') // DATA → phase 6 fires
      return { resolve, reject }
    }

    it('no-html: phase 6 write contains text/plain, no multipart', () => {
      const socket = makeMockSocket()
      driveToPhase6(socket)
      const written = socket.written.join('')
      expect(written).toContain('Content-Type: text/plain; charset=utf-8')
      expect(written).not.toContain('multipart')
      expect(written).not.toContain('text/html')
    })

    it('with html: phase 6 write contains multipart/alternative', () => {
      const socket = makeMockSocket()
      driveToPhase6(socket, '<p>Hello</p>')
      const written = socket.written.join('')
      expect(written).toContain('multipart/alternative')
      expect(written).toContain('Content-Type: text/plain; charset=utf-8')
      expect(written).toContain('Content-Type: text/html; charset=utf-8')
      expect(written).toContain('Body text')
      expect(written).toContain('<p>Hello</p>')
    })

    it('dot-stuffing applied to entire multipart body, not per-part', () => {
      const socket = makeMockSocket()
      // Body text and HTML both have lines starting with '.'.
      // Dot-stuffing must be applied to the whole assembled multipart body so
      // every such line is doubled, regardless of which MIME part it appears in.
      const resolve = vi.fn()
      const reject = vi.fn()
      attachAuthStateMachine(
        socket, 'user@example.com', 'password',
        'to@example.com', 'Subject', '.dotted plain', '', resolve, reject, '', '.dotted html',
      )
      serverSend(socket, '250 Hello\r\n')
      serverSend(socket, '334 user\r\n')
      serverSend(socket, '334 pass\r\n')
      serverSend(socket, '235 OK\r\n')
      serverSend(socket, '250 OK\r\n')
      serverSend(socket, '250 OK\r\n')
      serverSend(socket, '354 Start\r\n')

      const written = socket.written.join('')
      // Both lines starting with '.' must be doubled — dot-stuffed over the whole body.
      expect(written).toContain('..dotted plain')
      expect(written).toContain('..dotted html')
      // The raw (undoubled) forms must NOT appear as standalone lines
      expect(written).not.toMatch(/(?<!\.)\.dotted plain/)
      expect(written).not.toMatch(/(?<!\.)\.dotted html/)
    })

    it('MIME-Version: 1.0 present in both html and no-html writes', () => {
      const socketPlain = makeMockSocket()
      driveToPhase6(socketPlain)
      expect(socketPlain.written.join('')).toContain('MIME-Version: 1.0')

      const socketHtml = makeMockSocket()
      driveToPhase6(socketHtml, '<b>test</b>')
      expect(socketHtml.written.join('')).toContain('MIME-Version: 1.0')
    })
  })

  // --- draftEml fallback with html ---
  describe('draftEml with html', () => {
    const createdFiles: string[] = []

    afterEach(() => {
      for (const file of createdFiles) {
        try { if (fs.existsSync(file)) fs.unlinkSync(file) } catch { /* ignore */ }
      }
      const outbox = path.join(os.homedir(), 'Documents', 'agent_outbox')
      if (fs.existsSync(outbox)) {
        try { fs.rmSync(outbox, { recursive: true }) } catch { /* ignore */ }
      }
    })

    it('no-html draftEml does NOT add MIME-Version or Content-Type', () => {
      const result = draftEml('a@b.com', 'Sub', 'Body')
      const fp = result.match(/Email drafted to (.+?)(\(|$)/)?.[1]?.trim() ?? ''
      expect(fp).toBeTruthy()
      createdFiles.push(fp)
      const content = fs.readFileSync(fp, 'utf8')
      expect(content).not.toContain('MIME-Version')
      expect(content).not.toContain('Content-Type')
    })

    it('with html: draftEml includes MIME-Version, multipart/alternative, both parts', () => {
      const result = draftEml('a@b.com', 'Sub', 'Plain part', '', '', '', '<p>HTML part</p>')
      const fp = result.match(/Email drafted to (.+?)(\(|$)/)?.[1]?.trim() ?? ''
      expect(fp).toBeTruthy()
      createdFiles.push(fp)
      const content = fs.readFileSync(fp, 'utf8')
      expect(content).toContain('MIME-Version: 1.0')
      expect(content).toContain('multipart/alternative')
      expect(content).toContain('Content-Type: text/plain; charset=utf-8')
      expect(content).toContain('Content-Type: text/html; charset=utf-8')
      expect(content).toContain('Plain part')
      expect(content).toContain('<p>HTML part</p>')
    })

    it('with html: draftEml uses CRLF line endings', () => {
      const result = draftEml('a@b.com', 'Sub', 'Plain', '', '', '', '<b>HTML</b>')
      const fp = result.match(/Email drafted to (.+?)(\(|$)/)?.[1]?.trim() ?? ''
      expect(fp).toBeTruthy()
      createdFiles.push(fp)
      const content = fs.readFileSync(fp, 'utf8')
      expect(content).toContain('\r\n')
    })
  })
})
