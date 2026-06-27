/**
 * Meetings -- convene_meeting tool implementation.
 *
 * Runs a structured multi-round meeting where participants respond to a brief
 * and to each other's responses. Each round dispatches all participants in
 * parallel and collects their responses into a transcript.
 */

import { dispatchAgentAndWait } from './agent-dispatch'
import type { ControlRoom } from './control-room'
import type { IonContext } from 'ion-sdk'

interface MeetingOptions {
  brief: string
  participants: string[]
  rounds: number
  model: string
  workingDirectory: string
  universalStandards?: string
  agentsRoot?: string
  ctx?: IonContext
}

/** Maximum wall time a single round will wait for all participants. */
const ROUND_TIMEOUT_MS = 10 * 60_000

/**
 * Maximum number of participant agents dispatched concurrently within a single
 * round. Six simultaneous long-running agent sessions can exhaust the extension
 * process under memory pressure and take it down mid-tool-call. Three at a time
 * keeps peak concurrency reasonable while still parallelising the work.
 */
const MEETING_CONCURRENCY = 3

/**
 * Soft cap on the total characters carried forward as `previousRound` into
 * the next round's prompt. Without this, large round-1 responses fan out
 * into every round-2 task and blow past the participants' context windows.
 */
const PREVIOUS_ROUND_CHAR_BUDGET = 50_000

/** Per-agent slice budget used when squeezing into PREVIOUS_ROUND_CHAR_BUDGET. */
const PER_AGENT_TRIM_CHARS = 8_000

export interface RoundResponse {
  agent: string
  agentLabel: string
  response: string
  isError: boolean
}

export function trimRoundForCarryover(responses: RoundResponse[]): string {
  // First pass: include each response in full.
  const formatted = responses.map(r => `**${r.agentLabel}**: ${r.response}`)
  let joined = formatted.join('\n\n')
  if (joined.length <= PREVIOUS_ROUND_CHAR_BUDGET) return joined

  // Second pass: trim each oversized response to the per-agent budget.
  const trimmed = responses.map(r => {
    const body = r.response.length > PER_AGENT_TRIM_CHARS
      ? r.response.slice(0, PER_AGENT_TRIM_CHARS) + '\n... [trimmed for carryover]'
      : r.response
    return `**${r.agentLabel}**: ${body}`
  })
  joined = trimmed.join('\n\n')
  if (joined.length <= PREVIOUS_ROUND_CHAR_BUDGET) return joined

  // Third pass: drop oldest agents until we fit.
  const queue = [...trimmed]
  while (queue.length > 1 && queue.join('\n\n').length > PREVIOUS_ROUND_CHAR_BUDGET) {
    queue.shift()
  }
  return queue.join('\n\n')
}

export async function conveneMeeting(
  office: ControlRoom,
  opts: MeetingOptions,
): Promise<{ transcript: string; elapsed: number }> {
  const startTime = Date.now()
  const transcript: string[] = []

  const participantNames = opts.participants.map(p => {
    const def = office.allAgentDefs.find(d => d.name.toLowerCase() === p.toLowerCase())
    return def ? def.displayName : p.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
  })

  transcript.push(`# Meeting: ${opts.brief.slice(0, 80)}`)
  transcript.push(`Participants: ${participantNames.join(', ')}`)
  transcript.push(`Rounds: ${opts.rounds}`)
  transcript.push('')

  let previousRound = ''

  for (let round = 1; round <= opts.rounds; round++) {
    transcript.push(`## Round ${round}`)
    transcript.push('')

    // Build prompt for this round
    let roundPrompt = `MEETING BRIEF: ${opts.brief}\n\n`
    if (round === 1) {
      roundPrompt += 'This is the opening round. Provide your perspective on the brief. Be specific and concise -- this is a working meeting, not a presentation.'
    } else {
      roundPrompt += `This is round ${round}. Here are the previous round's responses:\n\n${previousRound}\n\nRespond to what others said. Challenge, build on, or refine. Be direct.`
    }

    // Dispatch participants in batches of MEETING_CONCURRENCY to avoid
    // exhausting the extension process with too many simultaneous agent
    // sessions. Results are collected in participant order.
    const results: Array<{ agent: string; result: Awaited<ReturnType<typeof dispatchAgentAndWait>> }> = []

    for (let i = 0; i < opts.participants.length; i += MEETING_CONCURRENCY) {
      const batch = opts.participants.slice(i, i + MEETING_CONCURRENCY)
      const batchResults = await Promise.all(
        batch.map(async agent => {
          const result = await dispatchAgentAndWait(office, {
            agent,
            task: roundPrompt,
            model: opts.model,
            workingDirectory: opts.workingDirectory,
            ...(opts.universalStandards !== undefined ? { universalStandards: opts.universalStandards } : {}),
            ...(opts.ctx !== undefined ? { ctx: opts.ctx } : {}),
            timeoutMs: ROUND_TIMEOUT_MS,
          })
          return { agent, result }
        }),
      )
      results.push(...batchResults)
    }

    const settled = results

    const roundResponses: RoundResponse[] = []
    for (const { agent, result } of settled) {
      const def = office.allAgentDefs.find(d => d.name.toLowerCase() === agent.toLowerCase())
      const agentLabel = def ? def.displayName : agent
      const isError = result.exitCode !== 0 || !result.output.trim()
      const response = isError
        ? `[Error: ${result.output || `agent returned exit code ${result.exitCode}`}]`
        : result.output
      transcript.push(`### ${agentLabel}`)
      transcript.push(response)
      transcript.push('')
      roundResponses.push({ agent, agentLabel, response, isError })
    }

    const successCount = roundResponses.filter(r => !r.isError).length
    if (successCount === 0 && round < opts.rounds) {
      transcript.push('')
      transcript.push(`_Meeting aborted: round ${round} produced no successful responses; skipping remaining rounds._`)
      break
    }

    previousRound = trimRoundForCarryover(roundResponses)
  }

  return {
    transcript: transcript.join('\n'),
    elapsed: Date.now() - startTime,
  }
}
