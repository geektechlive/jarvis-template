// Patrol routines for the proactive scheduler.
// Routines: log_patrol, commit_patrol, issue_patrol, improve_patrol, issue_resolver.
// Extracted from watch.ts to keep both files under the 800-line limit.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { log } from 'ion-sdk'
import { logEvent } from '../../memory/episodic'
import { isEnabled, isQuietHours } from '../helpers'
import { getSchedulerCtx } from '../ctx'
import { resolveNextAutoIssue, RESOLVER_MAX_RUN_MS } from '../../patrol/resolver'
import { notifyPatrolCycle } from '../../discord/notify'
import { runCommandAsync } from '../../util/ionPrompt'
import { runClaudeAgent } from '../../util/claudeAgent'
import { dispatchStaff } from '../../staff/dispatch'
import { readLogSlice } from './log-patrol-cursor'

const REPO_ROOT = process.env['JARVIS_REPO_ROOT'] ?? path.join(os.homedir(), 'Jarvis')

// ---------------------------------------------------------------------------
// Patrol utilities (internal to this module)
// ---------------------------------------------------------------------------

const isPatrolClear = (output: string | null): boolean =>
  output !== null && output.split('\n').some((line) => /^\**\s*PATROL_CLEAR\s*\**[.!]?\s*$/i.test(line.trim()))

// Read the deliberately-accepted findings list so patrol prompts can include
// it. Empty string if missing — patrol still runs, just without the filter.
function readPatrolIgnoreList(): string {
  try {
    const ignorePath = path.join(REPO_ROOT, 'docs', 'patrol-ignore.md')
    return fs.readFileSync(ignorePath, 'utf8')
  } catch {
    return ''
  }
}

function patrolIgnoreSection(): string {
  const content = readPatrolIgnoreList()
  if (!content) return ''
  return (
    `\n=== Patrol ignore list (read carefully, then skip any candidate that matches an entry) ===\n` +
    `The following findings have been deliberately accepted by the principal. Do NOT file an issue ` +
    `for anything matching an entry below; treat the candidate as noise. If you are uncertain whether ` +
    `a finding matches, err on the side of NOT filing.\n\n` +
    content +
    `\n=== End ignore list ===\n\n`
  )
}

// Window for treating a CLOSED issue as still-decided. A closed patrol issue
// inside this window means we already acted on it (fixed, or deliberately
// declined) -- re-filing it is the "same issue over and over" noise.
const PATROL_CLOSED_LOOKBACK_DAYS = 30

// Shared dedup-reference instruction. The earlier prompts only fetched OPEN
// issues, so anything we closed was re-discovered and re-filed on the next run.
// This makes every filing patrol also consult recently-closed issues and treat
// them as already-handled. Returns a single numbered-step body.
function patrolDedupReference(): string {
  const since = new Date(Date.now() - PATROL_CLOSED_LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10)
  return (
    `Build a dedup reference before filing anything. Fetch BOTH sets:\n` +
    `   - Open patrol issues:    gh issue list --repo <your-org>/jarvis --state open --label jarvis-patrol --limit 200 --json number,title\n` +
    `   - Recently-closed issues: gh issue list --repo <your-org>/jarvis --state closed --label jarvis-patrol --search 'closed:>=${since}' --limit 200 --json number,title,closedAt\n` +
    `   A candidate is ALREADY HANDLED if it matches (semantically) an open issue, a recently-closed issue, OR a patrol ignore-list entry. A recently-closed issue means we already decided it -- do NOT re-file it. Only if a recently-closed issue has clearly REGRESSED (the same failure is live again with fresh evidence in THIS run) reopen it with a comment (gh issue reopen <number> --repo <your-org>/jarvis --comment '...') instead of opening a duplicate.\n`
  )
}

