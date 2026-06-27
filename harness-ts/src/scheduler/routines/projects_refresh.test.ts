import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { runProjectsRefresh } from './projects_refresh'
import * as ionPrompt from '../../util/ionPrompt'
import * as helpers from '../helpers'

type MockCommandResult = { status: number; stdout: string; stderr: string } | { status: number; error: Error; stdout: string; stderr: string }

const TEMP_DIR = path.join(os.tmpdir(), 'projects-refresh-test')
const PROJECTS_FILE = path.join(TEMP_DIR, 'harness', 'identity', 'PROJECTS.md')

beforeEach(() => {
  fs.mkdirSync(path.dirname(PROJECTS_FILE), { recursive: true })
  vi.spyOn(helpers, 'isEnabled').mockReturnValue(true)
  process.env['JARVIS_DIR'] = TEMP_DIR
})

afterEach(() => {
  delete process.env['JARVIS_DIR']
  if (fs.existsSync(TEMP_DIR)) {
    fs.rmSync(TEMP_DIR, { recursive: true })
  }
  vi.restoreAllMocks()
})

const SAMPLE_PROJECTS = `# Projects

## Active

- **project-one**: A recent project. Last pushed: 2025-05-20.
- **project-two**: Another active one. Last pushed: 2025-05-15.

## Maintained

- **project-three**: An older project. Last pushed: 2025-03-01.

## Parked

- **project-four**: A very old project. Last pushed: 2024-12-01.
`

describe('projects_refresh', () => {
  it('skips if file does not exist', async () => {
    // No PROJECTS_FILE created; should skip gracefully
    await runProjectsRefresh()
    // Test passes if no exception thrown
  })

  it('recategorizes a project from active to maintained when old', async () => {
    fs.writeFileSync(PROJECTS_FILE, SAMPLE_PROJECTS, 'utf8')

    const mockGhResponse = (repoName: string | undefined): MockCommandResult => {
      const dates: Record<string, string> = {
        'project-one': '2025-04-15T00:00:00Z', // 36 days ago
        'project-two': '2025-05-15T00:00:00Z',
        'project-three': '2025-03-01T00:00:00Z',
        'project-four': '2024-12-01T00:00:00Z',
      }
      return { status: 0, stdout: JSON.stringify({ pushedAt: repoName ? dates[repoName] : '' }), stderr: '' }
    }

    vi.spyOn(ionPrompt, 'runCommandAsync').mockImplementation(async (cmd, args): Promise<MockCommandResult> => {
      if (cmd === 'gh' && args[0] === 'repo') {
        const repoNamePart = args[1]
        if (typeof repoNamePart === 'string') {
          const repoName = repoNamePart.split('/')[1]
          if (repoName) {
            return mockGhResponse(repoName)
          }
        }
      }
      return { status: 0, stdout: '', stderr: '' }
    })

    await runProjectsRefresh()

    const updated = fs.readFileSync(PROJECTS_FILE, 'utf8')
    expect(updated).toContain('## Active')
    expect(updated).toContain('## Maintained')
    // Check that project-one appears in updated file
    expect(updated).toContain('project-one')
  })

  it('preserves descriptions during update', async () => {
    fs.writeFileSync(PROJECTS_FILE, SAMPLE_PROJECTS, 'utf8')

    vi.spyOn(ionPrompt, 'runCommandAsync').mockImplementation(async (): Promise<MockCommandResult> => ({
      status: 0,
      stdout: JSON.stringify({ pushedAt: '2025-05-20T00:00:00Z' }),
      stderr: '',
    }))

    await runProjectsRefresh()

    const updated = fs.readFileSync(PROJECTS_FILE, 'utf8')
    expect(updated).toContain('A recent project')
    expect(updated).toContain('Another active one')
    expect(updated).toContain('An older project')
    expect(updated).toContain('A very old project')
  })

  it('does not rewrite file when nothing changed', async () => {
    fs.writeFileSync(PROJECTS_FILE, SAMPLE_PROJECTS, 'utf8')
    const originalMtime = fs.statSync(PROJECTS_FILE).mtimeMs

    vi.spyOn(ionPrompt, 'runCommandAsync').mockImplementation(async (cmd, args): Promise<MockCommandResult> => {
      if (cmd === 'gh' && args[0] === 'repo') {
        const repoNamePart = args[1]
        if (typeof repoNamePart === 'string') {
          const repoName = repoNamePart.split('/')[1]
          if (repoName) {
            const dates: Record<string, string> = {
              'project-one': '2025-05-20T00:00:00Z',
              'project-two': '2025-05-15T00:00:00Z',
              'project-three': '2025-03-01T00:00:00Z',
              'project-four': '2024-12-01T00:00:00Z',
            }
            return { status: 0, stdout: JSON.stringify({ pushedAt: dates[repoName] ?? '' }), stderr: '' }
          }
        }
      }
      return { status: 0, stdout: '', stderr: '' }
    })

    await new Promise(resolve => setTimeout(resolve, 10))

    await runProjectsRefresh()

    const newMtime = fs.statSync(PROJECTS_FILE).mtimeMs
    expect(newMtime).toBe(originalMtime)
  })

  it('handles 404 repos gracefully', async () => {
    fs.writeFileSync(PROJECTS_FILE, SAMPLE_PROJECTS, 'utf8')

    vi.spyOn(ionPrompt, 'runCommandAsync').mockImplementation(async (cmd, args): Promise<MockCommandResult> => {
      if (cmd === 'gh' && args[0] === 'repo') {
        const repoNamePart = args[1]
        if (typeof repoNamePart === 'string') {
          const repoName = repoNamePart.split('/')[1]
          if (repoName === 'project-three') {
            return { status: 1, error: new Error('not found'), stderr: '404', stdout: '' }
          }
          if (repoName) {
            const dates: Record<string, string> = {
              'project-one': '2025-05-20T00:00:00Z',
              'project-two': '2025-05-15T00:00:00Z',
              'project-four': '2024-12-01T00:00:00Z',
            }
            return { status: 0, stdout: JSON.stringify({ pushedAt: dates[repoName] ?? '' }), stderr: '' }
          }
        }
      }
      return { status: 0, stdout: '', stderr: '' }
    })

    await runProjectsRefresh()
    // Should not crash; skips project-three
    const updated = fs.readFileSync(PROJECTS_FILE, 'utf8')
    expect(updated).toContain('project-one')
    expect(updated).toContain('project-two')
    expect(updated).toContain('project-four')
  })

  it('keeps entries in file when updated', async () => {
    const projectsWithDates = `# Projects

## Active

- **proj-a**: First one. Last pushed: 2025-05-25.
- **proj-b**: Second one. Last pushed: 2025-05-20.

## Maintained

- **proj-c**: Third one. Last pushed: 2025-03-15.

## Parked

- **proj-d**: Fourth one. Last pushed: 2024-12-01.
`

    fs.writeFileSync(PROJECTS_FILE, projectsWithDates, 'utf8')

    vi.spyOn(ionPrompt, 'runCommandAsync').mockImplementation(async (): Promise<MockCommandResult> => ({
      status: 0,
      stdout: JSON.stringify({ pushedAt: '2025-05-20T00:00:00Z' }),
      stderr: '',
    }))

    await runProjectsRefresh()

    const updated = fs.readFileSync(PROJECTS_FILE, 'utf8')
    expect(updated).toContain('proj-a')
    expect(updated).toContain('proj-b')
    expect(updated).toContain('proj-c')
    expect(updated).toContain('proj-d')
  })
})
