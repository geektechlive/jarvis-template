// Mail send tool -- SMTP_SSL (port 465) and STARTTLS (port 587) via Node built-ins,
// .eml draft fallback.
// Ports harness/tools/writes.py::mail_send and _draft_eml.
//
// Credentials read from macOS Keychain via secrets/index.ts:
//   gmail_host         -- SMTP server hostname
//   gmail_user         -- SMTP login / from address
//   gmail_app_password -- App-specific password
//   gmail_port         -- "465" (SMTP_SSL) or "587" (STARTTLS)
//
// Falls back to .eml draft in ~/Documents/agent_outbox/ when creds are absent
// or when SMTP fails at runtime.

import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import * as tls from 'node:tls'
import { randomUUID } from 'node:crypto'
import { getSecret } from '../secrets'
import { recordError } from '../memory/episodic'

const _OUTBOX = path.join(os.homedir(), 'Documents', 'agent_outbox')
const SMTP_ABSOLUTE_TIMEOUT_MS = 30_000

// Strip \r/\n from header values to block CRLF injection.
function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim()
}

// RFC 5321 §4.5.2: any body line beginning with '.' must be doubled.
function dotStuff(body: string): string {
  return body.split(/\r?\n/).map((l) => (l.startsWith('.') ? '.' + l : l)).join('\r\n')
}

// Build MIME content type and body. When html is provided, emits a
// multipart/alternative with text/plain + text/html parts. When html is absent
// or empty, returns a plain text body identical to the pre-HTML implementation.
// Dot-stuffing is NOT applied here — it is an SMTP transmission concern and
// must NOT corrupt files written by draftEml.
export function buildMimeBody(
  body: string,
  html?: string,
): { contentType: string; mimeBody: string } {
  if (!html) {
    return { contentType: 'text/plain; charset=utf-8', mimeBody: body }
  }
  const boundary = randomUUID().replace(/-/g, '')
  const mimeBody = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    '',
    html,
    `--${boundary}--`,
  ].join('\r\n')
  return { contentType: `multipart/alternative; boundary="${boundary}"`, mimeBody }
}

export function draftEml(to: string, subject: string, body: string, cc = '', error = '', from = '', html?: string): string {
  fs.mkdirSync(_OUTBOX, { recursive: true })
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  const filePath = path.join(_OUTBOX, `${ts}.eml`)
  const fromAddr = from || 'Jarvis <jarvis@local>'
  const lines: string[] = [
    `Date: ${new Date().toUTCString()}`,
    `From: ${sanitizeHeader(fromAddr)}`,
    `To: ${sanitizeHeader(to)}`,
    `Subject: ${sanitizeHeader(subject)}`,
    `Message-ID: <${randomUUID()}@jarvis.local>`,
  ]
  if (cc) lines.push(`Cc: ${sanitizeHeader(cc)}`)
  if (html) {
    const { contentType, mimeBody } = buildMimeBody(body, html)
    lines.push('MIME-Version: 1.0', `Content-Type: ${contentType}`, '', mimeBody)
  } else {
    lines.push('', body)
  }
  fs.writeFileSync(filePath, lines.join('\r\n') + '\r\n', 'utf8')
  const note = error ? ` (SMTP error: ${error})` : ' (SMTP creds not configured)'
  return `Email drafted to ${filePath}${note}`
}