// Shared root-cause + clustering guidance. The earlier prompts filed one issue
// per symptom and judged only "real error vs noise", which produced a backlog of
// shallow, near-duplicate issues each describing a symptom of the same gap. This
// pushes every filing patrol to cluster by root cause and judge materiality
// before filing, so it surfaces fewer, deeper, more actionable issues.
function patrolRootCauseGuidance(): string {
  return (
    `Before filing, diagnose and cluster -- do NOT file one issue per symptom:\n` +
    `   - Group candidates by ROOT CAUSE. If several errors or problems share one underlying cause (a missing guard, an inconsistent helper, an unchecked boundary, a copy-pasted block), file ONE issue that names the root cause and lists the individual symptoms as evidence -- not one issue per symptom.\n` +
    `   - Judge materiality. Only file what is genuinely worth an engineer's time to fix. A self-correcting blip, a one-off transient, or a cosmetic nit is noise -- skip it. Prefer fewer, higher-signal issues.\n` +
    `   - Frame each issue around the root cause and its impact, with concrete evidence (log excerpt, sha, file:line), and state what the correct fix must address -- not just where the symptom appears -- so a resolver fixes the cause rather than patching the symptom.\n\n`
  )
}

interface GithubIssue {
  number: number
  title: string
  labels: Array<{ name: string }>
  url: string
}

async function fetchPatrolIssues(routineName: string, context: 'before' | 'after'): Promise<GithubIssue[]> {
  try {
    const r = await runCommandAsync('gh', [
      'issue', 'list',
      '--repo', '<your-org>/jarvis',
      '--state', 'open',
      '--label', 'jarvis-patrol',
      '--json', 'number,title,labels,url',
      '--limit', '200',
    ], { timeoutMs: 30_000 })
    if (!r.error) {
      return JSON.parse(r.stdout.trim()) as GithubIssue[]
    }
  } catch (err) {
    log.warn(`scheduler: ${routineName}: failed to fetch ${context}-state issues`, { err: String(err) })
  }
  return []
}

/**
 * Query open jarvis-patrol issues before and after a patrol run,
 * and notify on newly opened/closed issues via a single digest.
 */
async function notifyPatrolChanges(
  routineName: string,
  beforeIssues: GithubIssue[],
  afterIssues: GithubIssue[],
  openBacklog?: number,
): Promise<void> {
  const beforeSet = new Set(beforeIssues.map(i => i.number))
  const afterSet = new Set(afterIssues.map(i => i.number))

  const opened: Array<{ number: number; title: string; url: string; riskTier: 'safe' | 'risky' }> = []
  const closed: Array<{ number: number; title: string; url: string; riskTier: 'safe' | 'risky' }> = []

  // Newly opened
  for (const issue of afterIssues) {
    if (!beforeSet.has(issue.number)) {
      const severityLabel = issue.labels.find(l => l.name.startsWith('severity:'))?.name
      const riskTier = (severityLabel === 'severity: low' || severityLabel === 'severity: medium') ? 'safe' : 'risky'
      opened.push({
        number: issue.number,
        title: issue.title,
        url: issue.url,
        riskTier,
      })
    }
  }

  // Closed
  for (const issue of beforeIssues) {
    if (!afterSet.has(issue.number)) {
      const severityLabel = issue.labels.find(l => l.name.startsWith('severity:'))?.name
      const riskTier = (severityLabel === 'severity: low' || severityLabel === 'severity: medium') ? 'safe' : 'risky'
      closed.push({
        number: issue.number,
        title: issue.title,
        url: issue.url,
        riskTier,
      })
    }
  }

  try {
    await notifyPatrolCycle({ routine: routineName, opened, closed, openBacklog })
  } catch (err) {
    log.warn('scheduler: notifyPatrolChanges failed', { err: String(err) })
  }
}

/**
 * Run a patrol routine via ctx.dispatchAgent (Ion-native) when a root ctx is
 * available, or fall back to runClaudeAgent for cold-start. Returns the agent
 * output string so callers can check for PATROL_CLEAR.
 */
