#!/usr/bin/env node
// Self-contained CLI: reads JSON on stdin, creates an approval row in the
// Jarvis SQLite DB, posts an immediate Discord digest, prints the new id.
//
// Deployed to ~/bin/jarvis-create-approval on M2.
// Env var AGENT_DATA_DIR overrides the default ~/.jarvis DB location.

'use strict'

const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

// ---------------------------------------------------------------------------
// DB path (matches harness-ts/src/memory/episodic.ts resolution)
// ---------------------------------------------------------------------------

const dataDir = process.env['AGENT_DATA_DIR']
  ? process.env['AGENT_DATA_DIR'].replace('~', os.homedir())
  : path.join(os.homedir(), '.jarvis')
const dbPath = path.join(dataDir, 'conversations.db')

// better-sqlite3 lives in the harness-ts node_modules tree on the Mini
const sqlitePath = path.join(os.homedir(), 'Jarvis/harness-ts/node_modules/better-sqlite3')
let Database
try {
  Database = require(sqlitePath)
} catch {
  // Fallback: bare require for local dev with better-sqlite3 on PATH
  Database = require('better-sqlite3')
}

// ---------------------------------------------------------------------------
// Discord webhook URL from macOS Keychain
// ---------------------------------------------------------------------------

function readWebhookUrl() {
  // SSH context can't read login Keychain (exit 36), so prefer env var when set.
  // Workflows passing the URL via SSH command env hit this path; LaunchAgent context
  // falls through to Keychain.
  const fromEnv = process.env['DISCORD_WEBHOOK_URL']
  if (fromEnv && fromEnv.trim()) return fromEnv.trim()

  const service = 'jarvis-discord-webhook'
  const account = process.env['USER'] ?? '<username>'
  const result = spawnSync('security', ['find-generic-password', '-s', service, '-a', account, '-w'])
  if (result.status !== 0) {
    throw new Error(`Discord webhook URL not in env DISCORD_WEBHOOK_URL and not found in Keychain (service=${service}, account=${account})`)
  }
  return result.stdout.toString().trim()
}

// ---------------------------------------------------------------------------
// Digest formatter (mirrors harness-ts/src/discord/digest.ts formatDigestMessage)
// ---------------------------------------------------------------------------

const RISK_LABELS = { risky: '⚠️', safe: '' }

function formatDigestMessage(pending) {
  if (pending.length === 0) return 'Jarvis · no changes waiting approval.'

  const header = `Jarvis · ${pending.length} change${pending.length === 1 ? '' : 's'} waiting approval:\n`

  const items = pending.map((a, i) => {
    const num = i + 1
    const issueRef = a.github_issue_number != null ? `#${a.github_issue_number} — ` : ''
    const riskMark = RISK_LABELS[a.risk_tier] ? ` ${RISK_LABELS[a.risk_tier]}` : ''
    const files = a.files_changed && a.files_changed.length > 0
      ? `\n     touches: ${a.files_changed.slice(0, 3).join(', ')}${a.files_changed.length > 3 ? ` (+${a.files_changed.length - 3} more)` : ''}`
      : ''
    return `  ${num}) ${issueRef}${a.summary}\n     ${a.kind}${riskMark}${files}`
  })

  const footer = '\n\nReply: approve 1 / deny 2 / approve #<issue> / approve all / status / pending'
  return header + '\n' + items.join('\n\n') + footer
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Read stdin
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  raw = raw.trim()
  if (!raw) {
    process.stderr.write('ERROR: no input on stdin\n')
    process.exit(1)
  }

  let input
  try {
    input = JSON.parse(raw)
  } catch (err) {
    process.stderr.write(`ERROR: invalid JSON on stdin: ${err.message}\n`)
    process.exit(1)
  }

  const { kind, github_run_id, summary, files_changed, risk_tier } = input
  if (!kind || !summary || !risk_tier) {
    process.stderr.write('ERROR: required fields: kind, summary, risk_tier\n')
    process.exit(1)
  }

  // Open DB (creates tables if absent via initSchema equivalent)
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')

  // Ensure approvals table exists (defensive — normally created by harness-ts)
  db.exec(`
    CREATE TABLE IF NOT EXISTS approvals (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      kind                  TEXT    NOT NULL,
      github_run_id         TEXT,
      github_issue_number   INTEGER,
      summary               TEXT    NOT NULL,
      files_changed         TEXT,
      diff_excerpt          TEXT,
      risk_tier             TEXT    NOT NULL,
      discord_message_id    TEXT,
      discord_local_index   INTEGER,
      requested_at          INTEGER NOT NULL,
      decided_at            INTEGER,
      decision              TEXT,
      decided_by            TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_approvals_pending ON approvals(decided_at) WHERE decided_at IS NULL;
  `)

  // Insert the approval row
  const stmt = db.prepare(`
    INSERT INTO approvals (kind, github_run_id, github_issue_number, summary, files_changed, risk_tier, requested_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  const result = stmt.run(
    kind,
    github_run_id ?? null,
    input.github_issue_number ?? null,
    summary,
    files_changed && files_changed.length > 0 ? JSON.stringify(files_changed) : null,
    risk_tier,
    Date.now(),
  )
  const newId = result.lastInsertRowid

  // Fetch all pending rows to build the digest (including the one we just inserted)
  const rows = db.prepare(`SELECT * FROM approvals WHERE decided_at IS NULL ORDER BY requested_at ASC`).all()
  const pending = rows.map(row => ({
    id: row.id,
    kind: row.kind,
    github_run_id: row.github_run_id,
    github_issue_number: row.github_issue_number,
    summary: row.summary,
    files_changed: row.files_changed ? (() => { try { return JSON.parse(row.files_changed) } catch { return null } })() : null,
    risk_tier: row.risk_tier,
    discord_message_id: row.discord_message_id,
    discord_local_index: row.discord_local_index,
  }))

  // Post digest to Discord
  let webhookUrl
  try {
    webhookUrl = readWebhookUrl()
  } catch (err) {
    process.stderr.write(`ERROR: ${err.message}\n`)
    db.close()
    process.exit(1)
  }

  const content = formatDigestMessage(pending)
  const DISCORD_CONTENT_LIMIT = 2000
  const truncated = content.length > DISCORD_CONTENT_LIMIT
    ? content.slice(0, DISCORD_CONTENT_LIMIT - 15) + '... (truncated)'
    : content

  const res = await fetch(`${webhookUrl}?wait=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: truncated }),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '(no body)')
    process.stderr.write(`ERROR: Discord webhook failed: HTTP ${res.status} -- ${text}\n`)
    db.close()
    process.exit(1)
  }

  const json = await res.json()
  const messageId = String(json.id ?? '')

  // Bind the returned message ID and per-approval local indices
  if (messageId) {
    const update = db.prepare(`UPDATE approvals SET discord_message_id = ?, discord_local_index = ? WHERE id = ?`)
    const bind = db.transaction(() => {
      pending.forEach((a, i) => update.run(messageId, i + 1, a.id))
    })
    bind()
  }

  db.close()

  // Print only the new id to stdout for the caller to capture
  process.stdout.write(String(newId) + '\n')
}

main().catch(err => {
  process.stderr.write(`ERROR: ${err.message}\n`)
  process.exit(1)
})
