import type { IonSDK } from 'ion-sdk'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as os from 'node:os'
import * as path from 'node:path'
import { getSecret } from '../../secrets'
import { spotlightSearch } from '../../tools/spotlight'
import { gitDiff, gitApplyPatch } from '../../tools/git'
import { notesRead, notesCreate } from '../../tools/notes'
import { recentEvents, type EventRow } from '../../memory/episodic'
import { sanitizeUntrusted } from '../../memory/sanitize'

const execFileAsync = promisify(execFile)
const SCRIPTS_DIR = path.join(os.homedir(), 'Jarvis', 'scripts')

// R3: system/dev tools (original positions 8–10)
export function registerSystemToolsR3(ion: IonSDK): void {
  ion.registerTool({
    name: 'spotlight_search',
    description: 'Search files on this Mac using Spotlight. Returns bullet-list of matching paths. Use "name:<filename>" to find a file by name across the entire machine (e.g. "name:comfyui.sh"). Use a plain keyword for content/metadata search in Documents and Downloads.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Use "name:<filename>" for a filename search (whole machine), or a keyword/MDQuery expression for content search.' },
      },
      required: ['query'],
    },
    execute: async (params) => {
      return { content: sanitizeUntrusted(await spotlightSearch(params['query'] as string)) }
    },
  })

  ion.registerTool({
    name: 'git_diff',
    description: 'Show the current git diff for the Jarvis repo.',
    parameters: {
      type: 'object',
      properties: {
        staged: { type: 'boolean', description: 'If true, show staged changes (--staged). Default: unstaged.' },
      },
      required: [],
    },
    execute: async (params) => {
      return { content: gitDiff((params['staged'] as boolean | undefined) ?? false) }
    },
  })

  ion.registerTool({
    name: 'git_apply_patch',
    description: 'Apply a unified diff patch to the Jarvis repo. Only files in IMPROVABLE_PATHS are permitted.',
    parameters: {
      type: 'object',
      properties: {
        patch: { type: 'string', description: 'Unified diff patch string (output of git diff).' },
      },
      required: ['patch'],
    },
    execute: async (params) => {
      return { content: gitApplyPatch(params['patch'] as string) }
    },
  })
}

// R6: jina_fetch (original position 22)
export function registerSystemToolsR6(ion: IonSDK): void {
  ion.registerTool({
    name: 'jina_fetch',
    description: 'Fetch a URL and return clean markdown via Jina Reader. Handles JS-rendered pages and returns LLM-ready text. Falls back to web_fetch if Jina is unavailable.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch.' },
      },
      required: ['url'],
    },
    execute: async (params) => {
      const url = params['url'] as string
      const key = getSecret('jina-api-key')
      const headers: Record<string, string> = {
        'Accept': 'text/markdown',
        'X-Return-Format': 'markdown',
      }
      if (key) headers['Authorization'] = `Bearer ${key}`
      try {
        const res = await fetch(`https://r.jina.ai/${url}`, { headers, signal: AbortSignal.timeout(30_000) })
        if (!res.ok) throw new Error(`Jina returned ${res.status}`)
        const text = await res.text()
        if (!text || text.length < 100) throw new Error('Empty response')
        return { content: sanitizeUntrusted(text) }
      } catch (err) {
        // Fall back to ion built-in web_fetch
        return { content: `[jina_fetch fell back to web_fetch: ${String(err)}]\n\nUse web_fetch tool for ${url}`, isError: true }
      }
    },
  })
}

// R9: notes and health tools (original positions 27–29)
export function registerSystemToolsR9(ion: IonSDK): void {
  ion.registerTool({
    name: 'notes_read',
    description:
      'Search and read notes from Notes.app via the local SQLite store. ' +
      'Returns title, snippet, folder, and modification date. ' +
      'Use for lookups, answering "did I note anything about X", or surfacing relevant notes.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search term matched against note title and snippet.' },
        recent: { type: 'number', description: 'Number of most-recent notes to return (default 10, max 50).' },
        folder: { type: 'string', description: 'Optional folder name to filter by (substring match).' },
      },
      required: [],
    },
    execute: async (params) => ({
      content: sanitizeUntrusted(notesRead(
        (params['query'] as string | undefined) ?? undefined,
        Math.min(Math.max(Number((params['recent'] as number | undefined) ?? 10), 1), 50),
        (params['folder'] as string | undefined) ?? undefined,
      )),
    }),
  })

  ion.registerTool({
    name: 'notes_create',
    description:
      'Create a note in Notes.app via AppleScript. ' +
      'Requires the ion LaunchAgent GUI session (not available via plain SSH). ' +
      'Use when Alex asks to save something as a note.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Note title.' },
        body: { type: 'string', description: 'Note body text.' },
        folder: { type: 'string', description: 'Optional folder name (created if it does not exist).' },
      },
      required: ['title', 'body'],
    },
    execute: async (params) => ({
      content: notesCreate(
        params['title'] as string,
        params['body'] as string,
        (params['folder'] as string | undefined) ?? undefined,
      ),
    }),
  })

  ion.registerTool({
    name: 'get_health_data',
    description:
      "Get today's Apple Health summary (steps, sleep, HRV, heart rate, workouts, active energy). " +
      'Data is exported daily from iPhone via the Jarvis Health Shortcut to ~/.jarvis/health-today.json. ' +
      'Returns availability status if not yet exported today.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => {
      const script = path.join(SCRIPTS_DIR, 'health-read.sh')
      try {
        const { stdout } = await execFileAsync('/bin/bash', [script], { encoding: 'utf8', timeout: 10_000 })
        return { content: stdout || 'No health data available.' }
      } catch (err) {
        return { content: 'Health data unavailable: ' + (err instanceof Error ? err.message : String(err)) }
      }
    },
  })
}