async function dispatchPatrol(
  routineName: string,
  prompt: string,
  opts: { model: string; timeoutMs: number },
): Promise<string | null> {
  const ctx = getSchedulerCtx()
  if (ctx) {
    try {
      // Use background dispatch so the patrol routine returns immediately and
      // the 50-turn eng-lead session runs without blocking the scheduler slot.
      // onComplete / onError surface the terminal outcome for observability.
      await dispatchStaff(ctx, 'eng-lead', prompt, {
        model: opts.model,
        maxTurns: 50,
        background: true,
        onComplete: (r) => {
          logEvent(routineName, 'routine_delivered', { routine: routineName, dispatched: true, cost: r.cost })
        },
        onError: (err) => {
          logEvent(routineName, 'routine_failed', { routine: routineName, error: err.message })
          log.warn(`patrol: eng-lead dispatch failed`, { err: err.message })
        },
      })
      // Return immediately after background dispatch — the agent runs in the
      // background and will deliver results via onComplete/onError.
      return null
    } catch (err) {
      const msg = String(err)
      if (msg.includes('dispatch not available')) {
        // ion dispatch genuinely unavailable in this async context -- fall through
        // to subprocess so the patrol still runs.
        log.info(`scheduler: ${routineName}: ion dispatch unavailable in async context, falling back to Claude CLI`)
      } else {
        log.warn(`scheduler: ${routineName}: dispatchAgent failed, falling back to Claude CLI`, { err: msg })
      }
    }
  }
  return runClaudeAgent(routineName, prompt, opts)
}

// ---------------------------------------------------------------------------
// Patrol routine implementations
// ---------------------------------------------------------------------------

export async function runLogPatrol(): Promise<void> {
  if (!isEnabled('log_patrol')) return
  if (isQuietHours()) return
  const timestamp = new Date().toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    hour: '2-digit', minute: '2-digit', hour12: true,
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  })

  const beforeIssues = await fetchPatrolIssues('log_patrol', 'before')

  const engineLogPath = path.join(os.homedir(), '.ion', 'engine.log')
  const vectorLogPath = path.join(REPO_ROOT, 'logs', 'vector.error.log')
  const voiceLogPath = path.join(REPO_ROOT, 'logs', 'voice.error.log')
  const engineLogContent = readLogSlice(engineLogPath, 100)
  const vectorLogContent = readLogSlice(vectorLogPath, 100)
  const voiceLogContent = readLogSlice(voiceLogPath, 50)

  const logContext = [
    engineLogContent ? `=== ~/.ion/engine.log (last 100 lines) ===\n${engineLogContent}` : '',
    vectorLogContent ? `\n=== ~/Jarvis/logs/vector.error.log (last 100 lines) ===\n${vectorLogContent}` : '',
    voiceLogContent ? `\n=== ~/Jarvis/logs/voice.error.log (last 50 lines) ===\n${voiceLogContent}` : '',
  ].filter(Boolean).join('\n')

  const output = await dispatchPatrol(
    'log_patrol',
    `Automated log patrol for Jarvis. It is ${timestamp} CT.\n\n` +
    `You are the Engineering Lead. Scan runtime error logs for real errors and file GitHub issues. Be selective -- noise, warnings, and expected retries are not issues.\n\n` +
    `Log content (already fetched, cursor-aware):\n${logContext}\n\n` +
    patrolIgnoreSection() +
    patrolRootCauseGuidance() +
    `Steps:\n` +
    `1. Analyze the log content above for real errors (not noise, warnings, or expected retries). Hold a full list before proceeding.\n` +
    `2. ${patrolDedupReference()}` +
    `3. For EACH candidate in your list:\n` +
    `   a. Compare it semantically against the dedup reference above (open AND recently-closed issues) and the patrol ignore list. If the candidate is ALREADY HANDLED, skip it and continue to the next one.\n` +
    `   b. If it is not already handled, file a new issue: gh issue create --repo <your-org>/jarvis --title '...' --body '...' --label 'jarvis-patrol' --label 'bug' --label 'jarvis-auto'\n` +
    `      Include the relevant log excerpt in the issue body.\n` +
    `      Also add ONE severity label (severity: critical / severity: high / severity: medium / severity: low) based on impact.\n` +
    `      Also add ONE area label based on what system is affected: area: typescript, area: python, area: ios, area: go.\n` +
    `   c. NEVER stop early because one candidate was a duplicate -- always check every remaining candidate.\n` +
    `4. After checking ALL candidates: if every candidate was either noise or already tracked by an open issue, output exactly: PATROL_CLEAR\n\n` +
    `Only use these labels (they exist in the repo): jarvis-patrol, jarvis-auto, bug, enhancement, severity: critical, severity: high, severity: medium, severity: low, area: typescript, area: python, area: ios, area: go.`,
    { model: 'claude-sonnet-4-6', timeoutMs: 540_000 },
  )

  const afterIssues = await fetchPatrolIssues('log_patrol', 'after')
  await notifyPatrolChanges('log_patrol', beforeIssues, afterIssues, afterIssues.length)

  if (output === null) {
    logEvent('log_patrol', 'routine_delivered', { routine: 'log_patrol', result: 'timeout' })
    log.warn('scheduler: log_patrol: dispatch timed out')
  } else if (isPatrolClear(output)) {
    logEvent('log_patrol', 'routine_delivered', { routine: 'log_patrol', result: 'patrol_clear' })
    log.info('scheduler: log_patrol: patrol_clear')
  } else {
    logEvent('log_patrol', 'routine_delivered', { routine: 'log_patrol', result: output ? 'issues_filed' : 'error' })
    log.info('scheduler: log_patrol: productive run (issues filed or agent output present)')
  }
}

