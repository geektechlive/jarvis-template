import { join } from 'node:path'
import type { IonSDK } from 'ion-sdk'
import { log } from 'ion-sdk'
import { recall, remember } from '../../memory/recall'
import { buildAmbientSafariSection } from '../../ambient/safari'
import { triageAndAdd } from '../../triage'
import { extractFromMail } from '../../learning/mail'
import { VEC_SERVER, VEC_TIMEOUT_MS } from '../../config/endpoints'
import { HARNESS_DIR } from '../../config'
import { runCommandAsync } from '../../util/ionPrompt'

// R1: memory tools (original positions 1–4)
export function registerMemoryToolsR1(ion: IonSDK): void {
  ion.registerTool({
    name: 'recall_memory',
    description: 'Recall relevant memories from the Jarvis long-term store -- people, facts, preferences, decisions. This is YOUR tool: use it for any lookup, including contact/person facts, before saying you cannot find something. When no collection is given it searches both user_profile and knowledge (person facts are split across both). Use episodic_journal for your past work history (projects, goals, outcomes, friction points).',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for in memory. For a person, the name alone works (e.g. "Brandon").' },
        collection: {
          type: 'string',
          enum: ['user_profile', 'knowledge', 'agent_memories', 'procedural', 'episodic_journal'],
          description: 'Optional. Restrict to one collection. Omit to search user_profile + knowledge together (the right default for people and general facts). Use procedural to recall past skills -- how you handled similar tasks before. Use episodic_journal for your past work history.',
        },
      },
      required: ['query'],
    },
    execute: async (params) => {
      const query = ((params['query'] as string) ?? '').trim()
      if (!query) return { content: '[recall_memory requires a query string]' }
      const collection = params['collection'] as
        | 'user_profile' | 'knowledge' | 'agent_memories' | 'procedural' | 'episodic_journal' | undefined
      // No collection specified: person/general facts span user_profile + knowledge.
      // Search both in parallel and merge (dedup, preserve per-collection order).
      if (!collection) {
        const [profile, knowledge] = await Promise.all([
          recall(query, 'user_profile'),
          recall(query, 'knowledge'),
        ])
        const seen = new Set<string>()
        const merged: string[] = []
        for (const r of [...profile.results, ...knowledge.results]) {
          if (!seen.has(r)) {
            seen.add(r)
            merged.push(r)
          }
        }
        return { content: merged.length > 0 ? merged.join('\n') : '[No memories found]' }
      }
      const { results } = await recall(query, collection)
      return { content: results.length > 0 ? results.join('\n') : '[No memories found]' }
    },
  })

  ion.registerTool({
    name: 'get_safari_activity',
    description: "Get a domain-aggregated summary of recent Safari browsing activity and open tabs. Use when asked what Alex has been reading, researching, or browsing. Returns the last 24h of history by default.",
    parameters: {
      type: 'object',
      properties: {
        hours: { type: 'number', description: 'Lookback window in hours (default 24, max 72).' },
      },
      required: [],
    },
    execute: async (params) => {
      const hours = Math.min(Math.max(Number(params['hours'] ?? 24), 1), 72)
      const summary = buildAmbientSafariSection(hours)
      return { content: summary || 'No browser activity captured in this window.' }
    },
  })

  ion.registerTool({
    name: 'remember_fact',
    description: 'Store a fact or preference in the Jarvis long-term store.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The fact or preference to store.' },
        collection: {
          type: 'string',
          enum: ['user_profile', 'knowledge'],
          description: 'Which collection to store in (default: knowledge).',
        },
      },
      required: ['text'],
    },
    execute: async (params) => {
      const result = await remember(
        params['text'] as string,
        (params['collection'] as 'user_profile' | 'knowledge') ?? 'knowledge',
      )
      if (result.ok) {
        return { content: `Stored (id: ${result.id})` }
      }
      return { content: `[Store failed -- ${result.reason}${result.detail ? `: ${result.detail}` : ''}]` }
    },
  })

  // Reflection runs as the three-agent panel in reflection/index.ts (overnight
  // routine + /reflect command), dispatched via ctx.dispatchAgent with inline
  // panel system prompts. The reflection-analyst.md spec is also dispatchable by
  // name via the built-in Agent tool. Agent specs ship bundled with the extension
  // (dist/agents/) and via ~/.claude/agents/ for Claude Code.

  ion.registerTool({
    name: 'ingest_item',
    description: 'Triage an ingest item (mail, browser, Slack, etc.) and route it to the inbox or notification queue.',
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Origin of the item (e.g. mail, browser, slack).' },
        content: { type: 'string', description: 'The item text to triage.' },
        context: { type: 'string', description: 'Optional user preference context for scoring.' },
      },
      required: ['source', 'content'],
    },
    execute: async (params) => {
      const source = params['source'] as string
      const itemContent = params['content'] as string
      await triageAndAdd(
        { source, content: itemContent },
        (params['context'] as string | undefined) ?? '',
      )
      // Issue #539: extract durable facts from notable mail items so the
      // Chief of Communications triage path writes to semantic memory.
      // Only fires for mail source -- other sources (browser, slack) have
      // no structured mail fields and are not worth extracting here.
      if (source === 'mail') {
        const messageId = `ingest:${Date.now().toString(36)}`
        extractFromMail(
          {
            sender: 'unknown',
            subject: '(ingest_item)',
            body: itemContent,
            sentAt: new Date(),
            messageId,
          },
          30_000,
        ).catch((err: unknown) => {
          log.debug('ingest_item: extractFromMail failed (non-fatal)', { err: String(err) })
        })
      }
      return { content: `Triaged [${source}].` }
    },
  })

  // Ingest a document (PDF or text file) into semantic memory. Shells out to
  // scripts/ingest-doc.py via `uv run` so PDF extraction uses the project venv
  // (pypdf). This is the sanctioned path -- it replaces hand-written ingest
  // scripts, which previously landed untracked in scripts/ and wedged deploys.
  ion.registerTool({
    name: 'ingest_document',
    description: 'Ingest a document (a PDF or text file) into long-term memory by its file path. Extracts the text, splits it into chunks, and stores it in the knowledge collection so it becomes searchable via recall. Use this for any "ingest/remember this file" request -- never hand-write an ingest script. The file_path must already exist on disk (attachments are materialized to an absolute path before you see them).',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the PDF or text file to ingest.' },
        document_name: { type: 'string', description: 'Optional human-readable name for the document (defaults to the file name).' },
        collection: { type: 'string', description: 'Optional target collection (defaults to knowledge).' },
      },
      required: ['file_path'],
    },
    execute: async (params) => {
      const filePath = ((params['file_path'] as string) ?? '').trim()
      if (!filePath) return { content: '[ingest_document requires a file_path]' }
      const documentName = (params['document_name'] as string | undefined)?.trim()
      const collection = (params['collection'] as string | undefined)?.trim()

      const scriptPath = join(HARNESS_DIR, 'scripts', 'ingest-doc.py')
      const args = ['run', 'python', scriptPath, filePath]
      if (documentName) args.push('--document', documentName)
      if (collection) args.push('--collection', collection)

      const r = await runCommandAsync('/opt/homebrew/bin/uv', args, {
        cwd: HARNESS_DIR,
        timeoutMs: 300_000,
      })
      if (r.status !== 0 || r.error) {
        const errMsg = (r.stderr.trim() || r.stdout.trim() || String(r.error ?? 'unknown error'))
          .split('\n').slice(-3).join(' ')
        log.warn('ingest_document failed', { filePath, status: r.status, errMsg })
        return { content: `[ingest_document failed: ${errMsg}]` }
      }
      // Last line of stdout is the "Done: N/M chunks ingested." summary.
      const summary = r.stdout.trim().split('\n').filter(Boolean).pop() ?? 'ingested'
      return { content: `Ingested ${documentName ?? filePath}: ${summary}` }
    },
  })
}