// R12: routine status tool (original position 39)
export function registerSystemToolsR12(ion: IonSDK): void {
  ion.registerTool({
    name: 'get_routine_status',
    description:
      'Check whether a named routine or background agent completed recently. ' +
      'Returns last started time, last delivered time, exit status, and whether it may be stuck. ' +
      'Routine names: morning_brief, midday_checkin, evening_journal, overnight_reflection, ' +
      'weekly_curator, cfo_watch, repo_steward, tech_advisor_watch, log_patrol, commit_patrol, ' +
      'issue_patrol, improve_patrol, issue_resolver, memory_consolidation, rss_fetch, ' +
      'imessage_ingest, commit_activity_summary, triage_check, self_improvement, vault_export, ' +
      'netflix_watch, comms_pulse, projects_refresh, findings_dispatcher, intervention_digest, ' +
      'milestone_sweep, chain_miner, etc.',
    parameters: {
      type: 'object',
      properties: {
        routine_name: {
          type: 'string',
          description: 'The routine ID to check (e.g. "morning_brief").',
        },
        within_hours: {
          type: 'number',
          description: 'How far back to look (default 24).',
        },
      },
      required: ['routine_name'],
    },
    execute: async (params) => {
      const routineName = params['routine_name'] as string
      const withinHours = Math.max(Number(params['within_hours'] ?? 24), 1)

      const started = recentEvents(routineName, 'routine_started', withinHours)
      const delivered = recentEvents(routineName, 'routine_delivered', withinHours)

      if (started.length === 0 && delivered.length === 0) {
        return { content: `No ${routineName} events in the last ${withinHours} hours.` }
      }

      const lastStarted: EventRow | null = (started.length > 0 ? started[started.length - 1] : null) ?? null
      const lastDelivered: EventRow | null = (delivered.length > 0 ? delivered[delivered.length - 1] : null) ?? null

      // Extract exit_code from the last delivered event's detail
      let exitCode: number | null = null
      if (lastDelivered?.detail !== null && lastDelivered?.detail !== undefined) {
        const detail = lastDelivered.detail as Record<string, unknown>
        if (typeof detail === 'object' && 'exit_code' in detail && typeof detail['exit_code'] === 'number') {
          exitCode = detail['exit_code']
        }
      }

      // Hung = there is a started event more recent than the last delivered event (or no delivered at all)
      let mayBeHung = false
      if (lastStarted !== null) {
        if (lastDelivered === null) {
          mayBeHung = true
        } else {
          mayBeHung = lastStarted.id > lastDelivered.id
        }
      }

      const fmtTs = (ts: string): string => {
        const d = new Date(ts)
        return d.toLocaleString('en-US', {
          timeZone: 'America/Chicago',
          month: 'numeric',
          day: 'numeric',
          year: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
          timeZoneName: 'short',
        })
      }

      const exitStr =
        exitCode === null
          ? 'n/a'
          : exitCode === 0
            ? '0 (success)'
            : `${exitCode} (error)`

      const statusStr = mayBeHung
        ? 'may be running or hung'
        : lastDelivered !== null
          ? exitCode === 0 || exitCode === null
            ? 'completed'
            : 'completed with error'
          : 'unknown'

      const lines: string[] = [
        routineName,
        `  Last started:   ${lastStarted !== null ? fmtTs(lastStarted.ts) : 'none'}`,
        `  Last delivered: ${lastDelivered !== null ? fmtTs(lastDelivered.ts) : 'none'}`,
        `  Exit code:      ${exitStr}`,
        `  Status:         ${statusStr}`,
      ]

      return { content: lines.join('\n') }
    },
  })
}