const COMMIT_CURSOR_PATH = path.join(os.homedir(), '.jarvis', 'patrol-commit-cursor.txt')
const IMPROVE_PATROL_CURSOR_PATH = path.join(os.homedir(), '.jarvis', 'patrol-improve-cursor.txt')

export async function runCommitPatrol(): Promise<void> {
  if (!isEnabled('commit_patrol')) return
  if (isQuietHours()) return
  const timestamp = new Date().toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    hour: '2-digit', minute: '2-digit', hour12: true,
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  })

  // Read cursor (last reviewed HEAD SHA)
  let lastSha: string | undefined
  try {
    lastSha = fs.readFileSync(COMMIT_CURSOR_PATH, 'utf8').trim() || undefined
  } catch {
    // No cursor file yet -- first run
  }

  // Capture current HEAD
  let headSha: string
  try {
    const { stdout: headOut } = await runCommandAsync(
      'git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD'],
      { timeoutMs: 10_000 },
    )
    headSha = headOut.trim()
  } catch (err) {
    log.warn('scheduler: commit_patrol: failed to resolve HEAD', { err: String(err) })
    return
  }

  // If cursor exists, check whether there are new commits at all
  if (lastSha !== undefined) {
    let newCommits: string
    try {
      const { stdout: commitOut } = await runCommandAsync(
        'git', ['-C', REPO_ROOT, 'log', '--oneline', `${lastSha}..HEAD`],
        { timeoutMs: 10_000 },
      )
      newCommits = commitOut.trim()
    } catch {
      newCommits = ''
    }
    if (newCommits === '') {
      log.info('scheduler: commit_patrol: no_new_commits since last patrol')
      logEvent('commit_patrol', 'routine_delivered', { routine: 'commit_patrol', result: 'no_new_commits' })
      return
    }
  }

  const beforeIssues = await fetchPatrolIssues('commit_patrol', 'before')

  const logCommand = lastSha !== undefined
    ? `git -C ~/Jarvis log --oneline ${lastSha}..HEAD`
    : `git -C ~/Jarvis log --oneline -10`

  const output = await dispatchPatrol(
    'commit_patrol',
    `Automated commit patrol for Jarvis. It is ${timestamp} CT.\n\n` +
    `You are the Engineering Lead. Review recent commits for code quality problems or regressions and file GitHub issues. Be selective -- only file issues for real problems.\n\n` +
    patrolIgnoreSection() +
    patrolRootCauseGuidance() +
    `Steps:\n` +
    `1. Run: ${logCommand}\n` +
    `2. Review the diffs for commits of interest: git -C ~/Jarvis show --stat <sha> for each relevant sha\n` +
    `3. From the commit review, enumerate ALL candidate problems (quality issues, regressions -- be selective). Hold this full list before proceeding.\n` +
    `4. ${patrolDedupReference()}` +
    `5. For EACH candidate in your list:\n` +
    `   a. Compare it semantically against the dedup reference above (open AND recently-closed issues) and the patrol ignore list. If the candidate is ALREADY HANDLED, skip it and continue to the next one.\n` +
    `   b. If it is not already handled, file a new issue. Must be specific and actionable (not vague):\n` +
    `      gh issue create --repo <your-org>/jarvis --title '...' --body '...' --label 'jarvis-patrol'\n` +
    `      For bugs: also --label 'bug' AND --label 'jarvis-auto'. Do NOT add jarvis-auto to enhancements.\n` +
    `      For code quality improvements: also --label 'enhancement'. Never add jarvis-auto to enhancement issues.\n` +
    `      Also add ONE severity label: severity: critical / severity: high / severity: medium / severity: low.\n` +
    `      Also add ONE area label: area: typescript, area: python, area: ios, area: go.\n` +
    `   c. NEVER stop early because one candidate was a duplicate -- always check every remaining candidate.\n` +
    `6. After checking ALL candidates: if all were already tracked or nothing actionable was found, output exactly: PATROL_CLEAR\n\n` +
    `Only use these labels (they exist in the repo): jarvis-patrol, jarvis-auto, bug, enhancement, severity: critical, severity: high, severity: medium, severity: low, area: typescript, area: python, area: ios, area: go.`,
    { model: 'claude-sonnet-4-6', timeoutMs: 540_000 },
  )

  const afterIssues = await fetchPatrolIssues('commit_patrol', 'after')
  await notifyPatrolChanges('commit_patrol', beforeIssues, afterIssues, afterIssues.length)

  // Write cursor after agent completes — only when agent produced actual output.
  // null means the dispatch timed out; empty string means the agent produced no
  // output. Either way, do not advance the cursor so those commits are retried.
  if (output !== null && output.length > 0) {
    try {
      fs.mkdirSync(path.dirname(COMMIT_CURSOR_PATH), { recursive: true })
      fs.writeFileSync(COMMIT_CURSOR_PATH, headSha, 'utf8')
    } catch (err) {
      log.warn('scheduler: commit_patrol: failed to write cursor', { err: String(err) })
    }
  }

  if (output === null) {
    logEvent('commit_patrol', 'routine_delivered', { routine: 'commit_patrol', result: 'timeout' })
    log.warn('scheduler: commit_patrol: dispatch timed out')
  } else if (isPatrolClear(output)) {
    logEvent('commit_patrol', 'routine_delivered', { routine: 'commit_patrol', result: 'patrol_clear' })
    log.info('scheduler: commit_patrol: patrol_clear')
  } else {
    logEvent('commit_patrol', 'routine_delivered', { routine: 'commit_patrol', result: output ? 'issues_filed' : 'error' })
    log.info('scheduler: commit_patrol: productive run (issues filed or agent output present)')
  }
}

