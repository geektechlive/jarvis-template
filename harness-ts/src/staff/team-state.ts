/**
 * Team State -- persistence layer for dispatch history and session briefings.
 *
 * Stores dispatch records per team, prunes entries older than 7 days,
 * and builds markdown briefings for the CoS system prompt.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { DispatchRecord, TeamState } from './types'

function teamStatePath(dataHome: string, teamName: string): string {
  return join(dataHome, '.ion', 'team-state', `${teamName}.json`)
}

function ensureDir(dirPath: string): void {
  if (!existsSync(dirPath)) mkdirSync(dirPath, { recursive: true })
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

function pruneOldRecords(dispatches: DispatchRecord[]): DispatchRecord[] {
  const cutoff = new Date(Date.now() - SEVEN_DAYS_MS).toISOString()
  return dispatches.filter(d => d.completed > cutoff)
}

export function loadTeamState(dataHome: string, teamName: string): TeamState {
  const path = teamStatePath(dataHome, teamName)
  if (!existsSync(path)) {
    return { team: teamName, lastSession: '', dispatches: [] }
  }
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8')) as TeamState
    data.dispatches = pruneOldRecords(data.dispatches)
    return data
  } catch {
    return { team: teamName, lastSession: '', dispatches: [] }
  }
}

export function recordDispatch(
  dataHome: string,
  teamName: string,
  record: DispatchRecord,
): void {
  const state = loadTeamState(dataHome, teamName)
  state.dispatches.push(record)
  state.dispatches = pruneOldRecords(state.dispatches)
  saveTeamState(dataHome, teamName, state)
}

export function touchSession(dataHome: string, teamName: string): void {
  const state = loadTeamState(dataHome, teamName)
  state.lastSession = new Date().toISOString()
  saveTeamState(dataHome, teamName, state)
}

function saveTeamState(dataHome: string, teamName: string, state: TeamState): void {
  const dir = join(dataHome, '.ion', 'team-state')
  ensureDir(dir)
  writeFileSync(teamStatePath(dataHome, teamName), JSON.stringify(state, null, 2))
}

export function buildBriefing(dataHome: string, teamName: string): string {
  const state = loadTeamState(dataHome, teamName)
  if (state.dispatches.length === 0) return ''

  const byAgent = new Map<string, DispatchRecord[]>()
  for (const d of state.dispatches) {
    if (!byAgent.has(d.agent)) byAgent.set(d.agent, [])
    byAgent.get(d.agent)!.push(d)
  }

  const lines: string[] = []
  lines.push(`## Session Briefing (last 7 days)`)
  lines.push('')

  if (state.lastSession) {
    const ago = Math.round((Date.now() - new Date(state.lastSession).getTime()) / 3600000)
    lines.push(`Last session: ${ago < 1 ? 'less than 1 hour' : `${ago}h`} ago`)
    lines.push('')
  }

  let totalCost = 0
  let totalDispatches = 0

  for (const [agent, records] of byAgent) {
    totalDispatches += records.length
    const successes = records.filter(r => r.exitCode === 0).length
    const rate = records.length > 0 ? Math.round((successes / records.length) * 100) : 0
    const avgElapsed = Math.round(records.reduce((s, r) => s + r.elapsed, 0) / records.length)
    const agentCost = records.reduce((s, r) => s + r.cost, 0)
    totalCost += agentCost

    const latest = records[records.length - 1]!
    const taskPreview = latest.task.length > 60
      ? latest.task.slice(0, 57) + '...'
      : latest.task

    lines.push(`- **${agent}**: ${records.length} dispatch${records.length !== 1 ? 'es' : ''}, ${rate}% success, avg ${avgElapsed}s, $${agentCost.toFixed(2)}`)
    lines.push(`  Latest: ${taskPreview}`)
  }

  lines.push('')
  lines.push(`Total: ${totalDispatches} dispatches, $${totalCost.toFixed(2)} cost`)

  return lines.join('\n')
}
