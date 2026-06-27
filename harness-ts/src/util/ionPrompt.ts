// Shared ion prompt helpers.
// Used by both scheduler (fire-and-forget routines) and autonomy (capturing goal runs).

import { spawn } from 'node:child_process'
import { log } from 'ion-sdk'
import { logEvent } from '../memory/episodic'
import { getSchedulerCtx } from '../scheduler/ctx'

// ---------------------------------------------------------------------------
// Async command runner (mirrors the private copy in scheduler/index.ts)
// ---------------------------------------------------------------------------

interface CommandResult {
  status: number | null
  stdout: string
  stderr: string
  error?: Error
}

export function runCommandAsync(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {},
): Promise<CommandResult> {
  return new Promise((resolve) => {
    // spawn's `env` REPLACES the environment, so merge over process.env to keep PATH etc.
    const spawnOpts: Parameters<typeof spawn>[2] = {}
    if (opts.cwd) spawnOpts.cwd = opts.cwd
    if (opts.env) spawnOpts.env = { ...process.env, ...opts.env }
    const child = spawn(cmd, args, spawnOpts)
    let stdout = ''
    let stderr = ''
    let timer: NodeJS.Timeout | null = null
    let killedByTimeout = false
    let killTimer: NodeJS.Timeout | null = null

    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        killedByTimeout = true
        child.kill('SIGTERM')
        killTimer = setTimeout(() => child.kill('SIGKILL'), 2_000).unref()
      }, opts.timeoutMs)
    }

    if (opts.signal) {
      if (opts.signal.aborted) {
        child.kill('SIGTERM')
        if (killTimer) clearTimeout(killTimer)
        return resolve({ status: null, stdout, stderr, error: new Error('aborted') })
      }
      opts.signal.addEventListener('abort', () => {
        child.kill('SIGTERM')
        if (timer) clearTimeout(timer)
        if (killTimer) clearTimeout(killTimer)
        killTimer = setTimeout(() => child.kill('SIGKILL'), 2_000).unref()
      })
    }

    child.stdout?.on('data', (b: Buffer) => { stdout += b.toString('utf8') })
    child.stderr?.on('data', (b: Buffer) => { stderr += b.toString('utf8') })
    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      resolve({ status: null, stdout, stderr, error: err })
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      const error = killedByTimeout
        ? new Error(`command timed out after ${opts.timeoutMs}ms`)
        : undefined
      resolve({ status: code, stdout, stderr, ...(error ? { error } : {}) })
    })
  })
}

// ---------------------------------------------------------------------------
// Fire-and-forget: deliver a scheduler prompt through the engine session when
// ctx is available (before_prompt and turn_end hooks fire), falling back to
// subprocess when no session is active. Used by scheduler routines.
// ---------------------------------------------------------------------------

export async function runIonPrompt(routine: string, prompt: string): Promise<void> {
  logEvent(routine, 'routine_started', { routine })

  const ctx = getSchedulerCtx()
  if (ctx) {
    try {
      await ctx.sendPrompt(prompt)
      logEvent(routine, 'routine_delivered', { routine, exit_code: 0, via: 'sendPrompt' })
      log.info(`ionPrompt: ${routine} delivered via ctx.sendPrompt`)
      return
    } catch (err) {
      log.warn(`ionPrompt: ${routine} sendPrompt failed, falling back to subprocess`, { err: String(err) })
      logEvent(routine, 'routine_queued', { routine, via: 'sendPrompt', exit_code: -1, error: String(err) })
      // fall through to subprocess
    }
  }

  // Fallback: subprocess
  const ionBin = process.env['ION_BIN'] ?? 'ion'
  try {
    const r = await runCommandAsync(
      ionBin,
      ['prompt', '--key', 'jarvis', prompt, '--attach'],
      { timeoutMs: 240_000 },
    )
    logEvent(routine, 'routine_delivered', {
      routine,
      exit_code: r.status,
      ...(r.error ? { spawn_error: String(r.error) } : {}),
    })
    log.info(`ionPrompt: ${routine} delivered`, { exit_code: r.status })
  } catch (err) {
    log.warn(`ionPrompt: ${routine} failed`, { err: String(err) })
    logEvent(routine, 'routine_delivered', { routine, exit_code: -1, error: String(err) })
  }
}

// ---------------------------------------------------------------------------
// Capturing: runs `ion prompt --key jarvis <prompt> --attach` and returns
// stdout. Used by autonomy goal runs and anywhere the response text matters.
// ---------------------------------------------------------------------------

export interface IonPromptResult {
  stdout: string
  status: number | null
  error: Error | undefined
}

export async function runIonPromptCapture(
  prompt: string,
  timeoutMs = 240_000,
): Promise<IonPromptResult> {
  const ionBin = process.env['ION_BIN'] ?? 'ion'
  const r = await runCommandAsync(
    ionBin,
    ['prompt', '--key', 'jarvis', prompt, '--attach'],
    { timeoutMs },
  )
  return { stdout: r.stdout, status: r.status, error: r.error }
}