export async function runIssuePatrol(): Promise<void> {
  if (!isEnabled('issue_patrol')) return
  if (isQuietHours()) return
  const timestamp = new Date().toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    hour: '2-digit', minute: '2-digit', hour12: true,
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  })

  const beforeIssues = await fetchPatrolIssues('issue_patrol', 'before')

  const output = await dispatchPatrol(
    'issue_patrol',
    `Automated issue patrol for Jarvis. It is ${timestamp} CT.\n\n` +
    `You are the Engineering Lead. Triage existing open jarvis-patrol issues. Do NOT file new issues -- this patrol only triages.\n\n` +
    patrolIgnoreSection() +
    `Steps:\n` +
    `1. List open jarvis-patrol issues: gh issue list --repo <your-org>/jarvis --state open --label 'jarvis-patrol' --limit 200 --json number,title,labels,createdAt,body\n` +
    `2. For each issue returned, assess:\n` +
    `   - Does it match an entry on the patrol ignore list above? If yes, close it with a comment referencing the ignore list: gh issue close <number> --repo <your-org>/jarvis --comment 'Closing: matches an accepted entry in docs/patrol-ignore.md.'\n` +
    `   - Is it actually resolved already (check recent commits or code)? If yes, close it: gh issue close <number> --repo <your-org>/jarvis --comment 'Closing: appears resolved in recent commits.'\n` +
    `   - Is it stale with no activity and no longer relevant? If yes, close it with explanation.\n` +
    `   - Are there patterns across multiple issues that suggest a single root cause?\n` +
    `   - Are there near-duplicate issues — multiple issues with near-identical titles or describing the same underlying bug? If yes, pick the most informative one to keep, then close the redundant ones with: gh issue close <number> --repo <your-org>/jarvis --comment 'Closing as near-duplicate of #<kept-issue>. Root cause and context consolidated there.'\n` +
    `3. If all issues look valid, distinct, and active, output exactly: PATROL_CLEAR\n\n` +
    `Only close issues when clearly justified. Do not close issues speculatively.`,
    { model: 'claude-sonnet-4-6', timeoutMs: 540_000 },
  )

  const afterIssues = await fetchPatrolIssues('issue_patrol', 'after')
  await notifyPatrolChanges('issue_patrol', beforeIssues, afterIssues, afterIssues.length)

  if (output === null) {
    logEvent('issue_patrol', 'routine_delivered', { routine: 'issue_patrol', result: 'timeout' })
    log.warn('scheduler: issue_patrol: dispatch timed out')
  } else if (isPatrolClear(output)) {
    logEvent('issue_patrol', 'routine_delivered', { routine: 'issue_patrol', result: 'patrol_clear' })
    log.info('scheduler: issue_patrol: patrol_clear')
  } else {
    logEvent('issue_patrol', 'routine_delivered', { routine: 'issue_patrol', result: output ? 'issues_filed' : 'error' })
    log.info('scheduler: issue_patrol: productive run (issues closed or agent output present)')
  }
}

