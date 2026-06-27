import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { log } from 'ion-sdk'
import { logEvent } from '../../memory/episodic'
import { isEnabled } from '../helpers'
import { runCommandAsync } from '../../util/ionPrompt'
import { autoCommitPush } from '../../util/gitAutoCommit'

interface ProjectEntry {
  name: string
  description: string
  lastPushed: string
}

interface ParsedProjects {
  active: ProjectEntry[]
  maintained: ProjectEntry[]
  parked: ProjectEntry[]
}

function parseProjectsFile(content: string): ParsedProjects {
  const result: ParsedProjects = {
    active: [],
    maintained: [],
    parked: [],
  }

  const sections = content.split(/^##\s+/m)
  for (const section of sections) {
    const lines = section.split('\n')
    const header = lines[0]?.trim()
    const category = header?.toLowerCase()

    if (!category || !['active', 'maintained', 'parked'].includes(category)) {
      continue
    }

    const entries = result[category as keyof ParsedProjects]
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]
      if (!line || !line.startsWith('- **')) continue

      const match = /^-\s+\*\*([^*]+)\*\*:\s+(.+?)\.\s+Last\s+pushed:\s+(\d{4}-\d{2}-\d{2})\.?$/.exec(line)
      if (match && match[1] && match[2] && match[3]) {
        entries.push({
          name: match[1],
          description: match[2],
          lastPushed: match[3],
        })
      }
    }
  }

  return result
}

function categorizeByPushedDate(lastPushed: string): 'active' | 'maintained' | 'parked' {
  const lastDate = new Date(lastPushed)
  const now = new Date()
  const daysSince = Math.floor((now.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24))

  if (daysSince <= 30) return 'active'
  if (daysSince <= 90) return 'maintained'
  return 'parked'
}

function formatProjectsFile(projects: ParsedProjects): string {
  const sections: string[] = []

  for (const category of ['active', 'maintained', 'parked'] as const) {
    const entries = projects[category]
      .sort((a, b) => new Date(b.lastPushed).getTime() - new Date(a.lastPushed).getTime())
      .map(e => `- **${e.name}**: ${e.description}. Last pushed: ${e.lastPushed}.`)

    if (entries.length > 0) {
      sections.push(`## ${category.charAt(0).toUpperCase() + category.slice(1)}\n\n${entries.join('\n')}`)
    }
  }

  return sections.join('\n\n')
}

async function getLastPushedDate(repoName: string): Promise<string | null> {
  try {
    const r = await runCommandAsync('gh', [
      'repo', 'view',
      `<your-org>/${repoName}`,
      '--json', 'pushedAt',
    ], { timeoutMs: 10_000 })

    if (r.error) {
      log.warn(`projects_refresh: gh repo view failed for ${repoName}`, { stderr: r.stderr })
      return null
    }

    const data = JSON.parse(r.stdout.trim()) as { pushedAt: string }
    if (!data.pushedAt) return null

    const date = new Date(data.pushedAt)
    return date.toISOString().split('T')[0] ?? null
  } catch (err) {
    log.warn(`projects_refresh: failed to fetch ${repoName}`, { err: String(err) })
    return null
  }
}

export async function runProjectsRefresh(): Promise<void> {
  if (!isEnabled('projects_refresh')) return

  try {
    // Evaluated at call time so tests can override via process.env['JARVIS_DIR'] in beforeEach.
    const harnessDir = process.env['JARVIS_DIR'] ?? process.env['AGENT_HARNESS_DIR'] ?? path.join(os.homedir(), 'Jarvis')
    const projectsPath = path.join(harnessDir, 'harness', 'identity', 'PROJECTS.md')

    if (!fs.existsSync(projectsPath)) {
      log.warn('scheduler: projects_refresh: PROJECTS.md not found', { path: projectsPath })
      logEvent('projects_refresh', 'routine_delivered', {
        routine: 'projects_refresh',
        exit_code: -1,
        error: 'PROJECTS.md not found',
      })
      return
    }

    const content = fs.readFileSync(projectsPath, 'utf8')
    const projects = parseProjectsFile(content)

    const allEntries = [...projects.active, ...projects.maintained, ...projects.parked]
    let changedCount = 0
    let tierMoveCount = 0

    for (const entry of allEntries) {
      const newDate = await getLastPushedDate(entry.name)
      if (!newDate) {
        log.warn(`projects_refresh: skipped ${entry.name} (404 or fetch error)`)
        continue
      }

      if (newDate !== entry.lastPushed) {
        changedCount++
        entry.lastPushed = newDate
      }

      const oldCategory = projects.active.includes(entry)
        ? 'active'
        : projects.maintained.includes(entry)
          ? 'maintained'
          : 'parked'

      const newCategory = categorizeByPushedDate(newDate)

      if (oldCategory !== newCategory) {
        tierMoveCount++
        // Remove from old category
        const oldList = projects[oldCategory]
        const idx = oldList.indexOf(entry)
        if (idx >= 0) oldList.splice(idx, 1)

        // Add to new category
        projects[newCategory].push(entry)
      }
    }

    // Only rewrite if something changed
    if (changedCount === 0 && tierMoveCount === 0) {
      log.info('scheduler: projects_refresh: no changes', {
        repos_checked: allEntries.length,
      })
      logEvent('projects_refresh', 'routine_delivered', {
        routine: 'projects_refresh',
        repos_checked: allEntries.length,
        changed: 0,
        tier_moves: 0,
      })
      return
    }

    const newContent = formatProjectsFile(projects)
    fs.writeFileSync(projectsPath, newContent, 'utf8')

    // Commit + push the change so it isn't left uncommitted on the Mini (where the next
    // deploy would stash and drop it). Scoped to PROJECTS.md so unrelated dirt is untouched.
    await autoCommitPush(
      'harness/identity/PROJECTS.md',
      `chore(identity): refresh PROJECTS.md repo dates (${changedCount} changed, ${tierMoveCount} tier moves) [auto]`,
    )

    log.info('scheduler: projects_refresh: complete', {
      repos_checked: allEntries.length,
      dates_changed: changedCount,
      tier_moves: tierMoveCount,
    })

    logEvent('projects_refresh', 'routine_delivered', {
      routine: 'projects_refresh',
      repos_checked: allEntries.length,
      changed: changedCount,
      tier_moves: tierMoveCount,
    })
  } catch (err) {
    log.warn('scheduler: projects_refresh failed', { err: String(err) })
    logEvent('projects_refresh', 'routine_delivered', {
      routine: 'projects_refresh',
      exit_code: -1,
      error: String(err),
    })
  }
}