// Shared AUTH/envelope state machine, attached to a TLSSocket after EHLO is sent.
// Phase counter:
//   0=EHLO 250         → AUTH LOGIN
//   1=AUTH 334(user)   → base64 user
//   2=AUTH 334(pass)   → base64 pass
//   3=AUTH 235         → MAIL FROM
//   4=MAIL FROM 250    → RCPT TOs (not DATA — wait for all RCPT acknowledgements)
//   5=RCPT 250 (each)  → when all acked, DATA
//   6=DATA 354         → headers + dot-stuffed body
//   7=msg accepted 250 → QUIT
//   8=QUIT 221         → destroy + resolve
export function attachAuthStateMachine(
  socket: tls.TLSSocket,
  user: string,
  pass: string,
  to: string,
  subject: string,
  body: string,
  cc: string,
  resolve: () => void,
  reject: (err: Error) => void,
  from = '',
  html?: string,
): void {
  const send = (line: string) => socket.write(line + '\r\n')
  const recv: string[] = []
  let phase = 0
  const ccAddrs = cc ? cc.split(',').map((a) => a.trim()).filter(Boolean) : []
  const rcptAddrs = [to, ...ccAddrs]
  let rcptPending = 0

  socket.on('data', (chunk: Buffer) => {
    recv.push(chunk.toString())
    const joined = recv.join('')
    // Split on CRLF. The last element may be an incomplete line — keep it in
    // recv so it is prepended to the next chunk. Clearing the buffer and
    // re-pushing the partial line is equivalent to a sliding window drain.
    const lines = joined.split('\r\n')
    const partial = lines.pop() ?? ''
    recv.length = 0
    if (partial) recv.push(partial)

    // Process ALL complete terminal response lines in this chunk. TCP can
    // deliver multiple SMTP responses (e.g. several RCPT TO 250 OKs) in a
    // single read, so draining only the first causes rcptPending to stall.
    for (const line of lines) {
      if (!/^\d{3} /.test(line)) continue

      const code = parseInt(line.slice(0, 3), 10)
      if (code >= 400) { socket.destroy(); reject(new Error(`SMTP ${code}: ${line.trim()}`)); return }

      if      (phase === 0 && code === 250) { phase = 1; send('AUTH LOGIN') }
      else if (phase === 1 && code === 334) { phase = 2; send(Buffer.from(user).toString('base64')) }
      else if (phase === 2 && code === 334) { phase = 3; send(Buffer.from(pass).toString('base64')) }
      else if (phase === 3 && code === 235) { phase = 4; send(`MAIL FROM:<${user}>`) }
      else if (phase === 4 && code === 250) {
        // MAIL FROM accepted: send all RCPT TOs, wait for each 250 before DATA.
        phase = 5
        rcptPending = rcptAddrs.length
        for (const addr of rcptAddrs) send(`RCPT TO:<${addr.trim()}>`)
      } else if (phase === 5 && code === 250) {
        // Each RCPT TO 250 acknowledgement. When all are collected, send DATA.
        rcptPending--
        if (rcptPending === 0) { phase = 6; send('DATA') }
      } else if (phase === 6 && code === 354) {
        phase = 7
        const { contentType, mimeBody } = buildMimeBody(body, html)
        const hdrs = [
          `From: ${sanitizeHeader(from || user)}`, `To: ${sanitizeHeader(to)}`,
          ...(cc ? [`Cc: ${sanitizeHeader(cc)}`] : []),
          `Subject: ${sanitizeHeader(subject)}`, 'MIME-Version: 1.0',
          `Content-Type: ${contentType}`, '',
        ].join('\r\n')
        socket.write(hdrs + '\r\n' + dotStuff(mimeBody) + '\r\n.\r\n')
      } else if (phase === 7 && code === 250) { phase = 8; send('QUIT') }
      else if  (phase === 8 && code === 221) { socket.destroy(); resolve() }
    }
  })
}

// Extract the first terminal SMTP response line ("NNN " with a space, not a dash)
// from a buffer. Clears the buffer on match.
function parseTerminal(buf: string[]): { code: number; line: string } | null {
  const joined = buf.join('')
  const line = joined.split('\r\n').find((l) => /^\d{3} /.test(l))
  if (!line) return null
  buf.length = 0
  return { code: parseInt(line.slice(0, 3), 10), line }
}