const IMPROVE_FOCUSES = [
  {
    name: 'scheduler-and-routines',
    files: [
      '~/Jarvis/harness-ts/src/scheduler/index.ts',
      '~/Jarvis/harness-ts/src/scheduler/helpers.ts',
      '~/Jarvis/harness/config/routines.yaml',
    ],
    angle: 'Focus on: routine timing, quiet-hours logic, missed triggers, patrol health, scheduler lock behaviour, and anything that could cause a routine to silently fail or double-fire.',
  },
  {
    name: 'memory-and-learning',
    files: [
      '~/Jarvis/harness-ts/src/memory/episodic.ts',
      '~/Jarvis/harness-ts/src/learning/index.ts',
      '~/Jarvis/harness-ts/src/recall.ts',
    ],
    angle: 'Focus on: fact extraction quality, dedup thresholds, memory decay, FTS vs vector routing, learning gap detection, and any data loss or silent failure paths in the memory pipeline.',
  },
  {
    name: 'patrol-and-resolver',
    files: [
      '~/Jarvis/harness-ts/src/patrol/resolver.ts',
      '~/Jarvis/harness-ts/src/scheduler/routines/patrol.ts',
    ],
    angle: 'Focus on: resolver selection logic, issue dedup gaps, PATROL_CLEAR signal handling, patrol timeout risks, cursor drift, and whether the four patrols have overlapping or missing coverage.',
  },
  {
    name: 'staff-and-routing',
    files: [
      '~/Jarvis/harness/config/staff.yaml',
      '~/Jarvis/harness-ts/src/extension.ts',
    ],
    angle: 'Focus on: staff domain gaps (tasks with no clear owner), routing ambiguity, agent spec quality, missing staff members, and intent routing edge cases that could cause Jarvis to self-answer instead of delegating.',
  },
  {
    name: 'identity-and-persona',
    files: [
      '~/Jarvis/harness/identity/BEHAVIOR.md',
      '~/Jarvis/harness/identity/MISSION.md',
      '~/Jarvis/harness/identity/GOALS.md',
      '~/Jarvis/harness/identity/PROJECTS.md',
    ],
    angle: 'Focus on: behavioral gaps (guidance missing for real situations Jarvis encounters), goal staleness or misalignment with actual principal priorities, mission drift from how the system actually operates, and projects that should be tracked but are absent. Bar for filing an issue is HIGH: only file if adding or changing the guidance would make Jarvis materially more effective or accurate for the principal. Do NOT file issues for prose style, word choice, paragraph rewrites, or "could be clearer" observations -- only file when a substantive behavioral rule, goal, or constraint is missing, wrong, or outdated. Every issue must state exactly what should be added/changed and why it would improve Jarvis\'s effectiveness.',
  },
  {
    name: 'tools-and-integrations',
    files: [
      '~/Jarvis/harness-ts/src/tools/calendar.ts',
      '~/Jarvis/harness-ts/src/tools/mail.ts',
      '~/Jarvis/harness-ts/src/tools/spotlight.ts',
      '~/Jarvis/harness/config/integrations.yaml',
    ],
    angle: 'Focus on: tool reliability, error handling, timeout gaps, missing tools that Jarvis clearly needs (e.g. based on what staff agents currently do manually), and integrations that exist in config but aren\'t wired to tools.',
  },
] as const

