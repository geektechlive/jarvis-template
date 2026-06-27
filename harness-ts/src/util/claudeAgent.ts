import { log } from 'ion-sdk'
import { runCommandAsync } from './ionPrompt'

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001'

export interface RunClaudeAgentOpts {
  model?: string
  cwd?: string
  timeoutMs?: number
  signal?: AbortSignal
}

export interface RunClaudeAgentResult {
  stdout: string
  stderr: string
  aborted?: boolean
}

// runClaudeAgent is a utility that invokes the Claude CLI subprocess.
// Event logging (routine_started, routine_delivered) is owned by the scheduler core,
// not by this utility. Callers are responsible for emitting their own routine lifecycle events.
// When an AbortSignal is provided and aborted, the subprocess is killed with SIGTERM+SIGKILL.
export async function runClaudeAgent(
  routine: string,
  prompt: string,
  modelOrOpts: string | RunClaudeAgentOpts = DEFAULT_MODEL,
): Promise<string> {
  const claudeBin = process.env['CLAUDE_BIN'] ?? 'claude'
  const opts: RunClaudeAgentOpts =
    typeof modelOrOpts === 'string' ? { model: modelOrOpts } : modelOrOpts
  const model = opts.model ?? DEFAULT_MODEL
  const timeoutMs = opts.timeoutMs ?? 120_000
  try {
    const cmdOpts: { cwd?: string; timeoutMs?: number; signal?: AbortSignal } = { timeoutMs }
    if (opts.cwd) cmdOpts.cwd = opts.cwd
    if (opts.signal) cmdOpts.signal = opts.signal
    const r = await runCommandAsync(
      claudeBin,
      ['-p', prompt, '--model', model],
      cmdOpts,
    )
    // runCommandAsync never rejects; it resolves with error/status populated on
    // failure. Surface genuine failures (spawn error, timeout, non-zero exit) so
    // callers that treat "" as a valid result don't silently mask a dead
    // subprocess. Intentional aborts are not failures: runCommandAsync sets
    // exactly `new Error('aborted')` when the signal is already aborted.
    const aborted = opts.signal?.aborted === true || r.error?.message === 'aborted'
    if (!aborted && (r.error || (typeof r.status === 'number' && r.status !== 0))) {
      log.warn(`runClaudeAgent: ${routine} subprocess failed`, {
        routine,
        model,
        status: r.status,
        error: r.error?.message ?? null,
      })
    }
    return r.stdout
  } catch {
    return ''
  }
}
