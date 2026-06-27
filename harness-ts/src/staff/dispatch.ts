// dispatchStaff — programmatic (non-LLM) dispatch of a staff member through the
// ion engine, used by the background scheduler routines so every dispatch passes
// the specialist's real system prompt. Interactive (LLM-initiated) dispatch does
// NOT use this -- the model delegates via the engine's built-in Agent tool
// (calling ctx.dispatchAgent from a custom tool races on CliBackend, dsswift/ion#183).
//
// The engine spawns the child (CliBackend matching the parent) and APPENDS the
// systemPrompt to the backend default (runOpts.AppendSystemPrompt; append, not
// replace) — same as reflection/index.ts. Without this, ctx.dispatchAgent({name})
// runs a generic model with no specialist persona.
//
// extensionDir points the child at the tools-only child extension so staff get
// the harness's custom tools (recall_memory, calendar, mail, ...) in their child
// session. A child-extension load failure degrades gracefully in the engine
// (dispatch_agent.go logs and continues without it), so persona delivery never
// depends on the child extension loading.

import { join } from 'node:path'
import type { IonContext, EngineEvent, DispatchAgentOpts } from 'ion-sdk'
import { log } from 'ion-sdk'
import { HARNESS_DIR } from '../config'
import { getRosterEntry } from './roster'
import { validateTaskPrompt } from '../util/validateTask'

export interface DispatchStaffOpts {
  /** Override the model (defaults to the roster entry's model). */
  model?: string
  /** Cap the child's agent loop turns. */
  maxTurns?: number
  /** Per-child engine event callback (streaming/progress). */
  onEvent?: (ev: EngineEvent) => void
  /** When true, dispatch returns a stub immediately and runs in the background. */
  background?: boolean
  /** Fires when a background dispatch finishes successfully. */
  onComplete?: (result: DispatchStaffResult) => void
  /** Fires when a background dispatch finishes with a non-zero exit code. */
  onError?: (err: { message: string; exitCode: number; elapsed: number }) => void
}

export interface DispatchStaffResult {
  output: string
  cost: number
  inputTokens: number
  outputTokens: number
  elapsed: number
}

/**
 * Absolute path to the tools-only child extension entry point. The ion engine
 * expects a FILE path (not a directory); it derives the extension dir internally
 * via filepath.Dir. Built alongside the main extension (see Makefile).
 * Returns undefined if the extension dir is unknown (e.g. test stubs) so
 * dispatch degrades gracefully without child tools.
 */
function childExtensionPath(ctx: IonContext): string | undefined {
  // Prefer the engine-provided extension dir; fall back to the known build
  // output path under HARNESS_DIR when the engine has not populated it.
  const dir = ctx.config?.extensionDir
  if (dir) return join(dir, 'child-extension', 'index.js')
  return join(HARNESS_DIR, 'harness-ts', 'dist', 'child-extension', 'index.js')
}

/**
 * Dispatch a staff member by name. Resolves the specialist's system prompt and
 * model from the roster; falls back to a bare {name, task} dispatch (no persona)
 * if the roster misses — preserving prior behavior on cold-start.
 */
export async function dispatchStaff(
  ctx: IonContext,
  name: string,
  task: string,
  opts: DispatchStaffOpts = {},
): Promise<DispatchStaffResult> {
  const entry = getRosterEntry(name)
  if (!entry) {
    log.warn('jarvis: dispatchStaff roster miss — dispatching without persona', { name })
  }
  // Build opts with only defined fields (exactOptionalPropertyTypes is on, so
  // optional properties must be omitted rather than set to undefined).
  const dispatchOpts: DispatchAgentOpts = { name, task }
  const childDir = childExtensionPath(ctx)
  if (childDir !== undefined) dispatchOpts.extensionDir = childDir
  if (entry?.systemPrompt !== undefined) dispatchOpts.systemPrompt = entry.systemPrompt
  const model = opts.model ?? entry?.model
  if (model !== undefined) dispatchOpts.model = model
  if (opts.maxTurns !== undefined) dispatchOpts.maxTurns = opts.maxTurns
  if (opts.onEvent !== undefined) dispatchOpts.onEvent = opts.onEvent
  if (opts.background !== undefined) dispatchOpts.background = opts.background
  if (opts.onComplete !== undefined) {
    const onComplete = opts.onComplete
    dispatchOpts.onComplete = (r) => onComplete({
      output: r.output,
      cost: r.cost,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      elapsed: r.elapsed,
    })
  }
  if (opts.onError !== undefined) dispatchOpts.onError = opts.onError
  if (!validateTaskPrompt(dispatchOpts.task, `staff: dispatch agent '${dispatchOpts.name}'`)) {
    throw new Error(`dispatch: empty task for agent '${dispatchOpts.name}'`)
  }

  const r = await ctx.dispatchAgent(dispatchOpts)
  return {
    output: r.output,
    cost: r.cost,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    elapsed: r.elapsed,
  }
}