export async function runImprovePatrol(): Promise<void> {
  if (!isEnabled('improve_patrol')) return
  if (isQuietHours()) return
  const timestamp = new Date().toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    hour: '2-digit', minute: '2-digit', hour12: true,
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  })
  let lastFocusIndex = -1
  try {
    const raw = fs.readFileSync(IMPROVE_PATROL_CURSOR_PATH, 'utf8').trim()
    // Name-based cursor (current): look up by focus name to survive array reshuffles.
    // Legacy integer cursor: treat as old index for one cycle then switch to name-based.
    const nameIdx = (IMPROVE_FOCUSES as readonly { name: string }[]).findIndex(f => f.name === raw)
    if (nameIdx !== -1) {
      lastFocusIndex = nameIdx
    } else {
      const parsed = parseInt(raw, 10)
      if (!isNaN(parsed) && parsed >= 0 && parsed < IMPROVE_FOCUSES.length) {
        lastFocusIndex = parsed
      }
    }
  } catch {
    // No cursor file yet -- first run
  }
  const focusIndex = (lastFocusIndex + 1) % IMPROVE_FOCUSES.length
  const focus = IMPROVE_FOCUSES[focusIndex] ?? IMPROVE_FOCUSES[0]
  const fileList = focus.files.map((f) => `   - ${f}`).join('\n')

  const beforeIssues = await fetchPatrolIssues('improve_patrol', 'before')

  let output: string | null = null
  let dispatchSucceeded = false
  try {
    output = await dispatchPatrol(
      'improve_patrol',
      `Automated improvement patrol for Jarvis. It is ${timestamp} CT.\n\n` +
      `You are the Engineering Lead. Current focus area: ${focus.name}.\n\n` +
      `${focus.angle}\n\n` +
      `Your findings must be specific to this focus area. Do not file generic process or meta improvements -- file only issues you can ground in the files you read.\n\n` +
      patrolIgnoreSection() +
      `Steps:\n` +
      `1. Read these files to understand the current state of the system:\n` +
      `${fileList}\n` +
      `2. From your review, enumerate ALL candidate improvements (gaps, missing features, quality-of-life -- be selective). Hold this full list before proceeding.\n` +
      `3. ${patrolDedupReference()}` +
      `4. For EACH candidate in your list:\n` +
      `   a. Compare it semantically against the dedup reference above (open AND recently-closed issues) and the patrol ignore list. If the candidate is ALREADY HANDLED, skip it and continue to the next one.\n` +
      `   b. If it is not already handled, file a new issue. Must be specific, actionable, with a clear implementation path:\n` +
      `      gh issue create --repo <your-org>/jarvis --title '...' --body '...' --label 'jarvis-patrol' --label 'enhancement'\n` +
      `      Do NOT add jarvis-auto to enhancement issues -- improvements require human design decisions.\n` +
      `      Also add ONE severity label: severity: critical / severity: high / severity: medium / severity: low.\n` +
      `      Also add ONE area label: area: typescript, area: python, area: ios, area: go.\n` +
      `   c. NEVER stop early because one candidate was a duplicate -- always check every remaining candidate.\n` +
      `5. After checking ALL candidates: if all were already tracked or no meaningful improvements were found, output exactly: PATROL_CLEAR\n\n` +
      `Only use these labels (they exist in the repo): jarvis-patrol, jarvis-auto, bug, enhancement, severity: critical, severity: high, severity: medium, severity: low, area: typescript, area: python, area: ios, area: go.`,
      { model: 'claude-sonnet-4-6', timeoutMs: 540_000 },
    )
    dispatchSucceeded = true
  } catch (err) {
    log.warn('scheduler: improve_patrol: dispatch threw', { err: String(err) })
  }
  // Only advance the focus cursor when the agent actually produced output.
  // null = timeout, '' = no output — either way retry the same focus next run.
  // Pattern mirrors commit_patrol.
  if (dispatchSucceeded && output !== null && output.length > 0) {
    try {
      fs.mkdirSync(path.dirname(IMPROVE_PATROL_CURSOR_PATH), { recursive: true })
      fs.writeFileSync(IMPROVE_PATROL_CURSOR_PATH, focus.name, 'utf8')
    } catch (err) {
      log.warn('scheduler: improve_patrol: failed to write focus cursor', { err: String(err) })
    }
  }

  const afterIssues = await fetchPatrolIssues('improve_patrol', 'after')
  await notifyPatrolChanges('improve_patrol', beforeIssues, afterIssues, afterIssues.length)

  if (output === null) {
    logEvent('improve_patrol', 'routine_delivered', { routine: 'improve_patrol', result: 'timeout' })
    log.warn('scheduler: improve_patrol: dispatch timed out')
  } else if (isPatrolClear(output)) {
    logEvent('improve_patrol', 'routine_delivered', { routine: 'improve_patrol', result: 'patrol_clear' })
    log.info('scheduler: improve_patrol: patrol_clear')
  } else {
    logEvent('improve_patrol', 'routine_delivered', { routine: 'improve_patrol', result: output ? 'issues_filed' : 'error' })
    log.info('scheduler: improve_patrol: productive run (issues filed or agent output present)')
  }
}

export async function runIssueResolver(): Promise<void> {
  if (!isEnabled('issue_resolver')) return
  if (isQuietHours()) {
    log.info('scheduler: issue_resolver: quiet hours, standing down')
    return
  }
  log.info('scheduler: issue_resolver: starting')
  const controller = new AbortController()
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => {
      controller.abort()
      reject(new Error(`issue_resolver exceeded max_run_ms (${RESOLVER_MAX_RUN_MS})`))
    }, RESOLVER_MAX_RUN_MS),
  )
  try {
    await Promise.race([resolveNextAutoIssue(controller.signal), timeout])
    log.info('scheduler: issue_resolver: complete')
  } catch (err) {
    log.warn('scheduler: issue_resolver: failed', { err: String(err) })
    logEvent('issue_resolver', 'routine_delivered', { routine: 'issue_resolver', exit_code: -1, error: String(err) })
  }
}