function smtpSslSend(
  host: string, port: number, user: string, pass: string,
  to: string, subject: string, body: string, cc = '', from = '', html?: string,
): Promise<void> {
  if (port === 465) {
    // Direct TLS (SMTP_SSL): await 220 greeting, send EHLO, hand off to auth machine.
    return new Promise((resolve, reject) => {
      const socket = tls.connect({ host, port, servername: host }, () => {
        const recv: string[] = []
        const onGreeting = (chunk: Buffer) => {
          recv.push(chunk.toString())
          const r = parseTerminal(recv)
          if (!r) return
          if (r.code === 220) {
            socket.removeListener('data', onGreeting)
            socket.write(`EHLO ${os.hostname()}\r\n`)
            attachAuthStateMachine(socket, user, pass, to, subject, body, cc, resolve, reject, from, html)
          } else if (r.code >= 400) {
            socket.destroy(); reject(new Error(`SMTP ${r.code}: ${r.line.trim()}`))
          }
        }
        socket.on('data', onGreeting)
      })
      socket.setTimeout(15_000, () => { socket.destroy(); reject(new Error('SMTP connection timed out')) })
      socket.on('error', (err) => { socket.destroy(); reject(err instanceof Error ? err : new Error(String(err))) })
    })
  }

  // STARTTLS (port 587 or any non-465): plain socket → greeting → EHLO → STARTTLS
  // → TLS upgrade → EHLO again → shared auth state machine.
  return new Promise((resolve, reject) => {
    const plain = net.createConnection({ host, port })
    const buf: string[] = []
    let phase = 0 // 0=greeting, 1=EHLO resp, 2=STARTTLS resp

    plain.on('data', (chunk: Buffer) => {
      buf.push(chunk.toString())
      const r = parseTerminal(buf)
      if (!r) return
      if (r.code >= 400) { plain.destroy(); reject(new Error(`SMTP ${r.code}: ${r.line.trim()}`)); return }

      if (phase === 0 && r.code === 220) { phase = 1; plain.write(`EHLO ${os.hostname()}\r\n`) }
      else if (phase === 1 && r.code === 250) { phase = 2; plain.write('STARTTLS\r\n') }
      else if (phase === 2 && r.code === 220) {
        plain.removeAllListeners('data')
        plain.removeAllListeners('error')
        plain.removeAllListeners('timeout')
        plain.setTimeout(0) // disarm the plain-socket timer before TLS wraps it
        const tlsSocket = tls.connect({ socket: plain, servername: host }, () => {
          tlsSocket.write(`EHLO ${os.hostname()}\r\n`) // RFC 3207: re-send EHLO after upgrade
          attachAuthStateMachine(tlsSocket, user, pass, to, subject, body, cc, resolve, reject, from, html)
        })
        tlsSocket.setTimeout(15_000, () => { tlsSocket.destroy(); reject(new Error('SMTP connection timed out')) })
        tlsSocket.on('error', (err) => { tlsSocket.destroy(); reject(err instanceof Error ? err : new Error(String(err))) })
      }
    })
    plain.setTimeout(15_000, () => { plain.destroy(); reject(new Error('SMTP connection timed out')) })
    plain.on('error', (err) => { plain.destroy(); reject(err) })
  })
}

export async function mailSend(to: string, subject: string, body: string, cc = '', from = '', html?: string): Promise<{ content: string; isError?: boolean }> {
  const smtpHost = getSecret('gmail_host')
  const smtpUser = getSecret('gmail_user')
  const smtpPass = getSecret('gmail_app_password')
  const smtpPortStr = getSecret('gmail_port') ?? '465'

  if (!smtpHost || !smtpUser || !smtpPass) return { content: draftEml(to, subject, body, cc, '', from, html), isError: true }

  const smtpPort = parseInt(smtpPortStr, 10) || 465
  let smtpTimeoutHandle: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      smtpSslSend(smtpHost, smtpPort, smtpUser, smtpPass, to, subject, body, cc, from, html),
      new Promise<never>((_, reject) => {
        smtpTimeoutHandle = setTimeout(
          () => reject(new Error('SMTP connection timed out after 30s')),
          SMTP_ABSOLUTE_TIMEOUT_MS,
        )
      }),
    ])
    return { content: `Email sent to ${to}` }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    recordError('mail_send', err, { rateKey: 'mail_send' })
    return { content: draftEml(to, subject, body, cc, msg, from, html), isError: true }
  } finally {
    clearTimeout(smtpTimeoutHandle)
  }
}