// R7: isolated create_matter (original position 23)
export function registerMemoryToolsR7(ion: IonSDK): void {
  ion.registerTool({
    name: 'create_matter',
    description:
      'Create a named matter (concern/project) to group related memories, emails, and notes. Use for house moves, purchases, health situations, ongoing projects.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short name for the matter (e.g. "house-move", "tax-2026").' },
        description: { type: 'string', description: 'Optional longer description of what this matter covers.' },
      },
      required: ['name'],
    },
    execute: async (params) => {
      const name = params['name'] as string
      const description = (params['description'] as string | undefined) ?? ''
      try {
        const res = await fetch(`${VEC_SERVER}/matters/create`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, description }),
          signal: AbortSignal.timeout(VEC_TIMEOUT_MS),
        })
        const data = (await res.json()) as { id?: string; name?: string; error?: string }
        if (data.error) return { content: `Failed to create matter: ${data.error}` }
        return { content: JSON.stringify({ matter_id: data.id, name: data.name }) }
      } catch (err: unknown) {
        return { content: `create_matter unavailable: ${String(err)}` }
      }
    },
  })
}

// R11: matter operations (original positions 35–38)
export function registerMemoryToolsR11(ion: IonSDK): void {
  ion.registerTool({
    name: 'add_to_matter',
    description:
      "Add an item to an existing matter. item_type: 'memory' | 'email' | 'task' | 'note'. item_ref: a chroma ID, email thread ID, task description, or any reference string.",
    parameters: {
      type: 'object',
      properties: {
        matter_id: { type: 'string', description: 'The matter ID to add the item to.' },
        item_type: {
          type: 'string',
          enum: ['memory', 'email', 'task', 'note'],
          description: "Category of the item: 'memory', 'email', 'task', or 'note'.",
        },
        item_ref: {
          type: 'string',
          description: 'Reference string: chroma ID, email thread ID, task description, or free text.',
        },
      },
      required: ['matter_id', 'item_type', 'item_ref'],
    },
    execute: async (params) => {
      const matter_id = params['matter_id'] as string
      const item_type = params['item_type'] as string
      const item_ref = params['item_ref'] as string
      try {
        const res = await fetch(`${VEC_SERVER}/matters/add-item`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ matter_id, item_type, item_ref }),
          signal: AbortSignal.timeout(VEC_TIMEOUT_MS),
        })
        const data = (await res.json()) as { id?: string; error?: string }
        if (data.error) return { content: `Failed to add item: ${data.error}` }
        return { content: JSON.stringify({ item_id: data.id }) }
      } catch (err: unknown) {
        return { content: `add_to_matter unavailable: ${String(err)}` }
      }
    },
  })

  ion.registerTool({
    name: 'list_matters',
    description:
      'List matters (named concerns or projects). Returns open matters by default. Pass status="closed" for closed matters.',
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['open', 'closed'],
          description: 'Filter by status: "open" (default) or "closed".',
        },
      },
      required: [],
    },
    execute: async (params) => {
      const status = (params['status'] as string | undefined) ?? 'open'
      try {
        const res = await fetch(`${VEC_SERVER}/matters/list`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status }),
          signal: AbortSignal.timeout(VEC_TIMEOUT_MS),
        })
        const data = (await res.json()) as { matters?: unknown; error?: string }
        if (data.error) return { content: `Failed to list matters: ${data.error}` }
        return { content: JSON.stringify(data.matters ?? data) }
      } catch (err: unknown) {
        return { content: `list_matters unavailable: ${String(err)}` }
      }
    },
  })

  ion.registerTool({
    name: 'get_matter',
    description:
      'Get a matter and all its items by ID. Returns the matter metadata and everything linked to it.',
    parameters: {
      type: 'object',
      properties: {
        matter_id: { type: 'string', description: 'The matter ID to retrieve.' },
      },
      required: ['matter_id'],
    },
    execute: async (params) => {
      const matter_id = params['matter_id'] as string
      try {
        const res = await fetch(`${VEC_SERVER}/matters/show`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ matter_id }),
          signal: AbortSignal.timeout(VEC_TIMEOUT_MS),
        })
        const data = (await res.json()) as { matter?: unknown; error?: string }
        if (data.error) return { content: `Failed to get matter: ${data.error}` }
        return { content: JSON.stringify(data.matter ?? data) }
      } catch (err: unknown) {
        return { content: `get_matter unavailable: ${String(err)}` }
      }
    },
  })

  ion.registerTool({
    name: 'close_matter',
    description:
      'Close an open matter by ID. Use when a concern or project is resolved.',
    parameters: {
      type: 'object',
      properties: {
        matter_id: { type: 'string', description: 'The matter ID to close.' },
      },
      required: ['matter_id'],
    },
    execute: async (params) => {
      const matter_id = params['matter_id'] as string
      try {
        const res = await fetch(`${VEC_SERVER}/matters/close`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ matter_id }),
          signal: AbortSignal.timeout(VEC_TIMEOUT_MS),
        })
        const data = (await res.json()) as { closed?: boolean; error?: string }
        if (data.error) return { content: `Failed to close matter: ${data.error}` }
        return { content: data.closed ? 'Matter closed.' : 'Matter was already closed or not found.' }
      } catch (err: unknown) {
        return { content: `close_matter unavailable: ${String(err)}` }
      }
    },
  })
}
